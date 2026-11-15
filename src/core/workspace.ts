// In-memory view of the TwinCAT projects of the workspace. Independent of the
// VS Code API so it can be unit-tested against a real repository.

import * as fs from 'fs';
import * as path from 'path';
import { PlcProject, PlcProjectRef, TsProject, parsePlcProject, parseTsProject, parseXtiProject } from './project';
import { TcSourceFile, parseTcFile, parseTcText } from './tcfile';
import { Accessor, viewLabel } from './objectText';
import { IoLinkIndex, IoVar, parseIoLinks, parseProcessImage } from './ioLinks';

export function fileKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface SourceEntry {
  path: string;
  key: string;
  /** Path relative to the .plcproj folder, backslash separated as in the .plcproj. */
  include: string;
  project: PlcProject;
}

/** The I/O links of a PLC project in one TwinCAT project that holds it. */
export interface IoLinksIn {
  tsProject: TsProject;
  /** The PLC project's name in the .tsproj, as its links name it (`TIPC^Machine^...`). */
  plc: string;
  index: IoLinkIndex;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  file: TcSourceFile;
}

export class TcWorkspace {
  tsProjects: TsProject[] = [];
  plcProjects: PlcProject[] = [];
  loadErrors: string[] = [];
  /** Error message per .plcproj (fileKey) that could not be parsed, e.g. during a merge conflict. */
  readonly failedPlc = new Map<string, string>();
  /** Incremented whenever projects or files change. */
  version = 0;
  private readonly entries = new Map<string, SourceEntry>();
  private readonly plcByKey = new Map<string, PlcProject>();
  private readonly cache = new Map<string, CachedFile>();
  /** The I/O links of each .tsproj (fileKey) that has any. */
  private readonly ioLinksByTs = new Map<string, IoLinkIndex>();

  load(tsprojPaths: string[]): void {
    this.tsProjects = [];
    this.plcProjects = [];
    this.loadErrors = [];
    this.failedPlc.clear();
    this.entries.clear();
    this.plcByKey.clear();
    this.ioLinksByTs.clear();
    const seen = new Set<string>();
    for (const p of tsprojPaths) {
      const key = fileKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      let ts: TsProject;
      let text: string;
      try {
        text = fs.readFileSync(p, 'utf8');
        ts = parseTsProject(p, text);
      } catch (e) {
        this.loadErrors.push(`${p}: ${(e as Error).message}`);
        continue;
      }
      this.tsProjects.push(ts);
      // A project without <Mappings> links nothing: no I/O to show, and no variable said to be linked to nothing.
      const hasLinks = text.includes('<Mappings>');
      const image: IoVar[] = [];
      if (hasLinks) image.push(...this.processImage(text));
      for (const ref of ts.plcProjects) {
        // A PLC project saved as an Independent Project File: its .plcproj is in the .xti.
        if (ref.xtiPath && !this.readXti(ref, ref.xtiPath, hasLinks ? image : undefined)) continue;
        const plcKey = fileKey(ref.plcprojPath);
        // The same PLC project can belong to several TwinCAT projects (a simulation reuses the machine's).
        if (this.plcByKey.has(plcKey)) continue;
        let plc: PlcProject;
        try {
          plc = parsePlcProject(ref.plcprojPath, fs.readFileSync(ref.plcprojPath, 'utf8'));
        } catch (e) {
          if (!this.failedPlc.has(plcKey)) this.loadErrors.push(`${ref.plcprojPath}: ${(e as Error).message}`);
          this.failedPlc.set(plcKey, (e as Error).message);
          continue;
        }
        this.plcProjects.push(plc);
        this.plcByKey.set(plcKey, plc);
        for (const include of plc.compile) {
          const full = path.join(plc.dir, include.replace(/\\/g, path.sep));
          const k = fileKey(full);
          if (!this.entries.has(k)) this.entries.set(k, { path: full, key: k, include, project: plc });
        }
      }
      if (hasLinks) {
        try {
          this.ioLinksByTs.set(key, new IoLinkIndex(parseIoLinks(text), image));
        } catch (e) {
          this.loadErrors.push(`${p}: I/O links: ${(e as Error).message}`);
        }
      }
    }
    this.tsProjects.sort((a, b) => a.name.localeCompare(b.name));
    this.version++;
  }

  /**
   * Fills in the .plcproj of a PLC project from its .xti; false when the .xti cannot be read: the reference then
   * points at the .xti, and failedPlc says what went wrong, as for a .plcproj that does not load.
   */
  private readXti(ref: PlcProjectRef, xtiPath: string, image?: IoVar[]): boolean {
    try {
      const text = fs.readFileSync(xtiPath, 'utf8');
      Object.assign(ref, parseXtiProject(xtiPath, text));
      // The process image of its instance is in the .xti too.
      if (image) image.push(...this.processImage(text));
      return true;
    } catch (e) {
      const message = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'The Independent Project File (.xti) is not there' : (e as Error).message;
      ref.plcprojPath = xtiPath;
      if (!this.failedPlc.has(fileKey(xtiPath))) this.loadErrors.push(`${xtiPath}: ${message}`);
      this.failedPlc.set(fileKey(xtiPath), message);
      return false;
    }
  }

  /** The process image in the text of a .tsproj or .xti; none when it cannot be read (the links still show). */
  private processImage(text: string): IoVar[] {
    try {
      return parseProcessImage(text);
    } catch {
      return [];
    }
  }

  /**
   * The I/O links of a PLC project (its .plcproj) in each TwinCAT project that holds it and links any variable, as
   * the .tsproj was last saved by XAE.
   */
  ioLinks(plcprojPath: string): IoLinksIn[] {
    const k = fileKey(plcprojPath);
    const out: IoLinksIn[] = [];
    for (const ts of this.tsProjects) {
      const index = this.ioLinksByTs.get(fileKey(ts.path));
      if (!index) continue;
      for (const ref of ts.plcProjects) {
        if (ref.plcprojPath && fileKey(ref.plcprojPath) === k) out.push({ tsProject: ts, plc: ref.name, index });
      }
    }
    return out;
  }

  plcProject(plcprojPath: string): PlcProject | undefined {
    return this.plcByKey.get(fileKey(plcprojPath));
  }

  entry(p: string): SourceEntry | undefined {
    return this.entries.get(fileKey(p));
  }

  /**
   * The name of an object, method, property, action or accessor with its PLC project, as the MCP server's tools take
   * it and as XAE's tabs show it after the project: `Machine:FB_Valve.Open`, `Machine:FB_Valve.Speed.Get`.
   */
  qualifiedName(fsPath: string, objectId: string, accessor?: Accessor): string | undefined {
    const entry = this.entry(fsPath);
    const obj = entry && this.getFile(fsPath)?.objects.get(objectId);
    return obj ? `${entry.project.name}:${viewLabel(obj, accessor)}` : undefined;
  }

  get sourceEntries(): SourceEntry[] {
    return [...this.entries.values()];
  }

  /** A .tsproj, .plcproj or Independent Project File (.xti) of the workspace's projects. */
  isProjectFile(p: string): boolean {
    const k = fileKey(p);
    return this.tsProjects.some(t => fileKey(t.path) === k || t.plcProjects.some(r => r.xtiPath && fileKey(r.xtiPath) === k))
      || this.plcProjects.some(pp => fileKey(pp.path) === k);
  }

  /** Parsed file, re-read from disk when its mtime or size changed. */
  getFile(p: string): TcSourceFile | undefined {
    const k = fileKey(p);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      this.cache.delete(k);
      return undefined;
    }
    const cached = this.cache.get(k);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.file;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(p);
    } catch (e) {
      // Held by another program (XAE saving, a virus scanner) or gone since the stat: the version read before
      // until a read succeeds (the stat is not stored, so the next call reads again).
      if (cached) return cached.file;
      const unreadable = parseTcText(p, '');
      unreadable.error = (e as Error).message;
      return unreadable;
    }
    const file = parseTcFile(p, bytes);
    this.cache.set(k, { mtimeMs: stat.mtimeMs, size: stat.size, file });
    return file;
  }

  invalidate(p: string): void {
    // Read again by the next getFile; the version read before stays while the file cannot be read.
    const cached = this.cache.get(fileKey(p));
    if (cached) cached.mtimeMs = -1;
    this.version++;
  }
}

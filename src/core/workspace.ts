// In-memory view of the TwinCAT projects of the workspace. Independent of the
// VS Code API so it can be unit-tested against a real repository.

import * as fs from 'fs';
import * as path from 'path';
import { PlcProject, TsProject, parsePlcProject, parseTsProject } from './project';
import { TcSourceFile, parseTcFile } from './tcfile';

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
  private readonly tsOfPlc = new Map<PlcProject, TsProject[]>();
  private readonly plcByKey = new Map<string, PlcProject>();
  private readonly cache = new Map<string, CachedFile>();

  load(tsprojPaths: string[]): void {
    this.tsProjects = [];
    this.plcProjects = [];
    this.loadErrors = [];
    this.failedPlc.clear();
    this.entries.clear();
    this.tsOfPlc.clear();
    this.plcByKey.clear();
    const seen = new Set<string>();
    for (const p of tsprojPaths) {
      const key = fileKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      let ts: TsProject;
      try {
        ts = parseTsProject(p, fs.readFileSync(p, 'utf8'));
      } catch (e) {
        this.loadErrors.push(`${p}: ${(e as Error).message}`);
        continue;
      }
      this.tsProjects.push(ts);
      for (const ref of ts.plcProjects) {
        const plcKey = fileKey(ref.plcprojPath);
        const known = this.plcByKey.get(plcKey);
        if (known) {
          // The same PLC project can belong to several TwinCAT projects (a simulation reuses the machine's).
          this.tsOfPlc.get(known)?.push(ts);
          continue;
        }
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
        this.tsOfPlc.set(plc, [ts]);
        for (const include of plc.compile) {
          const full = path.join(plc.dir, include.replace(/\\/g, path.sep));
          const k = fileKey(full);
          if (!this.entries.has(k)) this.entries.set(k, { path: full, key: k, include, project: plc });
        }
      }
    }
    this.tsProjects.sort((a, b) => a.name.localeCompare(b.name));
    this.version++;
  }

  tsProjectsOf(plc: PlcProject): TsProject[] {
    return this.tsOfPlc.get(plc) ?? [];
  }

  plcProject(plcprojPath: string): PlcProject | undefined {
    return this.plcByKey.get(fileKey(plcprojPath));
  }

  entry(p: string): SourceEntry | undefined {
    return this.entries.get(fileKey(p));
  }

  get sourceEntries(): SourceEntry[] {
    return [...this.entries.values()];
  }

  isProjectFile(p: string): boolean {
    const k = fileKey(p);
    return this.tsProjects.some(t => fileKey(t.path) === k) || this.plcProjects.some(pp => fileKey(pp.path) === k);
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
    const file = parseTcFile(p, fs.readFileSync(p));
    this.cache.set(k, { mtimeMs: stat.mtimeMs, size: stat.size, file });
    return file;
  }

  invalidate(p: string): void {
    this.cache.delete(fileKey(p));
    this.version++;
  }
}

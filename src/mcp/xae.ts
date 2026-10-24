// The TwinCAT XAE instances running on this desktop, for the MCP server to read and write code in them instead of
// in the files when one has the project open. Talks to xae/XaeBridge.cs, compiled on first use with the .NET
// Framework's csc.exe against the automation assemblies of the XAE installed here, and run once per request
// (spawnSync: the tools are synchronous). Windows only; elsewhere, or without XAE, there are no instances.

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileKey } from '../core/workspace';

export interface XaeInstance {
  pid: number;
  progId: string;
  solution: string;
  /** The .tsproj files of its solution. */
  projects: string[];
}

export class XaeError extends Error {
  constructor(message: string, readonly dialogs: string[] = []) {
    super(dialogs.length ? `${message}. TwinCAT XAE shows: ${dialogs.join(' / ')}` : message);
  }
}

/** Where a tree item is: the .tsproj, the PLC project's name in it, and the path below its nested project. */
export interface XaeItem {
  pid: number;
  tsproj: string;
  plc: string;
  path: string[];
  /** The source file, for the state of its editor. */
  file?: string;
}

export interface LiveText {
  text: string;
  /** Full sha1 of the text, line breaks as LF (textHash). */
  hash: string;
  open: boolean;
  dirty: boolean;
}

/** The bridge's source: next to the bundle (out/xae), or in the repository when run from out/src. */
function bridgeSource(): string | undefined {
  for (const p of [path.join(__dirname, '..', 'xae', 'XaeBridge.cs'), path.join(__dirname, '..', '..', 'xae', 'XaeBridge.cs'),
    path.join(__dirname, '..', '..', '..', 'xae', 'XaeBridge.cs')]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function regDefault(key: string): string | undefined {
  try {
    const out = cp.execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /REG_SZ\s+(.*)$/m.exec(out)?.[1].trim();
  } catch {
    return undefined;
  }
}

/** The PublicAssemblies folder of the XAE registered for COM (64-bit TcXaeShell first). */
function xaeAssemblies(): string | undefined {
  for (const progId of ['TcXaeShell.DTE.17.0', 'TcXaeShell.DTE.15.0']) {
    const clsid = regDefault(`HKCR\\${progId}\\CLSID`);
    if (!clsid) continue;
    for (const view of ['HKCR\\CLSID', 'HKCR\\WOW6432Node\\CLSID']) {
      const server = regDefault(`${view}\\${clsid}\\LocalServer32`);
      const exe = server && /^\s*"?([^"]+?\.exe)/i.exec(server)?.[1];
      const dir = exe && path.join(path.dirname(exe), 'PublicAssemblies');
      if (dir && fs.existsSync(path.join(dir, 'envdte.dll')) && fs.existsSync(path.join(dir, 'envdte80.dll'))) return dir;
    }
  }
  return undefined;
}

function sysManagerAssembly(): string | undefined {
  const gac = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'TCatSysManagerLib');
  try {
    const versions = fs.readdirSync(gac).sort();
    for (const v of versions.reverse()) {
      const dll = path.join(gac, v, 'TCatSysManagerLib.dll');
      if (fs.existsSync(dll)) return dll;
    }
  } catch {
    // not installed
  }
  return undefined;
}

/** A TwinCAT XAE (or Visual Studio) process is running: if the bridge cannot be built, writing the files is not safe. */
function xaeRunning(): boolean {
  try {
    const out = cp.execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    return /^"(TcXaeShell|devenv)\.exe"/im.test(out);
  } catch {
    return false;
  }
}

export class Xae {
  private exe: string | undefined;
  private unavailable: string | undefined;
  private cache: { at: number; list: XaeInstance[] } | undefined;

  constructor(private readonly options: { enabled?: boolean; cacheDir?: string } = {}) {}

  /** The bridge, compiled once per version of its source and of the XAE assemblies; undefined where it cannot be. */
  private bridge(): string | undefined {
    if (this.exe || this.unavailable) return this.exe;
    if (process.platform !== 'win32' || this.options.enabled === false) {
      this.unavailable = 'not Windows';
      return undefined;
    }
    const source = bridgeSource();
    const assemblies = xaeAssemblies();
    const sysManager = sysManagerAssembly();
    const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!source || !assemblies || !sysManager || !fs.existsSync(csc)) {
      this.unavailable = !source ? 'XaeBridge.cs is missing' : !fs.existsSync(csc) ? '.NET Framework 4 (csc.exe) is missing' : 'TwinCAT XAE is not installed';
      return undefined;
    }
    const refs = [path.join(assemblies, 'envdte.dll'), path.join(assemblies, 'envdte80.dll'), sysManager];
    const hash = crypto.createHash('sha1').update(fs.readFileSync(source)).update(refs.join('|')).digest('hex').slice(0, 12);
    const base = this.options.cacheDir ?? path.join(process.env.LOCALAPPDATA ?? path.dirname(source), 'twincat-explorer');
    const dir = path.join(base, `xae-bridge-${hash}`);
    const exe = path.join(dir, 'XaeBridge.exe');
    if (!fs.existsSync(exe)) {
      fs.mkdirSync(dir, { recursive: true });
      for (const r of refs) fs.copyFileSync(r, path.join(dir, path.basename(r)));
      const res = cp.spawnSync(csc, ['/nologo', '/optimize', '/platform:anycpu', `/out:${exe}`,
        ...refs.map(r => `/r:${path.join(dir, path.basename(r))}`), '/r:System.Web.Extensions.dll', source], { encoding: 'utf8', windowsHide: true });
      if (res.status !== 0) {
        this.unavailable = `the XAE bridge did not compile: ${(res.stdout || res.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`;
        return undefined;
      }
    }
    this.exe = exe;
    return exe;
  }

  /** One request to a new bridge process; its result, or an XaeError (with XAE's dialogs on a timeout). */
  request<R>(req: Record<string, unknown>, timeoutMs = 30_000): R {
    const exe = this.bridge();
    if (!exe) throw new XaeError(`TwinCAT XAE cannot be driven: ${this.unavailable}`);
    const res = cp.spawnSync(exe, [], {
      input: JSON.stringify({ id: 1, timeoutMs, ...req }) + '\n', encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 10_000,
    });
    const line = (res.stdout ?? '').split('\n').find(l => l.trim().startsWith('{'));
    if (!line) throw new XaeError(`The XAE bridge gave no answer${res.error ? `: ${res.error.message}` : ''}${res.stderr ? `: ${res.stderr.trim()}` : ''}`);
    const answer = JSON.parse(line) as { ok: boolean; result?: R; error?: string; dialogs?: string[] };
    if (!answer.ok) throw new XaeError(answer.error ?? 'TwinCAT XAE refused the request', answer.dialogs ?? []);
    return answer.result as R;
  }

  /** The running XAEs, looked up again after two seconds. */
  instances(): XaeInstance[] {
    if (this.cache && Date.now() - this.cache.at < 2000) return this.cache.list;
    let list: XaeInstance[] = [];
    if (this.bridge()) list = this.request<XaeInstance[]>({ cmd: 'instances' }, 15_000);
    else if (this.unavailable !== 'not Windows' && this.unavailable !== 'TwinCAT XAE is not installed' && xaeRunning()) {
      throw new XaeError(`TwinCAT XAE is running but cannot be driven (${this.unavailable}); the files are left alone`);
    }
    this.cache = { at: Date.now(), list };
    return list;
  }

  forget(): void {
    this.cache = undefined;
  }

  /** The XAE that has this .tsproj open, if any. */
  instanceFor(tsproj: string): XaeInstance | undefined {
    const key = fileKey(tsproj);
    return this.instances().find(i => i.projects.some(p => fileKey(p) === key));
  }

  get(item: XaeItem, part: 'decl' | 'impl'): LiveText {
    return this.request<LiveText>({ cmd: 'get', ...item, part });
  }

  /** Sets the text when XAE's still has `expected` (full hash); a conflict gives XAE's current text instead. */
  set(item: XaeItem, part: 'decl' | 'impl', text: string, expected: string): LiveText & { conflict?: boolean } {
    return this.request<LiveText & { conflict?: boolean }>({ cmd: 'set', ...item, part, text, expected });
  }

  /**
   * XAE's declarations and implementations of an item and everything below it (a POU and its members), unsaved edits
   * included, by path below the item (`''`, `Open`, `Speed^Get`).
   */
  texts(item: XaeItem): { path: string; decl?: string; impl?: string }[] {
    return this.request<{ path: string; decl?: string; impl?: string }[]>({ cmd: 'texts', ...item });
  }

  doc(item: XaeItem): { open: boolean; dirty: boolean } {
    return this.request({ cmd: 'doc', ...item, path: [] });
  }

  /** The files with unsaved changes in the editors of an XAE. */
  dirty(pid: number): string[] {
    return this.request<string[]>({ cmd: 'dirty', pid });
  }

  /**
   * Saves the editor's document of a file when it still has unsaved changes. XAE saves a POU's file itself after a
   * set text, CreateChild and DeleteChild; the TwinCAT project is never saved, as that rewrites the .tsproj.
   */
  save(item: Omit<XaeItem, 'path'>, file: string): void {
    this.request({ cmd: 'save', ...item, path: [], file });
  }

  /**
   * A PLC project's .plcproj in XAE, which CreateChild and DeleteChild of an object leave unsaved: whether it has
   * unsaved changes. With `save`, it is saved first if it has, alone: neither the .tsproj nor the unsaved edits in the
   * PLC project's editors are saved with it. `open` false: XAE does not have it, and nothing is saved.
   */
  project(item: Omit<XaeItem, 'path'>, file: string, save = false): { open: boolean; dirty: boolean } {
    return this.request({ cmd: 'project', ...item, path: [], file, save });
  }

  children(item: XaeItem): { name: string }[] {
    return this.request<{ name: string }[]>({ cmd: 'children', ...item });
  }

  /** A child of an item. `info`: CreateChild's vInfo (an array; methods and accessors take none). */
  create(parent: XaeItem, name: string, subType: number, info: (string | number)[] | undefined, decl?: string): void {
    this.request({ cmd: 'create', ...parent, name, subType, info, decl });
  }

  delete(parent: XaeItem, name: string): void {
    this.request({ cmd: 'delete', ...parent, name });
  }

  check(item: Omit<XaeItem, 'path'>): string {
    return this.request<{ output: string }>({ cmd: 'check', ...item, path: [] }, 180_000).output;
  }
}

// The workspace's files in memory, behind the synchronous `fs` calls of the extension in the browser (fs.ts).
// The paths are the fsPath of the URIs, as on the desktop; a mount maps a folder's path back to its URI
// (a workspace folder, an extension's folder). The paths of every file of the workspace folders are known,
// the bytes of the TwinCAT files are read at once; writes change memory at once and the files in order.

import * as vscode from 'vscode';
import { process } from './process';

const windows = process.platform === 'win32';

/** Files whose bytes the extension reads synchronously: projects and TwinCAT sources. */
export const CONTENT = /\.(tsproj|plcproj|xti|tcpou|tcdut|tcgvl|tcio|tctto)$/i;

interface FileEntry {
  /** The path as the folder spells it. */
  path: string;
  /** Unset while the bytes were not read (not a TwinCAT file). */
  bytes?: Uint8Array;
  mtimeMs: number;
}

export interface Stat {
  directory: boolean;
  size: number;
  mtimeMs: number;
}

interface Mount {
  prefix: string;
  key: string;
  uri: vscode.Uri;
}

const files = new Map<string, FileEntry>();
/** Folders by key, with their spelling. */
const dirs = new Map<string, string>();
let mounts: Mount[] = [];
let clock = Date.now();

/** Forward slashes, no trailing slash ('' for the root). */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Windows paths are compared ignoring case, as on the desktop. */
function keyOf(p: string): string {
  const n = norm(p);
  return windows ? n.toLowerCase() : n;
}

function addDirs(p: string): void {
  let n = norm(p);
  for (let i = n.lastIndexOf('/'); i > 0; i = n.lastIndexOf('/')) {
    n = n.slice(0, i);
    const k = keyOf(n);
    if (dirs.has(k)) return;
    dirs.set(k, n);
  }
}

export function mount(fsPath: string, uri: vscode.Uri): void {
  const prefix = norm(fsPath);
  mounts = [...mounts.filter(m => m.key !== keyOf(prefix)), { prefix, key: keyOf(prefix), uri }]
    .sort((a, b) => b.prefix.length - a.prefix.length);
  if (prefix) dirs.set(keyOf(prefix), prefix);
}

export function isMounted(uri: vscode.Uri): boolean {
  return mounts.some(m => m.uri.toString() === uri.toString());
}

/** The URI of a path under a mount (the spelling of the file when it is known). */
export function uriOf(fsPath: string): vscode.Uri | undefined {
  const known = files.get(keyOf(fsPath))?.path ?? dirs.get(keyOf(fsPath));
  const n = norm(known ?? fsPath);
  const k = keyOf(n);
  for (const m of mounts) {
    if (k !== m.key && !k.startsWith(m.key + '/')) continue;
    const base = m.uri.path.replace(/\/+$/, '');
    return m.uri.with({ path: base + n.slice(m.prefix.length) || '/' });
  }
  return undefined;
}

function mustUri(fsPath: string): vscode.Uri {
  const uri = uriOf(fsPath);
  if (!uri) throw Object.assign(new Error(`EROFS: not a file of the workspace: ${fsPath}`), { code: 'EROFS' });
  return uri;
}

export function stat(fsPath: string): Stat | undefined {
  const k = keyOf(fsPath);
  const f = files.get(k);
  if (f) return { directory: false, size: f.bytes?.length ?? 0, mtimeMs: f.mtimeMs };
  if (dirs.has(k) || mounts.some(m => m.key === k)) return { directory: true, size: 0, mtimeMs: 0 };
  return undefined;
}

/** The bytes of a file; 'unread' for a file whose bytes were not read. */
export function read(fsPath: string): Uint8Array | 'unread' | undefined {
  const f = files.get(keyOf(fsPath));
  return f ? f.bytes ?? 'unread' : undefined;
}

/** The files under a folder whose bytes were read, by their path relative to it (forward slashes). */
export function contents(dir: string): { relPath: string; bytes: Uint8Array; mtimeMs: number }[] {
  const k = keyOf(dir);
  const out: { relPath: string; bytes: Uint8Array; mtimeMs: number }[] = [];
  for (const [key, f] of files) {
    if (f.bytes && key.startsWith(k + '/')) out.push({ relPath: f.path.slice(k.length + 1), bytes: f.bytes, mtimeMs: f.mtimeMs });
  }
  return out;
}

/** The names in a folder. */
export function list(dir: string): { name: string; directory: boolean }[] | undefined {
  const k = keyOf(dir);
  if (!stat(dir)?.directory) return undefined;
  const out: { name: string; directory: boolean }[] = [];
  const childOf = (key: string, spelled: string) => {
    if (!key.startsWith(k + '/')) return;
    const name = norm(spelled).slice(k.length + 1);
    if (name && !name.includes('/')) return name;
    return undefined;
  };
  for (const [key, d] of dirs) {
    const name = childOf(key, d);
    if (name) out.push({ name, directory: true });
  }
  for (const [key, f] of files) {
    const name = childOf(key, f.path);
    if (name) out.push({ name, directory: false });
  }
  return out;
}

function put(fsPath: string, bytes: Uint8Array | undefined): void {
  const k = keyOf(fsPath);
  const old = files.get(k);
  files.set(k, { path: old?.path ?? norm(fsPath), bytes, mtimeMs: ++clock });
  addDirs(fsPath);
}

function forget(fsPath: string): void {
  const k = keyOf(fsPath);
  files.delete(k);
  dirs.delete(k);
  for (const key of [...files.keys()]) if (key.startsWith(k + '/')) files.delete(key);
  for (const key of [...dirs.keys()]) if (key.startsWith(k + '/')) dirs.delete(key);
}

// ------------------------------------------------------------------ writes: memory at once, then the files in order

let queue: Promise<void> = Promise.resolve();
let report: (message: string) => void = () => undefined;

export function onWriteError(handler: (message: string) => void): void {
  report = handler;
}

function later(what: string, op: () => Thenable<void>): void {
  queue = queue.then(op).then(undefined, (e: Error) => report(`${what}: ${e.message}`));
}

export function write(fsPath: string, bytes: Uint8Array): void {
  const uri = mustUri(fsPath);
  put(fsPath, bytes);
  const copy = bytes.slice();
  later(`Writing ${fsPath}`, () => vscode.workspace.fs.writeFile(uri, copy));
}

export function makeDir(fsPath: string): void {
  const uri = mustUri(fsPath);
  if (stat(fsPath)) return;
  addDirs(norm(fsPath) + '/x');
  later(`Creating ${fsPath}`, () => vscode.workspace.fs.createDirectory(uri));
}

export function remove(fsPath: string, recursive: boolean): void {
  const uri = mustUri(fsPath);
  forget(fsPath);
  later(`Deleting ${fsPath}`, () => vscode.workspace.fs.delete(uri, { recursive, useTrash: false }));
}

export function rename(from: string, to: string): void {
  const fromUri = mustUri(from);
  const toUri = mustUri(to);
  const fromKey = keyOf(from);
  const moved = [...files.entries()].filter(([k]) => k === fromKey || k.startsWith(fromKey + '/'));
  const wasDir = dirs.has(fromKey);
  forget(from);
  for (const [, f] of moved) put(norm(to) + norm(f.path).slice(norm(from).length), f.bytes);
  if (wasDir) addDirs(norm(to) + '/x');
  later(`Renaming ${from}`, () => vscode.workspace.fs.rename(fromUri, toUri, { overwrite: true }));
}

/** Resolves once the writes asked for so far are done. */
export function settled(): Promise<void> {
  return queue;
}

// ------------------------------------------------------------------ reads from the workspace

/**
 * Runs `run` on the items with up to `size` of them at a time, the next one as soon as one is done: from GitHub each
 * read is a request, and waiting for the slowest of a batch before the next would add up.
 */
async function inParallel<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** Reads a file into memory (its bytes when it is a TwinCAT file); false when it cannot be read. */
async function load(uri: vscode.Uri, withBytes = CONTENT.test(uri.path)): Promise<boolean> {
  try {
    put(uri.fsPath, withBytes ? await vscode.workspace.fs.readFile(uri) : undefined);
    return true;
  } catch {
    return false;
  }
}

/** Mounts a workspace folder, learns the paths of its files and reads the TwinCAT ones. */
export async function loadFolder(folder: vscode.WorkspaceFolder): Promise<number> {
  mount(folder.uri.fsPath, folder.uri);
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'));
  for (const u of uris) if (!CONTENT.test(u.path)) put(u.fsPath, undefined);
  const wanted = uris.filter(u => CONTENT.test(u.path));
  // GitHub asks for no more than 100 requests at a time.
  await inParallel(wanted, 32, async u => void await load(u, true));
  return wanted.length;
}

/** Reads one more file: of an extension (its language configuration, a color theme) or a stub file. */
export async function loadFile(fsPath: string): Promise<Uint8Array | undefined> {
  const uri = uriOf(fsPath);
  if (!uri) return undefined;
  if (!(await load(uri, true))) return undefined;
  const bytes = read(fsPath);
  return bytes instanceof Uint8Array ? bytes : undefined;
}

/** Reads a file again after VS Code reported it created, changed or deleted. */
export async function sync(uri: vscode.Uri): Promise<void> {
  // The change may be one of our writes: read it once it is done.
  await settled();
  try {
    const st = await vscode.workspace.fs.stat(uri);
    if (st.type & vscode.FileType.Directory) addDirs(uri.fsPath + '/x');
    else if (!(await load(uri))) forget(uri.fsPath);
  } catch {
    forget(uri.fsPath);
  }
}

/** Reads a file's bytes, from memory or from the workspace (for the asynchronous `fs` calls). */
export async function readAsync(fsPath: string): Promise<Uint8Array> {
  const bytes = read(fsPath);
  if (bytes instanceof Uint8Array) return bytes;
  return vscode.workspace.fs.readFile(mustUri(fsPath));
}

// `fs` in the browser: the calls of the extension, on the files in memory of vfs.ts. The bytes of a file that
// was not read (not a TwinCAT file) are only available to the asynchronous calls.

import { Buffer } from 'buffer';
import * as vfs from './vfs';

type Encoding = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null | undefined;

function encodingOf(options: Encoding): BufferEncoding | undefined {
  return (typeof options === 'string' ? options : options?.encoding) ?? undefined;
}

function fail(code: string, syscall: string, p: string, why: string): never {
  throw Object.assign(new Error(`${code}: ${why}, ${syscall} '${p}'`), { code, syscall, path: p });
}

function bytesOf(p: string, syscall: string): Uint8Array {
  const bytes = vfs.read(p);
  if (bytes === undefined) fail(vfs.stat(p)?.directory ? 'EISDIR' : 'ENOENT', syscall, p, 'no such file or directory');
  if (bytes === 'unread') fail('EIO', syscall, p, 'not read in the browser');
  return bytes;
}

function decode(bytes: Uint8Array, options: Encoding): Buffer | string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encoding = encodingOf(options);
  return encoding ? buffer.toString(encoding) : buffer;
}

function encode(data: string | Uint8Array, options?: Encoding): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, encodingOf(options) ?? 'utf8') : data;
}

export function readFileSync(p: string, options?: Encoding): Buffer | string {
  return decode(bytesOf(p, 'open'), options);
}

export function writeFileSync(p: string, data: string | Uint8Array, options?: Encoding): void {
  vfs.write(p, encode(data, options));
}

export function appendFileSync(p: string, data: string | Uint8Array, options?: Encoding): void {
  const old = vfs.read(p);
  const added = encode(data, options);
  vfs.write(p, old instanceof Uint8Array ? Buffer.concat([old, added]) : added);
}

export function copyFileSync(from: string, to: string): void {
  vfs.write(to, bytesOf(from, 'copyfile'));
}

export function existsSync(p: string): boolean {
  return vfs.stat(p) !== undefined;
}

class Stats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtime: Date;

  constructor(private readonly st: vfs.Stat) {
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    this.mtime = new Date(st.mtimeMs);
  }

  isFile(): boolean {
    return !this.st.directory;
  }

  isDirectory(): boolean {
    return this.st.directory;
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

export function statSync(p: string, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const st = vfs.stat(p);
  if (st) return new Stats(st);
  if (options?.throwIfNoEntry === false) return undefined;
  return fail('ENOENT', 'stat', p, 'no such file or directory');
}

export const lstatSync = statSync;

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export function accessSync(p: string, mode = constants.F_OK): void {
  const st = vfs.stat(p);
  // Nothing is executable in the browser.
  if (!st || (mode & constants.X_OK) !== 0) fail(st ? 'EACCES' : 'ENOENT', 'access', p, 'no access');
}

class Dirent {
  constructor(readonly name: string, private readonly directory: boolean) {}

  isFile(): boolean {
    return !this.directory;
  }

  isDirectory(): boolean {
    return this.directory;
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

function entries(p: string, options?: { withFileTypes?: boolean } | BufferEncoding): (Dirent | string)[] {
  const names = vfs.list(p);
  if (!names) fail(vfs.stat(p) ? 'ENOTDIR' : 'ENOENT', 'scandir', p, 'no such directory');
  return typeof options === 'object' && options.withFileTypes
    ? names.map(n => new Dirent(n.name, n.directory))
    : names.map(n => n.name);
}

export function readdirSync(p: string, options?: { withFileTypes?: boolean } | BufferEncoding): (Dirent | string)[] {
  return entries(p, options);
}

export function mkdirSync(p: string, options?: { recursive?: boolean }): void {
  const st = vfs.stat(p);
  if (st) {
    if (options?.recursive && st.directory) return;
    fail('EEXIST', 'mkdir', p, 'file already exists');
  }
  vfs.makeDir(p);
}

export function renameSync(from: string, to: string): void {
  if (!vfs.stat(from)) fail('ENOENT', 'rename', from, 'no such file or directory');
  vfs.rename(from, to);
}

export function rmSync(p: string, options?: { recursive?: boolean; force?: boolean }): void {
  const st = vfs.stat(p);
  if (!st) {
    if (options?.force) return;
    fail('ENOENT', 'rm', p, 'no such file or directory');
  }
  if (st.directory && !options?.recursive) fail('ERR_FS_EISDIR', 'rm', p, 'is a directory');
  vfs.remove(p, !!options?.recursive);
}

export function rmdirSync(p: string): void {
  if (vfs.list(p)?.length) fail('ENOTEMPTY', 'rmdir', p, 'directory not empty');
  vfs.remove(p, false);
}

export function unlinkSync(p: string): void {
  if (!vfs.stat(p)) fail('ENOENT', 'unlink', p, 'no such file or directory');
  vfs.remove(p, false);
}

/** No watching in the browser: VS Code's file system watchers report the changes (see extension.ts). */
export function watch(): { close(): void; on(): unknown } {
  const watcher = { close: () => undefined, on: () => watcher };
  return watcher;
}

export const promises = {
  async readFile(p: string, options?: Encoding): Promise<Buffer | string> {
    return decode(await vfs.readAsync(p), options);
  },
  async readdir(p: string, options?: { withFileTypes?: boolean }): Promise<(Dirent | string)[]> {
    return entries(p, options);
  },
  async stat(p: string): Promise<Stats | undefined> {
    return statSync(p);
  },
};

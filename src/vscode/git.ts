// Git comparisons shown as notebook diffs: `twincat-diff:` URIs serve a file
// either from disk (working tree) or from a git ref, read-only.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { INDEX, WORKTREE, diffUri, parseDiffUri } from './uris';

function git(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(Buffer.from(stderr).toString('utf8').trim() || err.message));
      else resolve(stdout);
    });
  });
}

export async function showAtRef(fsPath: string, ref: string): Promise<Buffer> {
  // `<ref>:./name` is resolved relative to the working directory, which avoids comparing
  // the file path with the repository root (8.3 short names, drive letter case).
  const rel = `./${path.basename(fsPath)}`;
  const spec = ref === INDEX ? `:${rel}` : `${ref}:${rel}`;
  try {
    return await git(['show', spec], path.dirname(fsPath));
  } catch {
    // The file does not exist at that ref (new file): compare with an empty file.
    return Buffer.alloc(0);
  }
}

export async function verifyRef(fsPath: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], path.dirname(fsPath));
    return true;
  } catch {
    return false;
  }
}

export class DiffFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const ref = parseDiffUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    if (ref.ref === WORKTREE) {
      try {
        const s = fs.statSync(ref.fsPath);
        return { type: vscode.FileType.File, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      } catch {
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
      }
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = parseDiffUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    if (ref.ref === WORKTREE) {
      try {
        return fs.readFileSync(ref.fsPath);
      } catch {
        return new Uint8Array();
      }
    }
    return showAtRef(ref.fsPath, ref.ref);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('Comparisons are read-only');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  notifyChanged(fsPath: string): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: diffUri(fsPath, WORKTREE, path.basename(fsPath)) }]);
  }
}

function refLabel(ref: string): string {
  if (ref === INDEX) return 'Index';
  return ref;
}

/** Opens a notebook diff of a TwinCAT source file: `ref` on the left, working tree (or `right`) on the right. */
export async function openNotebookDiff(fsPath: string, ref: string, right: string = WORKTREE): Promise<void> {
  const base = path.basename(fsPath);
  const left = diffUri(fsPath, ref, `${base} (${refLabel(ref)})`);
  const rightUri = diffUri(fsPath, right, right === WORKTREE ? base : `${base} (${refLabel(right)})`);
  const title = `${base} (${refLabel(ref)} ↔ ${right === WORKTREE ? 'Working Tree' : refLabel(right)})`;
  await vscode.commands.executeCommand('vscode.diff', left, rightUri, title, { preview: true });
}

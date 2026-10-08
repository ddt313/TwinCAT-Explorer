// Git comparisons shown as notebook diffs: `twincat-diff:` URIs serve a file
// either from disk (working tree) or from a git ref or the index, read-only.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileKey } from '../core/workspace';
import { INDEX, WORKTREE, diffUri, parseDiffUri } from './uris';

function git(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // English messages: errors are recognised by their text (like the built-in git extension does).
    const env = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' };
    cp.execFile('git', args, { cwd, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(Buffer.from(stderr).toString('utf8').trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** git's message when a path does not exist at a ref or in the index (new, renamed or deleted file). */
const MISSING_PATH = /does not exist in|exists on disk, but not in|not in the index|neither on disk nor in the index|bad revision|invalid object name|path '.*' does not exist/i;

/** Nearest existing folder of a file: its own folder, unless that was deleted or moved. */
function existingDir(fsPath: string): string {
  let dir = path.dirname(fsPath);
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dir;
}

/** `./`-relative git path of a file seen from `cwd`, which avoids comparing it with the repository root (8.3 names, drive case). */
function relFrom(cwd: string, fsPath: string): string {
  return './' + path.relative(cwd, fsPath).split(path.sep).join('/');
}

function specOf(ref: string, rel: string): string {
  // `:0:` names the index stage explicitly; git then reports a missing path in words MISSING_PATH knows.
  return ref === INDEX ? `:0:${rel}` : `${ref}:${rel}`;
}

/**
 * Content of a file at `ref` (or in the index). `orig` is the repository-relative path at that ref
 * when the file was renamed since.
 */
export async function showAtRef(fsPath: string, ref: string, orig?: string): Promise<Buffer> {
  const cwd = existingDir(fsPath);
  const spec = specOf(ref, orig ?? relFrom(cwd, fsPath));
  try {
    return await git(['show', spec], cwd);
  } catch (e) {
    const message = (e as Error).message;
    // A file that does not exist at that ref (added since) is compared with an empty file;
    // anything else (git missing, not a repository, ...) is reported.
    if (MISSING_PATH.test(message)) return Buffer.alloc(0);
    throw new Error(`git show ${spec} failed: ${message}`);
  }
}

export async function verifyRef(fsPath: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], existingDir(fsPath));
    return true;
  } catch {
    return false;
  }
}

async function existsAt(fsPath: string, ref: string): Promise<boolean> {
  const cwd = existingDir(fsPath);
  try {
    await git(['cat-file', '-e', specOf(ref, relFrom(cwd, fsPath))], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Repository-relative path the file had at `ref` when git sees it as renamed between `ref` and the
 * working tree (or the index when `staged`), as in `git diff -M`.
 */
export async function renamedFrom(fsPath: string, ref: string, staged: boolean): Promise<string | undefined> {
  const cwd = existingDir(fsPath);
  try {
    const prefix = (await git(['rev-parse', '--show-prefix'], cwd)).toString('utf8').trim();
    const current = (prefix + path.relative(cwd, fsPath).split(path.sep).join('/')).toLowerCase();
    const args = ['diff', '-M', '--name-status', '-z'];
    if (staged) args.push('--cached');
    args.push(ref, '--');
    const tokens = (await git(args, cwd)).toString('utf8').split('\0');
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i];
      if (!status) break;
      if (status.startsWith('R') || status.startsWith('C')) {
        const from = tokens[i + 1];
        const to = tokens[i + 2];
        if (status.startsWith('R') && to?.toLowerCase() === current) return from;
        i += 3;
      } else {
        i += 2;
      }
    }
  } catch {
    // Not a repository or unknown ref: no rename information.
  }
  return undefined;
}

const ROOT_ID = /<(?:POU|DUT|GVL|Itf)\s[^>]*?\bId="\{?([0-9a-fA-F-]+)\}?"/;

/**
 * Repository-relative path of a file deleted since `ref` that holds the same TwinCAT object (same
 * root GUID). TwinCAT keeps the GUID when an object is renamed, so this finds renames git does not
 * report yet: the new file untracked, or too different for `git diff -M`.
 */
async function sameObjectDeleted(fsPath: string, ref: string, staged: boolean): Promise<string | undefined> {
  let id: string | undefined;
  try {
    id = ROOT_ID.exec(fs.readFileSync(fsPath, 'utf8'))?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
  if (!id) return undefined;
  const cwd = existingDir(fsPath);
  const ext = path.extname(fsPath).toLowerCase();
  try {
    const args = ['diff', '--name-only', '--diff-filter=D', '-z'];
    if (staged) args.push('--cached');
    args.push(ref, '--');
    const deleted = (await git(args, cwd)).toString('utf8').split('\0').filter(p => p && path.extname(p).toLowerCase() === ext);
    for (const candidate of deleted.slice(0, 100)) {
      const text = (await git(['show', `${ref}:${candidate}`], cwd)).toString('utf8');
      if (ROOT_ID.exec(text)?.[1]?.toLowerCase() === id) return candidate;
    }
  } catch {
    // no information
  }
  return undefined;
}

/** Path at `ref` of the file now at `fsPath`, when it was renamed since (undefined when not renamed). */
export async function originalPath(fsPath: string, ref: string, staged: boolean): Promise<string | undefined> {
  if (await existsAt(fsPath, ref)) return undefined;
  return (await renamedFrom(fsPath, ref, staged)) ?? (await sameObjectDeleted(fsPath, ref, staged));
}

export class DiffFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  /** Incremented when a repository changes (commit, checkout, stage) so the ref sides are re-read. */
  private refVersion = 1;
  private readonly served = new Map<string, vscode.Uri>();
  private readonly gitDirWatchers = new Map<string, vscode.Disposable>();
  private refTimer: NodeJS.Timeout | undefined;

  /** Watches HEAD, the index and the refs of the repository of a file, so ref sides refresh after commit/checkout/stage. */
  private async watchGitDir(fsPath: string): Promise<void> {
    let dirs: string[];
    try {
      const out = (await git(['rev-parse', '--absolute-git-dir', '--git-common-dir'], path.dirname(fsPath))).toString('utf8');
      dirs = out.split(/\r?\n/).filter(Boolean).map(d => path.resolve(path.dirname(fsPath), d));
    } catch {
      return;
    }
    for (const dir of new Set(dirs)) {
      const key = fileKey(dir);
      if (this.gitDirWatchers.has(key)) continue;
      // Node's watcher, not a VS Code FileSystemWatcher: a VS Code watcher rooted in .git stopped the
      // workspace watcher from reporting changes of the source files (tabs no longer reloaded).
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, name) => {
          const n = String(name ?? '').replace(/\\/g, '/');
          if (!/^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|index|packed-refs|COMMIT_EDITMSG|refs\/)/.test(n)) return;
          if (this.refTimer) clearTimeout(this.refTimer);
          this.refTimer = setTimeout(() => this.notifyRefsChanged(), 300);
        });
      } catch {
        continue;
      }
      watcher.on('error', () => watcher.close());
      this.gitDirWatchers.set(key, new vscode.Disposable(() => watcher.close()));
    }
  }

  dispose(): void {
    if (this.refTimer) clearTimeout(this.refTimer);
    this.gitDirWatchers.forEach(w => w.dispose());
    this.gitDirWatchers.clear();
  }

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
    return { type: vscode.FileType.File, ctime: 0, mtime: this.refVersion, size: 0 };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = parseDiffUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    this.served.set(uri.toString(), uri);
    if (ref.ref === WORKTREE) {
      try {
        return fs.readFileSync(ref.fsPath);
      } catch {
        return new Uint8Array();
      }
    }
    void this.watchGitDir(ref.fsPath);
    // Resolved at every read, so a rename committed later still shows the right file.
    const orig = await originalPath(ref.fsPath, ref.ref, ref.against === INDEX);
    return showAtRef(ref.fsPath, ref.ref, orig);
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

  /** The working tree file changed: refresh the right sides that show it. */
  notifyChanged(fsPath: string): void {
    const key = fileKey(fsPath);
    const events = [...this.served.values()]
      .filter(u => {
        const d = parseDiffUri(u);
        return d && d.ref === WORKTREE && fileKey(d.fsPath) === key;
      })
      .map(uri => ({ type: vscode.FileChangeType.Changed, uri }));
    if (events.length) this.emitter.fire(events);
  }

  /** A repository changed (commit, checkout, rebase, stage): refresh every ref and index side. */
  notifyRefsChanged(): void {
    this.refVersion++;
    const events = [...this.served.values()]
      .filter(u => parseDiffUri(u)?.ref !== WORKTREE)
      .map(uri => ({ type: vscode.FileChangeType.Changed, uri }));
    if (events.length) this.emitter.fire(events);
  }
}

function refLabel(ref: string): string {
  if (ref === INDEX) return 'Index';
  return ref;
}

/** Opens a notebook diff of a TwinCAT source file: `ref` on the left, working tree (or `right`) on the right. */
export async function openNotebookDiff(fsPath: string, ref: string, right: string = WORKTREE): Promise<void> {
  const base = path.basename(fsPath);
  const orig = await originalPath(fsPath, ref, right === INDEX);
  const leftName = orig ? path.posix.basename(orig) : base;
  const left = diffUri(fsPath, ref, `${leftName} (${refLabel(ref)})`, right);
  const rightUri = diffUri(fsPath, right, right === WORKTREE ? base : `${base} (${refLabel(right)})`);
  const title = `${orig ? `${leftName} → ` : ''}${base} (${refLabel(ref)} ↔ ${right === WORKTREE ? 'Working Tree' : refLabel(right)})`;
  await vscode.commands.executeCommand('vscode.diff', left, rightUri, title, { preview: true });
}

/** Calls `onChange` (debounced) whenever a repository known to the built-in git extension changes. */
export async function watchRepositories(onChange: () => void): Promise<vscode.Disposable> {
  const disposables: vscode.Disposable[] = [];
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  };
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
    if (ext) {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const api = exports.getAPI(1);
      const hook = (repo: GitRepository) => disposables.push(repo.state.onDidChange(fire));
      api.repositories.forEach(hook);
      disposables.push(api.onDidOpenRepository(hook));
    }
  } catch {
    // Git extension disabled or unavailable: the comparisons then refresh when reopened.
  }
  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    disposables.forEach(d => d.dispose());
  });
}

interface GitRepository {
  state: { onDidChange: vscode.Event<void> };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

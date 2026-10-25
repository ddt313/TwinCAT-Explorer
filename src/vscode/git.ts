// Git comparisons shown as notebook diffs: `twincat-diff:` URIs serve a file
// either from disk (working tree) or from a git ref or the index, read-only.
// Also the git plumbing the change markers use (repository root, HEAD, changed files).

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  BlameCommit, COMMIT_FORMAT, CommitInfo, FileLogEntry, NameStatus, blameArgs, fileLogArgs, parseBlame, parseCommit, parseFileLog,
  parseNameStatus,
} from '../core/gitLog';
import { findOnPath } from '../core/paths';
import { RunGit, parseIndexEntries } from '../core/staging';
import { fileKey } from '../core/workspace';
import { EMPTY, INDEX, SOURCE_EXTENSIONS, WORKTREE, diffUri, parseDiffUri, revisionUri } from './uris';

export type { CommitInfo } from '../core/gitLog';

// English messages, like the built-in git extension's. No optional locks: git never rewrites .git/index for
// these reads (a stat refresh), which GitDirWatcher would report as a change of the repository.
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0' };

let gitProgram: Promise<string> | undefined;
let gitUnavailable: string | undefined;

/** Turns git off: in the browser there is no git program to run. */
export function disableGit(reason: string): void {
  gitUnavailable = reason;
}

/**
 * Commits read without git: in the browser, from the repository's host (web/github.ts). HEAD, the files of a
 * commit, branches compared with the working tree, the history and blame of a file; no index, no renames.
 */
export interface RevisionSource {
  /** Root folder of the repository a file or folder is in; undefined outside one. */
  root(fsPath: string): string | undefined;
  /** Commit of HEAD. */
  head(root: string): Promise<string>;
  /** A file at a commit, by its repository-relative path; undefined when the commit does not have it. */
  read(root: string, relPath: string, commit: string): Promise<Uint8Array | undefined>;
  /** Before a comparison the user asked for: false, said to the user, when the commits cannot be read (signed out). */
  canRead(fsPath: string): Promise<boolean>;
  /** The commit a branch, tag or commit id names; undefined when the repository has no such ref. */
  resolve(root: string, ref: string): Promise<string | undefined>;
  /** The commit HEAD and a ref have in common last; undefined when there is no such ref. */
  mergeBase(root: string, ref: string): Promise<string | undefined>;
  /** Files with the given extensions that differ between a commit and the working tree, uncommitted changes included. */
  changesSince(root: string, base: string, extensions: string[]): Promise<NameStatus[]>;
  /**
   * The commits of HEAD that changed a file, newest first, as `git log -- <path>` lists them (renames not followed).
   * Their blobs are `<commit>:<path>` specs, which readBlobs reads.
   */
  fileLog(root: string, relPath: string): Promise<FileLogEntry[]>;
  /** The commit each line of ranges (1-based, inclusive) of a file in a commit comes from. */
  blame(root: string, commit: string, relPath: string, ranges: [number, number][]): Promise<BlameResult>;
  /** The first parent of a commit; undefined for the first commit of a repository. */
  firstParent(root: string, sha: string): Promise<string | undefined>;
  /** The first `count` commits of HEAD, newest first. */
  commitLog(root: string, count: number): Promise<CommitInfo[]>;
  /** Files a commit changed against its first parent (renames with the path they came from). */
  commitChanges(root: string, commit: string): Promise<NameStatus[]>;
}

let revisions: RevisionSource | undefined;

export function useRevisionSource(source: RevisionSource): void {
  revisions = source;
}

/** Whether the commits of a file can be compared with (in the browser: asks to sign in when they cannot). */
export function canReadRevisions(fsPath: string): Promise<boolean> {
  return revisions ? revisions.canRead(fsPath) : Promise.resolve(true);
}

async function showAtRevision(source: RevisionSource, fsPath: string, ref: string, orig?: string): Promise<Buffer> {
  if (ref === INDEX) throw new Error('There is no index in the browser');
  const root = source.root(fsPath);
  if (!root) throw new Error(`${fsPath} is not in a repository`);
  const commit = ref === 'HEAD' ? await source.head(root) : ref;
  const rel = orig ?? path.relative(root, fsPath).split(path.sep).join('/');
  const bytes = commit ? await source.read(root, rel, commit) : undefined;
  return bytes ? Buffer.from(bytes) : Buffer.alloc(0);
}

/**
 * Full path of the git program: the git extension's (it applies the `git.path` setting), else the first git
 * on PATH. Never a bare `git`: Windows looks for that in the folder git runs in first, so a `git.exe` in a
 * repository would run instead of git.
 */
function gitExecutable(): Promise<string> {
  if (gitUnavailable) return Promise.reject(new Error(gitUnavailable));
  if (!gitProgram) {
    const found = (async () => {
      const known = (await gitApi())?.git?.path;
      if (known && path.isAbsolute(known)) return known;
      const onPath = findOnPath('git');
      if (!onPath) throw new Error('git was not found: install Git, or set git.path to its full path');
      return onPath;
    })();
    gitProgram = found;
    // Looked up again next time (Git installed or the git extension enabled meanwhile).
    found.catch(() => {
      if (gitProgram === found) gitProgram = undefined;
    });
  }
  return gitProgram;
}

async function git(args: string[], cwd: string): Promise<Buffer> {
  const program = await gitExecutable();
  return new Promise((resolve, reject) => {
    cp.execFile(program, args, { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(Buffer.from(stderr).toString('utf8').trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** Runs git with `input` on its standard input. */
async function gitWithInput(args: string[], cwd: string, input: Buffer | string): Promise<Buffer> {
  const program = await gitExecutable();
  return new Promise((resolve, reject) => {
    const child = cp.spawn(program, args, { cwd, env: GIT_ENV, windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `git ${args.find(a => !a.startsWith('-'))} exited with ${code}`));
    });
    // git may stop reading early (an unknown path): the write then fails, and the exit code tells why.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** Git for the staging of core/staging.ts. */
export const runGit: RunGit = (args, cwd, input) => (input === undefined ? git(args, cwd) : gitWithInput(args, cwd, input));

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
  // `:0:` is the index (stage 0).
  return ref === INDEX ? `:0:${rel}` : `${ref}:${rel}`;
}

/**
 * Content of a file at `ref` (or in the index). `orig` is the repository-relative path at that ref
 * when the file was renamed since.
 */
export async function showAtRef(fsPath: string, ref: string, orig?: string): Promise<Buffer> {
  if (revisions) return showAtRevision(revisions, fsPath, ref, orig);
  const cwd = existingDir(fsPath);
  const spec = specOf(ref, orig ?? relFrom(cwd, fsPath));
  try {
    // A file that does not exist at that ref (added since), or an unknown ref, is compared with an empty
    // file; git missing or no repository is reported.
    return (await readBlobs(cwd, [spec]))[0] ?? Buffer.alloc(0);
  } catch (e) {
    throw new Error(`reading ${spec} failed: ${(e as Error).message}`);
  }
}

export async function verifyRef(fsPath: string, ref: string): Promise<boolean> {
  if (revisions) {
    const root = revisions.root(fsPath);
    return !!root && !!(await revisions.resolve(root, ref).catch(() => undefined));
  }
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], existingDir(fsPath));
    return true;
  } catch {
    return false;
  }
}

/** True when the file is in that commit (at its current path). */
export async function existsAt(fsPath: string, ref: string): Promise<boolean> {
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
    // Plumbing (diff-index) never refreshes or writes .git/index, which the .git watcher would see.
    const args = ['diff-index', '-M', '--name-status', '-z'];
    if (staged) args.push('--cached');
    args.push(ref, '--');
    return parseNameStatus((await git(args, cwd)).toString('utf8')).find(f => f.status === 'R' && f.path.toLowerCase() === current)?.from;
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
    const args = ['diff-index', '--name-only', '--diff-filter=D', '-z'];
    if (staged) args.push('--cached');
    args.push(ref, '--');
    const deleted = (await git(args, cwd)).toString('utf8').split('\0').filter(p => p && path.extname(p).toLowerCase() === ext).slice(0, 100);
    const texts = await readBlobs(cwd, deleted.map(p => `${ref}:${p}`));
    const found = texts.findIndex(t => t && ROOT_ID.exec(t.toString('utf8'))?.[1]?.toLowerCase() === id);
    return found < 0 ? undefined : deleted[found];
  } catch {
    // no information
  }
  return undefined;
}

/** Path at `ref` of the file now at `fsPath`, when it was renamed since (undefined when not renamed). */
export async function originalPath(fsPath: string, ref: string, staged: boolean): Promise<string | undefined> {
  if (revisions) return undefined;
  if (await existsAt(fsPath, ref)) return undefined;
  return (await renamedFrom(fsPath, ref, staged)) ?? (await sameObjectDeleted(fsPath, ref, staged));
}

/** A folder to run git in for a file or folder: the folder itself, or the nearest existing folder of the file. */
function folderOf(fsPath: string): string {
  try {
    if (fs.statSync(fsPath).isDirectory()) return fsPath;
  } catch {
    // a deleted file
  }
  return existingDir(fsPath);
}

/**
 * Root folder of the repository a file or folder is in, or undefined outside a repository. Other failures (git
 * missing, a repository git calls unsafe) are thrown: they can go away, unlike not being in a repository.
 * It is spelled like the given path: git's own top level can differ (long instead of 8.3 short names), and
 * file paths joined to it would then not match the workspace's.
 */
export async function repositoryRoot(fsPath: string): Promise<string | undefined> {
  if (revisions) return revisions.root(fsPath);
  const cwd = folderOf(fsPath);
  try {
    const up = (await git(['rev-parse', '--show-cdup'], cwd)).toString('utf8').trim();
    return path.resolve(cwd, up);
  } catch (e) {
    if (/not a git repository/i.test((e as Error).message)) return undefined;
    throw e;
  }
}

/** Commit of HEAD, or '' in a repository without commits. */
export async function headCommit(root: string): Promise<string> {
  // Not '' when it cannot be read (offline, signed out): every object would show as added.
  if (revisions) return revisions.head(root);
  try {
    return (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root)).toString('utf8').trim();
  } catch {
    return '';
  }
}

/**
 * TwinCAT source files of a repository that differ from HEAD: changed (staged or not), added, untracked,
 * renamed. Deleted files are left out (there is nothing to show for them).
 */
export async function changedSourceFiles(root: string): Promise<string[]> {
  // The browser knows no status of the working tree: a file is compared with HEAD once it is opened or saved.
  if (revisions) return [];
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...extensionSpecs(SOURCE_EXTENSIONS)];
  const tokens = (await git(args, root)).toString('utf8').split('\0');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(xy)) i++;
    if (xy.includes('D')) continue;
    out.push(path.join(root, entry.slice(3)));
  }
  return out;
}

/** A file that differs between a commit and the working tree. */
export interface PathChange {
  /** Changed, added (also untracked), deleted, or renamed (staged renames only). */
  status: 'M' | 'A' | 'D' | 'R';
  /** Path in the working tree; for a deleted file, where it was. */
  fsPath: string;
  /** Repository-relative path at the commit, for a renamed file. */
  from?: string;
}

/** Pathspecs of the files with these extensions, in any case. */
function extensionSpecs(extensions: string[]): string[] {
  return extensions.map(e => `:(icase)*${e}`);
}

function pathChange(root: string, f: NameStatus): PathChange {
  const change: PathChange = { status: f.status, fsPath: path.join(root, f.path) };
  if (f.from !== undefined) change.from = f.from;
  return change;
}

/**
 * Files with the given extensions that differ between `base` (a commit) and the working tree, staged or
 * not, plus the untracked ones.
 */
export async function changesSince(root: string, base: string, extensions: string[]): Promise<PathChange[]> {
  if (revisions) return (await revisions.changesSince(root, base, extensions)).map(f => pathChange(root, f));
  const specs = extensionSpecs(extensions);
  const byPath = new Map<string, PathChange>();
  const add = (c: PathChange) => {
    const key = fileKey(c.fsPath);
    const known = byPath.get(key);
    // Deleted from the index but on disk (git rm --cached, or made again): the file differs from the base.
    if (known && known.status !== c.status && (known.status === 'D' || c.status === 'D')) byPath.set(key, { status: 'M', fsPath: c.fsPath });
    else if (!known) byPath.set(key, c);
  };
  const diff = (await git(['diff', '--name-status', '-z', '-M', base, '--', ...specs], root)).toString('utf8');
  for (const f of parseNameStatus(diff)) add(pathChange(root, f));
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs], root))
    .toString('utf8').split('\0').filter(Boolean);
  for (const p of untracked) add({ status: 'A', fsPath: path.join(root, p) });
  return [...byPath.values()];
}

/** The uncommitted changes of a repository, as Source Control shows them, of the files with some extensions. */
export interface IndexChanges {
  /** Staged: files that differ between `head` and the index. */
  staged: PathChange[];
  /** Not staged: files that differ between the index and the working tree, and the untracked ones. */
  unstaged: PathChange[];
  /** Blob of each file in the index, by fileKey. */
  blobs: Map<string, string>;
  /** Files with a merge conflict, by fileKey. */
  conflicts: Set<string>;
}

/** The uncommitted changes of a repository (see IndexChanges), staged ones against `head`, the commit of HEAD. */
export async function indexChanges(root: string, head: string, extensions: string[]): Promise<IndexChanges> {
  const specs = extensionSpecs(extensions);
  const [staged, unstaged, untracked, entries] = await Promise.all([
    git(['diff', '--cached', '--name-status', '-z', '-M', head, '--', ...specs], root),
    git(['diff', '--name-status', '-z', '--', ...specs], root),
    git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs], root),
    git(['ls-files', '-s', '-z', '--', ...specs], root),
  ]);
  const out: IndexChanges = { staged: [], unstaged: [], blobs: new Map(), conflicts: new Set() };
  for (const e of parseIndexEntries(entries.toString('utf8'))) {
    const key = fileKey(path.join(root, e.path));
    if (e.stage === 0) out.blobs.set(key, e.blob);
    else out.conflicts.add(key);
  }
  // A file with a conflict has no version in the index yet: it is listed as not staged only.
  out.staged = parseNameStatus(staged.toString('utf8')).map(f => pathChange(root, f)).filter(c => !out.conflicts.has(fileKey(c.fsPath)));
  out.unstaged = parseNameStatus(unstaged.toString('utf8')).map(f => pathChange(root, f));
  for (const p of untracked.toString('utf8').split('\0').filter(Boolean)) out.unstaged.push({ status: 'A', fsPath: path.join(root, p) });
  return out;
}

/** The commit where HEAD's branch left `ref` (what a merge request of this branch into `ref` compares with). */
export async function mergeBase(root: string, ref: string): Promise<string | undefined> {
  if (revisions) return revisions.mergeBase(root, ref);
  try {
    return (await git(['merge-base', ref, 'HEAD'], root)).toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The first `count` commits reachable from HEAD, newest first, like `git log`. */
export async function commitLog(root: string, count: number): Promise<CommitInfo[]> {
  if (revisions) return revisions.commitLog(root, count);
  // No signature checks (log.showSignature): slow, and their text would land in the commit messages.
  const out = await git(['log', '--no-show-signature', `-n${count}`, `--format=${COMMIT_FORMAT}`, 'HEAD', '--'], root);
  return out.toString('utf8').split('\x1e').slice(1).map(parseCommit);
}

/** Files that a commit changed against `parent` (its first parent; none for the first commit of a repository). */
export async function commitChanges(root: string, commit: string, parent: string | undefined): Promise<PathChange[]> {
  // GitHub compares a commit with its first parent, the one the views pass.
  if (revisions) return (await revisions.commitChanges(root, commit)).map(f => pathChange(root, f));
  const args = ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-commit-id', ...(parent ? [parent, commit] : ['--root', commit]), '--'];
  return parseNameStatus((await git(args, root)).toString('utf8')).map(f => pathChange(root, f));
}

/**
 * Contents of several `<commit>:<path>` blobs read by one git process (a commit with a hundred files would
 * otherwise start two hundred); undefined for one that does not exist.
 */
export async function readBlobs(root: string, specs: string[]): Promise<(Buffer | undefined)[]> {
  if (specs.length === 0) return [];
  // In the browser, the `<commit>:<path>` specs of fileLog's blobs.
  if (revisions) {
    const source = revisions;
    return Promise.all(specs.map(async spec => {
      const at = spec.indexOf(':');
      const bytes = at > 0 ? await source.read(root, spec.slice(at + 1), spec.slice(0, at)) : undefined;
      return bytes && Buffer.from(bytes);
    }));
  }
  const out = await gitWithInput(['cat-file', '--batch'], root, specs.join('\n') + '\n');
  // Per object: `<id> <type> <size>\n<content>\n`, or `<name> missing\n`.
  const result: (Buffer | undefined)[] = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('git cat-file: the output ended early');
    const header = out.toString('utf8', pos, nl);
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header);
    if (!m) {
      result.push(undefined);
      continue;
    }
    const size = Number(m[2]);
    result.push(m[1] === 'blob' ? out.subarray(pos, pos + size) : undefined);
    pos += size + 1;
  }
  return result;
}

/** The commits of HEAD that changed a file (repository-relative path), newest first (see fileLogArgs). */
export async function fileLog(root: string, relPath: string): Promise<FileLogEntry[]> {
  if (revisions) return revisions.fileLog(root, relPath);
  return parseFileLog((await git(fileLogArgs(relPath), root)).toString('utf8'));
}

/** The first parent of a commit; undefined for the first commit of a repository. */
export async function firstParent(root: string, sha: string): Promise<string | undefined> {
  if (revisions) return revisions.firstParent(root, sha);
  try {
    return (await git(['rev-parse', '--verify', '--quiet', `${sha}^1`], root)).toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The commit of each blamed line (1-based line numbers), and the commits. */
export interface BlameResult {
  lines: Map<number, string>;
  commits: Map<string, BlameCommit>;
}

/** `git blame` of line ranges of a file as it is in a commit, at its repository-relative path there (see blameArgs). */
export async function blameLines(root: string, commit: string, relPath: string, ranges: [number, number][]): Promise<BlameResult> {
  if (revisions) return revisions.blame(root, commit, relPath, ranges);
  return parseBlame((await git(blameArgs(commit, relPath, ranges), root)).toString('utf8'));
}

/**
 * Repository-relative path in a commit of the file now at `fsPath`: its own, another one when it was moved
 * since (not committed yet), or undefined for a file that is not in that commit.
 */
export async function pathAt(root: string, fsPath: string, ref: string): Promise<string | undefined> {
  if (revisions) {
    const rel = path.relative(root, fsPath).split(path.sep).join('/');
    const commit = ref === 'HEAD' ? await revisions.head(root) : ref;
    return (await revisions.read(root, rel, commit)) ? rel : undefined;
  }
  if (await existsAt(fsPath, ref)) return path.relative(root, fsPath).split(path.sep).join('/');
  return originalPath(fsPath, ref, false);
}

/** Commits of HEAD that no remote-tracking branch has (not pushed yet). */
export async function localOnlyCommits(root: string): Promise<Set<string>> {
  // In the browser every commit is on GitHub.
  if (revisions) return new Set();
  try {
    const out = await git(['rev-list', '-n500', 'HEAD', '--not', '--remotes'], root);
    return new Set(out.toString('utf8').split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** The configured user.email of a repository ('' when none). */
export async function userEmail(root: string): Promise<string> {
  if (revisions) return '';
  try {
    return (await git(['config', 'user.email'], root)).toString('utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Watches HEAD, the index and the refs of the repositories of the files it is given and fires, debounced,
 * after a commit, checkout, stage or rebase.
 */
export class GitDirWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly probedDirs = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  async watch(fsPath: string): Promise<void> {
    const cwd = folderOf(fsPath);
    const probe = fileKey(cwd);
    if (this.probedDirs.has(probe)) return;
    this.probedDirs.add(probe);
    let dirs: string[];
    try {
      const out = (await git(['rev-parse', '--absolute-git-dir', '--git-common-dir'], cwd)).toString('utf8');
      dirs = out.split(/\r?\n/).filter(Boolean).map(d => path.resolve(cwd, d));
    } catch {
      this.probedDirs.delete(probe);
      return;
    }
    for (const dir of new Set(dirs)) {
      const key = fileKey(dir);
      if (this.watchers.has(key)) continue;
      // Node's watcher, not a VS Code FileSystemWatcher: a VS Code watcher rooted in .git stopped the
      // workspace watcher from reporting changes of the source files (tabs no longer reloaded).
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, name) => {
          const n = String(name ?? '').replace(/\\/g, '/');
          if (/^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|index|packed-refs|COMMIT_EDITMSG|refs\/)/.test(n)) this.changed();
        });
      } catch {
        continue;
      }
      watcher.on('error', () => watcher.close());
      this.watchers.set(key, new vscode.Disposable(() => watcher.close()));
    }
  }

  /** A repository changed (debounced): what the watcher reports, and what is done here (a stage), which it may miss. */
  changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 300);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watchers.forEach(w => w.dispose());
    this.watchers.clear();
    this.emitter.dispose();
  }
}

export class DiffFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  /** Incremented when a repository changes (commit, checkout, stage) so the ref sides are re-read. */
  private refVersion = 1;
  private readonly served = new Map<string, vscode.Uri>();
  /** Path at the ref of a renamed file, per served URI and ref version. */
  private readonly origCache = new Map<string, { version: number; orig: string | undefined }>();
  private readonly subscription: vscode.Disposable;

  /** `gitDirs` reports commits, checkouts and stages, after which the ref sides are re-read. */
  constructor(private readonly gitDirs: GitDirWatcher) {
    this.subscription = gitDirs.onDidChange(() => this.notifyRefsChanged());
  }

  dispose(): void {
    this.subscription.dispose();
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
    if (ref.ref === EMPTY) return new Uint8Array();
    this.served.set(uri.toString(), uri);
    if (ref.ref === WORKTREE) {
      try {
        return fs.readFileSync(ref.fsPath);
      } catch {
        return new Uint8Array();
      }
    }
    void this.gitDirs.watch(ref.fsPath);
    // A commit's file comes with its path there.
    if (ref.at) return showAtRef(ref.fsPath, ref.ref, ref.at);
    // Resolved at every read, so a rename committed later still shows the right file.
    const version = this.refVersion;
    const cached = this.origCache.get(uri.toString());
    let orig = cached?.version === version ? cached.orig : undefined;
    if (cached?.version !== version) {
      orig = await originalPath(ref.fsPath, ref.ref, ref.against === INDEX);
      // Labelled with the version it was looked up at: when the refs changed meanwhile, the next read looks again.
      this.origCache.set(uri.toString(), { version, orig });
    }
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
    // A side at a commit never changes.
    const events = [...this.served.values()]
      .filter(u => {
        const ref = parseDiffUri(u)?.ref;
        return ref !== undefined && ref !== WORKTREE && !isFullSha(ref);
      })
      .map(uri => ({ type: vscode.FileChangeType.Changed, uri }));
    if (events.length) this.emitter.fire(events);
  }
}

/** A commit named by its full SHA (not a branch or HEAD, which can move). */
function isFullSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function refLabel(ref: string): string {
  if (ref === INDEX) return 'Index';
  return isFullSha(ref) ? ref.slice(0, 7) : ref;
}

/**
 * A file (repository-relative path) as a commit has it, or an empty file when `ref` is undefined (not there).
 * The git extension's URI when it has the repository open (a git document, as VS Code's own diffs and GitLens
 * know it), else this extension's: the git extension's URIs of a repository it has not opened do not resolve.
 */
export async function revision(root: string, rel: string, ref: string | undefined): Promise<vscode.Uri> {
  const fsPath = path.join(root, rel);
  const label = `${path.posix.basename(rel)} (${ref ? ref.slice(0, 7) : 'empty'})`;
  if (!ref) return revisionUri(fsPath, EMPTY, label, rel);
  const api = await gitApi();
  const file = vscode.Uri.file(fsPath);
  return api?.getRepository(file) ? api.toGitUri(file, ref) : revisionUri(fsPath, ref, label, rel);
}

/**
 * Opens a notebook diff of a TwinCAT source file: `ref` on the left, working tree (or `right`) on the right.
 * `paths` gives the repository-relative paths of the file at both refs when they are known (a commit and
 * its parent), instead of looking renames up against the working tree.
 */
export async function openNotebookDiff(fsPath: string, ref: string, right: string = WORKTREE, paths?: { left: string; right: string }): Promise<void> {
  if (!(await canReadRevisions(fsPath))) return;
  const base = path.basename(fsPath);
  const orig = paths ? (paths.left !== paths.right ? paths.left : undefined) : await originalPath(fsPath, ref, right === INDEX);
  const leftName = orig ? path.posix.basename(orig) : base;
  const left = diffUri(fsPath, ref, `${leftName} (${refLabel(ref)})`, right, paths?.left);
  const rightUri = diffUri(fsPath, right, right === WORKTREE ? base : `${base} (${refLabel(right)})`, undefined, paths?.right);
  const title = `${orig ? `${leftName} → ` : ''}${base} (${refLabel(ref)} ↔ ${right === WORKTREE ? 'Working Tree' : refLabel(right)})`;
  await vscode.commands.executeCommand('vscode.diff', left, rightUri, title, { preview: true });
}

/** The git extension's API; undefined when that extension is disabled or unavailable. */
export async function gitApi(): Promise<GitApi | undefined> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
    if (!ext) return undefined;
    return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  } catch {
    return undefined;
  }
}

/** Calls `onChange` (debounced) whenever a repository known to the built-in git extension changes. */
export async function watchRepositories(onChange: () => void): Promise<vscode.Disposable> {
  const disposables: vscode.Disposable[] = [];
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  };
  // Without the git extension the comparisons refresh when reopened.
  const api = await gitApi();
  if (api) {
    // Fire only when the commit or branch changes: state.onDidChange runs after every git status.
    const hook = (repo: GitRepository) => {
      let last = `${repo.state.HEAD?.name ?? ''}@${repo.state.HEAD?.commit ?? ''}`;
      disposables.push(repo.state.onDidChange(() => {
        const now = `${repo.state.HEAD?.name ?? ''}@${repo.state.HEAD?.commit ?? ''}`;
        if (now !== last) {
          last = now;
          fire();
        }
      }));
    };
    api.repositories.forEach(hook);
    disposables.push(api.onDidOpenRepository(hook));
  }
  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    disposables.forEach(d => d.dispose());
  });
}

interface GitRepository {
  state: { onDidChange: vscode.Event<void>; HEAD?: { name?: string; commit?: string } };
}

/** The parts of the git extension's API used here. */
export interface GitApi {
  /** The git program the extension runs: the one it found, or the `git.path` setting. */
  git: { path: string };
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  /** The repository the git extension has open for a file, or null (its git URIs of the file do not resolve). */
  getRepository(uri: vscode.Uri): unknown;
}

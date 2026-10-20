// Stage and Unstage per object, as VS Code's Source Control stages files and lines: the index's version of a
// TwinCAT file takes one object view from the working tree (stage) or from HEAD (unstage) and keeps every other
// byte; Discard Changes gives the working file one object view back as the index has it. Also the same for whole
// files. Git runs through the function the caller passes (the extension's git, or the tests'), so this needs no
// VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import { Accessor } from './objectText';
import { takeView } from './splice';
import { encodeText, parseTcFile } from './tcfile';

/** Runs git in `cwd`, with `input` on its standard input; resolves with its output, rejects with its error message. */
export type RunGit = (args: string[], cwd: string, input?: string | Buffer) => Promise<Buffer>;

/** An entry of the index (`git ls-files -s`): stage 0, or 1 to 3 for the sides of a merge conflict. */
export interface IndexEntry {
  mode: string;
  blob: string;
  stage: number;
  /** Repository-relative path, as the index spells it. */
  path: string;
}

/** The entries of `git ls-files -s -z` output: `<mode> <blob> <stage>\t<path>`, NUL-terminated. */
export function parseIndexEntries(out: string): IndexEntry[] {
  return out.split('\0').flatMap(line => {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(line);
    return m ? [{ mode: m[1], blob: m[2], stage: Number(m[3]), path: m[4] }] : [];
  });
}

/** Repository-relative path of a file, with forward slashes. */
export function repoPath(root: string, fsPath: string): string {
  return path.relative(root, fsPath).split(path.sep).join('/');
}

/** The index entry of a file; undefined when the index does not have it. A file with a merge conflict is refused. */
export async function indexEntry(git: RunGit, root: string, fsPath: string): Promise<IndexEntry | undefined> {
  const rel = repoPath(root, fsPath);
  const all = parseIndexEntries((await git(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', rel], root)).toString('utf8'));
  const exact = all.filter(e => e.path === rel);
  const entries = exact.length ? exact : all.filter(e => e.path.toLowerCase() === rel.toLowerCase());
  if (entries.some(e => e.stage !== 0)) throw new Error(`${path.basename(fsPath)} has a merge conflict: resolve it first`);
  return entries[0];
}

/** The index entry of a file the operation needs there (a new file is staged whole, see stageFiles). */
async function requireEntry(git: RunGit, root: string, fsPath: string): Promise<IndexEntry> {
  const entry = await indexEntry(git, root, fsPath);
  if (!entry) throw new Error(`${path.basename(fsPath)} is not in the index: it is staged as a whole file`);
  return entry;
}

/** Runs a git command that writes the index again, a few times, while another git holds the index's lock. */
async function writingIndex(git: RunGit, args: string[], root: string, input?: string | Buffer): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await git(args, root, input);
    } catch (e) {
      if (attempt === 3 || !/index\.lock/.test((e as Error).message)) throw e;
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

/**
 * The index's version of a file as a checkout writes it (`git cat-file --filters`: the eol and smudge conversions
 * of .gitattributes), to be written back through the clean conversions (`filtered`). When these do not give back
 * the same blob (a file committed with CRLF before a `text eol=lf` attribute), the blob as stored, written back as
 * it is: either way the line endings of the rest of the file stay.
 */
async function readIndexVersion(git: RunGit, root: string, entry: IndexEntry): Promise<{ bytes: Buffer; filtered: boolean }> {
  const checkedOut = await git(['cat-file', '--filters', `--path=${entry.path}`, entry.blob], root);
  const again = (await git(['hash-object', '--stdin', `--path=${entry.path}`], root, checkedOut)).toString('utf8').trim();
  if (again === entry.blob) return { bytes: checkedOut, filtered: true };
  return { bytes: await git(['cat-file', 'blob', entry.blob], root), filtered: false };
}

/** Puts new content for a file in the index (`git hash-object -w` and `git update-index --cacheinfo`). */
async function writeIndexVersion(git: RunGit, root: string, entry: IndexEntry, bytes: Uint8Array, filtered: boolean): Promise<void> {
  const args = ['hash-object', '-w', '--stdin', ...(filtered ? [`--path=${entry.path}`] : [])];
  const blob = (await git(args, root, Buffer.from(bytes))).toString('utf8').trim();
  if (blob !== entry.blob) await writingIndex(git, ['update-index', '--cacheinfo', `${entry.mode},${blob},${entry.path}`], root);
}

/** The index's version of a file with one object view taken from another version (`from`). */
async function takeIntoIndex(git: RunGit, root: string, entry: IndexEntry, fsPath: string, from: Buffer, objectId: string,
  accessor: Accessor | undefined): Promise<void> {
  const index = await readIndexVersion(git, root, entry);
  const into = parseTcFile(fsPath, index.bytes);
  const text = takeView(into, parseTcFile(fsPath, from), objectId, accessor);
  if (text !== into.text) await writeIndexVersion(git, root, entry, encodeText(text, into.bom), index.filtered);
}

/**
 * Stage Changes of one object view: the index's version of the file gets it as the working tree has it (its code
 * and name, or the whole member when it is new or deleted, see takeView). The file is in the index and in the
 * working tree.
 */
export async function stageView(git: RunGit, root: string, fsPath: string, objectId: string, accessor?: Accessor): Promise<void> {
  const entry = await requireEntry(git, root, fsPath);
  await takeIntoIndex(git, root, entry, fsPath, fs.readFileSync(fsPath), objectId, accessor);
}

/** Unstage Changes of one object view: the index's version of the file gets it back as HEAD has it. */
export async function unstageView(git: RunGit, root: string, fsPath: string, objectId: string, accessor?: Accessor): Promise<void> {
  const entry = await requireEntry(git, root, fsPath);
  let head: Buffer;
  try {
    head = await git(['cat-file', 'blob', `HEAD:${entry.path}`], root);
  } catch {
    throw new Error(`${path.basename(fsPath)} is not in HEAD: it is unstaged as a whole file`);
  }
  await takeIntoIndex(git, root, entry, fsPath, head, objectId, accessor);
}

/** Discard Changes of one object view: the working file gets it back as the index has it. */
export async function discardView(git: RunGit, root: string, fsPath: string, objectId: string, accessor?: Accessor): Promise<void> {
  const entry = await requireEntry(git, root, fsPath);
  const index = parseTcFile(fsPath, await git(['cat-file', 'blob', entry.blob], root));
  const working = parseTcFile(fsPath, fs.readFileSync(fsPath));
  const text = takeView(working, index, objectId, accessor);
  if (text !== working.text) fs.writeFileSync(fsPath, encodeText(text, working.bom));
}

/** Arguments of git commands that read their paths from the standard input (literal paths, NUL-separated). */
const PATHS_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

/** A whole file to stage: its repository-relative path, and whether the working tree has it no more. */
export interface FileToStage {
  path: string;
  deleted?: boolean;
}

/** Stages whole files: `git add`, and `git rm --cached` for those deleted from the working tree. */
export async function stageFiles(git: RunGit, root: string, files: FileToStage[]): Promise<void> {
  const added = files.filter(f => !f.deleted).map(f => f.path);
  const deleted = files.filter(f => f.deleted).map(f => f.path);
  if (added.length) await writingIndex(git, ['--literal-pathspecs', 'add', ...PATHS_FROM_STDIN], root, added.join('\0'));
  if (deleted.length) {
    await writingIndex(git, ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', ...PATHS_FROM_STDIN], root, deleted.join('\0'));
  }
}

/** Unstages whole files (repository-relative paths): back to HEAD's version in the index, or out of it when HEAD has none. */
export async function unstageFiles(git: RunGit, root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await writingIndex(git, ['--literal-pathspecs', 'restore', '--staged', ...PATHS_FROM_STDIN], root, paths.join('\0'));
}

/** Discards the changes of whole files (repository-relative paths): the working tree gets the index's version back. */
export async function discardFiles(git: RunGit, root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await writingIndex(git, ['--literal-pathspecs', 'restore', '--worktree', ...PATHS_FROM_STDIN], root, paths.join('\0'));
}

// Parsers of git output: commits (`git log`), changed files (`--name-status -z`), the object history
// (`git log --follow --raw -z` of one file) and the line blame (`git blame --porcelain`).

export interface CommitInfo {
  sha: string;
  /** Parent commits; the first one is what the commit's changes are shown against. */
  parents: string[];
  author: string;
  email: string;
  /** Author date, seconds since 1970. */
  date: number;
  subject: string;
  body: string;
}

/** `--format` of a commit that parseCommit reads: a record separator, then the fields. */
export const COMMIT_FORMAT = '%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b';

/** The fields of one commit of COMMIT_FORMAT (the text after its record separator). */
export function parseCommit(fields: string): CommitInfo {
  const [sha, parents, author, email, date, subject, body] = fields.split('\x1f');
  return { sha, parents: parents ? parents.split(' ') : [], author, email, date: Number(date), subject, body: (body ?? '').trim() };
}

/** A file of `--name-status -z` output (git diff, diff-index, diff-tree). */
export interface NameStatus {
  /** Changed, added, deleted or renamed: a copy counts as added, a type change or conflict as changed. */
  status: 'M' | 'A' | 'D' | 'R';
  /** Repository-relative path; the new one of a rename or copy. */
  path: string;
  /** Repository-relative path a renamed file came from. */
  from?: string;
}

/** The files of `--name-status -z` output: a status, then one path, or two for a rename or copy. */
export function parseNameStatus(out: string): NameStatus[] {
  const tokens = out.split('\0');
  const files: NameStatus[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      files.push(status === 'R' ? { status: 'R', path: tokens[i + 2], from: tokens[i + 1] } : { status: 'A', path: tokens[i + 2] });
      i += 3;
    } else {
      files.push({ status: status === 'A' || status === 'D' ? status : 'M', path: tokens[i + 1] });
      i += 2;
    }
  }
  return files;
}

/**
 * Arguments of `git log` for the commits of HEAD that changed a file (repository-relative path), newest first,
 * followed through renames, with the file's blobs before and after each commit (parseFileLog reads them).
 * Merge commits are not listed: with --follow git shows them only when asked for their diffs, and their
 * changes come with the merged commits.
 */
export function fileLogArgs(relPath: string): string[] {
  return ['--literal-pathspecs', 'log', '--follow', '-M', '--raw', '--no-abbrev', '-z',
    `--format=${COMMIT_FORMAT}`, 'HEAD', '--', relPath];
}

/**
 * Arguments of `git blame` of line ranges (1-based, inclusive) of a file as it is in a commit (repository-relative
 * path there); parseBlame reads the output.
 */
export function blameArgs(commit: string, relPath: string, ranges: [number, number][]): string[] {
  const args = ['--literal-pathspecs', 'blame', '--porcelain'];
  for (const [start, end] of ranges) args.push('-L', `${start},${end}`);
  args.push(commit, '--', relPath);
  return args;
}

/** One commit of a file's history, and what it did to the file. */
export interface FileLogEntry {
  commit: CommitInfo;
  /**
   * Added, changed, deleted, renamed (moved), or copied: created from another file that stays (`git log
   * --follow` looks for copies too), whose blob and path are then the old ones.
   */
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  /** The file's blob before and after the commit; undefined on the side where it does not exist. */
  oldBlob?: string;
  newBlob?: string;
  /** Repository-relative path of the file before and after the commit (they differ for a rename or copy). */
  oldPath: string;
  newPath: string;
}

const NO_BLOB = /^0+$/;

/** The file's version before a commit of its history: none for a copy (its old blob is the file copied). */
export function blobBefore(e: FileLogEntry): string | undefined {
  return e.status === 'C' ? undefined : e.oldBlob;
}

/**
 * Entries of `git log --follow --raw --no-abbrev -z --format=<COMMIT_FORMAT> -- <file>`, newest first.
 * Each record is the commit's fields, a NUL, then the raw line `:<modes> <old blob> <new blob> <status>` and
 * the path (two paths for a rename), NUL-separated.
 */
export function parseFileLog(out: string): FileLogEntry[] {
  const entries: FileLogEntry[] = [];
  for (const record of out.split('\x1e')) {
    const headerEnd = record.indexOf('\0');
    if (headerEnd < 0) continue;
    const commit = parseCommit(record.slice(0, headerEnd));
    if (!commit.sha) continue;
    const tokens = record.slice(headerEnd + 1).split('\0').map(t => t.replace(/^\n+/, ''));
    const raw = tokens.findIndex(t => t.startsWith(':'));
    if (raw < 0) continue;
    // :<old mode> <new mode> <old blob> <new blob> <status letter><score>
    const fields = tokens[raw].slice(1).split(' ');
    const first = tokens[raw + 1];
    if (fields.length < 5 || !first) continue;
    const letter = fields[4][0];
    const twoPaths = letter === 'R' || letter === 'C';
    entries.push({
      commit,
      status: letter === 'R' || letter === 'C' || letter === 'A' || letter === 'D' ? letter : 'M',
      oldBlob: NO_BLOB.test(fields[2]) ? undefined : fields[2],
      newBlob: NO_BLOB.test(fields[3]) ? undefined : fields[3],
      oldPath: first,
      newPath: twoPaths ? tokens[raw + 2] || first : first,
    });
  }
  return entries;
}

/** The commit git blame gives lines that are not committed yet (64 zeros in a SHA-256 repository). */
export const UNCOMMITTED = '0000000000000000000000000000000000000000';

export function isUncommitted(sha: string): boolean {
  return /^0+$/.test(sha);
}

export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  /** Author date, seconds since 1970. */
  time: number;
  summary: string;
  /** Repository-relative path of the file in that commit. */
  filename: string;
  /** The commit the line came from before (normally the parent) and the file's path there; none for a first commit. */
  previous?: { sha: string; filename: string };
}

/** Undoes git's C-style quoting of a path with special characters (`"dir/\303\244.TcPOU"`). */
export function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `git blame --porcelain`: the commit of each line of the result (1-based line numbers) and the commits. */
export function parseBlame(out: string): { lines: Map<number, string>; commits: Map<string, BlameCommit> } {
  const lines = new Map<number, string>();
  const commits = new Map<string, BlameCommit>();
  let commit: BlameCommit | undefined;
  for (const raw of out.split('\n')) {
    // The line itself, after a TAB.
    if (raw.startsWith('\t')) continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const head = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (head) {
      commit = commits.get(head[1]);
      if (!commit) {
        commit = { sha: head[1], author: '', email: '', time: 0, summary: '', filename: '' };
        commits.set(head[1], commit);
      }
      lines.set(Number(head[2]), head[1]);
      continue;
    }
    if (!commit) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    switch (key) {
      case 'author': commit.author = value; break;
      case 'author-mail': commit.email = value.replace(/^<|>$/g, ''); break;
      case 'author-time': commit.time = Number(value); break;
      case 'summary': commit.summary = value; break;
      case 'filename': commit.filename = unquotePath(value); break;
      case 'previous': {
        const sp = value.indexOf(' ');
        if (sp > 0) commit.previous = { sha: value.slice(0, sp), filename: unquotePath(value.slice(sp + 1)) };
        break;
      }
    }
  }
  return { lines, commits };
}

/** Sorted ranges with overlapping or touching ones joined. */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

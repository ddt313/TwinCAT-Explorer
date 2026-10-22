// What the extension needs to know of github.com, without its DOM: the pull request a URL is about, where its raw
// files and its diff are, the files of a git diff, which commits a "Files changed" page compares (read from the
// page's markup as text), and the review threads of its review comments. Platform-free, so the unit tests cover it.

import { ReviewThread, Side, ThreadPosition } from './comments';
import { Commits } from './params';
import { DiffStyle } from './protocol';

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  /** The page shows one commit (`<sha>`) or a range of them (`<from>..<to>`), not the whole pull request. */
  commits?: string;
}

/** The pull request of a "Files changed" page (`/o/r/pull/7/files`, `/changes`, or a commit or a range of them). */
export function filesPage(pathname: string): PullRequest | undefined {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)(?:\/|$)([0-9a-f]{7,64}(?:\.\.[0-9a-f]{7,64})?(?=\/|$))?/.exec(pathname);
  if (!m) return undefined;
  const pr: PullRequest = { owner: m[1], repo: m[2], number: Number(m[3]) };
  if (m[4]) pr.commits = m[4];
  return pr;
}

/** A file as github.com serves it with the user's session (it redirects to raw.githubusercontent.com), as a template. */
export function githubRawTemplate(pr: PullRequest): string {
  return `https://github.com/${pr.owner}/${pr.repo}/raw/{sha}/{path}`;
}

/**
 * The diff of what the page shows as github.com serves it with the session: the pull request's (merge base to head),
 * a commit's (its parent to it), or a range's (`from` is an ancestor of `to`: the comparison from their merge base is
 * the same).
 */
export function pullDiffUrl(pr: PullRequest): string {
  const repo = `https://github.com/${pr.owner}/${pr.repo}`;
  if (!pr.commits) return `${repo}/pull/${pr.number}.diff`;
  const [from, to] = pr.commits.split('..');
  return to ? `${repo}/compare/${from}...${to}.diff` : `${repo}/commit/${from}.diff`;
}

/** A page of the pull request's review comments, from the REST API (a public repository needs no token). */
export function reviewCommentsUrl(pr: PullRequest, page: number): string {
  return `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=100&page=${page}`;
}

/**
 * The review threads of a pull request's review comments (`GET …/pulls/{n}/comments`): a comment and the replies to
 * it (`in_reply_to_id`). A comment is on the diff of its `commit_id`, at `line` on its `side` (`RIGHT`: the head,
 * `LEFT`: the base); an outdated one has no `line` any more, only its `original_line` on its `original_commit_id`.
 * The REST API does not say whether a thread is resolved.
 */
export function threadsFromGithub(comments: unknown): ReviewThread[] {
  if (!Array.isArray(comments)) return [];
  const list = (comments as Record<string, unknown>[]).filter(c => c && typeof c.id === 'number');
  const threads = new Map<number, ReviewThread>();
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const note = (c: Record<string, unknown>) => ({
    id: String(c.id), author: str((c.user as Record<string, unknown> | undefined)?.login) ?? 'Someone', created: str(c.created_at) ?? '', body: str(c.body) ?? '',
  });
  const position = (c: Record<string, unknown>, line: unknown, startLine: unknown, head: unknown): ThreadPosition | undefined => {
    const path = str(c.path);
    if (!path || !str(head)) return undefined;
    const p: ThreadPosition = { newPath: path, head: str(head) };
    if (c.subject_type === 'file') return { ...p, file: true };
    const n = num(line);
    if (!n) return undefined;
    const side: Side = c.side === 'LEFT' ? 'L' : 'R';
    if (side === 'L') p.oldLine = n;
    else p.newLine = n;
    const start = num(startLine);
    if (start && start !== n) p.start = { side: c.start_side === 'LEFT' ? 'L' : c.start_side === 'RIGHT' ? 'R' : side, line: start };
    return p;
  };
  for (const c of list) {
    if (typeof c.in_reply_to_id === 'number' && list.some(x => x.id === c.in_reply_to_id)) continue;
    const current = c.line == null && c.subject_type !== 'file' ? undefined : position(c, c.line, c.start_line, c.commit_id);
    const original = position(c, c.original_line, c.original_start_line, c.original_commit_id);
    const positions = [current, original].filter((p): p is ThreadPosition => !!p);
    if (positions.length === 0) continue;
    threads.set(c.id as number, {
      id: String(c.id), anchor: `discussion_r${c.id}`, url: str(c.html_url), notes: [note(c)], positions,
    });
  }
  for (const c of list) {
    const thread = typeof c.in_reply_to_id === 'number' ? threads.get(c.in_reply_to_id) : undefined;
    if (thread && thread.id !== String(c.id)) thread.notes.push(note(c));
  }
  return [...threads.values()];
}

export interface DiffFile {
  /** Path at the head (for a deleted file: at the base). */
  path: string;
  /** Path at the base, when it differs (renamed). */
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
}

/** A path as git writes it in a diff header: in double quotes, with C escapes and octal bytes, when unusual. */
function unquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') {
      bytes.push(c.charCodeAt(0));
      continue;
    }
    const e = s[++i];
    if (/[0-7]/.test(e)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(simple[e] ?? e.charCodeAt(0));
  }
  try {
    return decodeURIComponent(bytes.map(b => `%${b.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** The files of a git diff, from the headers of each file's part (`rename from`, `new file mode`, `---`, `+++`). */
export function filesInDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  interface Part { a?: string; b?: string; from?: string; to?: string; minus?: string | null; plus?: string | null; added?: boolean; deleted?: boolean; body?: boolean }
  let part: Part | undefined;
  const side = (s: string, prefix: string) => {
    if (s === '/dev/null') return null;
    const p = unquote(s);
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  };
  const flush = () => {
    if (!part) return;
    const oldPath = part.from ?? part.minus ?? part.a;
    const path = part.deleted ? oldPath : part.to ?? part.plus ?? part.b;
    if (path) {
      const status = part.added ? 'added' : part.deleted ? 'deleted' : oldPath && oldPath !== path ? 'renamed' : 'modified';
      out.push({ path, status, ...(status === 'renamed' ? { oldPath: oldPath! } : {}) });
    }
    part = undefined;
  };
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      flush();
      part = {};
      const names = line.slice(11);
      const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(names);
      // Unquoted, the two names are only told apart when they are the same path (no rename).
      const [a, b] = quoted ? [quoted[1], quoted[2]] : [names.slice(0, (names.length - 1) / 2), names.slice((names.length + 1) / 2)];
      part.a = side(a, 'a/') ?? undefined;
      part.b = side(b, 'b/') ?? undefined;
      continue;
    }
    // The header of a file's part ends where its hunks start: a removed line can read `--- ...` too.
    if (!part || part.body) continue;
    if (line.startsWith('@@') || line.startsWith('Binary files ')) part.body = true;
    else if (line.startsWith('rename from ')) part.from = unquote(line.slice(12));
    else if (line.startsWith('rename to ')) part.to = unquote(line.slice(10));
    else if (line.startsWith('new file mode')) part.added = true;
    else if (line.startsWith('deleted file mode')) part.deleted = true;
    else if (line.startsWith('--- ')) part.minus = side(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) part.plus = side(line.slice(4), 'b/');
  }
  flush();
  return out;
}

/** The order of the files of GitHub's diff, git's: by their whole paths, as bytes (`Z` before `a`, `a.TcPOU` before `a/`). */
export function compareGithubPaths(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

const SHA = '[0-9a-f]{40}';

/**
 * The commits a "Files changed" page compares, from its markup: the URLs the classic page loads its diffs from
 * (`/diffs/<base>..<head>`, `base_commit_oid=..&end_commit_oid=..`), or the JSON of the React page, from keys that
 * name a merge base or comparison start and a head or comparison end. The base branch's own commit
 * (`baseRefOid`) is never taken for the base: the page compares with the merge base.
 */
export function commitsInPage(markup: string): Commits | undefined {
  // JSON in attributes has its quotes escaped.
  const html = markup.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const diffs = new RegExp(`/diffs/(${SHA})\\.\\.(${SHA})`).exec(html);
  if (diffs) return { base: diffs[1], head: diffs[2], source: 'page: diff URL' };
  const partial = new RegExp(`base_commit_oid=(${SHA})&end_commit_oid=(${SHA})`).exec(html);
  if (partial) return { base: partial[1], head: partial[2], source: 'page: comparison URL' };
  const keys = shaKeys(html);
  const find = (patterns: RegExp[]) => {
    for (const p of patterns) {
      for (const [key, sha] of keys) if (p.test(key)) return { key, sha };
    }
    return undefined;
  };
  const base = find([/^merge_?base(_?(commit|oid|sha))*$/i, /^(comparison_?)?start(_?(commit|oid|sha))+$/i,
    /^(full_?diff_?)?base_?(commit_?)?(oid|sha)$/i]);
  const head = find([/^(comparison_?)?end(_?(commit|oid|sha))+$/i, /^head(_?ref)?(_?(commit|oid|sha))+$/i]);
  if (base && head && base.sha !== head.sha) return { base: base.sha, head: head.sha, source: `page: ${base.key}, ${head.key}` };
  return undefined;
}

/**
 * Every `key: "<sha>"` / `key=<sha>` of a text (JSON or URLs), in order, for commitsInPage and the diagnostics. The
 * key is the identifier before the `:` or `=` (and a quote), from its first letter or underscore. Found from each
 * separator before a commit, the key read backwards: looking for a key at each word of the text took most of a
 * second on a big page's markup.
 */
export function shaKeys(text: string): [string, string][] {
  const out: [string, string][] = [];
  const re = new RegExp(`[:=]\\s*["']?(${SHA})(?![0-9a-f])`, 'g');
  // Where the last pair ended: the next key starts after it.
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let end = m.index;
    while (end > from && /\s/.test(text[end - 1])) end--;
    if (end > from && /["']/.test(text[end - 1])) end--;
    let start = end;
    while (start > from && /\w/.test(text[start - 1])) start--;
    while (start < end && !/[A-Za-z_]/.test(text[start])) start++;
    if (start === end) continue;
    out.push([text.slice(start, end), m[1]]);
    from = re.lastIndex;
  }
  return out;
}

/**
 * The layout of GitHub's diffs, as its *Layout* setting shows them: from a row of the page's diff with a line on both
 * sides, given what each of its cells holds (`L`: the base's line number, `R`: the head's, `-`: other), the two numbers
 * side by side before the code (unified) or each before its side's code (split); else the URL's `diff` (`?diff=split`).
 */
export function githubDiffStyle(search: string, cells?: readonly string[]): DiffStyle | undefined {
  const left = cells?.indexOf('L') ?? -1;
  const right = cells?.indexOf('R') ?? -1;
  if (left >= 0 && right > left) return right === left + 1 ? 'unified' : 'split';
  const diff = new URLSearchParams(search).get('diff');
  return diff === 'split' || diff === 'unified' ? diff : undefined;
}

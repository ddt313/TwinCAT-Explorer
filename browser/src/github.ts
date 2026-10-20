// What the extension needs to know of github.com, without its DOM: the pull request a URL is about, where the
// raw files are, which commits a "Files changed" page compares (read from the page's markup as text), and the
// parameters a viewer frame gets. Platform-free, so the unit tests cover it.

import { PROJECT_FILE, SOURCE_FILE } from './model';

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
}

/** The pull request of a "Files changed" page (`/o/r/pull/7/files`, `/changes`, or a commit range of them). */
export function filesPage(pathname: string): PullRequest | undefined {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)(?:\/|$)/.exec(pathname);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

/** A file the extension shows as TwinCAT objects (or, for a project file, checks for a TmcHash-only change). */
export function isTwinCatFile(path: string): boolean {
  return SOURCE_FILE.test(path) || PROJECT_FILE.test(path);
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The file as github.com serves it with the user's session (it redirects to raw.githubusercontent.com). */
export function rawUrl(pr: PullRequest, sha: string, path: string): string {
  return `https://github.com/${pr.owner}/${pr.repo}/raw/${sha}/${encodePath(path)}`;
}

/** The pull request's diff as github.com serves it with the session: what the page shows, merge base to head. */
export function pullDiffUrl(pr: PullRequest): string {
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}.diff`;
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

/** The same file through the REST API, which needs a token for a private repository. */
export function apiContentUrl(pr: PullRequest, sha: string, path: string): string {
  return `https://api.github.com/repos/${pr.owner}/${pr.repo}/contents/${encodePath(path)}?ref=${sha}`;
}

export interface Commits {
  /** The merge base the page compares with (three-dot diff) and the head. */
  base: string;
  head: string;
  /** Where they were found, for the diagnostics. */
  source: string;
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

/** Every `key: "<sha>"` / `key=<sha>` of a text (JSON or URLs), in order, for commitsInPage and the diagnostics. */
export function shaKeys(text: string): [string, string][] {
  const out: [string, string][] = [];
  const re = new RegExp(`["']?([A-Za-z_][\\w]*)["']?\\s*(?::|=)\\s*["']?(${SHA})(?![0-9a-f])`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) out.push([m[1], m[2]]);
  return out;
}

export type Theme = 'light' | 'dark' | 'auto';

/** What a viewer frame is told about its file (in its URL's fragment). */
export interface ViewerParams extends PullRequest {
  base: string;
  head: string;
  /** Path at the head (for a deleted file: at the base) and, when renamed, at the base. */
  path: string;
  oldPath?: string;
  /** The page shows the file as deleted. */
  deleted?: boolean;
  /** `diff-<sha256 of the path>`: GitHub's anchor of the file, and the prefix of its line anchors. */
  anchor: string;
  theme: Theme;
  /** Where the commits came from (diagnostics). */
  source?: string;
}

export function encodeParams(p: ViewerParams): string {
  const q = new URLSearchParams({
    o: p.owner, r: p.repo, n: String(p.number), b: p.base, h: p.head, p: p.path, a: p.anchor, t: p.theme,
  });
  if (p.oldPath && p.oldPath !== p.path) q.set('op', p.oldPath);
  if (p.deleted) q.set('d', '1');
  if (p.source) q.set('s', p.source);
  return q.toString();
}

export function decodeParams(fragment: string): ViewerParams | undefined {
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  const get = (k: string) => q.get(k) ?? '';
  const number = Number(get('n'));
  const theme = get('t');
  if (!get('o') || !get('r') || !Number.isInteger(number) || !/^[0-9a-f]{40}$/.test(get('b')) || !/^[0-9a-f]{40}$/.test(get('h')) || !get('p')) {
    return undefined;
  }
  return {
    owner: get('o'), repo: get('r'), number, base: get('b'), head: get('h'), path: get('p'),
    oldPath: q.get('op') ?? undefined, deleted: q.get('d') === '1', anchor: /^diff-[0-9a-f]{64}$/.test(get('a')) ? get('a') : '',
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto', source: q.get('s') ?? undefined,
  };
}

/** What the tree frame is told (in its URL's fragment): the pull request, its commits, the theme. */
export interface TreeParams extends PullRequest {
  base: string;
  head: string;
  theme: Theme;
  source?: string;
}

export function encodeTreeParams(p: TreeParams): string {
  const q = new URLSearchParams({ o: p.owner, r: p.repo, n: String(p.number), b: p.base, h: p.head, t: p.theme });
  if (p.source) q.set('s', p.source);
  return q.toString();
}

export function decodeTreeParams(fragment: string): TreeParams | undefined {
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  const get = (k: string) => q.get(k) ?? '';
  const number = Number(get('n'));
  if (!get('o') || !get('r') || !Number.isInteger(number) || !/^[0-9a-f]{40}$/.test(get('b')) || !/^[0-9a-f]{40}$/.test(get('h'))) return undefined;
  const theme = get('t');
  return {
    owner: get('o'), repo: get('r'), number, base: get('b'), head: get('h'),
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto', source: q.get('s') ?? undefined,
  };
}

/** A line of GitHub's diff of the file: `L` for the base side, `R` for the head side. */
export function lineAnchor(fileAnchor: string, side: 'L' | 'R', line: number): string {
  return `${fileAnchor}${side}${line}`;
}

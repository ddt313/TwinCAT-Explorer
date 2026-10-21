// What the extension needs to know of github.com, without its DOM: the pull request a URL is about, where its raw
// files and its diff are, the files of a git diff, and which commits a "Files changed" page compares (read from the
// page's markup as text). Platform-free, so the unit tests cover it.

import { Commits } from './params';

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

/** A file as github.com serves it with the user's session (it redirects to raw.githubusercontent.com), as a template. */
export function githubRawTemplate(pr: PullRequest): string {
  return `https://github.com/${pr.owner}/${pr.repo}/raw/{sha}/{path}`;
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

// What the extension needs to know of Bitbucket Cloud (bitbucket.org), without its DOM: the pull request a URL is
// about, where its raw files are, its REST API (the page's own `/!api/2.0`, which takes the session cookie, else
// api.bitbucket.org for public repositories), the files of its diffstat, the review threads of its comments, and the
// line anchors of its diffs. Platform-free, so the unit tests cover it.

import { ReviewNote, ReviewThread, Side, ThreadPosition } from './comments';
import { Theme } from './params';
import { ChangedFile } from './protocol';

export interface BitbucketRepository {
  workspace: string;
  repo: string;
}

export interface BitbucketPullRequest extends BitbucketRepository {
  id: number;
}

/** The pull request of a "Files changed" page: `/workspace/repo/pull-requests/7/diff`. */
export function pullRequestPage(pathname: string): BitbucketPullRequest | undefined {
  const m = /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)\/diff(?:\/|$)/.exec(pathname);
  return m ? { workspace: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), id: Number(m[3]) } : undefined;
}

const encodeSegments = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** A file at a commit as bitbucket.org serves it, with the session, as a template (`{sha}`, `{path}`). */
export function bitbucketRawTemplate(pr: BitbucketRepository): string {
  return `https://bitbucket.org/${encodeSegments(pr.workspace)}/${encodeSegments(pr.repo)}/raw/{sha}/{path}`;
}

/**
 * The REST API of a repository: the page's own (`https://bitbucket.org/!api/2.0`, same origin, with the session: a
 * private repository needs no token), or the public one (`https://api.bitbucket.org/2.0`, public repositories only).
 */
export function repositoryApi(apiRoot: string, pr: BitbucketRepository): string {
  return `${apiRoot}/repositories/${encodeURIComponent(pr.workspace)}/${encodeURIComponent(pr.repo)}`;
}

export const PAGE_API = 'https://bitbucket.org/!api/2.0';
export const PUBLIC_API = 'https://api.bitbucket.org/2.0';

/** A comment on the pull request's own page. */
export function commentUrl(pr: BitbucketPullRequest, commentId: string): string {
  return `https://bitbucket.org/${encodeSegments(pr.workspace)}/${encodeSegments(pr.repo)}/pull-requests/${pr.id}/diff#comment-${commentId}`;
}

/** The element id of a file's block: the extension sets it, beside Bitbucket's own `chg-<path>` marker. */
export function bitbucketBlockId(path: string): string {
  return `tcx-chg-${path}`;
}

/**
 * The line a line anchor of Bitbucket's diff names, `L<path>F<old line>T<new line>` (an unchanged line),
 * `L<path>F<old line>` (a removed one) or `L<path>T<new line>` (an added one), among the blocks' ids: the head's line
 * first.
 */
export function bitbucketLineOfAnchor(id: string, anchors: string[]): { anchor: string; side: Side; line: number } | undefined {
  for (const anchor of anchors) {
    if (!anchor.startsWith('tcx-chg-')) continue;
    const prefix = `L${anchor.slice('tcx-chg-'.length)}`;
    if (!id.startsWith(prefix)) continue;
    const m = /^(?:F(\d+))?(?:T(\d+))?$/.exec(id.slice(prefix.length));
    if (!m || (!m[1] && !m[2])) continue;
    return m[2] ? { anchor, side: 'R', line: Number(m[2]) } : { anchor, side: 'L', line: Number(m[1]) };
  }
  return undefined;
}

/** Whether a line anchor of a file (`F3T3`, `F6`, `T6` after `L<path>`) is that line on that side. */
export function isLineAnchor(id: string, path: string, side: Side, line: number): boolean {
  const prefix = `L${path}`;
  if (!id.startsWith(prefix)) return false;
  const m = /^(?:F(\d+))?(?:T(\d+))?$/.exec(id.slice(prefix.length));
  return !!m && Number(side === 'L' ? m[1] : m[2]) === line;
}

/** The files of a diffstat (`…/pullrequests/:id/diffstat`): `added`, `removed`, `modified`, `renamed`. */
export function filesFromDiffstat(list: unknown): ChangedFile[] {
  if (!Array.isArray(list)) return [];
  const out: ChangedFile[] = [];
  const pathOf = (side: unknown) => {
    const p = (side as { path?: unknown } | null | undefined)?.path;
    return typeof p === 'string' ? p : undefined;
  };
  for (const f of list as Record<string, unknown>[]) {
    if (!f || typeof f !== 'object') continue;
    const newPath = pathOf(f.new);
    const oldPath = pathOf(f.old);
    const deleted = f.status === 'removed' || !newPath;
    const path = deleted ? oldPath ?? newPath : newPath;
    if (!path) continue;
    const file: ChangedFile = { path };
    if (oldPath && oldPath !== path) file.oldPath = oldPath;
    if (f.status === 'added' || (!oldPath && newPath)) file.added = true;
    if (deleted) file.deleted = true;
    out.push(file);
  }
  return out;
}

const lineNumber = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * The review threads of a pull request's comments (`GET …/pullrequests/:id/comments`): an inline comment and the
 * replies to it (`parent`, at any depth). An inline comment is on `path`, at `from` (a line of the base file: a
 * removed or an unchanged line) or `to` (a line of the head file: an added one), on neither for the whole file; one
 * Bitbucket marks `outdated` was made on an older head. The diff is the one the page compares, from the merge base to
 * `head`: the comment has no commits of its own. A comment on the pull request itself is left out, and so are the
 * deleted ones. A thread is resolved when its first comment has a `resolution`.
 */
export function threadsFromBitbucket(comments: unknown, head: string, urlOf: (commentId: string) => string): ReviewThread[] {
  if (!Array.isArray(comments)) return [];
  const list = (comments as Record<string, unknown>[]).filter(c => c && (typeof c.id === 'number' || typeof c.id === 'string'));
  const byId = new Map(list.map(c => [String(c.id), c]));
  const rootOf = (c: Record<string, unknown>): Record<string, unknown> => {
    let at = c;
    for (let i = 0; i < 100; i++) {
      const parent = (at.parent as { id?: unknown } | undefined)?.id;
      const next = parent === undefined ? undefined : byId.get(String(parent));
      if (!next) return at;
      at = next;
    }
    return at;
  };
  const threads = new Map<string, ReviewThread>();
  const note = (c: Record<string, unknown>): ReviewNote => {
    const user = (c.user ?? {}) as Record<string, unknown>;
    return {
      id: String(c.id), author: text(user.display_name) ?? text(user.nickname) ?? 'Someone', created: text(c.created_on) ?? '',
      body: text((c.content as { raw?: unknown } | undefined)?.raw) ?? '',
    };
  };
  for (const c of list) {
    const root = rootOf(c);
    const inline = root.inline as Record<string, unknown> | undefined;
    if (!inline || typeof inline.path !== 'string') continue;
    const rootId = String(root.id);
    let thread = threads.get(rootId);
    if (!thread) {
      const from = lineNumber(inline.from);
      const to = lineNumber(inline.to);
      const position: ThreadPosition = { oldPath: inline.path, newPath: inline.path };
      if (from) position.oldLine = from;
      if (to) position.newLine = to;
      if (!from && !to) position.file = true;
      if (inline.outdated !== true) position.head = head;
      const startFrom = lineNumber(inline.start_from);
      const startTo = lineNumber(inline.start_to);
      const start = startTo ? { side: 'R' as const, line: startTo } : startFrom ? { side: 'L' as const, line: startFrom } : undefined;
      if (start && start.line !== (to ?? from)) position.start = start;
      const resolution = root.resolution as { type?: unknown } | null | undefined;
      thread = {
        id: rootId, anchor: `comment-${rootId}`, url: urlOf(rootId), notes: [],
        resolved: resolution?.type === 'comment_resolution', positions: [position],
      };
      threads.set(rootId, thread);
    }
    if (c.deleted !== true) thread.notes.push(note(c));
  }
  const out = [...threads.values()].filter(t => t.notes.length > 0);
  for (const t of out) t.notes.sort((a, b) => (a.id === t.id ? -1 : b.id === t.id ? 1 : a.created.localeCompare(b.created)));
  return out;
}

/** Bitbucket's color mode, from `<html data-color-mode>` (Atlassian's design tokens follow it). */
export function bitbucketTheme(colorMode: string | undefined): Theme {
  return colorMode === 'dark' ? 'dark' : 'light';
}

// ------------------------------------------------------------------ the repository's pages

/**
 * A page of a repository's files, `/workspace/repo/src/<ref>/<path>`: a folder or a file. The ref is one part (a branch
 * with slashes is shown at its commit, `/src/<sha>/<path>?at=feature/x`).
 */
export interface BitbucketSourcePage extends BitbucketRepository {
  ref: string;
  /** The path after the ref, decoded; empty at the top. */
  path: string;
}

export function sourcePage(pathname: string): BitbucketSourcePage | undefined {
  const m = /^\/([^/]+)\/([^/]+)\/src\/([^/]+)(?:\/(.*?))?\/?$/.exec(pathname);
  if (!m) return undefined;
  try {
    return {
      workspace: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), ref: decodeURIComponent(m[3]),
      path: (m[4] ?? '').split('/').map(decodeURIComponent).join('/'),
    };
  } catch {
    return undefined;
  }
}

/** The page of a file at a ref. */
export function sourceUrl(r: BitbucketRepository, ref: string, path: string): string {
  return `https://bitbucket.org/${encodeSegments(r.workspace)}/${encodeSegments(r.repo)}/src/${encodeURIComponent(ref)}/${encodeSegments(path)}`;
}

/** The REST API's commit of a ref (its `hash`), from a repository's API (`repositoryApi`). */
export function commitPath(ref: string): string {
  return `/commit/${encodeURIComponent(ref)}`;
}

/** The REST API's files at a commit, its folders' too, a page of 100 at a time (`next`). */
export function sourceTreePath(sha: string): string {
  return `/src/${sha}/?max_depth=100&pagelen=100`;
}

/** The files (not the folders) of a page of `src`. */
export function filesFromSrc(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap(e => {
    const x = e as Record<string, unknown>;
    return x.type === 'commit_file' && typeof x.path === 'string' ? [x.path] : [];
  });
}

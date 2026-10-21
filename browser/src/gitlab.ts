// What the extension needs to know of GitLab (gitlab.com or a self-managed instance), without its DOM: the merge
// request a URL is about, where its raw files are, its REST API (which takes the session cookie on its own origin,
// so a private project needs no token), the files and commits the API and the page's data give, the review threads
// of its discussions, and the line anchors of its diffs. Platform-free, so the unit tests cover it.

import { ReviewNote, ReviewThread, ThreadPosition } from './comments';
import { Commits, Theme } from './params';
import { ChangedFile } from './protocol';

export interface MergeRequest {
  /** `group/subgroup/project`. */
  project: string;
  iid: number;
}

/** The merge request of a GitLab page: `/group/project/-/merge_requests/7` and its tabs (`/diffs`, `/commits`, ...). */
export function mergeRequestPage(pathname: string): MergeRequest | undefined {
  const m = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(pathname);
  return m ? { project: decodeURIComponent(m[1]), iid: Number(m[2]) } : undefined;
}

/** The "Changes" tab of a merge request, where the diffs are. */
export function isChangesTab(pathname: string): boolean {
  return /\/-\/merge_requests\/\d+\/diffs(?:\/|$)/.test(pathname);
}

const encodeSegments = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** A file at a commit as GitLab serves it, as a template (`{sha}`, `{path}`). */
export function gitlabRawTemplate(origin: string, project: string): string {
  return `${origin}/${encodeSegments(project)}/-/raw/{sha}/{path}`;
}

/** The REST API of a merge request; `project` is the project's id or its full path. */
export function mergeRequestApi(origin: string, project: string | number, iid: number): string {
  return `${origin}/api/v4/projects/${encodeURIComponent(String(project))}/merge_requests/${iid}`;
}

/**
 * The Changes tab shows part of the merge request: one commit (`commit_id`), a version (`diff_id`) or a comparison of
 * versions (`start_sha`). Its files are those of the commits it compares, not the merge request's.
 */
export function isPartialView(search: string): boolean {
  const q = new URLSearchParams(search);
  return ['commit_id', 'diff_id', 'start_sha'].some(k => q.has(k));
}

/** The REST API's comparison of two commits, `base..head` (its `diffs` are the files, as the merge request's are). */
export function compareApi(origin: string, project: string | number, base: string, head: string): string {
  return `${origin}/api/v4/projects/${encodeURIComponent(String(project))}/repository/compare?from=${base}&to=${head}&straight=true`;
}

/**
 * The discussions of a merge request as its own page reads them (`discussions.json`, a page of them after `cursor`):
 * all of them (`notes_filter=0`) without saving that filter as the user's choice (`persist_filter=false`).
 */
export function discussionsUrl(origin: string, project: string, iid: number, cursor?: string): string {
  const url = `${origin}/${encodeSegments(project)}/-/merge_requests/${iid}/discussions.json?notes_filter=0&persist_filter=false&per_page=100`;
  return cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
}

/** A note on the merge request's own page (its Overview tab). */
export function noteUrl(origin: string, project: string, iid: number, noteId: string): string {
  return `${origin}/${encodeSegments(project)}/-/merge_requests/${iid}#note_${noteId}`;
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
const sha = (v: unknown) => (typeof v === 'string' && SHA_RE.test(v) ? v : undefined);
const lineNumber = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** A position of a diff note (`position_type` `text` or `file`; an image's is on no line of an XML file). */
function gitlabPosition(value: unknown): ThreadPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (p.position_type !== 'text' && p.position_type !== 'file') return undefined;
  const start = (p.line_range as { start?: Record<string, unknown> } | undefined)?.start;
  const startNew = lineNumber(start?.new_line);
  const startOld = lineNumber(start?.old_line);
  const first = startNew ? { side: 'R' as const, line: startNew } : startOld ? { side: 'L' as const, line: startOld } : undefined;
  const onLine = p.position_type === 'text';
  const position: ThreadPosition = {
    oldPath: text(p.old_path), newPath: text(p.new_path), base: sha(p.base_sha), head: sha(p.head_sha),
    oldLine: onLine ? lineNumber(p.old_line) : undefined, newLine: onLine ? lineNumber(p.new_line) : undefined, file: onLine ? undefined : true,
  };
  if (onLine && first && first.line !== (position.newLine ?? position.oldLine)) position.start = first;
  // Only what is there.
  for (const k of Object.keys(position) as (keyof ThreadPosition)[]) if (position[k] === undefined) delete position[k];
  return position.head && (position.oldPath ?? position.newPath) ? position : undefined;
}

/**
 * The review threads of a merge request's discussions: those of `discussions.json` (positions of the discussion: the
 * current one, the original one, and the ones GitLab carried to the merge ref, which the page compares when the
 * merge request can be merged) or of the REST API's `…/discussions` (the first note's position). A discussion that is
 * on no line or file of the diff (a comment on the merge request) is left out, and so are system notes.
 */
export function threadsFromGitlab(discussions: unknown, urlOf: (noteId: string) => string): ReviewThread[] {
  if (!Array.isArray(discussions)) return [];
  const out: ReviewThread[] = [];
  for (const d of discussions as Record<string, unknown>[]) {
    if (!d || typeof d !== 'object' || d.diff_discussion === false) continue;
    const raw = (Array.isArray(d.notes) ? d.notes : []) as Record<string, unknown>[];
    const notes: ReviewNote[] = raw
      .filter(n => n && n.system !== true && (typeof n.id === 'number' || typeof n.id === 'string'))
      .map(n => {
        const author = (n.author ?? {}) as Record<string, unknown>;
        return { id: String(n.id), author: text(author.name) ?? text(author.username) ?? 'Someone', created: text(n.created_at) ?? '', body: text(n.note) ?? text(n.body) ?? '' };
      });
    const first = raw[0] ?? {};
    const candidates = [d.position, d.original_position, ...(Array.isArray(d.positions) ? d.positions : []), first.position, first.original_position];
    const positions: ThreadPosition[] = [];
    for (const p of candidates.map(gitlabPosition)) if (p && !positions.some(q => JSON.stringify(q) === JSON.stringify(p))) positions.push(p);
    if (notes.length === 0 || positions.length === 0) continue;
    const resolvable = d.resolvable === true || raw.some(n => n?.resolvable === true);
    const resolved = typeof d.resolved === 'boolean' ? d.resolved : raw.filter(n => n?.resolvable === true).every(n => n.resolved === true);
    out.push({
      id: String(d.id ?? notes[0].id), anchor: `note_${notes[0].id}`, url: urlOf(notes[0].id), notes,
      resolved: resolvable ? resolved : undefined, positions,
    });
  }
  return out;
}

/** The files of `GET …/merge_requests/:iid/diffs` (GitLab 15.7+) or of the `changes` of `…/changes`. */
export function filesFromApi(list: unknown): ChangedFile[] {
  if (!Array.isArray(list)) return [];
  const out: ChangedFile[] = [];
  for (const f of list as Record<string, unknown>[]) {
    const newPath = typeof f.new_path === 'string' ? f.new_path : undefined;
    const oldPath = typeof f.old_path === 'string' ? f.old_path : undefined;
    const deleted = f.deleted_file === true;
    const path = deleted ? oldPath ?? newPath : newPath ?? oldPath;
    if (!path) continue;
    const file: ChangedFile = { path };
    if (oldPath && oldPath !== path) file.oldPath = oldPath;
    if (f.new_file === true) file.added = true;
    if (deleted) file.deleted = true;
    out.push(file);
  }
  return out;
}

/** The commits of `diff_refs` (`base_sha`, `start_sha`, `head_sha`): GitLab's diff is from the merge base to the head. */
export function commitsFromDiffRefs(refs: unknown, source: string): Commits | undefined {
  const r = refs as Record<string, unknown> | undefined;
  const base = sha(r?.base_sha) ?? sha(r?.start_sha);
  const head = sha(r?.head_sha);
  return base && head ? { base, head, source } : undefined;
}

/** A file block of the Rapid Diffs page: its `data-file-data` (paths, raw path, the commits compared). */
export function rapidFileData(json: string | undefined): { file: ChangedFile; commits?: Commits } | undefined {
  if (!json) return undefined;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const [file] = filesFromApi([data]);
  return file ? { file, commits: commitsFromDiffRefs(data.diff_refs, 'page: Rapid Diffs data') } : undefined;
}

/**
 * A line of the Rapid Diffs page, by the hash of its file (the block's id): `line_<9 characters>_<old line>` for a
 * removed or an unchanged line, `…_A<new line>` for an added one.
 */
export function rapidLineAnchor(fileHash: string, side: 'L' | 'R', line: number): string {
  return `line_${fileHash.slice(0, 9)}_${side === 'R' ? 'A' : ''}${line}`;
}

/** GitLab's color mode, from the classes of `<html>` (`gl-dark` when dark, also when it follows the system). */
export function gitlabTheme(htmlClass: string): Theme {
  return /(?:^|\s)gl-dark(?:\s|$)/.test(htmlClass) ? 'dark' : 'light';
}

// What the extension needs to know of GitLab (gitlab.com or a self-managed instance), without its DOM: the merge
// request a URL is about, where its raw files are, its REST API (which takes the session cookie on its own origin,
// so a private project needs no token), the files and commits the API and the page's data give, and the line
// anchors of its diffs. Platform-free, so the unit tests cover it.

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
  const sha = (v: unknown) => (typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v) ? v : undefined);
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
 * removed line, `…_A<new line>` for an added one.
 */
export function rapidLineAnchor(fileHash: string, side: 'L' | 'R', line: number): string {
  return `line_${fileHash.slice(0, 9)}_${side === 'R' ? 'A' : ''}${line}`;
}

/** GitLab's color mode, from the classes of `<html>` (`gl-dark` when dark, also when it follows the system). */
export function gitlabTheme(htmlClass: string): Theme {
  return /(?:^|\s)gl-dark(?:\s|$)/.test(htmlClass) ? 'dark' : 'light';
}

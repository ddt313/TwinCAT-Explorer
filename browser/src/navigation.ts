// The rule for a navigation in a review page to an anchor (a link to a comment or a line, the browser's back and
// forward, the host's own navigation that sets the location's hash): when the target is in the host's diff of a
// file whose TwinCAT view is on, that diff is hidden under the view, so the view goes off and the target shows. The
// file's block itself and its header stay in view: a link to the file keeps its view. Platform-free.

import { bitbucketLineOfAnchor } from './bitbucket';
import { ReviewThread, Side, threadsOfFile } from './comments';

/** A file of the page with a TwinCAT view: its block's id, its paths, whether its view is on. */
export interface ViewState {
  anchor: string;
  path: string;
  oldPath?: string;
  on: boolean;
}

/** Where the element the hash names is, when it is in the page: the block it is in, and whether in its diff. */
export interface Found {
  anchor: string;
  /** In the host's diff of the file (hidden by the view), not the block itself, its header or the view. */
  inDiff: boolean;
}

/** Where the TwinCAT view comes back to: the XML line or the thread the navigation went to. */
export interface Back {
  xml?: { side: Side; line: number };
  thread?: string;
}

export interface Leave {
  /** The block whose view goes off. */
  anchor: string;
  back: Back;
  /** What to show when the element is not in the page: the thread, or the line the anchor names. */
  thread?: ReviewThread;
  line?: { side: Side; line: number };
}

/** The element id a location's hash names (`#note_12` → `note_12`). */
export function anchorId(hash: string): string | undefined {
  let id = hash.replace(/^#/, '');
  try {
    id = decodeURIComponent(id);
  } catch {
    // As it is.
  }
  return id || undefined;
}

/** The note a comment's anchor names: GitLab's `note_12`, GitHub's `discussion_r12` (and `r12`), Bitbucket's `comment-12`. */
export function noteOfAnchor(id: string): string | undefined {
  return /^(?:note_|discussion_r|r|comment-)(\d+)$/.exec(id)?.[1];
}

/**
 * The file and line a line anchor names, among the blocks' ids: GitHub's `diff-<sha256 of the path>R12` (or `L`),
 * GitLab's `line_<first 9 characters of the sha1 of the path>_A12` (an added line; without `A`, a removed one) of
 * Rapid Diffs and `<sha1>_11_12` (old and new line) of the classic page, Bitbucket's `L<path>F11T12` (`F11`: a removed
 * line, `T12`: an added one); and in a file of a GitLab repository's page (`blob:<path>`, the block the element is in),
 * its line `L12`.
 */
export function lineOfAnchor(id: string, anchors: string[], within?: string): { anchor: string; side: Side; line: number } | undefined {
  const blob = /^L(\d+)$/.exec(id);
  if (blob && within?.startsWith('blob:')) return { anchor: within, side: 'R', line: Number(blob[1]) };
  let m = /^(diff-[0-9a-f]{64})([LR])(\d+)$/.exec(id);
  if (m && anchors.includes(m[1])) return { anchor: m[1], side: m[2] as Side, line: Number(m[3]) };
  m = /^line_([0-9a-f]{9})_(A?)(\d+)$/.exec(id);
  const rapid = m && anchors.find(a => /^[0-9a-f]{40}$/.test(a) && a.startsWith(m![1]));
  if (m && rapid) return { anchor: rapid, side: m[2] ? 'R' : 'L', line: Number(m[3]) };
  m = /^([0-9a-f]{40})_(\d+)_(\d+)$/.exec(id);
  if (m && anchors.includes(m[1])) return Number(m[3]) > 0 ? { anchor: m[1], side: 'R', line: Number(m[3]) } : { anchor: m[1], side: 'L', line: Number(m[2]) };
  return id.startsWith('L') ? bitbucketLineOfAnchor(id, anchors) : undefined;
}

/**
 * The view a navigation to `hash` turns off, if any. The target is the element the hash names when it is in the
 * page (`found`), else a comment of the known threads (its file is in the threads' positions), else a line anchor.
 */
export function leaveFor(hash: string, views: ViewState[], found: Found | undefined, threads: ReviewThread[]): Leave | undefined {
  const id = anchorId(hash);
  if (!id) return undefined;
  const note = noteOfAnchor(id);
  const thread = note ? threads.find(t => t.notes.some(n => n.id === note)) : undefined;
  const line = lineOfAnchor(id, views.map(v => v.anchor), found?.anchor);
  const back: Back = thread ? { thread: thread.id } : line ? { xml: { side: line.side, line: line.line } } : {};
  if (found) {
    const view = views.find(v => v.anchor === found.anchor);
    return view?.on && found.inDiff ? { anchor: view.anchor, back } : undefined;
  }
  if (thread) {
    const view = views.find(v => threadsOfFile([thread], v.path, v.oldPath).length > 0);
    return view?.on ? { anchor: view.anchor, back, thread } : undefined;
  }
  if (line) {
    const view = views.find(v => v.anchor === line.anchor);
    return view?.on ? { anchor: view.anchor, back, line: { side: line.side, line: line.line } } : undefined;
  }
  return undefined;
}

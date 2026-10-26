// Messages between the content script (on GitHub, GitLab or Bitbucket), the extension's frames inside the page (a viewer per
// file, the tree) and the service worker.

import { Accessor } from '../../src/core/objectText';
import { ReviewThread, Side } from './comments';

/** A file of a pull or merge request as the extension needs it. */
export interface ChangedFile {
  /** Path at the head (for a deleted file: at the base) and, when renamed, at the base. */
  path: string;
  oldPath?: string;
  added?: boolean;
  deleted?: boolean;
}

/** A diff with the base's and the head's lines one under the other (unified), or side by side (split). */
export type DiffStyle = 'unified' | 'split';

/** A place in a viewer: an object view, the section line on an XML line, a thread. */
export interface Reveal {
  objectId?: string;
  accessor?: Accessor;
  xml?: { side: Side; line: number };
  thread?: string;
}

/** A frame to the content script, with `window.parent.postMessage`. */
export type FrameMessage =
  | { tcx: 'ready' }
  /** A viewer's height: the page sizes the frame to it. */
  | { tcx: 'height'; height: number }
  /**
   * Show the host's own diff of the file at this line of the XML: `L` on the base side, `R` on the head side; for an
   * unchanged line, also its line at the base (`oldLine`), which the host may know it by instead (GitLab's Rapid Diffs).
   */
  | { tcx: 'goto'; side: Side; line: number; oldLine?: number }
  /** Show this thread in the host's own diff (else the line it is on). */
  | { tcx: 'thread'; id: string; side?: Side; line?: number; oldLine?: number }
  /** Fetch this URL from the page (same origin as the host, with the user's session). */
  | { tcx: 'fetch'; id: number; url: string }
  /** From the tree: show this file's TwinCAT view, at this object view. */
  | { tcx: 'reveal'; path: string; objectId?: string; accessor?: Accessor }
  /** From a viewer: scroll the page so that this offset of the frame shows. */
  | { tcx: 'scroll'; top: number };

/** The content script to a frame. */
export type PageMessage =
  | { tcx: 'fetched'; id: number; result: FetchResult }
  /** To the tree: the change's files, `complete` when the host's API gave them (else the page's list). */
  | { tcx: 'files'; files: ChangedFile[]; complete: boolean }
  /** To a viewer: open this place and say where it is. */
  | ({ tcx: 'reveal' } & Reveal)
  /** To a viewer: the layout of the host's own diffs, as the user set it there (when the page shows it, and as it changes). */
  | { tcx: 'style'; style: DiffStyle }
  /** To a viewer, the threads on its file; to the tree, all of them; or why there are none. */
  | { tcx: 'threads'; threads: ReviewThread[]; source?: string; problem?: string };

/** A frame to the service worker, with `chrome.runtime.sendMessage`. */
export type WorkerRequest = { tcx: 'fetch'; url: string };

export interface FetchResult {
  ok: boolean;
  status: number;
  /** URL of the response, after redirects. */
  url?: string;
  contentType?: string;
  /** Body as UTF-8 text, without a BOM. */
  text?: string;
  error?: string;
}

/** GitHub's, gitlab.com's and Bitbucket's hosts: pages, raw files, diffs, API. */
const BUILT_IN_HOSTS = ['github.com', 'raw.githubusercontent.com', 'patch-diff.githubusercontent.com', 'api.github.com', 'gitlab.com', 'bitbucket.org', 'api.bitbucket.org'];

/** Only these are fetched for a frame: the built-in hosts over HTTPS, and the sites the user turned the extension on for. */
export function fetchAllowed(url: string, sites: readonly string[] = []): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' && BUILT_IN_HOSTS.includes(u.hostname)) || sites.includes(u.origin);
  } catch {
    return false;
  }
}

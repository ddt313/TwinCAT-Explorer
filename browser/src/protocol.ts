// Messages between the content script (on GitHub or GitLab), the extension's frames inside the page (a viewer per
// file, the tree) and the service worker.

import { Accessor } from '../../src/core/objectText';

/** A file of a pull or merge request as the extension needs it. */
export interface ChangedFile {
  /** Path at the head (for a deleted file: at the base) and, when renamed, at the base. */
  path: string;
  oldPath?: string;
  added?: boolean;
  deleted?: boolean;
}

/** A frame to the content script, with `window.parent.postMessage`. */
export type FrameMessage =
  | { tcx: 'ready' }
  /** A viewer's height: the page sizes the frame to it. */
  | { tcx: 'height'; height: number }
  /** Show the host's own diff of the file at this line of the XML: `L` on the base side, `R` on the head side. */
  | { tcx: 'goto'; side: 'L' | 'R'; line: number }
  /** Fetch this URL from the page (same origin as the host, with the user's session). */
  | { tcx: 'fetch'; id: number; url: string }
  /** From the tree: show this file's TwinCAT view, at this object view. */
  | { tcx: 'reveal'; path: string; objectId?: string; accessor?: Accessor }
  /** From a viewer: scroll the page so that this offset of the frame shows. */
  | { tcx: 'scroll'; top: number };

/** The content script to a frame. */
export type PageMessage =
  | { tcx: 'fetched'; id: number; result: FetchResult }
  /** To the tree: the change's TwinCAT files, `complete` when the host's API gave them (else the page's list). */
  | { tcx: 'files'; files: ChangedFile[]; complete: boolean }
  /** To a viewer: open this object view and say where it is. */
  | { tcx: 'reveal'; objectId: string; accessor?: Accessor };

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

/** GitHub's and gitlab.com's hosts: pages, raw files, diffs, API. */
const BUILT_IN_HOSTS = ['github.com', 'raw.githubusercontent.com', 'patch-diff.githubusercontent.com', 'api.github.com', 'gitlab.com'];

/** Only these are fetched for a frame: the built-in hosts over HTTPS, and the sites the user turned the extension on for. */
export function fetchAllowed(url: string, sites: readonly string[] = []): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' && BUILT_IN_HOSTS.includes(u.hostname)) || sites.includes(u.origin);
  } catch {
    return false;
  }
}

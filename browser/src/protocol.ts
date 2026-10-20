// Messages between the content script (on github.com), the extension's frames inside the GitHub page (a viewer
// per file, the tree) and the service worker.

import { Accessor } from '../../src/core/objectText';

/** A frame to the content script, with `window.parent.postMessage`. */
export type FrameMessage =
  | { tcx: 'ready' }
  /** A viewer's height: the page sizes the frame to it. */
  | { tcx: 'height'; height: number }
  /** Show GitHub's own diff of the file at this line anchor (`diff-<hash>R12`). */
  | { tcx: 'goto'; anchor: string }
  /** Fetch this URL from the page (same origin as github.com, with the user's session). */
  | { tcx: 'fetch'; id: number; url: string }
  /** From the tree: show this file's TwinCAT view, at this object view. */
  | { tcx: 'reveal'; anchor: string; objectId?: string; accessor?: Accessor }
  /** From a viewer: scroll the page so that this offset of the frame shows. */
  | { tcx: 'scroll'; top: number };

/** A file of the pull request as the page knows it (the tree's list when the pull request's diff cannot be read). */
export interface PageFile {
  path: string;
  oldPath?: string;
  anchor: string;
  deleted?: boolean;
}

/** The content script to a frame. */
export type PageMessage =
  | { tcx: 'fetched'; id: number; result: FetchResult }
  /** To the tree: the TwinCAT files the page shows. */
  | { tcx: 'files'; files: PageFile[] }
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

/** Only these hosts are fetched for a frame: GitHub's pages, raw files, diffs and API. */
export function fetchAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:'
      && ['github.com', 'raw.githubusercontent.com', 'patch-diff.githubusercontent.com', 'api.github.com'].includes(u.hostname);
  } catch {
    return false;
  }
}

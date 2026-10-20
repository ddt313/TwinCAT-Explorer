// Messages between the content script (on github.com), the viewer frames (extension pages inside the GitHub
// page) and the service worker.

/** A viewer frame to the content script, with `window.parent.postMessage`. */
export type FrameMessage =
  | { tcx: 'ready' }
  | { tcx: 'height'; height: number }
  /** Show GitHub's own diff of the file at this line anchor (`diff-<hash>R12`). */
  | { tcx: 'goto'; anchor: string }
  /** Fetch this URL from the page (same origin as github.com, with the user's session). */
  | { tcx: 'fetch'; id: number; url: string };

/** The content script to a viewer frame. */
export type PageMessage = { tcx: 'fetched'; id: number; result: FetchResult };

/** A viewer frame to the service worker, with `chrome.runtime.sendMessage`. */
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

/** Only these hosts are fetched for a frame: GitHub's pages, raw files and API. */
export function fetchAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['github.com', 'raw.githubusercontent.com', 'api.github.com'].includes(u.hostname);
  } catch {
    return false;
  }
}

// The files read at a commit, kept in the extension's Cache Storage: a file at a commit never changes, so a view or
// the tree that reads it again (another file of a repository's pages, the same page loaded again, the tree after the
// view) has it at once instead of asking the host. Only a URL that names its commit (a sha) is kept; at most `LIMIT`
// files, the oldest going first. Without Cache Storage (a frame that has none), every file is read from the host.

import { namesCommit } from './params';

const CACHE = 'tcx-files-v1';
const LIMIT = 3000;

function open(): Promise<Cache> | undefined {
  try {
    return typeof caches === 'undefined' ? undefined : caches.open(CACHE);
  } catch {
    return undefined;
  }
}

/** A file's text read before, when it was. */
export async function cachedText(url: string): Promise<string | undefined> {
  if (!namesCommit(url)) return undefined;
  try {
    const hit = await (await open())?.match(url);
    return hit ? await hit.text() : undefined;
  } catch {
    return undefined;
  }
}

let writes = 0;

/** Keeps a file's text; now and then, the oldest go beyond the limit. */
export async function keepText(url: string, text: string): Promise<void> {
  if (!namesCommit(url)) return;
  try {
    const cache = await open();
    if (!cache) return;
    await cache.put(url, new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    if (++writes % 100 !== 1) return;
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - LIMIT)).map(k => cache.delete(k)));
  } catch {
    // Not kept: read from the host next time.
  }
}

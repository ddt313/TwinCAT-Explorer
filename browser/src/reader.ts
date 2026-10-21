// Reading a file of the pull or merge request in a frame (a viewer or the tree): the ways tried in turn, in the
// order the host's adapter gave, until one works; and what each attempt gave, for the diagnostics.

import { fetchText } from './fetchText';
import { Strategy } from './params';
import { FetchResult, FrameMessage, PageMessage } from './protocol';

/** Every way, for the diagnostics' button that tries them all. */
export const ALL_WAYS: Strategy[] = ['frame', 'worker', 'page'];

export interface Attempt {
  what: string;
  strategy: Strategy;
  status: number;
  host?: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface Read {
  text?: string;
  /** The way that reads this repository did not find it. */
  absent?: boolean;
  statuses: Map<Strategy, number>;
}

/** A raw file or a diff, not an HTML page (a sign-in page, an error page). */
const isFile = (r: FetchResult) => r.ok && r.text !== undefined && !/text\/html/i.test(r.contentType ?? '');

export class Reader {
  readonly attempts: Attempt[] = [];
  /** The way that read a file of this repository: a 404 from it means the file is not in that version. */
  reader?: Strategy;
  private readonly pending = new Map<number, (r: FetchResult) => void>();
  private nextId = 0;

  /** `origin`: the page's, the only one the frame talks to; `order`: the ways to try, in turn. */
  constructor(private readonly post: (m: FrameMessage) => void, private readonly origin: string, private readonly order: Strategy[]) {
    window.addEventListener('message', e => {
      if (e.origin !== this.origin || e.source !== window.parent) return;
      const m = e.data as PageMessage;
      if (m?.tcx !== 'fetched') return;
      this.pending.get(m.id)?.(m.result);
      this.pending.delete(m.id);
    });
  }

  private viaPage(url: string): Promise<FetchResult> {
    const id = ++this.nextId;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, status: 0, error: 'the page did not answer' });
      }, 20000);
      this.pending.set(id, r => {
        clearTimeout(timer);
        resolve(r);
      });
      this.post({ tcx: 'fetch', id, url });
    });
  }

  private via(strategy: Strategy, url: string): Promise<FetchResult> {
    switch (strategy) {
      case 'frame': return fetchText(url, 'include');
      case 'worker': return chrome.runtime.sendMessage<FetchResult>({ tcx: 'fetch', url })
        .then(r => r ?? { ok: false, status: 0, error: 'no answer' }, e => ({ ok: false, status: 0, error: String(e) }));
      case 'page': return this.viaPage(url);
    }
  }

  async attempt(what: string, strategy: Strategy, url: string, log = this.attempts): Promise<FetchResult> {
    const start = performance.now();
    const r = await this.via(strategy, url);
    let host: string | undefined;
    try {
      host = r.url ? new URL(r.url).host : undefined;
    } catch {
      host = undefined;
    }
    log.push({
      what, strategy, status: r.status, host, ms: Math.round(performance.now() - start), ok: isFile(r),
      error: r.error ?? (r.ok && !isFile(r) ? `not a file (${r.contentType})` : undefined),
    });
    return r;
  }

  /** Reads a URL the way that worked before first, the others after it. */
  async read(what: string, url: string): Promise<Read> {
    const statuses = new Map<Strategy, number>();
    for (const strategy of this.reader ? [this.reader, ...this.order.filter(s => s !== this.reader)] : this.order) {
      const r = await this.attempt(what, strategy, url);
      statuses.set(strategy, r.status);
      if (isFile(r)) {
        this.reader ??= strategy;
        return { text: r.text, statuses };
      }
      if (strategy === this.reader && r.status === 404) return { absent: true, statuses };
    }
    return { statuses };
  }

  /** The text of a version: undefined when the file is not in it, null when it could not be read. */
  textOf(r: Read | undefined): string | undefined | null {
    if (!r) return undefined;
    if (r.text !== undefined) return r.text;
    // Read before the way that works was known: what that way answered tells.
    if (r.absent || (this.reader && r.statuses.get(this.reader) === 404)) return undefined;
    return null;
  }
}

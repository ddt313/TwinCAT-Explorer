// Bitbucket Cloud's "Files changed" tab of a pull request (`/workspace/repo/pull-requests/7/diff`). A file's block is
// its `<article data-qa="branch-diff-file">`, after Bitbucket's empty marker `<div id="chg-<path>">` (its link to the
// file); the extension gives the article an id of its own (`tcx-chg-<path>`), which Bitbucket does not use. Its
// header is `[data-qa="bk-file__header"]`, its diff `[data-qa="bk-file__content"]`, its lines' anchors
// `L<path>F<old>T<new>`. The commits, the files and the review threads come from the REST API: the page's own
// (`/!api/2.0`, same origin, with the session, so a private repository needs no token), else api.bitbucket.org
// (public repositories). The page scrolls in a panel; the file header is sticky in it.

import {
  BitbucketPullRequest, PAGE_API, PUBLIC_API, bitbucketBlockId, bitbucketRawTemplate, bitbucketTheme, commentUrl, filesFromDiffstat, isLineAnchor,
  repositoryApi, threadsFromBitbucket,
} from './bitbucket';
import { ReviewThread, ThreadsResult } from './comments';
import { Host, showTarget } from './host';
import { Commits, Strategy, Theme } from './params';
import { ChangedFile, DiffStyle } from './protocol';

const BLOCK = 'article[data-qa="branch-diff-file"]';
const MARKER = /^chg-(.+)$/;
const LABEL = /^Diff of file (.+)$/;
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

export class BitbucketHost implements Host {
  readonly kind = 'bitbucket';
  readonly key: string;
  readonly raw: string;
  /** From the page first: the raw files have the page's origin, and the session goes with them. */
  readonly order: Strategy[] = ['page', 'frame', 'worker'];
  /** Below the pull request's sticky bar (its tabs and filters) and the file's sticky header, in the panel that scrolls. */
  readonly stickyTop = 90;
  readonly treeOverlay = false;
  readonly threadsFresh = 5000;
  private apiFiles: Promise<ChangedFile[] | undefined> | undefined;
  /** The commits last looked for: the comments that are not outdated are on their head. */
  private compared: Promise<Commits | undefined> | undefined;
  /** The API that answered last: the page's, else the public one. */
  private apiRoot = PAGE_API;

  constructor(private readonly pr: BitbucketPullRequest) {
    this.key = `bitbucket:${pr.workspace}/${pr.repo}#${pr.id}`;
    this.raw = bitbucketRawTemplate(pr);
  }

  /** A JSON answer of the REST API: the page's (with the session), else the public one (public repositories). */
  private async get<T>(path: string): Promise<T> {
    let last = '';
    for (const root of [this.apiRoot, ...[PAGE_API, PUBLIC_API].filter(r => r !== this.apiRoot)]) {
      try {
        const url = path.startsWith('https://') ? path.replace(/^https:\/\/[^/]+(?:\/!api)?\/2\.0/, root) : `${repositoryApi(root, this.pr)}${path}`;
        const r = await fetch(url, { credentials: root === PAGE_API ? 'same-origin' : 'omit', headers: { Accept: 'application/json' } });
        if (r.ok) {
          this.apiRoot = root;
          return await r.json() as T;
        }
        last = `HTTP ${r.status}`;
      } catch (e) {
        last = String(e);
      }
    }
    throw new Error(last);
  }

  /** Every page of a paged answer (`values`, `next`). */
  private async all(path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < 50; page++) {
      const data: { values?: unknown[]; next?: string } = await this.get(next);
      out.push(...(data.values ?? []));
      next = data.next;
    }
    return out;
  }

  /**
   * The pull request's diff is from the merge base of its source and destination commits to its source commit (its
   * diffstat's `topic=true`); the API gives them short, `merge-base` and `commit` full.
   */
  commits(): Promise<Commits | undefined> {
    this.compared = this.findCommits();
    return this.compared;
  }

  private async findCommits(): Promise<Commits | undefined> {
    try {
      const pr: { source?: { commit?: { hash?: string } }; destination?: { commit?: { hash?: string } } } = await this.get(`/pullrequests/${this.pr.id}`);
      const source = pr.source?.commit?.hash;
      const destination = pr.destination?.commit?.hash;
      if (!source || !destination) return undefined;
      const [base, head] = await Promise.all([
        this.get<{ hash?: string }>(`/merge-base/${source}..${destination}`),
        this.get<{ hash?: string }>(`/commit/${source}?fields=hash`),
      ]);
      if (!base.hash || !head.hash) return undefined;
      return { base: base.hash, head: head.hash, source: this.apiRoot === PAGE_API ? 'REST API, session' : 'REST API, public' };
    } catch (e) {
      log('The REST API did not give the commits:', String(e));
      return undefined;
    }
  }

  files(): Promise<ChangedFile[] | undefined> {
    this.apiFiles ??= this.all(`/pullrequests/${this.pr.id}/diffstat?pagelen=500`).then(filesFromDiffstat, (e: unknown) => {
      log('The REST API did not give the files:', String(e));
      return undefined;
    });
    return this.apiFiles;
  }

  async listedFiles(): Promise<ChangedFile[]> {
    // The file tree's links name the files' paths (`#chg-<path>`), but not whether they were added or renamed.
    return [...document.querySelectorAll<HTMLAnchorElement>('#file-tree a[href^="#chg-"]')].map(a => ({ path: decodeURIComponent(a.getAttribute('href')!.slice(5)) }));
  }

  async threads(): Promise<ThreadsResult> {
    const c = await (this.compared ?? this.commits());
    try {
      const all = await this.all(`/pullrequests/${this.pr.id}/comments?pagelen=100&fields=%2Bvalues.resolution.type`);
      return { threads: threadsFromBitbucket(all, c?.head ?? '', id => commentUrl(this.pr, id)), source: this.apiRoot === PAGE_API ? 'REST API, session' : 'REST API, public' };
    } catch (e) {
      log('The comments were not read:', String(e));
      const signedOut = /HTTP 40[134]/.test(String(e));
      return { threads: [], problem: `The comments could not be read (${String(e)})${signedOut ? ': sign in to see them' : ''}.` };
    }
  }

  /** The articles of the files, each with its id: its path, from Bitbucket's marker before it, else its label. */
  containers(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const article of document.querySelectorAll<HTMLElement>(BLOCK)) {
      const path = BitbucketHost.pathOf(article);
      if (!path) continue;
      const id = bitbucketBlockId(path);
      if (article.id !== id) article.id = id;
      out.push(article);
    }
    return out;
  }

  private static pathOf(article: HTMLElement): string | undefined {
    const marker = article.parentElement?.previousElementSibling?.id;
    const m = marker ? MARKER.exec(marker) : null;
    if (m) return m[1];
    return LABEL.exec(article.getAttribute('aria-label') ?? '')?.[1];
  }

  header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-qa="bk-file__header"], [data-testid="file-header"]');
  }

  async identify(container: HTMLElement): Promise<ChangedFile | undefined> {
    const path = BitbucketHost.pathOf(container);
    if (!path) return undefined;
    // The API says whether it was added, deleted or renamed.
    const known = (await this.files())?.find(f => f.path === path);
    return { path, ...known };
  }

  /** Beside the file's path, before the header's actions (Viewed, the menu). */
  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('[data-qa="bk-filepath"]')?.parentElement ?? header;
  }

  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    const body = container.querySelector<HTMLElement>('[data-qa="bk-file__content"], [data-testid="file-content"]');
    return { after: header, hide: body ? [body] : [] };
  }

  async anchorOf(path: string): Promise<string> {
    return bitbucketBlockId(path);
  }

  goToLine(container: HTMLElement, side: 'L' | 'R', line: number): boolean {
    const path = container.id.slice('tcx-chg-'.length);
    const target = [...container.querySelectorAll<HTMLElement>('[data-qa="code-line-permalink"][id]')].find(el => isLineAnchor(el.id, path, side, line));
    return showTarget(container, target ?? null);
  }

  goToThread(container: HTMLElement, thread: ReviewThread): boolean {
    return showTarget(container, document.getElementById(thread.anchor));
  }

  /** Bitbucket's tree link to the file, which scrolls the diff to it; else its marker's hash. */
  goToFile(anchor: string): void {
    if (document.getElementById(anchor)) return;
    const path = anchor.slice('tcx-chg-'.length);
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#chg-"]')].find(a => decodeURIComponent(a.getAttribute('href')!.slice(5)) === path);
    if (link) link.click();
    else location.hash = `chg-${path}`;
  }

  treePanel(): HTMLElement | null {
    return document.getElementById('file-tree');
  }

  theme(): Theme {
    return bitbucketTheme(document.documentElement.dataset.colorMode);
  }

  diffStyle(): DiffStyle | undefined {
    return undefined;
  }
}

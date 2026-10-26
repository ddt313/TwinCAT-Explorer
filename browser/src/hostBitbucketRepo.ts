// Bitbucket Cloud's pages of a repository's files, `/workspace/repo/src/<ref>/<path>`: a folder or a file, one React
// app. The file is the element of its header (`[data-qa="bk-file__header"]`) and its content
// (`[data-qa="bk-file__content"]`, a Monaco editor whose lines are `#lines-12`), its title the page's `<h1>`. The commit
// and the files come from the REST API: the page's own (`/!api/2.0`, with the session: a private repository needs no
// token), else api.bitbucket.org (public repositories). The page has no tree of its files: the TwinCAT tab floats.
// See hostRepository.ts.

import {
  BitbucketSourcePage, PAGE_API, PUBLIC_API, bitbucketRawTemplate, bitbucketTheme, commitPath, filesFromSrc, repositoryApi, sourcePage, sourceTreePath,
  sourceUrl,
} from './bitbucket';
import { RepositoryHost, SHA } from './hostRepository';
import { Commits, Strategy, Theme } from './params';

export class BitbucketRepositoryHost extends RepositoryHost {
  readonly kind = 'bitbucket';
  /** From the page first: the raw files have the page's origin, and the session goes with them. */
  readonly order: Strategy[] = ['page', 'frame', 'worker'];
  /** Below the page's header, in the panel that scrolls. */
  readonly stickyTop = 24;
  readonly treeOverlay = false;
  /** The API that answered last: the page's, else the public one. */
  private apiRoot = PAGE_API;

  constructor(private readonly page: BitbucketSourcePage) {
    super(`bitbucket-repository:${page.workspace}/${page.repo}@${page.ref}`, bitbucketRawTemplate(page), page.ref);
  }

  /** A JSON answer of the REST API: the page's (with the session), else the public one (public repositories). */
  private async get<T>(pathOrUrl: string): Promise<T> {
    let last = '';
    for (const root of [this.apiRoot, ...[PAGE_API, PUBLIC_API].filter(r => r !== this.apiRoot)]) {
      try {
        const url = pathOrUrl.startsWith('https://') ? pathOrUrl.replace(/^https:\/\/[^/]+(?:\/!api)?\/2\.0/, root) : `${repositoryApi(root, this.page)}${pathOrUrl}`;
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

  protected urlFile(): string | undefined {
    const now = sourcePage(location.pathname);
    return now && now.ref === this.ref && now.path ? now.path : undefined;
  }

  /** The page's title; a folder's page has it too, but no file header. */
  protected shownName(): string | undefined {
    return this.fileElement() ? document.querySelector('h1')?.textContent?.trim() : undefined;
  }

  protected fileElement(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-qa="bk-file__header"]')?.parentElement ?? null;
  }

  protected async findCommit(): Promise<Commits | undefined> {
    const { hash } = await this.get<{ hash?: unknown }>(commitPath(this.ref));
    if (typeof hash !== 'string' || !SHA.test(hash)) throw new Error('no hash');
    return { base: hash, head: hash, source: `REST API${this.apiRoot === PAGE_API ? ', session' : ''}: ${this.ref}` };
  }

  /** `src`, recursive, a page of 100 at a time. */
  protected async listFiles(sha: string): Promise<string[]> {
    const out: string[] = [];
    let next: string | undefined = sourceTreePath(sha);
    for (let page = 0; next && page < 200; page++) {
      const data: { values?: unknown; next?: string } = await this.get(next);
      out.push(...filesFromSrc(data.values));
      next = data.next;
    }
    return out;
  }

  protected fileUrl(path: string): string {
    return sourceUrl(this.page, this.ref, path);
  }

  /** Its router follows a history entry it did not make, told by a `popstate`: the file's page in the app. */
  protected override route(url: string): boolean {
    history.pushState(null, '', url);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
    return true;
  }

  header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(':scope > [data-qa="bk-file__header"]');
  }

  /** Beside *Blame* and *Edit*. */
  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('[data-qa="bk-file__actions"]') ?? header;
  }

  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    return { after: header, hide: [...container.querySelectorAll<HTMLElement>(':scope > [data-qa="bk-file__content"]')] };
  }

  /** The file's line, `#lines-12`: the app scrolls to it and marks it. */
  goToLine(_container: HTMLElement, _side: 'L' | 'R', line: number): boolean {
    location.hash = `lines-${line}`;
    return true;
  }

  treePanel(): HTMLElement | null {
    return null;
  }

  theme(): Theme {
    return bitbucketTheme(document.documentElement.dataset.colorMode);
  }
}

// GitHub's pages of a repository's files: a folder (`/o/r/tree/<ref>/<path>`) and a file (`/o/r/blob/<ref>/<path>`),
// one React app. The file is the element of its sticky header (`#repos-sticky-header`) and of its code below it, its
// title `[data-testid="breadcrumbs-filename"] h1`. The ref and its commit are in the page's data (`refInfo` of the JSON
// it embeds, as it was loaded), else in the JSON the page's URL answers with the session; the files at the commit are
// those of the page's *Go to file* (`tree-list`, with the session: a private repository needs no token). See
// hostRepository.ts.

import { GithubRepositoryPage, githubBlobUrl, githubRawTemplate, githubTreeListUrl, pathsOfTreeList, refInfoOf } from './github';
import { refAndPath } from './gitlab';
import { RepositoryHost } from './hostRepository';
import { Commits, Strategy, Theme } from './params';

const JSON_HEADERS = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

/** The page's embedded data, read once a page (it is the page's as it was loaded: the app does not change it). */
let embedded: { el: Element; info?: { name: string; oid?: string } } | undefined;

function embeddedRef(): { name: string; oid?: string } | undefined {
  const el = document.querySelector('script[data-target="react-app.embeddedData"]');
  if (!el) return undefined;
  if (embedded?.el !== el) {
    let info: { name: string; oid?: string } | undefined;
    try {
      info = refInfoOf(JSON.parse(el.textContent ?? ''));
    } catch {
      info = undefined;
    }
    embedded = { el, info };
  }
  return embedded.info;
}

export class GitHubRepositoryHost extends RepositoryHost {
  readonly kind = 'github';
  /** As on a pull request: the raw files redirect to raw.githubusercontent.com, which the frame reads. */
  readonly order: Strategy[] = ['frame', 'worker', 'page'];
  /** Below the file's sticky header, in the window. */
  readonly stickyTop = 64;
  readonly treeOverlay = false;
  private readonly owner: string;
  private readonly repo: string;

  constructor(page: GithubRepositoryPage) {
    const { ref } = refAndPath(page.rest, [embeddedRef()?.name]);
    super(`github-repository:${page.owner}/${page.repo}@${ref}`, githubRawTemplate(page), ref);
    this.owner = page.owner;
    this.repo = page.repo;
  }

  protected urlFile(): string | undefined {
    const m = /^\/[^/]+\/[^/]+\/blob\/(.+?)\/?$/.exec(location.pathname);
    try {
      const rest = m?.[1].split('/').map(decodeURIComponent).join('/');
      return rest?.startsWith(`${this.ref}/`) ? rest.slice(this.ref.length + 1) : undefined;
    } catch {
      return undefined;
    }
  }

  protected shownName(): string | undefined {
    return document.querySelector('[data-testid="breadcrumbs-filename"] h1')?.textContent?.trim();
  }

  protected fileElement(): HTMLElement | null {
    return document.getElementById('repos-sticky-header')?.parentElement ?? null;
  }

  /** The page's data when it is the ref's, else the JSON of the page's URL (what the app reads when it goes there). */
  protected async findCommit(): Promise<Commits | undefined> {
    const own = embeddedRef();
    if (own?.name === this.ref && own.oid) return { base: own.oid, head: own.oid, source: `page: ${this.ref}` };
    const r = await fetch(`https://github.com/${this.owner}/${this.repo}/tree/${this.ref.split('/').map(encodeURIComponent).join('/')}`, { headers: JSON_HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const oid = refInfoOf(await r.json())?.oid;
    if (!oid) throw new Error('no refInfo');
    return { base: oid, head: oid, source: `page's JSON, session: ${this.ref}` };
  }

  protected async listFiles(sha: string): Promise<string[]> {
    const r = await fetch(githubTreeListUrl(this.owner, this.repo, sha), { headers: JSON_HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return pathsOfTreeList(await r.json());
  }

  protected fileUrl(path: string): string {
    return githubBlobUrl(this.owner, this.repo, this.ref, path);
  }

  /** GitHub's tree has no links: its row (`<path>-item`, rendered while its folder is open) shows the file, hidden too. */
  protected override clickRow(path: string): boolean {
    const row = document.getElementById(`${path}-item`);
    if (!row) return false;
    (row.querySelector<HTMLElement>('[class*="TreeView-item-content"]') ?? row).click();
    return true;
  }

  header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(':scope > #repos-sticky-header');
  }

  /** Beside the *Code | Blame* switch. */
  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('ul.SegmentedControl')?.parentElement
      ?? header.querySelector<HTMLElement>('.react-blob-header-edit-and-raw-actions')?.parentElement ?? header;
  }

  /** The code (or the rendered file) is what comes after the header. */
  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    const hide = [...container.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== header
      && !el.classList.contains('tcx-host') && !!(header.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    return { after: header, hide };
  }

  /** The file's line, `#L12`: the app scrolls to it and marks it (its lines are rendered as they show). */
  goToLine(_container: HTMLElement, _side: 'L' | 'R', line: number): boolean {
    location.hash = `L${line}`;
    return true;
  }

  treePanel(): HTMLElement | null {
    return document.getElementById('repos-file-tree');
  }

  theme(): Theme {
    const mode = document.documentElement.dataset.colorMode;
    return mode === 'light' || mode === 'dark' ? mode : 'auto';
  }
}

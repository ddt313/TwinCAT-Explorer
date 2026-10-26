// GitLab's pages of a repository's files, on gitlab.com or a self-managed instance: a folder (`/-/tree/<ref>/<path>`)
// and a file (`/-/blob/<ref>/<path>`), one Vue app that goes from one to the other without loading a page. A file's
// `.file-holder` shows file after file: its block is named by the file's path. The commit is the ref's, from the REST
// API (with the session, as for a merge request); the files are all those at that commit, from the REST API too; no
// review threads. The views and the tree show the objects as they are at that commit (`snapshot`).

import { ReviewThread, ThreadsResult } from './comments';
import { RepositoryPage, blobUrl, commitApi, filesFromTree, gitlabRawTemplate, gitlabTheme, nextPageUrl, refAndPath, repositoryTreeApi } from './gitlab';
import { Host, showTarget } from './host';
import { hasObjectView } from './model';
import { Commits, Strategy, Theme } from './params';
import { ChangedFile, DiffStyle } from './protocol';

const SHA = /^[0-9a-f]{40}$/;
/** A block's id: the file's path. */
const PREFIX = 'blob:';
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

export class GitLabRepositoryHost implements Host {
  readonly kind = 'gitlab';
  readonly key: string;
  readonly raw: string;
  /** From the page first: the raw files have the page's origin, and the session goes with them. */
  readonly order: Strategy[] = ['page', 'frame', 'worker'];
  /** The page scrolls in a panel below GitLab's bars; the file's header is sticky in it. */
  readonly stickyTop = 64;
  readonly treeOverlay = true;
  readonly threadsFresh = Number.POSITIVE_INFINITY;
  readonly snapshot = true;
  readonly ref: string;
  private readonly project: string | number;
  /** The instance's root: its origin, and the path it is served under (`https://example.com/gitlab`). */
  private readonly root: string;
  private readonly path: string;
  private sha: Promise<Commits | undefined> | undefined;
  private apiFiles: Promise<ChangedFile[] | undefined> | undefined;

  constructor(page: RepositoryPage) {
    const data = document.body.dataset;
    const id = Number(data.projectId);
    const full = data.projectFullPath;
    const at = full ? location.pathname.indexOf(`/${full}/-/`) : -1;
    this.root = location.origin + (at > 0 ? location.pathname.slice(0, at) : '');
    this.path = full && at >= 0 ? full : page.project;
    this.project = Number.isInteger(id) && id > 0 ? id : this.path;
    this.ref = refAndPath(page.rest, GitLabRepositoryHost.pageRefs()).ref;
    // Another ref is another page; another file or folder of the same ref is not (the tree stays).
    this.key = `gitlab-repository:${this.root}/${this.path}@${this.ref}`;
    this.raw = gitlabRawTemplate(this.root, this.path);
  }

  /** The refs the page names: the file header's (Vue, kept up to date), the page's own (as it was loaded). */
  private static pageRefs(): (string | undefined)[] {
    return [
      document.querySelector('.js-file-title[currentref]')?.getAttribute('currentref') ?? undefined,
      document.getElementById('js-ambiguous-ref-modal')?.dataset.ref,
    ];
  }

  /** The file the page shows now, if it shows one. */
  private currentFile(): string | undefined {
    const m = /\/-\/blob\/(.+?)\/?$/.exec(location.pathname);
    if (!m) return undefined;
    let rest: string;
    try {
      rest = m[1].split('/').map(decodeURIComponent).join('/');
    } catch {
      return undefined;
    }
    if (!rest.startsWith(`${this.ref}/`)) return undefined;
    const path = rest.slice(this.ref.length + 1);
    // The URL changes before the app shows the file: its title says which one it shows (a folder's README has none).
    const title = document.querySelector('.file-holder [data-testid="file-title-content"]')?.textContent?.trim();
    return title === path.slice(path.lastIndexOf('/') + 1) ? path : undefined;
  }

  commits(): Promise<Commits | undefined> {
    this.sha = (async () => {
      if (SHA.test(this.ref)) return { base: this.ref, head: this.ref, source: 'URL' };
      try {
        const r = await fetch(commitApi(this.root, this.project, this.ref));
        const id = r.ok ? (await r.json() as { id?: unknown }).id : undefined;
        if (typeof id === 'string' && SHA.test(id)) return { base: id, head: id, source: `REST API, session: ${this.ref}` };
        log('The REST API did not give the commit of', this.ref, r.status);
      } catch (e) {
        log('The REST API did not give the commit of', this.ref, String(e));
      }
      return undefined;
    })();
    return this.sha;
  }

  async threads(): Promise<ThreadsResult> {
    return { threads: [], source: 'none on a repository\'s page' };
  }

  /** The TwinCAT source files at the commit, all the repository's: a page of 100 at a time. */
  files(): Promise<ChangedFile[] | undefined> {
    this.apiFiles ??= (async () => {
      const c = await (this.sha ?? this.commits());
      if (!c) {
        this.apiFiles = undefined;
        return undefined;
      }
      try {
        const out: ChangedFile[] = [];
        let url: string | undefined = repositoryTreeApi(this.root, this.project, c.head);
        for (let page = 0; url && page < 200; page++) {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          out.push(...filesFromTree(await r.json()).filter(hasObjectView).map(path => ({ path })));
          url = nextPageUrl(r.headers.get('link'));
        }
        return out;
      } catch (e) {
        log('The REST API did not give the files:', String(e));
        return undefined;
      }
    })();
    return this.apiFiles;
  }

  async listedFiles(): Promise<ChangedFile[]> {
    return [];
  }

  containers(): HTMLElement[] {
    const holder = this.currentFile() !== undefined ? document.querySelector<HTMLElement>('.file-holder') : null;
    return holder ? [holder] : [];
  }

  blockId(): string {
    return PREFIX + (this.currentFile() ?? '');
  }

  blockById(anchor: string): HTMLElement | null {
    return anchor === PREFIX + this.currentFile() ? document.querySelector<HTMLElement>('.file-holder') : null;
  }

  header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(':scope > .js-file-title');
  }

  async identify(): Promise<ChangedFile | undefined> {
    const path = this.currentFile();
    return path === undefined ? undefined : { path };
  }

  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('.file-header-content') ?? header;
  }

  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    return { after: header, hide: [...container.querySelectorAll<HTMLElement>(':scope > .blob-viewer')] };
  }

  async anchorOf(path: string): Promise<string> {
    return PREFIX + path;
  }

  /** The file's line (`#L12`, which GitLab marks); one not rendered yet is still the location's hash, which GitLab shows. */
  goToLine(container: HTMLElement, _side: 'L' | 'R', line: number): boolean {
    const el = document.getElementById(`L${line}`);
    if (el) return showTarget(container, el);
    location.hash = `L${line}`;
    return true;
  }

  goToThread(_container: HTMLElement, _thread: ReviewThread): boolean {
    return false;
  }

  /**
   * The file's page: in the app when it lists the file (its row in GitLab's tree, or in the folder's table), else
   * loaded (the app's router does not follow a change of the history it did not make), as when the app did not show it.
   */
  goToFile(anchor: string): void {
    if (!anchor.startsWith(PREFIX)) return;
    const url = blobUrl(this.root, this.path, this.ref, anchor.slice(PREFIX.length));
    const target = new URL(url).pathname;
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a[data-testid="file-row"][href], a[data-testid="file-name-link"][href]')]
      .find(a => a.offsetParent && new URL(a.href).pathname === target);
    if (!link) {
      location.assign(url);
      return;
    }
    link.click();
    setTimeout(() => {
      if (!this.blockById(anchor)) location.assign(url);
    }, 4000);
  }

  treePanel(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.file-tree-browser section[aria-labelledby="tree-list-heading"]');
  }

  theme(): Theme {
    return gitlabTheme(document.documentElement.className);
  }

  diffStyle(): DiffStyle | undefined {
    return undefined;
  }
}

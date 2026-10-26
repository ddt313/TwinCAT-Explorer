// GitLab's pages of a repository's files, on gitlab.com or a self-managed instance: a folder (`/-/tree/<ref>/<path>`)
// and a file (`/-/blob/<ref>/<path>`), one Vue app. The file is its `.file-holder` (`.js-file-title` and
// `.blob-viewer`), its title `[data-testid="file-title-content"]`. The commit is the ref's, from the REST API (with
// the session, as for a merge request); the files are those of the REST API's `repository/tree` (hostRepository.ts).

import { RepositoryPage, blobUrl, commitApi, filesFromTree, gitlabRawTemplate, gitlabTheme, nextPageUrl, refAndPath, repositoryTreeApi } from './gitlab';
import { showTarget } from './host';
import { RepositoryHost, SHA } from './hostRepository';
import { Commits, Strategy, Theme } from './params';

export class GitLabRepositoryHost extends RepositoryHost {
  readonly kind = 'gitlab';
  /** From the page first: the raw files have the page's origin, and the session goes with them. */
  readonly order: Strategy[] = ['page', 'frame', 'worker'];
  /** The page scrolls in a panel below GitLab's bars; the file's header is sticky in it. */
  readonly stickyTop = 64;
  /** Over GitLab's tree, which stays rendered (its rows are clicked to go to a file). */
  readonly treeOverlay = true;
  private readonly project: string | number;
  /** The instance's root: its origin, and the path it is served under (`https://example.com/gitlab`). */
  private readonly root: string;
  private readonly path: string;

  constructor(page: RepositoryPage) {
    const data = document.body.dataset;
    const id = Number(data.projectId);
    const full = data.projectFullPath;
    const at = full ? location.pathname.indexOf(`/${full}/-/`) : -1;
    const root = location.origin + (at > 0 ? location.pathname.slice(0, at) : '');
    const path = full && at >= 0 ? full : page.project;
    // The refs the page names: the file header's (Vue, kept up to date), the page's own (as it was loaded).
    const { ref } = refAndPath(page.rest, [
      document.querySelector('.js-file-title[currentref]')?.getAttribute('currentref') ?? undefined,
      document.getElementById('js-ambiguous-ref-modal')?.dataset.ref,
    ]);
    // Another ref is another page; another file or folder of the same ref is not (the tree stays).
    super(`gitlab-repository:${root}/${path}@${ref}`, gitlabRawTemplate(root, path), ref);
    this.root = root;
    this.path = path;
    this.project = Number.isInteger(id) && id > 0 ? id : path;
  }

  protected urlFile(): string | undefined {
    const m = /\/-\/blob\/(.+?)\/?$/.exec(location.pathname);
    try {
      const rest = m?.[1].split('/').map(decodeURIComponent).join('/');
      return rest?.startsWith(`${this.ref}/`) ? rest.slice(this.ref.length + 1) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A folder's README has a `.file-holder` too, without this title. */
  protected shownName(): string | undefined {
    return document.querySelector('.file-holder [data-testid="file-title-content"]')?.textContent?.trim();
  }

  protected fileElement(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.file-holder');
  }

  protected async findCommit(): Promise<Commits | undefined> {
    const r = await fetch(commitApi(this.root, this.project, this.ref));
    const id = r.ok ? (await r.json() as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && SHA.test(id)) return { base: id, head: id, source: `REST API, session: ${this.ref}` };
    throw new Error(`HTTP ${r.status}`);
  }

  /** `repository/tree`, recursive, a page of 100 at a time. */
  protected async listFiles(sha: string): Promise<string[]> {
    const out: string[] = [];
    let url: string | undefined = repositoryTreeApi(this.root, this.project, sha);
    for (let page = 0; url && page < 200; page++) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      out.push(...filesFromTree(await r.json()));
      url = nextPageUrl(r.headers.get('link'));
    }
    return out;
  }

  protected fileUrl(path: string): string {
    return blobUrl(this.root, this.path, this.ref, path);
  }

  header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(':scope > .js-file-title');
  }

  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('.file-header-content') ?? header;
  }

  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    return { after: header, hide: [...container.querySelectorAll<HTMLElement>(':scope > .blob-viewer')] };
  }

  /** The file's line (`#L12`, which GitLab marks); one not rendered yet is still the location's hash, which GitLab shows. */
  goToLine(container: HTMLElement, _side: 'L' | 'R', line: number): boolean {
    const el = document.getElementById(`L${line}`);
    if (el) return showTarget(container, el);
    location.hash = `L${line}`;
    return true;
  }

  treePanel(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.file-tree-browser section[aria-labelledby="tree-list-heading"]');
  }

  theme(): Theme {
    return gitlabTheme(document.documentElement.className);
  }
}

// GitLab's "Changes" tab of a merge request, on gitlab.com or a self-managed instance, in its two diff pages:
// Rapid Diffs (`<diff-file>` blocks whose `data-file-data` has the paths and the commits compared) and the classic
// Vue app (`.diff-file.file-holder` blocks with `data-path`, rendered as the page scrolls). A block's id is the sha1 of
// its path. The files come from the REST API, which takes the session cookie on its own origin (a private project
// needs no token); the commits from the page's data (what it shows, its version and comparison included), else the
// REST API.

import { commitsFromDiffRefs, filesFromApi, gitlabRawTemplate, gitlabTheme, mergeRequestApi, MergeRequest, rapidFileData, rapidLineAnchor } from './gitlab';
import { Host, digest } from './host';
import { Commits, Strategy, Theme } from './params';
import { ChangedFile } from './protocol';

const RAPID = 'diff-file[data-file-data]';
const CLASSIC = 'div.diff-file.file-holder[data-path]';
const BLOCK_ID = /^[0-9a-f]{40}$/;
const XHR = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

export class GitLabHost implements Host {
  readonly kind = 'gitlab';
  readonly key: string;
  readonly raw: string;
  /** From the page first: the raw files have the page's origin, and the session goes with them. */
  readonly order: Strategy[] = ['page', 'frame', 'worker'];
  /** The page scrolls in a panel below GitLab's bars; its sticky file header is in it. */
  readonly stickyTop = 110;
  readonly treeOverlay = true;
  private readonly project: string | number;
  private apiFiles: Promise<ChangedFile[] | undefined> | undefined;

  /** The instance's root: its origin, and the path it is served under (`https://example.com/gitlab`). */
  private readonly root: string;
  private readonly path: string;

  constructor(private readonly mr: MergeRequest) {
    const data = document.body.dataset;
    const id = Number(data.projectId);
    // The page names its project: what comes before it in the URL is the instance's own path.
    const full = data.projectFullPath;
    const at = full ? location.pathname.indexOf(`/${full}/-/`) : -1;
    this.root = location.origin + (at > 0 ? location.pathname.slice(0, at) : '');
    this.path = full && at >= 0 ? full : mr.project;
    this.project = Number.isInteger(id) && id > 0 ? id : this.path;
    // Another version or comparison of the merge request is another page.
    this.key = `gitlab:${this.root}/${this.path}!${mr.iid}${location.search}`;
    this.raw = gitlabRawTemplate(this.root, this.path);
  }

  private api(path = ''): string {
    return `${mergeRequestApi(this.root, this.project, this.mr.iid)}${path}`;
  }

  async commits(): Promise<Commits | undefined> {
    const rapid = rapidFileData(document.querySelector<HTMLElement>(RAPID)?.dataset.fileData)?.commits;
    if (rapid) return rapid;
    // The classic page loads its diffs from this endpoint, with the version, commit and comparison of its URL: the
    // diff refs of what it shows. (Its mount point loses the endpoint's attribute once the page has started.)
    try {
      const url = new URL(`${this.root}/${this.path.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/${this.mr.iid}/diffs_batch.json`);
      for (const [k, v] of new URLSearchParams(location.search)) if (['diff_id', 'start_sha', 'commit_id', 'diff_head'].includes(k)) url.searchParams.set(k, v);
      if (!url.searchParams.has('diff_head') && !url.searchParams.has('diff_id') && !url.searchParams.has('commit_id')) url.searchParams.set('diff_head', 'true');
      url.searchParams.set('page', '0');
      url.searchParams.set('per_page', '1');
      const r = await fetch(url, { headers: XHR });
      const c = r.ok ? commitsFromDiffRefs((await r.json() as { diff_files?: { diff_refs?: unknown }[] }).diff_files?.[0]?.diff_refs, 'page: diffs batch') : undefined;
      if (c) return c;
    } catch (e) {
      log('The page\'s diffs batch did not give the commits:', String(e));
    }
    try {
      const r = await fetch(this.api());
      if (r.ok) return commitsFromDiffRefs((await r.json() as { diff_refs?: unknown }).diff_refs, 'REST API, session');
      log('The REST API did not give the merge request:', r.status);
    } catch (e) {
      log('The REST API did not give the merge request:', String(e));
    }
    return undefined;
  }

  /** `…/merge_requests/:iid/diffs` (GitLab 15.7+), page by page, else `…/changes` of older versions. */
  files(): Promise<ChangedFile[] | undefined> {
    this.apiFiles ??= (async () => {
      try {
        const out: ChangedFile[] = [];
        for (let page = 1; page <= 50; page++) {
          const r = await fetch(this.api(`/diffs?page=${page}&per_page=100`));
          if (!r.ok) {
            if (page > 1) break;
            const changes = await fetch(this.api('/changes'));
            return changes.ok ? filesFromApi((await changes.json() as { changes?: unknown }).changes) : undefined;
          }
          out.push(...filesFromApi(await r.json()));
          if (!r.headers.get('x-next-page')) break;
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
    // The REST API lists them all; the page's tree has no full paths to add.
    return [];
  }

  containers(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`${RAPID}, ${CLASSIC}`)].filter(c => BLOCK_ID.test(c.id));
  }

  private static rapid(container: HTMLElement): boolean {
    return container.tagName === 'DIFF-FILE';
  }

  header(container: HTMLElement): HTMLElement | null {
    return GitLabHost.rapid(container)
      ? container.querySelector<HTMLElement>('.rd-diff-file-header, [data-testid="rd-diff-file-header"]')
      : container.querySelector<HTMLElement>('.js-file-title, [data-testid="file-title-container"]');
  }

  async identify(container: HTMLElement): Promise<ChangedFile | undefined> {
    const own = GitLabHost.rapid(container) ? rapidFileData(container.dataset.fileData)?.file : container.dataset.path ? { path: container.dataset.path } : undefined;
    if (!own) return undefined;
    // The API says whether it was added, deleted or renamed (the classic block has its new path only).
    const known = (await this.files())?.find(f => f.path === own.path);
    return { ...own, ...known };
  }

  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('.rd-diff-file-header-main, .file-header-content') ?? header;
  }

  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    if (GitLabHost.rapid(container)) {
      const sticky = container.querySelector<HTMLElement>('.rd-diff-file-header-sticky') ?? header;
      const body = container.querySelector<HTMLElement>('.rd-diff-file-details');
      return { after: sticky, hide: body ? [body] : [] };
    }
    const body = container.querySelector<HTMLElement>(':scope > .diff-content');
    return { after: header, hide: body ? [body] : [] };
  }

  async anchorOf(path: string): Promise<string> {
    return digest('SHA-1', path);
  }

  goToLine(container: HTMLElement, side: 'L' | 'R', line: number): boolean {
    let target: HTMLElement | null;
    if (GitLabHost.rapid(container)) target = document.getElementById(rapidLineAnchor(container.id, side, line));
    else target = container.querySelector<HTMLElement>(`[data-interop-${side === 'L' ? 'old' : 'new'}-line="${line}"][id]`);
    if (!target) return false;
    location.hash = target.id;
    target.scrollIntoView({ block: 'center' });
    return true;
  }

  goToFile(anchor: string): void {
    if (document.getElementById(anchor)) return;
    // The classic page renders a block when its row in GitLab's tree is clicked.
    const row = document.querySelector<HTMLElement>(`button[data-file-row="${anchor}"], a[data-file-row="${anchor}"]`);
    if (row) row.click();
    else location.hash = anchor;
  }

  treePanel(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="file-browser-tree"]');
  }

  theme(): Theme {
    return gitlabTheme(document.documentElement.className);
  }
}

// GitLab's "Changes" tab of a merge request, on gitlab.com or a self-managed instance, in its two diff pages:
// Rapid Diffs (`<diff-file>` blocks whose `data-file-data` has the paths and the commits compared) and the classic
// Vue app (`.diff-file.file-holder` blocks with `data-path`, rendered as the page scrolls). A block's id is the sha1 of
// its path. The files come from the REST API, which takes the session cookie on its own origin (a private project
// needs no token); the commits from the page's data (what it shows, its version and comparison included), else the
// REST API; on a page of one commit, version or comparison (`commit_id`, `diff_id`, `start_sha`), the files are
// those of the commits it compares, from the REST API too; the review threads from the discussions the page itself
// reads, else the REST API, with the session too. The Changes tab of a merge request being created (`…/new/diffs`)
// has the same blocks, and its own commits and files (GitLabNewMergeRequestHost).

import { ReviewThread, ThreadsResult } from './comments';
import {
  commitApi, commitsFromDiffRefs, compareApi, discussionsUrl, filesFromApi, gitlabDiffStyle, gitlabRawTemplate, gitlabTheme, isPartialView, mergeBaseApi,
  mergeRequestApi, MergeRequest, NewMergeRequest, noteUrl, rapidFileData, rapidLineAnchor, threadsFromGitlab,
} from './gitlab';
import { Host, digest, showTarget } from './host';
import { Commits, Strategy, Theme } from './params';
import { ChangedFile, DiffStyle } from './protocol';

const RAPID = 'diff-file[data-file-data]';
const CLASSIC = 'div.diff-file.file-holder[data-path]';
const BLOCK_ID = /^[0-9a-f]{40}$/;
const XHR = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

/**
 * What GitLab's pages of diffs share, a merge request's Changes tab and the Changes tab of a new merge request: the
 * instance's root and the project, the raw files, the blocks of the two diff pages, their lines and the file tree.
 */
export abstract class GitLabDiffsHost implements Host {
  readonly kind = 'gitlab';
  abstract readonly key: string;
  readonly raw: string;
  /** From the page first: the raw files have the page's origin, and the session goes with them. */
  readonly order: Strategy[] = ['page', 'frame', 'worker'];
  /** The page scrolls in a panel below GitLab's bars; its sticky file header is in it. */
  readonly stickyTop = 110;
  readonly treeOverlay = true;
  /** Read again each time a view is turned on, a few seconds apart: a comment just written shows. */
  readonly threadsFresh = 5000;
  /** The page's project: its id, else its full path. */
  protected readonly project: string | number;
  /** The instance's root: its origin, and the path it is served under (`https://example.com/gitlab`). */
  protected readonly root: string;
  protected readonly path: string;

  constructor(project: string) {
    const data = document.body.dataset;
    const id = Number(data.projectId);
    // The page names its project: what comes before it in the URL is the instance's own path.
    const full = data.projectFullPath;
    const at = full ? location.pathname.indexOf(`/${full}/-/`) : -1;
    this.root = location.origin + (at > 0 ? location.pathname.slice(0, at) : '');
    this.path = full && at >= 0 ? full : project;
    this.project = Number.isInteger(id) && id > 0 ? id : this.path;
    this.raw = gitlabRawTemplate(this.root, this.path);
  }

  abstract commits(): Promise<Commits | undefined>;
  abstract files(): Promise<ChangedFile[] | undefined>;
  abstract threads(): Promise<ThreadsResult>;

  /** The comparison of two commits by the REST API: a file not on the page is not there to show. */
  protected async compareFiles(c: Commits): Promise<ChangedFile[] | undefined> {
    try {
      const r = await fetch(compareApi(this.root, this.project, c.base, c.head));
      if (r.ok) return filesFromApi((await r.json() as { diffs?: unknown }).diffs);
      log('The REST API did not compare the commits:', r.status);
    } catch (e) {
      log('The REST API did not compare the commits:', String(e));
    }
    return undefined;
  }

  /** The commits of the Rapid Diffs page, in its first file's data. */
  protected static rapidCommits(): Commits | undefined {
    return rapidFileData(document.querySelector<HTMLElement>(RAPID)?.dataset.fileData)?.commits;
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
    return GitLabDiffsHost.rapid(container)
      ? container.querySelector<HTMLElement>('.rd-diff-file-header, [data-testid="rd-diff-file-header"]')
      : container.querySelector<HTMLElement>('.js-file-title, [data-testid="file-title-container"]');
  }

  async identify(container: HTMLElement): Promise<ChangedFile | undefined> {
    const own = GitLabDiffsHost.rapid(container) ? rapidFileData(container.dataset.fileData)?.file : container.dataset.path ? { path: container.dataset.path } : undefined;
    if (!own) return undefined;
    // The API says whether it was added, deleted or renamed (the classic block has its new path only).
    const known = (await this.files())?.find(f => f.path === own.path);
    return { ...own, ...known };
  }

  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('.rd-diff-file-header-main, .file-header-content') ?? header;
  }

  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    if (GitLabDiffsHost.rapid(container)) {
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
    if (GitLabDiffsHost.rapid(container)) target = document.getElementById(rapidLineAnchor(container.id, side, line));
    else target = container.querySelector<HTMLElement>(`[data-interop-${side === 'L' ? 'old' : 'new'}-line="${line}"][id]`);
    return showTarget(container, target);
  }

  /** The first note's element (`note_<id>`, both pages), else the discussion's (a collapsed one, resolved). */
  goToThread(container: HTMLElement, thread: ReviewThread): boolean {
    const el = document.getElementById(thread.anchor) ?? container.querySelector<HTMLElement>(`[data-discussion-id="${CSS.escape(thread.id)}"]`);
    return showTarget(container, el);
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

  diffStyle(): DiffStyle | undefined {
    return gitlabDiffStyle(location.search, document.cookie);
  }
}

/** A merge request's Changes tab. */
export class GitLabHost extends GitLabDiffsHost {
  readonly key: string;
  private apiFiles: Promise<ChangedFile[] | undefined> | undefined;
  /** The commits being looked for, for the files of a page that shows part of the merge request. */
  private compared: Promise<Commits | undefined> | undefined;
  /** The commits `apiFiles` is the comparison of, on such a page. */
  private filesOf = '';

  constructor(private readonly mr: MergeRequest) {
    super(mr.project);
    // Another version or comparison of the merge request is another page.
    this.key = `gitlab:${this.root}/${this.path}!${mr.iid}${location.search}`;
  }

  private api(path = ''): string {
    return `${mergeRequestApi(this.root, this.project, this.mr.iid)}${path}`;
  }

  commits(): Promise<Commits | undefined> {
    this.compared = this.findCommits();
    return this.compared;
  }

  private async findCommits(): Promise<Commits | undefined> {
    const rapid = GitLabDiffsHost.rapidCommits();
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

  /**
   * `…/merge_requests/:iid/diffs` (GitLab 15.7+), page by page, else `…/changes` of older versions. On a page of one
   * commit, version or comparison, the comparison of its commits: a file the merge request changes elsewhere is not
   * on the page (its block is not there to show).
   */
  files(): Promise<ChangedFile[] | undefined> {
    if (isPartialView(location.search)) return this.comparedFiles();
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

  /** Read once for the commits the page compares; none while they are not found (they may be, later: retryCommits). */
  private async comparedFiles(): Promise<ChangedFile[] | undefined> {
    const c = await this.compared;
    if (!c) return undefined;
    const key = `${c.base}..${c.head}`;
    if (this.filesOf !== key || !this.apiFiles) {
      this.filesOf = key;
      this.apiFiles = this.compareFiles(c);
    }
    return this.apiFiles;
  }

  /**
   * The discussions as the page reads them, `discussions.json`: what the page shows, with the positions GitLab carried
   * to the merge ref, which the page compares when the merge request can be merged, and readable signed out on a
   * public project (gitlab.com's REST API wants a session for notes). Else the REST API's `…/discussions`.
   */
  async threads(): Promise<ThreadsResult> {
    const urlOf = (id: string) => noteUrl(this.root, this.path, this.mr.iid, id);
    const failed: string[] = [];
    try {
      const all: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = await fetch(discussionsUrl(this.root, this.path, this.mr.iid, cursor), { headers: XHR });
        const data: unknown = r.ok ? await r.json() : undefined;
        if (!Array.isArray(data)) throw new Error(r.ok ? 'not a list' : `HTTP ${r.status}`);
        all.push(...data);
        cursor = r.headers.get('x-next-page-cursor') ?? undefined;
        if (!cursor) return { threads: threadsFromGitlab(all, urlOf), source: 'page: discussions.json' };
      }
    } catch (e) {
      failed.push(`discussions.json: ${(e as Error).message ?? e}`);
    }
    try {
      const all: unknown[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await fetch(this.api(`/discussions?per_page=100&page=${page}`));
        const data: unknown = r.ok ? await r.json() : undefined;
        if (!Array.isArray(data)) throw new Error(r.ok ? 'not a list' : `HTTP ${r.status}`);
        all.push(...data);
        if (!r.headers.get('x-next-page')) return { threads: threadsFromGitlab(all, urlOf), source: 'REST API, session' };
      }
    } catch (e) {
      failed.push(`REST API: ${(e as Error).message ?? e}`);
    }
    log('The comments were not read:', failed.join('; '));
    const signedOut = failed.some(f => /HTTP 40[13]/.test(f));
    return { threads: [], problem: `The comments could not be read (${failed.join('; ')})${signedOut ? ': sign in to see them' : ''}.` };
  }
}

/**
 * The Changes tab of a merge request being created (`…/-/merge_requests/new/diffs`, under the source project): what
 * the branches would change, before *Create merge request*. The commits from the page's data (Rapid Diffs), else the
 * REST API: the source branch's head, and its merge base with the target branch (GitLab's diff is from there); the
 * files from the REST API's comparison of them. The base is in the history of the head, so the source project serves
 * both, a fork's too. No review threads: there is no merge request yet.
 */
export class GitLabNewMergeRequestHost extends GitLabDiffsHost {
  readonly key: string;
  private compared: Promise<Commits | undefined> | undefined;
  private apiFiles: Promise<ChangedFile[] | undefined> | undefined;
  private filesOf = '';

  constructor(private readonly mr: NewMergeRequest) {
    super(mr.project);
    this.key = `gitlab:${this.root}/${this.path}!new:${mr.targetProjectId ?? ''}:${mr.target}..${mr.sourceProjectId ?? ''}:${mr.source}`;
  }

  commits(): Promise<Commits | undefined> {
    this.compared = this.findCommits();
    return this.compared;
  }

  private async findCommits(): Promise<Commits | undefined> {
    const rapid = GitLabDiffsHost.rapidCommits();
    if (rapid) return rapid;
    try {
      const source = this.mr.sourceProjectId ?? this.project;
      const target = this.mr.targetProjectId ?? source;
      const h = await fetch(commitApi(this.root, source, this.mr.source));
      const head = h.ok ? (await h.json() as { id?: unknown }).id : undefined;
      if (typeof head !== 'string') {
        log('The REST API did not give the source branch:', h.status);
        return undefined;
      }
      const b = await fetch(mergeBaseApi(this.root, target, [this.mr.target, head]));
      const base = b.ok ? (await b.json() as { id?: unknown }).id : undefined;
      if (typeof base !== 'string') {
        log('The REST API did not give the merge base:', b.status);
        return undefined;
      }
      return commitsFromDiffRefs({ base_sha: base, head_sha: head }, 'REST API, session');
    } catch (e) {
      log('The REST API did not give the commits:', String(e));
      return undefined;
    }
  }

  /** Read once for the commits found; none while they are not (they may be, later: retryCommits). */
  async files(): Promise<ChangedFile[] | undefined> {
    const c = await (this.compared ?? this.commits());
    if (!c) return undefined;
    const key = `${c.base}..${c.head}`;
    if (this.filesOf !== key || !this.apiFiles) {
      this.filesOf = key;
      this.apiFiles = this.compareFiles(c);
    }
    return this.apiFiles;
  }

  async threads(): Promise<ThreadsResult> {
    return { threads: [] };
  }
}

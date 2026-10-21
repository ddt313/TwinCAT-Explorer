// GitHub's "Files changed" page, classic and React. A file's block is the element whose id is GitHub's anchor of
// the file, `diff-<sha256 of the path>` (links to files rely on it); the path is a text of the block's header (or
// of the file's row in GitHub's tree) whose sha256 is that anchor; the header and the tree's panel are found by
// class name and role. The commits come from the page's markup, else from the REST API (public repositories); the
// review comments from the REST API without a token, so for public repositories only.

import { ReviewThread, ThreadsResult } from './comments';
import { PullRequest, commitsInPage, githubRawTemplate, pullDiffUrl, reviewCommentsUrl, shaKeys, threadsFromGithub } from './github';
import { Host, digest, showTarget } from './host';
import { isTwinCatFile } from './model';
import { Commits, Strategy, Theme } from './params';
import { ChangedFile } from './protocol';

const FILE_ANCHOR = /^diff-([0-9a-f]{64})$/;
/** Headers of the classic page and of the React page (its CSS module classes keep their readable part). */
const HEADER = '.file-header, [class*="diff-file-header"], [class*="DiffFileHeader"]';
const PATH_ATTRIBUTES = ['data-path', 'data-tagsearch-path', 'data-file-path', 'title', 'value', 'aria-label'];
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

/**
 * Texts that may be the path of a TwinCAT file, renamed ones (`old → new`, `old renamed to new`) first: the
 * attributes of `shallow` elements, the attributes and texts of `deep` ones and of what is in them.
 */
function pathCandidates(shallow: Element[], deep: Element[]): { path: string; oldPath?: string }[] {
  const texts = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.replace(/[‎‏]/g, '').trim();
    if (t && t.length < 1000 && !t.includes('\n')) texts.add(t);
  };
  const all = deep.flatMap(d => [d, ...d.querySelectorAll('*')]);
  for (const el of [...shallow, ...all]) for (const attr of PATH_ATTRIBUTES) add(el.getAttribute(attr));
  for (const el of all) if (el.matches('a, code, span, h3, [class*="file-name"]')) add(el.textContent);
  const pairs: { path: string; oldPath: string }[] = [];
  const singles: { path: string }[] = [];
  for (const t of texts) {
    for (const sep of [' → ', ' renamed to ', '  ']) {
      const k = t.indexOf(sep);
      if (k > 0) pairs.push({ oldPath: t.slice(0, k).trim(), path: t.slice(k + sep.length).trim() });
    }
    singles.push({ path: t });
  }
  return [...pairs, ...singles].filter(c => isTwinCatFile(c.path));
}

/** The path of a TwinCAT file: the candidate whose sha256 is the file's anchor. */
async function identifyPath(anchor: string, shallow: Element[], deep: Element[]): Promise<{ path: string; oldPath?: string } | undefined> {
  const hash = FILE_ANCHOR.exec(anchor)![1];
  const candidates = pathCandidates(shallow, deep);
  for (const c of candidates) if (await digest('SHA-256', c.path) === hash) return c;
  if (candidates.length) log('No path matches the anchor', anchor, '; candidates:', candidates);
  return undefined;
}

export class GitHubHost implements Host {
  readonly kind = 'github';
  readonly key: string;
  readonly raw: string;
  readonly order: Strategy[] = ['frame', 'worker', 'page'];
  readonly diff: string;
  readonly stickyTop = 150;
  readonly treeOverlay = false;
  /** The REST API without a token allows 60 requests an hour: read again a minute apart at most. */
  readonly threadsFresh = 60000;
  private readonly listed = new Map<string, ChangedFile>();
  private readonly notListed = new Set<string>();

  constructor(private readonly pr: PullRequest) {
    this.key = `github:${location.pathname}`;
    this.raw = githubRawTemplate(pr);
    this.diff = pullDiffUrl(pr);
  }

  async commits(): Promise<Commits | undefined> {
    const markup = document.documentElement.outerHTML;
    const found = commitsInPage(markup);
    if (found) return found;
    log('No commits found in the page; keys with a commit there:',
      [...new Set(shaKeys(markup.replace(/&quot;/g, '"')).map(([k, v]) => `${k}=${v.slice(0, 7)}`))].join(' '));
    try {
      const api = `https://api.github.com/repos/${this.pr.owner}/${this.pr.repo}`;
      const pull = await fetch(`${api}/pulls/${this.pr.number}`);
      if (!pull.ok) throw new Error(`pull request: ${pull.status}`);
      const { head, base } = await pull.json() as { head: { sha: string }; base: { sha: string } };
      const compare = await fetch(`${api}/compare/${base.sha}...${head.sha}?per_page=1`);
      if (!compare.ok) throw new Error(`compare: ${compare.status}`);
      const mergeBase = (await compare.json() as { merge_base_commit: { sha: string } }).merge_base_commit.sha;
      return { base: mergeBase, head: head.sha, source: 'REST API, no token' };
    } catch (e) {
      log('The REST API without a token does not tell either (a private repository needs a token):', String(e));
      return undefined;
    }
  }

  /** `GET …/pulls/{n}/comments`, page by page, without a token: a private repository answers 404. */
  async threads(): Promise<ThreadsResult> {
    const all: unknown[] = [];
    try {
      for (let page = 1; page <= 30; page++) {
        const r = await fetch(reviewCommentsUrl(this.pr, page));
        if (r.status === 404) {
          return { threads: [], problem: 'The review comments of a private repository need a GitHub token, which this version of the extension does not take.' };
        }
        if (r.status === 403 || r.status === 429) {
          return { threads: [], problem: 'GitHub refused to give the review comments without a token (its limit of requests an hour, most likely): try again later.' };
        }
        const data: unknown = r.ok ? await r.json() : undefined;
        if (!Array.isArray(data)) throw new Error(r.ok ? 'not a list' : `HTTP ${r.status}`);
        all.push(...data);
        if (!/rel="next"/.test(r.headers.get('link') ?? '')) break;
      }
    } catch (e) {
      log('The review comments were not read:', String(e));
      return { threads: [], problem: `The review comments could not be read (${(e as Error).message ?? e}).` };
    }
    return { threads: threadsFromGithub(all), source: 'REST API, no token' };
  }

  async files(): Promise<ChangedFile[] | undefined> {
    // The tree reads the pull request's diff itself (only an extension page can: it has no CORS header).
    return undefined;
  }

  /** The TwinCAT files of GitHub's tree, also those whose diff is not loaded yet. */
  async listedFiles(): Promise<ChangedFile[]> {
    for (const link of document.querySelectorAll<HTMLAnchorElement>('[role="treeitem"] a[href^="#diff-"]')) {
      const anchor = link.getAttribute('href')!.slice(1);
      if (!FILE_ANCHOR.test(anchor) || this.listed.has(anchor) || this.notListed.has(anchor)) continue;
      const row = link.closest('[role="treeitem"]')!;
      const file = await identifyPath(anchor, [], [row]);
      if (file) this.listed.set(anchor, { ...file, deleted: row.getAttribute('data-file-deleted') === 'true' });
      else this.notListed.add(anchor);
    }
    return [...this.listed.values()];
  }

  containers(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('div[id^="diff-"]')].filter(c => FILE_ANCHOR.test(c.id));
  }

  header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(HEADER);
  }

  async identify(container: HTMLElement, header: HTMLElement): Promise<ChangedFile | undefined> {
    const file = await identifyPath(container.id, [container], [header]);
    if (!file) return undefined;
    const deleted = header.dataset.fileDeleted === 'true' || container.dataset.fileDeleted === 'true';
    return deleted ? { ...file, deleted } : file;
  }

  toggleSlot(header: HTMLElement): HTMLElement {
    return header.querySelector<HTMLElement>('.file-info, [class*="file-path-section"]') ?? header;
  }

  /** The level where the header and GitHub's diff are siblings: the viewer after the header, the rest hidden. */
  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] } {
    let parent = container;
    for (;;) {
      let top = header;
      while (top.parentElement && top.parentElement !== parent) top = top.parentElement;
      const others = [...parent.children].filter((c): c is HTMLElement => c !== top && !c.classList.contains('tcx-host'));
      if (others.length > 0 || top === header) return { after: top, hide: others };
      parent = top;
    }
  }

  async anchorOf(path: string): Promise<string> {
    return `diff-${await digest('SHA-256', path)}`;
  }

  goToLine(container: HTMLElement, side: 'L' | 'R', line: number): boolean {
    const anchor = `${container.id}${side}${line}`;
    location.hash = anchor;
    const el = document.getElementById(anchor);
    el?.scrollIntoView({ block: 'center' });
    return !!el;
  }

  /** The comment's element: `discussion_r<id>` (classic page), `r<id>`. */
  goToThread(container: HTMLElement, thread: ReviewThread): boolean {
    return showTarget(container, document.getElementById(thread.anchor) ?? document.getElementById(thread.anchor.replace(/^discussion_/, '')));
  }

  goToFile(anchor: string): void {
    // As a click in GitHub's own tree does: GitHub scrolls to the file, loading its diff first when it has to.
    const link = document.querySelector<HTMLAnchorElement>(`a[href="#${anchor}"]`);
    if (link) link.click();
    else location.hash = anchor;
  }

  /** GitHub's panel of the file tree: the element that holds the tree and its filter field (classic and React). */
  treePanel(): HTMLElement | null {
    const tree = document.querySelector('file-tree, [role="tree"][aria-label*="file" i]');
    let el = tree?.parentElement ?? null;
    while (el && el !== document.body && !el.querySelector('input[placeholder*="filter" i], input[aria-label*="filter" i]')) el = el.parentElement;
    return el && el !== document.body ? el : null;
  }

  theme(): Theme {
    const mode = document.documentElement.dataset.colorMode;
    return mode === 'light' || mode === 'dark' ? mode : 'auto';
  }
}

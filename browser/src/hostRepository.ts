// What the pages of a repository's files have in common, whatever the host (GitHub, GitLab, Bitbucket): a folder or a
// file at a ref, in an app that goes from one to the other without loading a page and shows file after file in the
// same element. One page for the content script per repository and ref: the tree stays while the user goes from file
// to file. A file's block is named by its path (`blob:<path>`), and is the page's file only while the page's title
// names it (the URL changes before the app shows the file). The commit is the ref's; the files are all the TwinCAT
// source files at that commit; no review threads. The views and the tree show the objects as they are (`snapshot`).

import { ReviewThread, ThreadsResult } from './comments';
import { Host } from './host';
import { hasObjectView } from './model';
import { Commits, HostKind, Strategy, Theme } from './params';
import { ChangedFile, DiffStyle } from './protocol';

export const SHA = /^[0-9a-f]{40}$/;
/** A block's id: the file's path. */
const PREFIX = 'blob:';
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

/** The path of a URL, decoded part by part, to compare two links. */
function decodedPath(url: string): string | undefined {
  try {
    return new URL(url, location.href).pathname.split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
}

export abstract class RepositoryHost implements Host {
  abstract readonly kind: HostKind;
  abstract readonly order: Strategy[];
  abstract readonly stickyTop: number;
  abstract readonly treeOverlay: boolean;
  readonly threadsFresh = Number.POSITIVE_INFINITY;
  readonly snapshot = true;
  private sha: Promise<Commits | undefined> | undefined;
  private apiFiles: Promise<ChangedFile[] | undefined> | undefined;

  /** `key`: the repository and the ref; `raw`: the host's URL of a raw file. */
  constructor(readonly key: string, readonly raw: string, readonly ref: string) {}

  /** The path of the file the URL names (relative to the ref), when the page is a file's. */
  protected abstract urlFile(): string | undefined;
  /** The name of the file the page shows, from its title (none on a folder's page). */
  protected abstract shownName(): string | undefined;
  /** The element of the file the page shows, with its header and its content. */
  protected abstract fileElement(): HTMLElement | null;
  /** The ref's commit (a sha in the URL is the commit). */
  protected abstract findCommit(): Promise<Commits | undefined>;
  /** All the files at a commit. */
  protected abstract listFiles(sha: string): Promise<string[]>;
  /** The page of a file at the ref. */
  protected abstract fileUrl(path: string): string;
  /** Shows a file's page in the app when the page lists the file in a way other than a link (a tree's row). */
  protected clickRow(_path: string): boolean {
    return false;
  }

  abstract header(container: HTMLElement): HTMLElement | null;
  abstract toggleSlot(header: HTMLElement): HTMLElement;
  abstract layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] };
  abstract goToLine(container: HTMLElement, side: 'L' | 'R', line: number): boolean;
  abstract treePanel(): HTMLElement | null;
  abstract theme(): Theme;

  /** The file the page shows now, if it shows one. */
  protected currentFile(): string | undefined {
    const path = this.urlFile();
    if (!path) return undefined;
    return this.shownName() === path.slice(path.lastIndexOf('/') + 1) ? path : undefined;
  }

  commits(): Promise<Commits | undefined> {
    this.sha = SHA.test(this.ref) ? Promise.resolve({ base: this.ref, head: this.ref, source: 'URL' }) : this.findCommit().catch((e: unknown) => {
      log('The commit of', this.ref, 'was not found:', String(e));
      return undefined;
    });
    return this.sha;
  }

  async threads(): Promise<ThreadsResult> {
    return { threads: [], source: 'none on a repository\'s page' };
  }

  /** The TwinCAT source files at the commit, all the repository's. */
  files(): Promise<ChangedFile[] | undefined> {
    this.apiFiles ??= (async () => {
      const c = await (this.sha ?? this.commits());
      if (!c) {
        this.apiFiles = undefined;
        return undefined;
      }
      try {
        return (await this.listFiles(c.head)).filter(hasObjectView).map(path => ({ path }));
      } catch (e) {
        log('The files at the commit were not listed:', String(e));
        return undefined;
      }
    })();
    return this.apiFiles;
  }

  async listedFiles(): Promise<ChangedFile[]> {
    return [];
  }

  containers(): HTMLElement[] {
    const el = this.currentFile() !== undefined ? this.fileElement() : null;
    return el ? [el] : [];
  }

  blockId(): string {
    return PREFIX + (this.currentFile() ?? '');
  }

  blockById(anchor: string): HTMLElement | null {
    const path = this.currentFile();
    return path !== undefined && anchor === PREFIX + path ? this.fileElement() : null;
  }

  async identify(): Promise<ChangedFile | undefined> {
    const path = this.currentFile();
    return path === undefined ? undefined : { path };
  }

  async anchorOf(path: string): Promise<string> {
    return PREFIX + path;
  }

  goToThread(_container: HTMLElement, _thread: ReviewThread): boolean {
    return false;
  }

  /**
   * The file's page: in the app when the page lists the file (a link to it, or its row in the host's tree), else
   * loaded, as when the app did not show it (an app's router does not follow a history it did not change).
   */
  goToFile(anchor: string): void {
    if (!anchor.startsWith(PREFIX)) return;
    const path = anchor.slice(PREFIX.length);
    const url = this.fileUrl(path);
    const target = decodedPath(url);
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].find(a => a.offsetParent && decodedPath(a.href) === target);
    if (link) link.click();
    else if (!this.clickRow(path)) {
      location.assign(url);
      return;
    }
    setTimeout(() => {
      if (!this.blockById(anchor)) location.assign(url);
    }, 4000);
  }

  diffStyle(): DiffStyle | undefined {
    return undefined;
  }
}

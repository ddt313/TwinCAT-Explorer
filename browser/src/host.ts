// What the content script needs of a review page, whatever the host: one adapter per page (GitHub's "Files changed",
// GitLab's "Changes" and its repository's files, Bitbucket's "Files changed"), the only code that knows the host's DOM
// and URLs.

import { ReviewThread, Side, ThreadsResult } from './comments';
import { Commits, HostKind, Strategy, Theme } from './params';
import { ChangedFile, DiffStyle } from './protocol';

export interface Host {
  readonly kind: HostKind;
  /** The review page: the content script starts over on another one. */
  readonly key: string;
  /** The host's URL of a raw file, with `{sha}` and `{path}`. */
  readonly raw: string;
  /** The ways the frames read a file, in this order. */
  readonly order: Strategy[];
  /** The change's git diff, from which the tree takes its list of files (else from `files`). */
  readonly diff?: string;
  /** Where a revealed object goes, from the top of what scrolls: below the host's sticky bars. */
  readonly stickyTop: number;
  /**
   * The TwinCAT tab covers the host's tree instead of hiding it: the host goes on rendering its rows (GitLab's list
   * renders only the rows it shows), and `goToFile` can still click one.
   */
  readonly treeOverlay: boolean;
  /** How long threads read stay fresh (ms): a view turned on after that reads them again. */
  readonly threadsFresh: number;
  /**
   * The page shows the files at one commit (a repository's files), not a change: the views and the tree show the
   * objects as they are, without a diff; `commits()` gives that commit as both base and head, `files()` all the files.
   */
  readonly snapshot?: boolean;

  /**
   * The commits the page compares: one attempt. The content script makes one a page and keeps its result, nothing
   * found included; it makes another only on a user's action, some seconds later at the soonest (lookup.ts).
   */
  commits(): Promise<Commits | undefined>;
  /** The change's review threads, read with the session (no token), or why they cannot be read. */
  threads(): Promise<ThreadsResult>;
  /** The change's files from the host's API, when it has one the session opens. */
  files(): Promise<ChangedFile[] | undefined>;
  /** The files the page lists itself (its file tree), for the tree when nothing better is there. */
  listedFiles(): Promise<ChangedFile[]>;

  /** The blocks of the files the page shows now. */
  containers(): HTMLElement[];
  /** The id of a block, when its element's id does not name its file (one element shows file after file); else its id. */
  blockId?(container: HTMLElement): string;
  /** The block of such an id, while the page shows it. */
  blockById?(anchor: string): HTMLElement | null;
  header(container: HTMLElement): HTMLElement | null;
  /** The file of a block, or undefined for a block that is not a file. */
  identify(container: HTMLElement, header: HTMLElement): Promise<ChangedFile | undefined>;
  /** Where the toggle goes in a block's header. */
  toggleSlot(header: HTMLElement): HTMLElement;
  /** Where the viewer goes (after this element) and the elements of the host's diff it hides. */
  layout(container: HTMLElement, header: HTMLElement): { after: HTMLElement; hide: HTMLElement[] };

  /** The id of a file's block. */
  anchorOf(path: string): Promise<string>;
  /** Shows a line of the host's diff of a file (its XML): false when the page does not show that line. */
  goToLine(container: HTMLElement, side: Side, line: number): boolean;
  /** Shows a thread in the host's diff of a file: false when the page does not show it (collapsed, not loaded). */
  goToThread(container: HTMLElement, thread: ReviewThread): boolean;
  /** Makes the host bring a file's block into the page (it may load or render it first). */
  goToFile(anchor: string): void;
  /** The host's panel with its file tree (and filter field), where the TwinCAT tab goes. */
  treePanel(): HTMLElement | null;
  theme(): Theme;
  /** The layout of the host's own diffs, as the user set it there; undefined when the page does not show it. */
  diffStyle(): DiffStyle | undefined;
}

export async function digest(algorithm: 'SHA-1' | 'SHA-256', text: string): Promise<string> {
  const hash = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Scrolls an element of a file's block to the middle of the window and makes it the location's target. */
export function showTarget(container: HTMLElement, el: HTMLElement | null): boolean {
  if (!el || !container.contains(el)) return false;
  if (el.id) location.hash = el.id;
  el.scrollIntoView({ block: 'center' });
  return true;
}

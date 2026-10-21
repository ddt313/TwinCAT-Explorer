// What the content script needs of a review page, whatever the host: one adapter per host (GitHub's "Files changed",
// GitLab's "Changes"), the only code that knows the host's DOM and URLs.

import { Commits, Strategy, Theme } from './params';
import { ChangedFile } from './protocol';

export interface Host {
  readonly kind: 'github' | 'gitlab';
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

  /** The commits the page compares. */
  commits(): Promise<Commits | undefined>;
  /** The change's files from the host's API, when it has one the session opens. */
  files(): Promise<ChangedFile[] | undefined>;
  /** The files the page lists itself (its file tree), for the tree when nothing better is there. */
  listedFiles(): Promise<ChangedFile[]>;

  /** The blocks of the files the page shows now. */
  containers(): HTMLElement[];
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
  goToLine(container: HTMLElement, side: 'L' | 'R', line: number): boolean;
  /** Makes the host bring a file's block into the page (it may load or render it first). */
  goToFile(anchor: string): void;
  /** The host's panel with its file tree (and filter field), where the TwinCAT tab goes. */
  treePanel(): HTMLElement | null;
  theme(): Theme;
}

export async function digest(algorithm: 'SHA-1' | 'SHA-256', text: string): Promise<string> {
  const hash = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

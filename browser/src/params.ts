// What the extension's frames are told in their URL's fragment, whatever the host (GitHub, GitLab, Bitbucket): the
// page they are in, how its files are read, which commits it compares, and the file (a viewer) or the list (the tree).
// Platform-free.

export type Theme = 'light' | 'dark' | 'auto';

export type HostKind = 'github' | 'gitlab' | 'bitbucket';
const HOST_KINDS: HostKind[] = ['github', 'gitlab', 'bitbucket'];

/**
 * The ways a frame reads a file, tried in the given order: from the frame itself (an extension page, with host
 * permissions), from the service worker, and from the page (same origin as the host, with the user's session).
 */
export type Strategy = 'frame' | 'worker' | 'page';
const STRATEGIES: Strategy[] = ['frame', 'worker', 'page'];

/** The commits a review page compares: the merge base (or the start it was told) and the head. */
export interface Commits {
  base: string;
  head: string;
  /** Where they were found, for the diagnostics. */
  source: string;
}

export interface FrameParams {
  /** The page's origin (`https://github.com`, `https://gitlab.example.com`): the frame talks to it only. */
  origin: string;
  /** The host's URL of a raw file, with `{sha}` and `{path}` in it. */
  raw: string;
  order: Strategy[];
  base: string;
  head: string;
  theme: Theme;
  source?: string;
}

export interface ViewerParams extends FrameParams {
  /** Path at the head (for a deleted file: at the base) and, when renamed, at the base. */
  path: string;
  oldPath?: string;
  /** The page shows the file as deleted or added: one version only is read. */
  deleted?: boolean;
  added?: boolean;
}

export interface TreeParams extends FrameParams {
  /** The change's git diff, the list of its files (else the page sends the list). */
  diff?: string;
  /** The host whose page the tree is beside: its folders and files go in the order the page shows them. */
  host?: HostKind;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The URL of a file at a commit, from the host's template. */
export function fileUrl(template: string, sha: string, path: string): string {
  return template.replace('{sha}', sha).replace('{path}', path.split('/').map(encodeURIComponent).join('/'));
}

function encodeFrame(p: FrameParams, q: URLSearchParams): void {
  q.set('origin', p.origin);
  q.set('raw', p.raw);
  q.set('order', p.order.join(','));
  q.set('b', p.base);
  q.set('h', p.head);
  q.set('t', p.theme);
  if (p.source) q.set('s', p.source);
}

/** The frame part of a fragment, checked: an origin, a template on that origin, commits. */
function decodeFrame(q: URLSearchParams): FrameParams | undefined {
  const get = (k: string) => q.get(k) ?? '';
  const origin = get('origin');
  const raw = get('raw');
  const order = get('order').split(',').filter((s): s is Strategy => (STRATEGIES as string[]).includes(s));
  if (!/^https?:\/\/[^/?#]+$/.test(origin) || !raw.startsWith(`${origin}/`) || !raw.includes('{sha}') || !raw.includes('{path}')) return undefined;
  if (!SHA.test(get('b')) || !SHA.test(get('h'))) return undefined;
  const theme = get('t');
  return {
    origin, raw, order: order.length ? order : STRATEGIES, base: get('b'), head: get('h'),
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto', source: q.get('s') ?? undefined,
  };
}

export function encodeViewerParams(p: ViewerParams): string {
  const q = new URLSearchParams();
  encodeFrame(p, q);
  q.set('p', p.path);
  if (p.oldPath && p.oldPath !== p.path) q.set('op', p.oldPath);
  if (p.deleted) q.set('d', '1');
  if (p.added) q.set('a', '1');
  return q.toString();
}

export function decodeViewerParams(fragment: string): ViewerParams | undefined {
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  const frame = decodeFrame(q);
  const path = q.get('p');
  if (!frame || !path) return undefined;
  return { ...frame, path, oldPath: q.get('op') ?? undefined, deleted: q.get('d') === '1', added: q.get('a') === '1' };
}

export function encodeTreeParams(p: TreeParams): string {
  const q = new URLSearchParams();
  encodeFrame(p, q);
  if (p.diff) q.set('diff', p.diff);
  if (p.host) q.set('k', p.host);
  return q.toString();
}

export function decodeTreeParams(fragment: string): TreeParams | undefined {
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  const frame = decodeFrame(q);
  const diff = q.get('diff') ?? undefined;
  if (!frame || (diff !== undefined && !diff.startsWith(`${frame.origin}/`))) return undefined;
  const host = q.get('k');
  return { ...frame, diff, host: (HOST_KINDS as (string | null)[]).includes(host) ? host as HostKind : undefined };
}

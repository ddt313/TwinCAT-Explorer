// The tree panel: a pull request's TwinCAT changes the way XAE's Solution Explorer shows a project, in a frame
// of the extension beside GitHub's file tree. Its files come from the pull request's diff (the page's own list
// when the diff cannot be read); it reads each of them at the merge base and at the head, a few at a time, and
// fills the tree as they come. A click shows the object in its file's TwinCAT view.

import { DiffFile, decodeTreeParams, filesInDiff, isTwinCatFile, pullDiffUrl, rawUrl } from './github';
import { buildFileView } from './model';
import { FrameMessage, PageFile, PageMessage } from './protocol';
import { Reader } from './reader';
import { TreeFile, TreeNode, buildTree, treeSummary } from './treeModel';

const GITHUB = 'https://github.com';
const READING_AT_ONCE = 4;

const root = document.getElementById('root')!;
const params = decodeTreeParams(location.hash);
document.documentElement.dataset.theme = params?.theme ?? 'auto';
const post = (m: FrameMessage) => window.parent.postMessage(m, GITHUB);
const reader = new Reader(post);

interface Entry extends TreeFile {
  status?: DiffFile['status'];
}

let entries: Entry[] = [];
/** Where the list of files came from. */
let source: 'diff' | 'page' | undefined;
let problem: string | undefined;
const reading = new Set<Entry>();
const collapsed = new Set<string>();
let selected: string | undefined;
let nodes = new Map<string, TreeNode>();

async function anchorOf(path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return `diff-${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------------ the files and their reading

/** The page's list (blocks and GitHub's file tree), used when the pull request's diff cannot be read. */
function takePageFiles(files: PageFile[]): void {
  let changed = false;
  for (const f of files) {
    const e = entries.find(x => x.anchor === f.anchor);
    if (!e) {
      entries.push({ path: f.path, oldPath: f.oldPath, anchor: f.anchor, status: f.deleted ? 'deleted' : undefined });
      changed = true;
    } else if (f.oldPath && !e.oldPath) {
      // Its block showed the rename: read again at the old path.
      Object.assign(e, { oldPath: f.oldPath, view: undefined, error: undefined });
      changed = true;
    }
  }
  if (changed) {
    render();
    void readAll();
  }
}

async function readEntry(e: Entry): Promise<void> {
  try {
    const head = e.status === 'deleted' ? undefined : await reader.read(`head ${e.path}`, rawUrl(params!, params!.head, e.path));
    const base = e.status === 'added' ? undefined : await reader.read(`base ${e.path}`, rawUrl(params!, params!.base, e.oldPath ?? e.path));
    const after = reader.textOf(head);
    const before = reader.textOf(base);
    if (after === null || before === null) e.error = 'cannot be read';
    else if (after === undefined && before === undefined) e.error = 'in neither version';
    else e.view = buildFileView({ path: e.path, oldPath: e.oldPath, before, after });
  } catch (err) {
    e.error = String((err as Error).message ?? err);
  }
}

async function readAll(): Promise<void> {
  const next = () => {
    const e = entries.find(x => !x.view && !x.error && !reading.has(x));
    if (e) reading.add(e);
    return e;
  };
  await Promise.all(Array.from({ length: READING_AT_ONCE }, async () => {
    for (let e = next(); e; e = next()) {
      await readEntry(e);
      reading.delete(e);
      scheduleRender();
    }
  }));
}

let pageFiles: PageFile[] = [];
window.addEventListener('message', e => {
  if (e.origin !== GITHUB || e.source !== window.parent) return;
  const m = e.data as PageMessage;
  if (m?.tcx !== 'files') return;
  pageFiles = m.files;
  if (source === 'page') takePageFiles(pageFiles);
});

async function main(): Promise<void> {
  post({ tcx: 'ready' });
  if (!params) {
    root.innerHTML = '<p class="note">The tree did not get the pull request to show.</p>';
    return;
  }
  render();
  const diff = await reader.read('the pull request\'s diff', pullDiffUrl(params));
  if (diff.text !== undefined) {
    source = 'diff';
    const list = filesInDiff(diff.text).filter(f => isTwinCatFile(f.path));
    entries = await Promise.all(list.map(async f => ({ path: f.path, oldPath: f.oldPath, status: f.status, anchor: await anchorOf(f.path) })));
  } else {
    source = 'page';
    problem = 'The pull request\'s diff could not be read: the files are the ones the page lists.';
    takePageFiles(pageFiles);
  }
  render();
  await readAll();
}

// ------------------------------------------------------------------ rendering

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
darkScheme.addEventListener('change', () => render());

function iconSrc(name: string): string {
  const dark = params?.theme === 'dark' || (params?.theme !== 'light' && darkScheme.matches);
  return `icons/${dark ? 'dark' : 'light'}/${name}.svg`;
}

let renderTimer: number | undefined;
function scheduleRender(): void {
  if (renderTimer !== undefined) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = undefined;
    render();
  }, 100);
}

function rowsHtml(list: TreeNode[], depth: number, out: string[]): void {
  for (const n of list) {
    nodes.set(n.id, n);
    const open = !collapsed.has(n.id);
    const twisty = n.children.length ? `<span class="twisty${open ? ' open' : ''}"></span>` : '<span class="twisty none"></span>';
    const icon = n.icon ? `<img class="icon" src="${iconSrc(n.icon)}" alt="">` : '';
    const letter = n.change ? `<span class="letter l-${n.change}" title="${n.change}">${LETTER[n.change]}</span>` : '';
    const classes = ['row', n.kind, n.muted ? 'muted' : '', n.change ? `c-${n.change}` : '', n.id === selected ? 'selected' : ''].filter(Boolean).join(' ');
    out.push(`<div class="${classes}" role="treeitem" tabindex="-1" aria-level="${depth + 1}"${n.children.length ? ` aria-expanded="${open}"` : ''}
      data-id="${esc(n.id)}" style="--depth: ${depth}" title="${esc(n.tooltip ?? n.label)}">${twisty}${icon}<span class="label">${esc(n.label)}</span>${n.description ? `<span class="desc">${esc(n.description)}</span>` : ''}${letter}</div>`);
    if (open) rowsHtml(n.children, depth + 1, out);
  }
}

function render(): void {
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  nodes = new Map();
  const s = treeSummary(entries);
  const counts = source ? `${s.files} file${s.files === 1 ? '' : 's'} · ${s.objects} object${s.objects === 1 ? '' : 's'}${s.reading ? ` · reading ${s.reading}…` : ''}` : 'reading the pull request\'s diff…';
  const rows: string[] = [];
  rowsHtml(buildTree(entries), 0, rows);
  const empty = source && entries.length === 0 ? '<p class="note">No TwinCAT file in this pull request.</p>' : '';
  root.innerHTML = `<div class="head"><span class="title">TwinCAT</span><span class="counts">${counts}</span></div>
    ${problem ? `<p class="note">${esc(problem)}</p>` : ''}${empty}<div class="tree" role="tree">${rows.join('')}</div>`;
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

// ------------------------------------------------------------------ interaction

root.addEventListener('click', e => {
  const row = (e.target as Element).closest<HTMLElement>('.row');
  const node = row && nodes.get(row.dataset.id!);
  if (!row || !node) return;
  const onTwisty = (e.target as Element).classList.contains('twisty');
  if (node.children.length && (onTwisty || !node.anchor)) {
    if (collapsed.has(node.id)) collapsed.delete(node.id);
    else collapsed.add(node.id);
    render();
    return;
  }
  if (!node.anchor) return;
  selected = node.id;
  render();
  // A file shows its view from the top; an object, at that object.
  post({ tcx: 'reveal', anchor: node.anchor, ...(node.kind === 'file' ? {} : { objectId: node.objectId, accessor: node.accessor }) });
});

root.addEventListener('keydown', e => {
  const row = (e.target as Element).closest<HTMLElement>('.row');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    row.click();
  }
});

void main().catch(e => {
  root.innerHTML = `<p class="note">The tree failed: ${esc(String((e as Error).stack ?? e))}</p>`;
});

// The tree panel: a pull or merge request's TwinCAT changes the way XAE's Solution Explorer shows a project, in a
// frame of the extension beside the host's file tree. Its files come from the change's git diff (GitHub) or from
// the page, which has them from the host's API (GitLab) or, failing that, from its own list. It reads each file at
// the base and at the head, a few at a time, and fills the tree as they come. A click shows the object in its
// file's TwinCAT view.

import { DiffFile, filesInDiff } from './github';
import { buildFileView, isTwinCatFile } from './model';
import { decodeTreeParams, fileUrl } from './params';
import { ChangedFile, FrameMessage, PageMessage } from './protocol';
import { Reader } from './reader';
import { isKnownSite } from './sites';
import { TreeFile, TreeNode, buildTree, treeSummary } from './treeModel';

const READING_AT_ONCE = 4;

const root = document.getElementById('root')!;
const params = decodeTreeParams(location.hash);
document.documentElement.dataset.theme = params?.theme ?? 'auto';
const post = (m: FrameMessage) => {
  if (params) window.parent.postMessage(m, params.origin);
};
const reader = new Reader(post, params?.origin ?? '', params?.order ?? []);

interface Entry extends TreeFile {
  status?: DiffFile['status'];
}

let entries: Entry[] = [];
/** Where the list of files came from: the change's diff, the host's API (through the page), the page's own list. */
let source: 'diff' | 'api' | 'page' | undefined;
let problem: string | undefined;
const PAGE_LIST = 'The change\'s diff or the host\'s API could not be read: the files are the ones the page lists.';
const reading = new Set<Entry>();
const collapsed = new Set<string>();
let selected: string | undefined;
let nodes = new Map<string, TreeNode>();

// ------------------------------------------------------------------ the files and their reading

/** Files from the page: the host's API (`complete`) or the page's own list, which grows as the page loads. */
function takeFiles(files: ChangedFile[]): void {
  let changed = false;
  for (const f of files.filter(x => isTwinCatFile(x.path))) {
    const e = entries.find(x => x.path === f.path);
    const status: DiffFile['status'] | undefined = f.added ? 'added' : f.deleted ? 'deleted' : f.oldPath ? 'renamed' : undefined;
    if (!e) {
      entries.push({ path: f.path, oldPath: f.oldPath, status });
      changed = true;
    } else if (f.oldPath && !e.oldPath) {
      // The page showed the rename later: read again at the old path.
      Object.assign(e, { oldPath: f.oldPath, status, view: undefined, error: undefined });
      changed = true;
    }
  }
  if (changed) {
    render();
    void readAll();
  }
}

async function readEntry(e: Entry): Promise<void> {
  const p = params!;
  try {
    const head = e.status === 'deleted' ? undefined : await reader.read(`head ${e.path}`, fileUrl(p.raw, p.head, e.path));
    const base = e.status === 'added' ? undefined : await reader.read(`base ${e.path}`, fileUrl(p.raw, p.base, e.oldPath ?? e.path));
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

let pageFiles: { files: ChangedFile[]; complete: boolean } | undefined;
window.addEventListener('message', e => {
  if (!params || e.origin !== params.origin || e.source !== window.parent) return;
  const m = e.data as PageMessage;
  if (m?.tcx !== 'files') return;
  pageFiles = { files: m.files, complete: m.complete };
  // The change's diff, once read, is the list; the page's list only fills in for it.
  if (source === 'diff') return;
  if (source === undefined && params.diff) return;
  source = m.complete ? 'api' : 'page';
  problem = m.complete ? undefined : PAGE_LIST;
  takeFiles(m.files);
});

async function main(): Promise<void> {
  // Only in a page of a site the extension works on, which made this frame.
  if (!params || location.ancestorOrigins?.[0] !== params.origin || !(await isKnownSite(params.origin))) {
    root.innerHTML = '<p class="note">The tree did not get the change to show.</p>';
    return;
  }
  post({ tcx: 'ready' });
  render();
  if (!params.diff) return;
  const diff = await reader.read('the change\'s diff', params.diff);
  if (diff.text !== undefined) {
    source = 'diff';
    entries = filesInDiff(diff.text).filter(f => isTwinCatFile(f.path)).map(f => ({ path: f.path, oldPath: f.oldPath, status: f.status }));
    render();
    await readAll();
    return;
  }
  source = 'page';
  problem = PAGE_LIST;
  if (pageFiles) takeFiles(pageFiles.files);
  render();
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
  const counts = source ? `${s.files} file${s.files === 1 ? '' : 's'} · ${s.objects} object${s.objects === 1 ? '' : 's'}${s.reading ? ` · reading ${s.reading}…` : ''}` : 'reading the list of files…';
  const rows: string[] = [];
  rowsHtml(buildTree(entries), 0, rows);
  const empty = source && entries.length === 0 ? '<p class="note">No TwinCAT file in this change.</p>' : '';
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
  if (node.children.length && (onTwisty || !node.file)) {
    if (collapsed.has(node.id)) collapsed.delete(node.id);
    else collapsed.add(node.id);
    render();
    return;
  }
  if (!node.file) return;
  selected = node.id;
  render();
  // A file shows its view from the top; an object, at that object.
  post({ tcx: 'reveal', path: node.file, ...(node.kind === 'file' ? {} : { objectId: node.objectId, accessor: node.accessor }) });
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

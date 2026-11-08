// The tree panel: a pull or merge request's TwinCAT changes the way XAE's Solution Explorer shows a project, in a
// frame of the extension beside the host's file tree. Its files come from the change's git diff (GitHub) or from
// the page, which has them from the host's API (GitLab) or, failing that, from its own list. It reads each file at
// the base and at the head, a few at a time, and fills the tree as they come, with the number of review threads on
// each object and file (the page sends the threads). A click shows the object in its file's TwinCAT view. The change's
// other files are in the tree too, not read: a click shows the host's diff of the file. Of a repository's page
// (`snapshot`), the TwinCAT files at its commit, which the page lists from the host's API, each read once and shown
// with all its objects, the files folded; a click shows the file's page, at the object.

import { ThreadsResult, placeThreads, threadsOfFile } from './comments';
import { DiffFile, compareGithubPaths, filesInDiff } from './github';
import { compareGitlabPaths } from './gitlab';
import { buildFileView, isTwinCatFile } from './model';
import { decodeTreeParams, fileUrl } from './params';
import { ChangedFile, FrameMessage, PageMessage } from './protocol';
import { Reader } from './reader';
import { frameKnowsSite } from './sites';
import { NodeChange, TreeFile, TreeNode, branches, buildTree, treeSummary } from './treeModel';

const READING_AT_ONCE = 4;

const root = document.getElementById('root')!;
const params = decodeTreeParams(location.hash);
document.documentElement.dataset.theme = params?.theme ?? 'auto';
const post = (m: FrameMessage) => {
  if (params) window.parent.postMessage(m, params.origin);
};
const reader = new Reader(post, params?.origin ?? '', params?.order ?? []);
const snapshot = !!params?.snapshot;
/** The folders and files in the order of the host's page (of a change); XAE's, of the files at a commit. */
const pathOrder = snapshot ? undefined : params?.host === 'gitlab' ? compareGitlabPaths : params?.host === 'github' ? compareGithubPaths : undefined;

interface Entry extends TreeFile {
  status?: DiffFile['status'];
}

/** A file of the change; one that is not TwinCAT's is not read, its change is its status. */
function entry(path: string, oldPath: string | undefined, status: DiffFile['status'] | undefined): Entry {
  const other: NodeChange | undefined = isTwinCatFile(path) ? undefined : status ?? 'modified';
  return { path, oldPath, status, ...(other ? { other } : {}) };
}

let entries: Entry[] = [];
/** Where the list of files came from: the change's diff, the host's API (through the page), the page's own list. */
let source: 'diff' | 'api' | 'page' | undefined;
let problem: string | undefined;
const PAGE_LIST = 'The change\'s diff or the host\'s API could not be read: the files are the ones the page lists.';
const reading = new Set<Entry>();
const collapsed = new Set<string>();
/** Of the files at a commit, the files are folded: these are not. */
const expanded = new Set<string>();
const isOpen = (n: TreeNode) => (snapshot && n.kind === 'file' ? expanded.has(n.id) : !collapsed.has(n.id));
function setOpen(n: TreeNode, open: boolean): void {
  if (snapshot && n.kind === 'file') {
    if (open) expanded.add(n.id);
    else expanded.delete(n.id);
  } else if (open) collapsed.delete(n.id);
  else collapsed.add(n.id);
}
/** Expand All / Collapse All: these nodes and every branch below them. */
function setOpenAll(list: TreeNode[], open: boolean): void {
  for (const n of branches(list)) setOpen(n, open);
  render();
}
/** The tree as last rendered: what the buttons of the head expand and collapse. */
let shown: TreeNode[] = [];
let selected: string | undefined;
let nodes = new Map<string, TreeNode>();

// ------------------------------------------------------------------ the files and their reading

/** Files from the page: the host's API (`complete`) or the page's own list, which grows as the page loads. */
function takeFiles(files: ChangedFile[]): void {
  let changed = false;
  for (const f of files) {
    const e = entries.find(x => x.path === f.path);
    const status: DiffFile['status'] | undefined = f.added ? 'added' : f.deleted ? 'deleted' : f.oldPath ? 'renamed' : undefined;
    if (!e) {
      entries.push(entry(f.path, f.oldPath, status));
      changed = true;
    } else if (f.oldPath && !e.oldPath) {
      // The page showed the rename later: read again at the old path.
      Object.assign(e, entry(f.path, f.oldPath, status), { view: undefined, error: undefined });
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
    const base = e.status === 'added' || snapshot ? undefined : await reader.read(`base ${e.path}`, fileUrl(p.raw, p.base, e.oldPath ?? e.path));
    const after = reader.textOf(head);
    // One version: compared with itself, all its objects are there, unchanged.
    const before = snapshot ? after : reader.textOf(base);
    if (after === null || before === null) e.error = 'cannot be read';
    else if (after === undefined && before === undefined) e.error = 'in neither version';
    else e.view = buildFileView({ path: e.path, oldPath: e.oldPath, before, after });
  } catch (err) {
    e.error = String((err as Error).message ?? err);
  }
}

async function readAll(): Promise<void> {
  const next = () => {
    const e = entries.find(x => !x.other && !x.view && !x.error && !reading.has(x));
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

/** The change's review threads, as the page sent them. */
let threadInfo: ThreadsResult | undefined;

/** The threads on each file read: in all, and under the lines of each of its object views. */
function countThreads(): void {
  if (!params) return;
  for (const e of entries) {
    const list = threadInfo ? threadsOfFile(threadInfo.threads, e.path, e.oldPath) : [];
    e.comments = list.length ? { perObject: e.view ? placeThreads(e.view, list, params).perObject : [], total: list.length } : undefined;
  }
}

let pageFiles: { files: ChangedFile[]; complete: boolean } | undefined;
window.addEventListener('message', e => {
  if (!params || e.origin !== params.origin || e.source !== window.parent) return;
  const m = e.data as PageMessage;
  if (m?.tcx === 'threads' && Array.isArray(m.threads)) {
    threadInfo = { threads: m.threads, source: m.source, problem: m.problem };
    scheduleRender();
    return;
  }
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
  if (!params || location.ancestorOrigins?.[0] !== params.origin || !(await frameKnowsSite(params.origin))) {
    root.innerHTML = '<p class="note">The tree did not get the change to show.</p>';
    return;
  }
  post({ tcx: 'ready' });
  render();
  if (!params.diff) return;
  const diff = await reader.read('the change\'s diff', params.diff);
  if (diff.text !== undefined) {
    source = 'diff';
    entries = filesInDiff(diff.text).map(f => entry(f.path, f.oldPath, f.status));
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
/** A speech bubble, before a count of threads (as in the viewer). */
const BUBBLE = '<svg class="bubble" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v8h-6l-3 3v-3h-2z"/></svg>';
/** Codicons' expand-all and collapse-all, the buttons of VS Code's views. */
const EXPAND_ALL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 9H4v1h5V9z"/><path d="M7 12V7H6v5h1z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg>';
const COLLAPSE_ALL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 9H4v1h5V9z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg>';
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
    const open = isOpen(n);
    const twisty = n.children.length ? `<span class="twisty${open ? ' open' : ''}"></span>` : '<span class="twisty none"></span>';
    const icon = n.icon ? `<img class="icon" src="${iconSrc(n.icon)}" alt="">` : '';
    const letter = n.change ? `<span class="letter l-${n.change}" title="${n.change}">${LETTER[n.change]}</span>` : '';
    const where = n.kind === 'file' ? 'on this file' : 'on its lines';
    const comments = n.comments ? `<span class="cmt" title="${n.comments} comment thread${n.comments === 1 ? '' : 's'} ${where}">${BUBBLE}${n.comments}</span>` : '';
    const classes = ['row', n.kind, n.muted ? 'muted' : '', n.change ? `c-${n.change}` : '', n.id === selected ? 'selected' : ''].filter(Boolean).join(' ');
    out.push(`<div class="${classes}" role="treeitem" tabindex="-1" aria-level="${depth + 1}"${n.children.length ? ` aria-expanded="${open}"` : ''}
      data-id="${esc(n.id)}" style="--depth: ${depth}" title="${esc(n.tooltip ?? n.label)}">${twisty}${icon}<span class="label">${esc(n.label)}</span>${n.description ? `<span class="desc">${esc(n.description)}</span>` : ''}${comments}${letter}</div>`);
    if (open) rowsHtml(n.children, depth + 1, out);
  }
}

function render(): void {
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  nodes = new Map();
  countThreads();
  const s = treeSummary(entries, snapshot);
  const threads = entries.reduce((n, e) => n + (e.comments?.total ?? 0), 0);
  const counts = source ? `${s.files} file${s.files === 1 ? '' : 's'} · ${s.objects} object${s.objects === 1 ? '' : 's'}${
    threads ? ` · ${threads} thread${threads === 1 ? '' : 's'}` : ''}${s.reading ? ` · reading ${s.reading}…` : ''}` : 'reading the list of files…';
  const rows: string[] = [];
  shown = buildTree(entries, pathOrder, snapshot);
  rowsHtml(shown, 0, rows);
  const empty = source && !entries.some(e => !e.other) ? `<p class="note">No TwinCAT file ${snapshot ? 'at this commit' : 'in this change'}.</p>` : '';
  const notes = [problem, threadInfo?.problem && `Comments: ${threadInfo.problem}`].filter(Boolean).map(n => `<p class="note">${esc(n!)}</p>`).join('');
  const buttons = shown.some(n => n.children.length) ? `<span class="actions">
    <button type="button" class="act" data-act="expand" title="Expand All" aria-label="Expand All">${EXPAND_ALL}</button>
    <button type="button" class="act" data-act="collapse" title="Collapse All" aria-label="Collapse All">${COLLAPSE_ALL}</button></span>` : '';
  root.innerHTML = `<div class="head"><span class="title">TwinCAT</span><span class="counts">${counts}</span>${buttons}</div>
    ${notes}${empty}<div class="tree" role="tree">${rows.join('')}</div>`;
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

// ------------------------------------------------------------------ interaction

root.addEventListener('click', e => {
  const act = (e.target as Element).closest<HTMLElement>('.act');
  if (act) {
    setOpenAll(shown, act.dataset.act === 'expand');
    return;
  }
  const row = (e.target as Element).closest<HTMLElement>('.row');
  const node = row && nodes.get(row.dataset.id!);
  if (!row || !node) return;
  const onTwisty = (e.target as Element).classList.contains('twisty');
  if (node.children.length && (onTwisty || !node.file)) {
    // Alt+click, as in VS Code's trees: the node and every branch below it.
    if (e.altKey) setOpenAll([node], !isOpen(node));
    else {
      setOpen(node, !isOpen(node));
      render();
    }
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

// ------------------------------------------------------------------ the context menu of a node with children

let menu: HTMLElement | undefined;
function closeMenu(): void {
  menu?.remove();
  menu = undefined;
}

function openMenu(node: TreeNode, x: number, y: number): void {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  for (const [label, open] of [['Expand All', true], ['Collapse All', false]] as const) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', () => {
      closeMenu();
      setOpenAll([node], open);
      root.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(node.id)}"]`)?.focus();
    });
    m.append(item);
  }
  document.body.append(m);
  // In the frame, beside the pointer: moved in when it would go past the right or the bottom.
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(0, Math.min(x, document.documentElement.clientWidth - r.width))}px`;
  m.style.top = `${Math.max(0, Math.min(y, document.documentElement.clientHeight - r.height))}px`;
  menu = m;
  m.querySelector<HTMLElement>('.menu-item')?.focus();
}

root.addEventListener('contextmenu', e => {
  const row = (e.target as Element).closest<HTMLElement>('.row');
  const node = row && nodes.get(row.dataset.id!);
  if (!row || !node?.children.length) {
    closeMenu();
    return;
  }
  e.preventDefault();
  // From the keyboard (the menu key, Shift+F10): below the row.
  const at = e.button < 0 || (e.clientX === 0 && e.clientY === 0) ? row.getBoundingClientRect() : undefined;
  openMenu(node, at ? at.left + 16 : e.clientX, at ? at.bottom : e.clientY);
});

document.addEventListener('mousedown', e => {
  if (menu && !menu.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', e => {
  if (!menu) return;
  const items = [...menu.querySelectorAll<HTMLElement>('.menu-item')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
window.addEventListener('blur', closeMenu);
window.addEventListener('scroll', closeMenu);
window.addEventListener('resize', closeMenu);

void main().catch(e => {
  root.innerHTML = `<p class="note">The tree failed: ${esc(String((e as Error).stack ?? e))}</p>`;
});

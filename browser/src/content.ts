// Content script on github.com. On a pull request's "Files changed" page it finds the blocks of the TwinCAT
// files, adds a "TwinCAT view" toggle to their headers and, when on, shows the extension's viewer in a frame in
// place of GitHub's diff, with the pull request's coordinates. Above GitHub's file tree it adds a "TwinCAT" tab,
// the extension's tree of the changed objects in a frame, and takes a click there to the object's view. It reads
// no files itself, except for a frame that asks it to (the page has the user's github.com session).
//
// Its hold on GitHub's page: a file's block is the element whose id is GitHub's anchor of the file,
// `diff-<sha256 of the path>` (the classic and the React page both have it, links to files rely on it); the
// path is a text of the block's header (or of the file's row in GitHub's tree) whose sha256 is that anchor; the
// header and the panel of GitHub's tree are found by class name and role.

import { Accessor } from '../../src/core/objectText';
import { fetchText } from './fetchText';
import {
  Commits, PullRequest, Theme, ViewerParams, commitsInPage, encodeParams, encodeTreeParams, filesPage, isTwinCatFile, shaKeys,
} from './github';
import { FrameMessage, PageFile, PageMessage, fetchAllowed } from './protocol';

const EXTENSION = new URL(chrome.runtime.getURL('')).origin;
const VIEWER = chrome.runtime.getURL('viewer.html');
const TREE = chrome.runtime.getURL('tree.html');
const FILE_ANCHOR = /^diff-([0-9a-f]{64})$/;
/** Headers of the classic page and of the React page (its CSS module classes keep their readable part). */
const HEADER = '.file-header, [class*="diff-file-header"], [class*="DiffFileHeader"]';
/** Where a revealed object goes: below GitHub's sticky bars. */
const STICKY_TOP = 150;
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Block {
  anchor: string;
  path: string;
  oldPath?: string;
  deleted: boolean;
  on: boolean;
  frame?: HTMLIFrameElement;
  /** The viewer in the frame has started: it takes messages. */
  ready?: boolean;
  /** An object view the tree asked for, until the viewer has shown it. */
  reveal?: { objectId: string; accessor?: Accessor };
}

/** The TwinCAT files of the page by anchor: a block GitHub renders again keeps its state. */
let blocks = new Map<string, Block>();
/** Anchors looked at that are not TwinCAT files. */
let skipped = new Set<string>();
/** TwinCAT files of GitHub's file tree, also those whose diff is not loaded yet. */
let treeFiles = new Map<string, PageFile>();
let treeSkipped = new Set<string>();
let page = '';
let commits: Promise<Commits | undefined> = Promise.resolve(undefined);

// ------------------------------------------------------------------ the page's commits

/** The merge base and head the page compares: from its markup, else from the REST API (public repositories). */
async function resolveCommits(pr: PullRequest): Promise<Commits | undefined> {
  const markup = document.documentElement.outerHTML;
  const found = commitsInPage(markup);
  if (found) return found;
  log('No commits found in the page; keys with a commit there:',
    [...new Set(shaKeys(markup.replace(/&quot;/g, '"')).map(([k, v]) => `${k}=${v.slice(0, 7)}`))].join(' '));
  try {
    const api = `https://api.github.com/repos/${pr.owner}/${pr.repo}`;
    const pull = await fetch(`${api}/pulls/${pr.number}`);
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

/** The commits, looked for again when the page had not loaded its data yet (a soft navigation to the tab). */
async function currentCommits(pr: PullRequest): Promise<Commits | undefined> {
  return (await commits) ?? (await (commits = resolveCommits(pr)));
}

function theme(): Theme {
  const mode = document.documentElement.dataset.colorMode;
  return mode === 'light' || mode === 'dark' ? mode : 'auto';
}

// ------------------------------------------------------------------ the paths of files

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const PATH_ATTRIBUTES = ['data-path', 'data-tagsearch-path', 'data-file-path', 'title', 'value', 'aria-label'];

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
async function identify(anchor: string, shallow: Element[], deep: Element[]): Promise<{ path: string; oldPath?: string } | undefined> {
  const hash = FILE_ANCHOR.exec(anchor)![1];
  const candidates = pathCandidates(shallow, deep);
  for (const c of candidates) if (await sha256(c.path) === hash) return c;
  if (candidates.length) log('No path matches the anchor', anchor, '; candidates:', candidates);
  return undefined;
}

// ------------------------------------------------------------------ the blocks of the files

/** Where the header and GitHub's diff are siblings: the diff is hidden there, and the viewer put after the header. */
function split(container: HTMLElement, header: HTMLElement): { parent: HTMLElement; top: HTMLElement } {
  let parent = container;
  for (;;) {
    let top = header;
    while (top.parentElement && top.parentElement !== parent) top = top.parentElement;
    const others = [...parent.children].filter(c => c !== top && !c.classList.contains('tcx-host'));
    if (others.length > 0 || top === header) return { parent, top };
    parent = top;
  }
}

function containerOf(block: Block): HTMLElement | null {
  return document.getElementById(block.anchor);
}

/** Shows the viewer or GitHub's diff in a block, as its toggle says. */
async function apply(block: Block): Promise<void> {
  const container = containerOf(block);
  const header = container?.querySelector<HTMLElement>(HEADER);
  if (!container || !header) return;
  const { parent, top } = split(container, header);
  let host = parent.querySelector<HTMLElement>(':scope > .tcx-host');
  if (!block.on) {
    host?.classList.add('tcx-hidden');
    for (const el of parent.querySelectorAll(':scope > .tcx-hidden')) if (el !== host) el.classList.remove('tcx-hidden');
    return;
  }
  if (!host) {
    host = document.createElement('div');
    host.className = 'tcx-host';
    top.after(host);
    const pr = filesPage(location.pathname);
    const c = pr && await currentCommits(pr);
    if (!pr || !c) {
      host.innerHTML = '<p class="tcx-message">TwinCAT view: the commits this page compares were not found (see the console).</p>';
    } else {
      const params: ViewerParams = {
        ...pr, base: c.base, head: c.head, path: block.path, oldPath: block.oldPath, deleted: block.deleted,
        anchor: block.anchor, theme: theme(), source: c.source,
      };
      const frame = document.createElement('iframe');
      frame.className = 'tcx-frame';
      frame.title = `TwinCAT objects of ${block.path}`;
      frame.src = `${VIEWER}#${encodeParams(params)}`;
      host.append(frame);
      block.frame = frame;
      block.ready = false;
    }
  }
  host.classList.remove('tcx-hidden');
  for (const el of parent.children) if (el !== top && el !== host) el.classList.add('tcx-hidden');
}

function setOn(block: Block, on: boolean): void {
  block.on = on;
  const button = containerOf(block)?.querySelector('.tcx-toggle');
  button?.setAttribute('aria-pressed', String(on));
  void apply(block);
}

function addToggle(block: Block, header: HTMLElement): void {
  const existing = header.querySelector('.tcx-toggle');
  if (existing) {
    existing.setAttribute('aria-pressed', String(block.on));
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tcx-toggle';
  button.textContent = 'TwinCAT view';
  button.title = 'Show the TwinCAT objects of this file instead of its XML (Alt+click: all TwinCAT files)';
  button.setAttribute('aria-pressed', String(block.on));
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const on = !block.on;
    for (const b of e.altKey ? blocks.values() : [block]) setOn(b, on);
  });
  const slot = header.querySelector<HTMLElement>('.file-info, [class*="file-path-section"]') ?? header;
  slot.append(button);
}

/** A short message beside a block's toggle. */
function note(block: Block, text: string): void {
  const button = containerOf(block)?.querySelector('.tcx-toggle');
  if (!button) return;
  button.parentElement?.querySelector('.tcx-note')?.remove();
  const span = document.createElement('span');
  span.className = 'tcx-note';
  span.textContent = text;
  button.after(span);
  setTimeout(() => span.remove(), 6000);
}

/** The block of a file's container: identified the first time (undefined for a file that is not TwinCAT), with its toggle. */
async function blockOf(container: HTMLElement): Promise<Block | undefined> {
  const anchor = container.id;
  if (!FILE_ANCHOR.test(anchor) || skipped.has(anchor)) return undefined;
  const header = container.querySelector<HTMLElement>(HEADER);
  if (!header) return undefined;
  let block = blocks.get(anchor);
  if (!block) {
    const file = await identify(anchor, [container], [header]);
    if (!file) {
      skipped.add(anchor);
      return undefined;
    }
    const deleted = header.dataset.fileDeleted === 'true' || container.dataset.fileDeleted === 'true';
    block = { anchor, ...file, deleted, on: false };
    blocks.set(anchor, block);
  }
  addToggle(block, header);
  return block;
}

// ------------------------------------------------------------------ the tree panel

/** The TwinCAT tab is shown instead of GitHub's file tree (remembered across pages). */
let treeOn = false;
let treeFrame: HTMLIFrameElement | undefined;
let treeReady = false;
let lastFiles = '';
chrome.storage.local.get('tcxTree').then(v => {
  treeOn = v.tcxTree === true;
  schedule();
}, () => undefined);

/** GitHub's panel of the file tree: the element that holds the tree and its filter field (classic and React). */
function fileTreePanel(): HTMLElement | null {
  const tree = document.querySelector('file-tree, [role="tree"][aria-label*="file" i]');
  let el = tree?.parentElement ?? null;
  while (el && el !== document.body && !el.querySelector('input[placeholder*="filter" i], input[aria-label*="filter" i]')) el = el.parentElement;
  return el && el !== document.body ? el : null;
}

function sizeTree(): void {
  if (!treeFrame || !treeOn || treeFrame.closest('.tcx-float')) return;
  treeFrame.style.height = `${Math.max(240, Math.floor(window.innerHeight - treeFrame.getBoundingClientRect().top - 12))}px`;
}

/** The tabs above GitHub's tree (or, without one, a floating panel), and the tree's frame when its tab is on. */
async function ensureTreePanel(pr: PullRequest): Promise<void> {
  let box = document.querySelector<HTMLElement>('.tcx-tree');
  if (!box) {
    const panel = fileTreePanel();
    box = document.createElement('div');
    box.className = panel ? 'tcx-tree' : 'tcx-tree tcx-float';
    box.innerHTML = '<div class="tcx-tabs" role="tablist"><button type="button" role="tab" data-tab="files">Files</button>'
      + '<button type="button" role="tab" data-tab="twincat">TwinCAT</button></div>';
    box.addEventListener('click', e => {
      const tab = (e.target as Element).closest<HTMLElement>('[data-tab]');
      if (!tab) return;
      treeOn = tab.dataset.tab === 'twincat';
      void chrome.storage.local.set({ tcxTree: treeOn }).catch(() => undefined);
      void ensureTreePanel(pr);
    });
    if (panel) panel.prepend(box);
    else document.body.append(box);
    treeFrame = undefined;
  }
  for (const tab of box.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String((tab.getAttribute('data-tab') === 'twincat') === treeOn));
  if (!box.classList.contains('tcx-float')) {
    for (const el of box.parentElement!.children) if (el !== box) el.classList.toggle('tcx-hidden', treeOn);
  }
  if (treeOn && !treeFrame) {
    const c = await currentCommits(pr);
    if (!treeOn || box.querySelector('.tcx-tree-frame, .tcx-message')) return;
    if (!c) {
      box.insertAdjacentHTML('beforeend', '<p class="tcx-message">TwinCAT: the commits this page compares were not found (see the console).</p>');
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'tcx-tree-frame';
    frame.title = 'TwinCAT changes';
    frame.src = `${TREE}#${encodeTreeParams({ ...pr, base: c.base, head: c.head, theme: theme(), source: c.source })}`;
    box.append(frame);
    treeFrame = frame;
    treeReady = false;
  }
  treeFrame?.classList.toggle('tcx-hidden', !treeOn);
  box.querySelector('.tcx-message')?.classList.toggle('tcx-hidden', !treeOn);
  sizeTree();
}

/** The TwinCAT files of GitHub's tree: a row's text whose sha256 is the anchor its link goes to. */
async function readFileTree(): Promise<void> {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[role="treeitem"] a[href^="#diff-"]')) {
    const anchor = link.getAttribute('href')!.slice(1);
    if (!FILE_ANCHOR.test(anchor) || treeFiles.has(anchor) || treeSkipped.has(anchor)) continue;
    const row = link.closest('[role="treeitem"]')!;
    const file = await identify(anchor, [], [row]);
    if (file) treeFiles.set(anchor, { ...file, anchor, deleted: row.getAttribute('data-file-deleted') === 'true' });
    else treeSkipped.add(anchor);
  }
}

/** The page's TwinCAT files to the tree (its list when it cannot read the pull request's diff), when they changed. */
function postFiles(): void {
  if (!treeFrame || !treeReady) return;
  const files = new Map(treeFiles);
  for (const b of blocks.values()) files.set(b.anchor, { path: b.path, oldPath: b.oldPath, anchor: b.anchor, deleted: b.deleted });
  const list = [...files.values()];
  const text = JSON.stringify(list);
  if (text === lastFiles) return;
  lastFiles = text;
  const message: PageMessage = { tcx: 'files', files: list };
  treeFrame.contentWindow?.postMessage(message, EXTENSION);
}

/** From the tree: the file's view, at the object view when one was clicked. */
async function reveal(anchor: string, objectId?: string, accessor?: Accessor): Promise<void> {
  let container = document.getElementById(anchor);
  if (!container) {
    // As a click in GitHub's own tree does: GitHub scrolls to the file, loading its diff first when it has to.
    const link = document.querySelector<HTMLAnchorElement>(`a[href="#${anchor}"]`);
    if (link) link.click();
    else location.hash = anchor;
    for (let i = 0; i < 40 && !(container = document.getElementById(anchor)); i++) await sleep(250);
  }
  if (!container) return;
  const block = await blockOf(container);
  container.scrollIntoView({ block: 'start' });
  if (!block) return;
  block.reveal = objectId ? { objectId, accessor } : undefined;
  if (!block.on) setOn(block, true);
  else postReveal(block);
}

function postReveal(block: Block): void {
  if (!block.reveal || !block.ready || !block.frame) return;
  const message: PageMessage = { tcx: 'reveal', ...block.reveal };
  block.frame.contentWindow?.postMessage(message, EXTENSION);
}

// ------------------------------------------------------------------ scanning the page

let scanning = false;
let rescan = false;

async function scan(): Promise<void> {
  if (scanning) {
    rescan = true;
    return;
  }
  scanning = true;
  try {
    const pr = filesPage(location.pathname);
    const key = pr ? location.pathname : '';
    if (key !== page) {
      page = key;
      blocks = new Map();
      skipped = new Set();
      treeFiles = new Map();
      treeSkipped = new Set();
      commits = pr ? resolveCommits(pr) : Promise.resolve(undefined);
      if (pr) void commits.then(c => log('Pull request', pr, c ? `compares ${c.base.slice(0, 7)}...${c.head.slice(0, 7)} (${c.source})` : 'commits unknown'));
    }
    if (!pr) return;
    const known = blocks.size;
    for (const container of document.querySelectorAll<HTMLElement>('div[id^="diff-"]')) {
      const block = await blockOf(container);
      // GitHub may have rendered the block or its diff again: the viewer comes back, the diff goes.
      if (block?.on) void apply(block);
    }
    if (blocks.size > known) log(`${blocks.size - known} more TwinCAT file(s); ${blocks.size} in all, ${skipped.size} other file(s)`);
    await readFileTree();
    await ensureTreePanel(pr);
    postFiles();
  } finally {
    scanning = false;
    if (rescan) {
      rescan = false;
      schedule();
    }
  }
}

let timer: number | undefined;
function schedule(): void {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    void scan();
  }, 200);
}

// ------------------------------------------------------------------ the frames' messages

function goto(block: Block, anchor: string): void {
  setOn(block, false);
  requestAnimationFrame(() => {
    location.hash = anchor;
    const line = document.getElementById(anchor);
    if (line) line.scrollIntoView({ block: 'center' });
    else note(block, 'That line is not in GitHub\'s diff here (not loaded yet?).');
  });
}

/** A frame's fetch from the page, which has the user's github.com session. */
function answerFetch(frame: HTMLIFrameElement, m: Extract<FrameMessage, { tcx: 'fetch' }>): void {
  if (!fetchAllowed(m.url)) return;
  void fetchText(m.url, 'same-origin').then(result => {
    const answer: PageMessage = { tcx: 'fetched', id: m.id, result };
    frame.contentWindow?.postMessage(answer, EXTENSION);
  });
}

window.addEventListener('message', e => {
  if (e.origin !== EXTENSION) return;
  const m = e.data as FrameMessage;
  if (treeFrame && e.source === treeFrame.contentWindow) {
    if (m?.tcx === 'ready') {
      treeReady = true;
      lastFiles = '';
      postFiles();
    } else if (m?.tcx === 'reveal' && FILE_ANCHOR.test(m.anchor)) void reveal(m.anchor, m.objectId, m.accessor);
    else if (m?.tcx === 'fetch') answerFetch(treeFrame, m);
    return;
  }
  const block = [...blocks.values()].find(b => b.frame?.contentWindow === e.source);
  const frame = block?.frame;
  if (!block || !frame) return;
  switch (m?.tcx) {
    case 'ready':
      block.ready = true;
      postReveal(block);
      return;
    case 'height':
      frame.style.height = `${Math.max(40, Math.ceil(m.height))}px`;
      return;
    case 'goto':
      if (m.anchor.startsWith(block.anchor)) goto(block, m.anchor);
      return;
    case 'scroll':
      block.reveal = undefined;
      window.scrollTo({ top: frame.getBoundingClientRect().top + window.scrollY + m.top - STICKY_TOP, behavior: 'smooth' });
      return;
    case 'fetch':
      answerFetch(frame, m);
      return;
    default:
      return;
  }
});

let sizing = false;
const resize = () => {
  if (sizing) return;
  sizing = true;
  requestAnimationFrame(() => {
    sizing = false;
    sizeTree();
  });
};
window.addEventListener('resize', resize);
window.addEventListener('scroll', resize, { passive: true });

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
schedule();

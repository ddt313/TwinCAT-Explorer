// Content script on review pages: GitHub's "Files changed", GitLab's "Changes" (gitlab.com, and the self-managed
// instances the user turned the extension on for). It finds the blocks of the TwinCAT files, adds a "TwinCAT view"
// toggle to their headers and, when on, shows the extension's viewer in a frame in place of the host's diff, with
// the change's coordinates. Above the host's file tree it adds a "TwinCAT" tab, the extension's tree of the changed
// objects in a frame, and takes a click there to the object's view. It reads no files itself, except for a frame
// that asks it to (the page has the user's session). Everything that knows a host's DOM is in its adapter (host.ts).

import { Accessor } from '../../src/core/objectText';
import { fetchText } from './fetchText';
import { filesPage } from './github';
import { isChangesTab, mergeRequestPage } from './gitlab';
import { Host } from './host';
import { GitHubHost } from './hostGithub';
import { GitLabHost } from './hostGitlab';
import { isTwinCatFile } from './model';
import { Commits, ViewerParams, encodeTreeParams, encodeViewerParams } from './params';
import { ChangedFile, FrameMessage, PageMessage, fetchAllowed } from './protocol';

const EXTENSION = new URL(chrome.runtime.getURL('')).origin;
const VIEWER = chrome.runtime.getURL('viewer.html');
const TREE = chrome.runtime.getURL('tree.html');
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The adapter of the page, when it is a review page. */
function detectHost(): Host | undefined {
  if (location.hostname === 'github.com') {
    const pr = filesPage(location.pathname);
    return pr ? new GitHubHost(pr) : undefined;
  }
  const mr = mergeRequestPage(location.pathname);
  if (mr && isChangesTab(location.pathname) && document.body?.dataset.page?.startsWith('projects:merge_requests')) return new GitLabHost(mr);
  return undefined;
}

interface Block extends ChangedFile {
  anchor: string;
  on: boolean;
  frame?: HTMLIFrameElement;
  /** The viewer in the frame has started: it takes messages. */
  ready?: boolean;
  /** An object view the tree asked for, until the viewer has shown it. */
  reveal?: { objectId: string; accessor?: Accessor };
}

let host: Host | undefined;
let page = '';
/** The TwinCAT files of the page by their block's id: a block the host renders again keeps its state. */
let blocks = new Map<string, Block>();
/** Blocks looked at that are not TwinCAT files. */
let skipped = new Set<string>();
let commits: Promise<Commits | undefined> = Promise.resolve(undefined);

/** The commits, looked for again when the page had not loaded its data yet (a soft navigation to the tab). */
async function currentCommits(): Promise<Commits | undefined> {
  if (!host) return undefined;
  return (await commits) ?? (await (commits = host.commits()));
}

// ------------------------------------------------------------------ the blocks of the files

function containerOf(block: Block): HTMLElement | null {
  return document.getElementById(block.anchor);
}

/** Shows the viewer or the host's diff in a block, as its toggle says. */
async function apply(block: Block): Promise<void> {
  const container = containerOf(block);
  const header = container && host?.header(container);
  if (!host || !container || !header) return;
  const { after, hide } = host.layout(container, header);
  let frameHost = after.parentElement?.querySelector<HTMLElement>(':scope > .tcx-host');
  if (!block.on) {
    frameHost?.classList.add('tcx-hidden');
    for (const el of hide) el.classList.remove('tcx-hidden');
    return;
  }
  if (!frameHost) {
    frameHost = document.createElement('div');
    frameHost.className = 'tcx-host';
    after.after(frameHost);
    const c = await currentCommits();
    if (!c) {
      frameHost.innerHTML = '<p class="tcx-message">TwinCAT view: the commits this page compares were not found (see the console).</p>';
    } else {
      const params: ViewerParams = {
        origin: location.origin, raw: host.raw, order: host.order, base: c.base, head: c.head, theme: host.theme(), source: c.source,
        path: block.path, oldPath: block.oldPath, deleted: block.deleted, added: block.added,
      };
      const frame = document.createElement('iframe');
      frame.className = 'tcx-frame';
      frame.title = `TwinCAT objects of ${block.path}`;
      frame.src = `${VIEWER}#${encodeViewerParams(params)}`;
      frameHost.append(frame);
      block.frame = frame;
      block.ready = false;
    }
  }
  frameHost.classList.remove('tcx-hidden');
  for (const el of hide) el.classList.add('tcx-hidden');
}

function setOn(block: Block, on: boolean): void {
  block.on = on;
  containerOf(block)?.querySelector('.tcx-toggle')?.setAttribute('aria-pressed', String(on));
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
  host!.toggleSlot(header).append(button);
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
  const header = host?.header(container);
  if (!host || skipped.has(anchor) || !header) return undefined;
  let block = blocks.get(anchor);
  if (!block) {
    const file = await host.identify(container, header);
    if (!file || !isTwinCatFile(file.path)) {
      skipped.add(anchor);
      return undefined;
    }
    block = { ...file, anchor, on: false };
    blocks.set(anchor, block);
  }
  addToggle(block, header);
  return block;
}

// ------------------------------------------------------------------ the tree panel

/** The TwinCAT tab is shown instead of the host's file tree (remembered across pages). */
let treeOn = false;
let treeFrame: HTMLIFrameElement | undefined;
let treeReady = false;
let lastFiles = '';

function sizeTree(): void {
  // A floating panel and a panel over the host's tree have the height their CSS gives them.
  if (!treeFrame || !treeOn || treeFrame.closest('.tcx-float, .tcx-overlay')) return;
  treeFrame.style.height = `${Math.max(240, Math.floor(window.innerHeight - treeFrame.getBoundingClientRect().top - 12))}px`;
}

/** The tabs above the host's tree (or, without one, a floating panel), and the tree's frame when its tab is on. */
async function ensureTreePanel(): Promise<void> {
  if (!host) return;
  let box = document.querySelector<HTMLElement>('.tcx-tree');
  const panel = host.treePanel();
  // The host's tree came after the floating panel (GitLab renders its sidebar later): the tabs go there.
  if (box?.classList.contains('tcx-float') && panel) {
    box.remove();
    box = null;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = panel ? 'tcx-tree' : 'tcx-tree tcx-float';
    box.innerHTML = '<div class="tcx-tabs" role="tablist"><button type="button" role="tab" data-tab="files">Files</button>'
      + '<button type="button" role="tab" data-tab="twincat">TwinCAT</button></div>';
    box.addEventListener('click', e => {
      const tab = (e.target as Element).closest<HTMLElement>('[data-tab]');
      if (!tab) return;
      treeOn = tab.dataset.tab === 'twincat';
      void chrome.storage.local.set({ tcxTree: treeOn }).catch(() => undefined);
      void ensureTreePanel();
    });
    if (panel) panel.prepend(box);
    else document.body.append(box);
    treeFrame = undefined;
  }
  for (const tab of box.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String((tab.getAttribute('data-tab') === 'twincat') === treeOn));
  if (!box.classList.contains('tcx-float')) {
    const parent = box.parentElement!;
    if (host.treeOverlay) {
      // Over the host's tree, which stays rendered underneath.
      box.classList.toggle('tcx-overlay', treeOn);
      if (getComputedStyle(parent).position === 'static') parent.classList.add('tcx-overlay-parent');
    } else {
      for (const el of parent.children) if (el !== box) el.classList.toggle('tcx-hidden', treeOn);
    }
  }
  if (treeOn && !treeFrame) {
    const c = await currentCommits();
    if (!treeOn || box.querySelector('.tcx-tree-frame, .tcx-message')) return;
    if (!c) {
      box.insertAdjacentHTML('beforeend', '<p class="tcx-message">TwinCAT: the commits this page compares were not found (see the console).</p>');
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'tcx-tree-frame';
    frame.title = 'TwinCAT changes';
    frame.src = `${TREE}#${encodeTreeParams({
      origin: location.origin, raw: host.raw, order: host.order, base: c.base, head: c.head, theme: host.theme(), source: c.source, diff: host.diff,
    })}`;
    box.append(frame);
    treeFrame = frame;
    treeReady = false;
  }
  treeFrame?.classList.toggle('tcx-hidden', !treeOn);
  box.querySelector('.tcx-message')?.classList.toggle('tcx-hidden', !treeOn);
  sizeTree();
}

/** The change's TwinCAT files to the tree: the host's API when it has one, else the page's list, when they changed. */
async function postFiles(): Promise<void> {
  if (!host || !treeFrame || !treeReady) return;
  const api = await host.files();
  let files: ChangedFile[];
  if (api) files = api;
  else {
    const byPath = new Map((await host.listedFiles()).map(f => [f.path, f]));
    for (const b of blocks.values()) byPath.set(b.path, { path: b.path, oldPath: b.oldPath, added: b.added, deleted: b.deleted });
    files = [...byPath.values()];
  }
  const text = JSON.stringify([files, !!api]);
  if (text === lastFiles || !treeFrame) return;
  lastFiles = text;
  const message: PageMessage = { tcx: 'files', files, complete: !!api };
  treeFrame.contentWindow?.postMessage(message, EXTENSION);
}

/** From the tree: the file's view, at the object view when one was clicked. */
async function reveal(path: string, objectId?: string, accessor?: Accessor): Promise<void> {
  if (!host) return;
  const anchor = await host.anchorOf(path);
  let container = document.getElementById(anchor);
  if (!container) {
    host.goToFile(anchor);
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
    const found = detectHost();
    const key = found?.key ?? '';
    if (key !== page) {
      page = key;
      host = found;
      blocks = new Map();
      skipped = new Set();
      lastFiles = '';
      document.querySelector('.tcx-tree')?.remove();
      treeFrame = undefined;
      commits = host ? host.commits() : Promise.resolve(undefined);
      if (host) void commits.then(c => log(host?.kind, page, c ? `compares ${c.base.slice(0, 7)}...${c.head.slice(0, 7)} (${c.source})` : 'commits unknown'));
    }
    if (!host) return;
    const known = blocks.size;
    for (const container of host.containers()) {
      const block = await blockOf(container);
      // The host may have rendered the block or its diff again: the viewer comes back, the diff goes.
      if (block?.on) void apply(block);
    }
    if (blocks.size > known) log(`${blocks.size - known} more TwinCAT file(s); ${blocks.size} in all, ${skipped.size} other file(s)`);
    await ensureTreePanel();
    await postFiles();
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

function goto(block: Block, side: 'L' | 'R', line: number): void {
  setOn(block, false);
  requestAnimationFrame(() => {
    const container = containerOf(block);
    if (!host || !container || !host.goToLine(container, side, line)) note(block, 'That line is not in the page\'s diff here (not loaded yet?).');
  });
}

/** What scrolls an element into view: GitLab's panels scroll inside the page, GitHub's page itself. */
function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** A frame's fetch from the page, which has the user's session: the page's own origin and the host's built-in hosts. */
function answerFetch(frame: HTMLIFrameElement, m: Extract<FrameMessage, { tcx: 'fetch' }>): void {
  if (!fetchAllowed(m.url, [location.origin])) return;
  void fetchText(m.url, 'same-origin').then(result => {
    const answer: PageMessage = { tcx: 'fetched', id: m.id, result };
    frame.contentWindow?.postMessage(answer, EXTENSION);
  });
}

function onFrameMessage(e: MessageEvent): void {
  if (e.origin !== EXTENSION) return;
  const m = e.data as FrameMessage;
  if (treeFrame && e.source === treeFrame.contentWindow) {
    if (m?.tcx === 'ready') {
      treeReady = true;
      lastFiles = '';
      void postFiles();
    } else if (m?.tcx === 'reveal' && typeof m.path === 'string') void reveal(m.path, m.objectId, m.accessor);
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
      if ((m.side === 'L' || m.side === 'R') && Number.isInteger(m.line) && m.line > 0) goto(block, m.side, m.line);
      return;
    case 'scroll': {
      block.reveal = undefined;
      const scroller = scrollerOf(frame);
      const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      scroller.scrollBy({ top: frame.getBoundingClientRect().top + m.top - top - (host?.stickyTop ?? 0), behavior: 'smooth' });
      return;
    }
    case 'fetch':
      answerFetch(frame, m);
      return;
    default:
      return;
  }
}

let sizing = false;
const resize = () => {
  if (sizing) return;
  sizing = true;
  requestAnimationFrame(() => {
    sizing = false;
    sizeTree();
  });
};
// Once per page: the service worker also starts the script in the tab a site was just turned on in.
const started = globalThis as { tcxContent?: boolean };
if (!started.tcxContent) {
  started.tcxContent = true;
  window.addEventListener('message', onFrameMessage);
  window.addEventListener('resize', resize);
  // Any scrolling, of the page or of a panel in it (scroll events do not bubble; they are seen while captured).
  document.addEventListener('scroll', resize, { capture: true, passive: true });
  chrome.storage.local.get('tcxTree').then(v => {
    treeOn = v.tcxTree === true;
    schedule();
  }, () => undefined);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}

// Content script on review pages: GitHub's "Files changed", GitLab's "Changes" (gitlab.com, and the self-managed
// instances the user turned the extension on for). It finds the blocks of the TwinCAT files, adds a "TwinCAT view"
// toggle to their headers and, when on, shows the extension's viewer in a frame in place of the host's diff, with
// the change's coordinates and the review threads on the file. Above the host's file tree it adds a "TwinCAT" tab,
// the extension's tree of the changed objects in a frame, and takes a click there to the object's view. A jump from
// a view to the host's diff (an XML line, a thread), and a navigation to an anchor in the diff a view hides, turn
// that view off, with a button beside the toggle to come back. It reads no files itself, except for a frame that
// asks it to (the page has the user's session). On a site the user set to start by hand (sites.ts), it does nothing
// until the popup starts it in the tab. Everything that knows a host's DOM is in its adapter (host.ts).

import { Accessor } from '../../src/core/objectText';
import { ReviewThread, Side, ThreadsResult, currentPosition, threadsOfFile } from './comments';
import { fetchText } from './fetchText';
import { filesPage } from './github';
import { isChangesTab, mergeRequestPage } from './gitlab';
import { Host } from './host';
import { GitHubHost } from './hostGithub';
import { GitLabHost } from './hostGitlab';
import { Lookup } from './lookup';
import { hasObjectView } from './model';
import { startsOnItsOwn } from './sites';
import { Back, Found, anchorId, leaveFor } from './navigation';
import { Commits, ViewerParams, encodeTreeParams, encodeViewerParams } from './params';
import { ChangedFile, DiffStyle, FrameMessage, PageMessage, Reveal, fetchAllowed } from './protocol';

const EXTENSION = new URL(chrome.runtime.getURL('')).origin;
const VIEWER = chrome.runtime.getURL('viewer.html');
const TREE = chrome.runtime.getURL('tree.html');
/** How long after an attempt that found no commits a user's action may look for them again (ms). */
const COMMITS_AGAIN = 5000;
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
  /** A place in the view the tree or the back button asked for, until the viewer is told. */
  reveal?: Reveal;
  /** Where the view was left for the host's diff, while it is off: where the back button goes. */
  back?: Back;
}

let host: Host | undefined;
let page = '';
/** The TwinCAT files of the page by their block's id: a block the host renders again keeps its state. */
let blocks = new Map<string, Block>();
/** Blocks looked at that are not TwinCAT files. */
let skipped = new Set<string>();
/**
 * The commits the page compares: one attempt a page, which all who ask share, and its result kept, nothing found
 * included (on a big page an attempt took most of a second of its main thread; on GitLab it makes requests).
 */
let commits: Lookup<Commits> | undefined;

function currentCommits(): Promise<Commits | undefined> {
  return commits?.get() ?? Promise.resolve(undefined);
}

const compares = (c: Commits | undefined) => (c ? `compares ${c.base.slice(0, 7)}...${c.head.slice(0, 7)} (${c.source})` : 'commits unknown');

/**
 * On a user's action (a view or the TwinCAT tab turned on): the commits looked for again when they were not found,
 * some seconds after the last attempt at the soonest, as the page may not have had its data then (a soft navigation
 * to the tab). Found now, they take the place of the messages that said they were not (`apply`, `ensureTreePanel`).
 */
function retryCommits(): void {
  const lookup = commits;
  void lookup?.retry()?.then(c => {
    if (lookup !== commits) return;
    log(host?.kind, page, compares(c), '(looked for again)');
    if (c) schedule();
  });
}

// ------------------------------------------------------------------ the review threads

let threads: Promise<ThreadsResult> | undefined;
let threadsAsked = 0;
/** The threads last read, as the frames were told. */
let lastThreads: ThreadsResult | undefined;

/** The review threads, read when a frame first wants them, and again (`fresh`) once the host's time to keep them is over. */
function loadThreads(fresh = false): Promise<ThreadsResult> {
  if (!host) return Promise.resolve({ threads: [] });
  if (!threads || (fresh && Date.now() - threadsAsked > host.threadsFresh)) {
    threadsAsked = Date.now();
    const asked = host.threads().catch((e: unknown): ThreadsResult => ({ threads: [], problem: `The comments could not be read (${String(e)}).` }));
    threads = asked;
    void asked.then(r => {
      if (threads !== asked) return;
      const changed = JSON.stringify(r) !== JSON.stringify(lastThreads);
      lastThreads = r;
      if (!changed) return;
      log(r.problem ?? `${r.threads.length} review thread(s) on files (${r.source})`);
      for (const b of blocks.values()) if (b.ready) postThreads(b.frame, b);
      if (treeReady) postThreads(treeFrame);
    });
  }
  return threads;
}

/** To a viewer the threads on its file, to the tree all of them. */
function postThreads(frame: HTMLIFrameElement | undefined, block?: Block): void {
  if (!frame || !lastThreads) return;
  const { source, problem } = lastThreads;
  const list = block ? threadsOfFile(lastThreads.threads, block.path, block.oldPath) : lastThreads.threads;
  const message: PageMessage = { tcx: 'threads', threads: list, source, problem };
  frame.contentWindow?.postMessage(message, EXTENSION);
}

/** The line of the host's diff a thread is on, for the page's commits (and its line at the base, for an unchanged one). */
function threadLine(thread: ReviewThread): { side: Side; line: number; oldLine?: number } | undefined {
  const c = commits?.value;
  const p = c && currentPosition(thread, c);
  if (p?.newLine) return { side: 'R', line: p.newLine, oldLine: p.oldLine };
  if (p?.oldLine) return { side: 'L', line: p.oldLine };
  return undefined;
}

// ------------------------------------------------------------------ the layout of the host's diffs

/** The layout of the host's own diffs as the views were told: they follow the user's setting there. */
let lastStyle: DiffStyle | undefined;

function postStyle(block: Block): void {
  if (!lastStyle || !block.ready) return;
  const message: PageMessage = { tcx: 'style', style: lastStyle };
  block.frame?.contentWindow?.postMessage(message, EXTENSION);
}

/** Looks at the host's layout again (the page changed: the user may have set the other one); the views follow a change. */
function checkStyle(): void {
  const style = host?.diffStyle();
  if (!style || style === lastStyle) return;
  log('The page\'s diffs are', style);
  lastStyle = style;
  for (const b of blocks.values()) postStyle(b);
}

// ------------------------------------------------------------------ the blocks of the files

function containerOf(block: Block): HTMLElement | null {
  return document.getElementById(block.anchor);
}

/** The viewer's frame in a block, in place of what its host element had (nothing yet, or the message of no commits). */
function addViewer(block: Block, frameHost: HTMLElement, c: Commits): void {
  if (!host) return;
  const params: ViewerParams = {
    origin: location.origin, raw: host.raw, order: host.order, base: c.base, head: c.head, theme: host.theme(), source: c.source,
    path: block.path, oldPath: block.oldPath, deleted: block.deleted, added: block.added,
  };
  const frame = document.createElement('iframe');
  frame.className = 'tcx-frame';
  frame.title = `TwinCAT objects of ${block.path}`;
  frame.src = `${VIEWER}#${encodeViewerParams(params)}`;
  frameHost.replaceChildren(frame);
  block.frame = frame;
  block.ready = false;
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
    if (c) addViewer(block, frameHost, c);
    else frameHost.innerHTML = '<p class="tcx-message">TwinCAT view: the commits this page compares were not found (see the console).</p>';
  } else if (commits?.value && frameHost.querySelector(':scope > .tcx-message')) {
    // Not found when the view was first turned on, found since (retryCommits).
    addViewer(block, frameHost, commits.value);
  }
  frameHost.classList.remove('tcx-hidden');
  for (const el of hide) el.classList.add('tcx-hidden');
}

/**
 * Turns a block's view on or off. On, which is a user's action (the toggle, the back button, the tree), the viewer goes
 * to the place asked for, the commits are looked for again if they were not found, and the threads read again if old.
 */
function setOn(block: Block, on: boolean): void {
  block.on = on;
  const container = containerOf(block);
  container?.querySelector('.tcx-toggle')?.setAttribute('aria-pressed', String(on));
  if (on) {
    block.back = undefined;
    container?.querySelector('.tcx-back')?.remove();
    retryCommits();
    void loadThreads(true);
  }
  void apply(block).then(() => {
    if (on) postReveal(block);
  });
}

function addToggle(block: Block, header: HTMLElement): void {
  const existing = header.querySelector('.tcx-toggle');
  if (existing) {
    existing.setAttribute('aria-pressed', String(block.on));
    addBack(block);
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tcx-toggle';
  button.textContent = 'TwinCAT view';
  button.title = 'Show the TwinCAT objects of this file instead of its XML (Alt+click: all TwinCAT files)';
  button.setAttribute('aria-pressed', String(block.on));
  host!.toggleSlot(header).append(button);
  addBack(block);
}

/**
 * The clicks on the toggles and back buttons, taken on the document before the host sees them: a block the host
 * renders again from a copy of its markup (GitLab's classic page, as it scrolls) has the buttons without listeners.
 */
function onButtonClick(e: MouseEvent): void {
  const button = (e.target as Element | null)?.closest?.('.tcx-toggle, .tcx-back');
  const block = button && [...blocks.values()].find(b => containerOf(b)?.contains(button));
  if (!button || !block) return;
  e.preventDefault();
  e.stopPropagation();
  if (button.classList.contains('tcx-back')) {
    block.reveal = block.back;
    setOn(block, true);
    return;
  }
  const on = !block.on;
  for (const b of e.altKey ? blocks.values() : [block]) {
    b.reveal = undefined;
    setOn(b, on);
  }
}

/** Leaves a block's view for the host's diff, with the way back to where it was. */
function leave(block: Block, back: Back): void {
  setOn(block, false);
  block.back = back;
  addBack(block);
}

/** While a view is off after a jump to the host's diff: a button beside the toggle to come back where it was left. */
function addBack(block: Block): void {
  const toggle = containerOf(block)?.querySelector('.tcx-toggle');
  if (!toggle || !block.back || block.on || toggle.parentElement?.querySelector('.tcx-back')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tcx-back';
  button.textContent = '↩ Back to the TwinCAT view';
  button.title = 'Show this file\'s TwinCAT view again, where you left it';
  toggle.after(button);
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

/**
 * The block of a file's container: identified the first time, with its toggle. Undefined for a file without a TwinCAT
 * view (not TwinCAT, or a project file such as a `.tsproj`, which keeps the host's diff).
 */
async function blockOf(container: HTMLElement): Promise<Block | undefined> {
  const anchor = container.id;
  const header = host?.header(container);
  if (!host || skipped.has(anchor) || !header) return undefined;
  let block = blocks.get(anchor);
  if (!block) {
    const file = await host.identify(container, header);
    if (!file || !hasObjectView(file.path)) {
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
      if (treeOn) retryCommits();
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
    // Once the message says they were not found, the scans do not wait for the commits: a user's action looks for
    // them again (retryCommits), and scans again when it finds them.
    const c = box.querySelector('.tcx-message') ? commits?.value : await currentCommits();
    if (!treeOn || treeFrame || !box.isConnected) return;
    if (c) {
      box.querySelector('.tcx-message')?.remove();
      const frame = document.createElement('iframe');
      frame.className = 'tcx-tree-frame';
      frame.title = 'TwinCAT changes';
      frame.src = `${TREE}#${encodeTreeParams({
        origin: location.origin, raw: host.raw, order: host.order, base: c.base, head: c.head, theme: host.theme(), source: c.source, diff: host.diff, host: host.kind,
      })}`;
      box.append(frame);
      treeFrame = frame;
      treeReady = false;
    } else if (!box.querySelector('.tcx-message')) {
      box.insertAdjacentHTML('beforeend', '<p class="tcx-message">TwinCAT: the commits this page compares were not found (see the console).</p>');
    }
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
  // An object of a view shown already: the viewer scrolls to it from where the page is, not from the file's top.
  const shown = !!objectId && !!block?.on && !!block.ready;
  if (!shown) container.scrollIntoView({ block: 'start' });
  if (!block) return;
  block.reveal = objectId ? { objectId, accessor } : undefined;
  if (!block.on) setOn(block, true);
  else postReveal(block);
}

/** Tells the viewer the place asked for, once: it opens it when it can, and says where it is. */
function postReveal(block: Block): void {
  if (!block.reveal || !block.ready || !block.frame) return;
  const message: PageMessage = { tcx: 'reveal', ...block.reveal };
  block.reveal = undefined;
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
      threads = undefined;
      lastThreads = undefined;
      commits = undefined;
      lastStyle = undefined;
      if (found) {
        // Looked for only once a view or the TwinCAT tab is on: a page where neither is used asks the host nothing.
        commits = new Lookup(() => found.commits().then(c => {
          log(found.kind, key, compares(c));
          return c;
        }, (e: unknown) => {
          log('The commits could not be looked for:', String(e));
          return undefined;
        }), COMMITS_AGAIN);
      }
    }
    if (!host) return;
    const known = blocks.size;
    for (const container of host.containers()) {
      const block = await blockOf(container);
      // The host may have rendered the block or its diff again: the viewer comes back, the diff goes.
      if (block?.on) void apply(block);
    }
    checkStyle();
    if (blocks.size > known) log(`${blocks.size - known} more TwinCAT file(s); ${blocks.size} in all, ${skipped.size} other file(s)`);
    await ensureTreePanel();
    await postFiles();
    // A hash set without a hashchange (history.pushState) shows here, with the page's next change.
    checkHash();
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

// ------------------------------------------------------------------ navigation

/** Shows a line of the host's diff; an unchanged line by its line at the head, else by its line at the base. */
function showLine(container: HTMLElement, side: Side, line: number, oldLine?: number): boolean {
  return !!host && (host.goToLine(container, side, line) || (side === 'R' && !!oldLine && host.goToLine(container, 'L', oldLine)));
}

/** From a viewer: the host's diff at a line of the XML. */
function goto(block: Block, side: Side, line: number, oldLine?: number): void {
  leave(block, { xml: { side, line } });
  requestAnimationFrame(() => {
    const container = containerOf(block);
    if (!container || !showLine(container, side, line, oldLine)) note(block, 'That line is not in the page\'s diff here (outside its changes, or not loaded yet).');
  });
}

/** From a viewer: a thread in the host's diff, else the line it is on. */
function gotoThread(block: Block, id: string, side?: Side, line?: number, oldLine?: number): void {
  const thread = lastThreads?.threads.find(t => t.id === id);
  leave(block, { thread: id });
  requestAnimationFrame(() => {
    const container = containerOf(block);
    if (!host || !container) return;
    if (thread && host.goToThread(container, thread)) return;
    if (side && line && showLine(container, side, line, oldLine)) return;
    note(block, 'That thread is not in the page\'s diff here (collapsed, or not loaded yet).');
  });
}

let lastHash = location.hash;

/** The block an element is in, and whether in the host's diff of the file, which the view hides. */
function foundIn(el: HTMLElement): Found | undefined {
  for (const b of blocks.values()) {
    const container = containerOf(b);
    const header = container && host?.header(container);
    if (!host || !container || !header || !container.contains(el)) continue;
    return { anchor: b.anchor, inDiff: host.layout(container, header).hide.some(h => h.contains(el)) };
  }
  return undefined;
}

/** A navigation to an anchor in the diff a view hides (a link to a comment or a line) turns the view off (navigation.ts). */
function checkHash(): void {
  if (location.hash === lastHash) return;
  lastHash = location.hash;
  if (!host || blocks.size === 0) return;
  const id = anchorId(location.hash);
  const el = id ? document.getElementById(id) : null;
  const views = [...blocks.values()].map(b => ({ anchor: b.anchor, path: b.path, oldPath: b.oldPath, on: b.on }));
  const target = leaveFor(location.hash, views, el ? foundIn(el) : undefined, lastThreads?.threads ?? []);
  const block = target && blocks.get(target.anchor);
  if (!target || !block) return;
  log('The page went to', id, 'in the diff of', block.path, ': its TwinCAT view goes off');
  leave(block, target.back);
  requestAnimationFrame(() => {
    const container = containerOf(block);
    if (!host || !container) return;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
    if (target.thread && host.goToThread(container, target.thread)) return;
    const line: { side: Side; line: number; oldLine?: number } | undefined = target.line ?? (target.thread ? threadLine(target.thread) : undefined);
    if (line) showLine(container, line.side, line.line, line.oldLine);
  });
}

// ------------------------------------------------------------------ the frames' messages

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
      postThreads(treeFrame);
      void loadThreads();
    } else if (m?.tcx === 'reveal' && typeof m.path === 'string') void reveal(m.path, m.objectId, m.accessor);
    else if (m?.tcx === 'fetch') answerFetch(treeFrame, m);
    return;
  }
  const block = [...blocks.values()].find(b => b.frame?.contentWindow === e.source);
  const frame = block?.frame;
  if (!block || !frame) return;
  const isLine = (side: unknown, line: unknown): line is number => (side === 'L' || side === 'R') && Number.isInteger(line) && (line as number) > 0;
  const oldLine = (m?.tcx === 'goto' || m?.tcx === 'thread') && isLine('L', m.oldLine) ? m.oldLine : undefined;
  switch (m?.tcx) {
    case 'ready':
      block.ready = true;
      postStyle(block);
      postReveal(block);
      postThreads(frame, block);
      void loadThreads();
      return;
    case 'height':
      frame.style.height = `${Math.max(40, Math.ceil(m.height))}px`;
      return;
    case 'goto':
      if (isLine(m.side, m.line)) goto(block, m.side, m.line, oldLine);
      return;
    case 'thread':
      if (typeof m.id === 'string') gotoThread(block, m.id, isLine(m.side, m.line) ? m.side : undefined, isLine(m.side, m.line) ? m.line : undefined, oldLine);
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
// Once per page: the service worker also starts the script in the tab a site was just turned on in, and the popup in
// a tab of a site that starts by hand (`tcxByHand`), where the script the page loaded stays idle.
const started = globalThis as { tcxContent?: boolean; tcxByHand?: boolean };

function start(): void {
  if (started.tcxContent) return;
  started.tcxContent = true;
  window.addEventListener('message', onFrameMessage);
  window.addEventListener('resize', resize);
  window.addEventListener('hashchange', checkHash);
  window.addEventListener('popstate', checkHash);
  document.addEventListener('click', onButtonClick, { capture: true });
  // Any scrolling, of the page or of a panel in it (scroll events do not bubble; they are seen while captured).
  document.addEventListener('scroll', resize, { capture: true, passive: true });
  chrome.storage.local.get('tcxTree').then(v => {
    treeOn = v.tcxTree === true;
    schedule();
  }, () => undefined);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}

if (started.tcxByHand) start();
else void startsOnItsOwn(location.origin).then(on => on && start(), start);

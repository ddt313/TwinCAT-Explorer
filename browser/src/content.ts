// Content script on github.com. On a pull request's "Files changed" page it finds the blocks of the TwinCAT
// files, adds a "TwinCAT view" toggle to their headers and, when on, shows the extension's viewer in a frame in
// place of GitHub's diff, with the pull request's coordinates. It reads no files itself, except for a viewer
// that asks it to (the page has the user's github.com session).
//
// Its hold on GitHub's page: a file's block is the element whose id is GitHub's anchor of the file,
// `diff-<sha256 of the path>` (the classic and the React page both have it, links to files rely on it); the
// path is a text of the block's header whose sha256 is that anchor; the header is found by class name.

import { fetchText } from './fetchText';
import { Commits, PullRequest, Theme, ViewerParams, commitsInPage, encodeParams, filesPage, isTwinCatFile, shaKeys } from './github';
import { FrameMessage, PageMessage, fetchAllowed } from './protocol';

const EXTENSION = new URL(chrome.runtime.getURL('')).origin;
const VIEWER = chrome.runtime.getURL('viewer.html');
const FILE_ANCHOR = /^diff-([0-9a-f]{64})$/;
/** Headers of the classic page and of the React page (its CSS module classes keep their readable part). */
const HEADER = '.file-header, [class*="diff-file-header"], [class*="DiffFileHeader"]';
const log = (...args: unknown[]) => console.debug('[TwinCAT view]', ...args);

interface Block {
  anchor: string;
  path: string;
  oldPath?: string;
  deleted: boolean;
  on: boolean;
  frame?: HTMLIFrameElement;
}

/** The TwinCAT files of the page by anchor: a block GitHub renders again keeps its state. */
let blocks = new Map<string, Block>();
/** Anchors looked at that are not TwinCAT files. */
let skipped = new Set<string>();
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

// ------------------------------------------------------------------ the blocks of the files

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The texts of a block's header that may be the path of a TwinCAT file, renamed ones (`old → new`, `old renamed to
 * new`) first: attributes and texts, whatever the markup is.
 */
function pathCandidates(container: Element, header: Element): { path: string; oldPath?: string }[] {
  const texts = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.replace(/[‎‏]/g, '').trim();
    if (t && t.length < 1000 && !t.includes('\n')) texts.add(t);
  };
  for (const el of [container, header, ...header.querySelectorAll('*')]) {
    for (const attr of ['data-path', 'data-tagsearch-path', 'data-file-path', 'title', 'value', 'aria-label']) add(el.getAttribute(attr));
  }
  for (const el of header.querySelectorAll('a, code, span, h3, [class*="file-name"]')) add(el.textContent);
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

/** The path of a TwinCAT file's block: the candidate whose sha256 is the block's anchor. */
async function identify(container: HTMLElement, header: Element): Promise<{ path: string; oldPath?: string } | undefined> {
  const hash = FILE_ANCHOR.exec(container.id)![1];
  const candidates = pathCandidates(container, header);
  for (const c of candidates) if (await sha256(c.path) === hash) return c;
  if (candidates.length) log('No path in the header of', container.id, 'matches its anchor; candidates:', candidates);
  return undefined;
}

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

function theme(): Theme {
  const mode = document.documentElement.dataset.colorMode;
  return mode === 'light' || mode === 'dark' ? mode : 'auto';
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
    let c = await commits;
    // The page may have loaded its data after the first look (a soft navigation to the tab).
    if (pr && !c) c = await (commits = resolveCommits(pr));
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
      commits = pr ? resolveCommits(pr) : Promise.resolve(undefined);
      if (pr) void commits.then(c => log('Pull request', pr, c ? `compares ${c.base.slice(0, 7)}...${c.head.slice(0, 7)} (${c.source})` : 'commits unknown'));
    }
    if (!pr) return;
    let found = 0;
    for (const container of document.querySelectorAll<HTMLElement>('div[id^="diff-"]')) {
      const anchor = container.id;
      if (!FILE_ANCHOR.test(anchor) || skipped.has(anchor)) continue;
      const header = container.querySelector<HTMLElement>(HEADER);
      if (!header) continue;
      let block = blocks.get(anchor);
      if (!block) {
        const file = await identify(container, header);
        if (!file) {
          skipped.add(anchor);
          continue;
        }
        const deleted = header.dataset.fileDeleted === 'true' || container.dataset.fileDeleted === 'true';
        block = { anchor, ...file, deleted, on: false };
        blocks.set(anchor, block);
        found++;
      }
      addToggle(block, header);
      // GitHub may have rendered the block or its diff again: the viewer comes back, the diff goes.
      if (block.on) void apply(block);
    }
    if (found) log(`${found} more TwinCAT file(s); ${blocks.size} in all, ${skipped.size} other file(s)`);
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

// ------------------------------------------------------------------ the viewers' messages

function goto(block: Block, anchor: string): void {
  setOn(block, false);
  requestAnimationFrame(() => {
    location.hash = anchor;
    const line = document.getElementById(anchor);
    if (line) line.scrollIntoView({ block: 'center' });
    else note(block, 'That line is not in GitHub\'s diff here (not loaded yet?).');
  });
}

window.addEventListener('message', e => {
  if (e.origin !== EXTENSION) return;
  const block = [...blocks.values()].find(b => b.frame?.contentWindow === e.source);
  const frame = block?.frame;
  if (!block || !frame) return;
  const m = e.data as FrameMessage;
  switch (m?.tcx) {
    case 'height':
      frame.style.height = `${Math.max(40, Math.ceil(m.height))}px`;
      return;
    case 'goto':
      if (m.anchor.startsWith(block.anchor)) goto(block, m.anchor);
      return;
    case 'fetch':
      if (!fetchAllowed(m.url)) return;
      void fetchText(m.url, 'same-origin').then(result => {
        const answer: PageMessage = { tcx: 'fetched', id: m.id, result };
        frame.contentWindow?.postMessage(answer, EXTENSION);
      });
      return;
    default:
      return;
  }
});

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
schedule();

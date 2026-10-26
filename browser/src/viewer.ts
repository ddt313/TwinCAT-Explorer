// The TwinCAT view of one file of a pull or merge request, in a frame of the extension inside the host's page
// (GitHub's "Files changed", GitLab's "Changes"), where the page's CSP and CSS do not reach it. It reads the file at the merge base and at the head and
// shows its objects in the layout of the VS Code extension's commit diff: each changed object with its
// Declaration diff above its Implementation diff (unified or split, as the host's own diffs), unchanged objects collapsed,
// and the review threads on the file under the lines they are on (comments.ts), which the page sends. Read-only.
// On a page of a repository's file (`snapshot`), the file at that one commit: each object with its Declaration above
// its Implementation, as they are, each line with the line of the file it is on.

import { KIND_WORD } from '../../src/core/treeLabels';
import { LineRef, PlacedThread, Placement, ReviewNote, Side, ThreadsResult, placeThreads, unresolvedCount, xmlLineIndex } from './comments';
import { Span, highlightLines } from './highlight';
import { lineChange } from './lineDiff';
import { DiffLine, FileView, ObjectView, SplitRow, buildFileView, splitRows } from './model';
import { decodeViewerParams, fileUrl } from './params';
import { DiffStyle, FrameMessage, PageMessage, Reveal } from './protocol';
import { ALL_WAYS, Attempt, Reader } from './reader';
import { isKnownSite } from './sites';
/** Unchanged lines shown around a change; longer runs are folded. */
const CONTEXT = 3;
/**
 * The layout of the diffs: the host's own, as the page tells it, and when it changes there; else (the page does not
 * show it) the last one chosen with the view's switch, kept. The switch changes the views of the page until the host's
 * layout changes.
 */
const STYLE_KEY = 'tcxDiffStyle';
let diffStyle: DiffStyle = 'unified';
let hostStyle: DiffStyle | undefined;

const root = document.getElementById('root')!;
const params = decodeViewerParams(location.hash);
document.documentElement.dataset.theme = params?.theme ?? 'auto';
const post = (m: FrameMessage) => {
  if (params) window.parent.postMessage(m, params.origin);
};

// ------------------------------------------------------------------ reading the two versions

const files = new Reader(post, params?.origin ?? '', params?.order ?? []);
const probes: Attempt[] = [];

async function main(): Promise<void> {
  // Only in a page of a site the extension works on, which made this frame: no other page gets the user's files.
  if (!params || location.ancestorOrigins?.[0] !== params.origin || !(await isKnownSite(params.origin))) {
    root.innerHTML = '<p class="notice error">This view did not get the file to show.</p>';
    return;
  }
  post({ tcx: 'ready' });
  const head = params.deleted ? undefined : await files.read('head', fileUrl(params.raw, params.head, params.path));
  const base = params.added || params.snapshot ? undefined : await files.read('base', fileUrl(params.raw, params.base, params.oldPath ?? params.path));
  const after = files.textOf(head);
  // One version: compared with itself, every object is unchanged and shows all its lines.
  const before = params.snapshot ? after : files.textOf(base);
  if (after === null || before === null || (after === undefined && before === undefined)) {
    view = undefined;
    root.innerHTML = `<p class="notice error">The file could not be read with this browser's session (see
      Diagnostics). Turn the toggle off for the page's diff.</p>${diagnosticsHtml()}`;
    return;
  }
  view = buildFileView({ path: params.path, oldPath: params.oldPath, before, after });
  const kept = await chrome.storage.local.get(STYLE_KEY).then(v => (v[STYLE_KEY] === 'split' ? 'split' : 'unified'), () => 'unified' as const);
  diffStyle = hostStyle ?? kept;
  place();
  render();
  if (pendingReveal) void reveal(pendingReveal);
}

// ------------------------------------------------------------------ rendering

let view: FileView | undefined;
const highlights = new Map<string, { old: Span[][]; now: Span[][]; pairs: Map<number, [number, number]> }>();
/** The review threads on the file, as the page sent them, and where they go in the view. */
let threadInfo: ThreadsResult | undefined;
let placement: Placement | undefined;
let lineIndex: Record<Side, Map<number, LineRef>> | undefined;

function place(): void {
  placement = view && threadInfo && params ? placeThreads(view, threadInfo.threads, params) : undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = (sha: string) => sha.slice(0, 7);
const snapshot = !!params?.snapshot;
const split = () => diffStyle === 'split' && !snapshot;

const BADGE: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D' };
/** A speech bubble, before a count of threads. */
const BUBBLE = '<svg class="bubble" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v8h-6l-3 3v-3h-2z"/></svg>';

/** The threads under the lines and sections of an object view. */
function objectThreads(i: number): PlacedThread[] {
  if (!placement) return [];
  return [...placement.lines, ...placement.sections].filter(([key]) => key.startsWith(`${i}:`)).flatMap(([, list]) => list);
}

const threadsAt = (i: number, s: number, k: number) => placement?.lines.get(`${i}:${s}:${k}`);
const sectionHasThreads = (i: number, s: number) => view!.objects[i].sections[s].lines.some((_, k) => threadsAt(i, s, k));

function render(): void {
  const v = view!;
  const parts = [summaryHtml(v)];
  // An unchanged object with threads is shown on its own, open, not in a group; each object of one version too.
  const grouped = (i: number) => !snapshot && v.objects[i].change === 'unchanged' && !(placement?.perObject[i]);
  for (let i = 0; i < v.objects.length;) {
    if (!grouped(i)) {
      parts.push(objectHtml(i, true));
      i++;
      continue;
    }
    let j = i;
    while (j < v.objects.length && grouped(j)) j++;
    parts.push(groupHtml(i, j));
    i = j;
  }
  parts.push(commentListsHtml());
  parts.push(diagnosticsHtml());
  root.innerHTML = parts.join('');
}

/** Renders again (threads came or changed), keeping what was opened or closed. */
function rerender(): void {
  const key = (box: HTMLElement) => (box.classList.contains('group') ? `g${box.dataset.from}-${box.dataset.to}`
    : box.classList.contains('obj') ? `o${box.dataset.o}` : `s${box.dataset.o}:${box.dataset.s}`);
  const boxes = '.group, .obj, .sec[data-s]';
  const was = new Map([...root.querySelectorAll<HTMLElement>(boxes)].map(b => [key(b), b.classList.contains('open')]));
  const threadsOpen = new Map([...root.querySelectorAll<HTMLDetailsElement>('details.thread')].map(d => [d.dataset.t, d.open]));
  render();
  // Groups first, then the objects they render, then the sections those render.
  for (const selector of ['.group', '.obj', '.sec[data-s]']) {
    for (const box of root.querySelectorAll<HTMLElement>(selector)) {
      const open = was.get(key(box));
      if (open !== undefined && open !== box.classList.contains('open')) setOpen(box, open);
    }
  }
  for (const d of root.querySelectorAll<HTMLDetailsElement>('details.thread')) {
    const open = threadsOpen.get(d.dataset.t);
    if (open !== undefined) d.open = open;
  }
}

function summaryHtml(v: FileView): string {
  if (snapshot) {
    const n = v.objects.length;
    let out = `<div class="summary"><span class="title">TwinCAT objects</span>${n ? ` · ${n} object${n === 1 ? '' : 's'}` : ''}
      <span class="muted right">read-only · ${params ? `<code>${short(params.head)}</code>` : ''}</span></div>`;
    if (v.note) out += `<p class="notice">${esc(v.note)}</p>`;
    if (v.error) out += `<p class="notice error">${esc(v.error)}</p>`;
    return out;
  }
  const counts = (['modified', 'added', 'deleted'] as const).filter(k => v.counts[k] > 0).map(k => `${v.counts[k]} ${k}`);
  if (v.counts.unchanged > 0) counts.push(`${v.counts.unchanged} unchanged`);
  const file = v.change === 'added' ? 'New file' : v.change === 'deleted' ? 'Deleted file' : v.oldPath ? `Renamed from <code>${esc(v.oldPath)}</code>` : '';
  const commits = params ? `<code>${short(params.base)}</code> → <code>${short(params.head)}</code>` : '';
  const threads = threadInfo?.threads ?? [];
  const open = unresolvedCount(threads);
  const comments = threads.length ? ` · <span class="cmt">${BUBBLE}${threads.length} thread${threads.length === 1 ? '' : 's'}${open ? `, ${open} unresolved` : ''}</span>` : '';
  let out = `<div class="summary"><span class="title">TwinCAT objects</span>${counts.length ? ` · ${counts.join(' · ')}` : ''}${file ? ` · ${file}` : ''}${comments}
    <span class="muted right">read-only · ${commits}</span>${styleSwitchHtml()}</div>`;
  if (v.metadataOnly) out += `<p class="notice">No code changed: ${esc(v.metadataOnly)}</p>`;
  if (v.note) out += `<p class="notice">${esc(v.note)}</p>`;
  if (v.error) out += `<p class="notice error">${esc(v.error)}</p>`;
  if (threadInfo?.problem) out += `<p class="notice">Comments: ${esc(threadInfo.problem)}</p>`;
  return out;
}

/** Unified | Split, for all the views of the page. */
function styleSwitchHtml(): string {
  const button = (style: DiffStyle, label: string) => `<button type="button" data-style="${style}" aria-pressed="${diffStyle === style}">${label}</button>`;
  return `<span class="style" role="group" aria-label="Diff layout">${button('unified', 'Unified')}${button('split', 'Split')}</span>`;
}

function setStyle(style: DiffStyle): void {
  if (style === diffStyle) return;
  diffStyle = style;
  if (view) rerender();
}

function shortName(o: ObjectView): string {
  return o.depth === 0 ? o.label : o.label.slice(o.label.indexOf('.') + 1);
}

function groupHtml(from: number, to: number): string {
  const objects = view!.objects.slice(from, to);
  const names = objects.slice(0, 6).map(shortName).join(', ') + (objects.length > 6 ? ', …' : '');
  return `<div class="group" data-from="${from}" data-to="${to}">
    <div class="group-head" role="button" tabindex="0" aria-expanded="false"><span class="chev"></span>${objects.length} unchanged object${objects.length === 1 ? '' : 's'}
    <span class="muted">${esc(names)}</span></div><div class="group-body"></div></div>`;
}

function stat(added: number, deleted: number): string {
  return `<span class="stat">${added ? `<span class="plus">+${added}</span>` : ''}${deleted ? ` <span class="minus">−${deleted}</span>` : ''}</span>`;
}

/** The number of threads of an object view, for its header. */
function countHtml(list: PlacedThread[]): string {
  if (list.length === 0) return '';
  const open = unresolvedCount(list.map(p => p.thread));
  const title = `${list.length} comment thread${list.length === 1 ? '' : 's'}${open ? `, ${open} unresolved` : ''}`;
  return `<span class="cmt${open ? ' open' : ''}" title="${title}">${BUBBLE}${list.length}</span>`;
}

function objectHtml(i: number, open: boolean): string {
  const o = view!.objects[i];
  const badge = BADGE[o.change];
  return `<div class="obj obj-${o.change} d${o.depth}${open ? ' open' : ''}" data-o="${i}">
    <div class="obj-head" role="button" tabindex="0" aria-expanded="${open}"><span class="chev"></span>${badge ? `<span class="badge b-${o.change}" title="${o.change}">${badge}</span>` : ''}<span class="name">${esc(o.label)}</span><span class="kind">${o.accessor ? `${o.accessor} accessor` : KIND_WORD[o.kind]}</span>${o.renamedFrom ? `<span class="renamed">renamed from ${esc(o.renamedFrom)}</span>` : ''}${countHtml(objectThreads(i))}${snapshot ? '' : o.change === 'unchanged' ? '<span class="muted">unchanged</span>' : stat(o.added, o.deleted)}</div>
    <div class="obj-body">${open ? o.sections.map((_, s) => sectionHtml(i, s)).join('') : ''}</div></div>`;
}

function sectionHtml(i: number, s: number): string {
  const o = view!.objects[i];
  const sec = o.sections[s];
  const label = `<span class="sec-label">${esc(sec.label)}</span>`;
  if (!sec.text) {
    const note = snapshot ? 'graphical code is not shown, the page\'s file has its XML'
      : sec.status === 'same' ? 'unchanged' : `${sec.status}: graphical code is not shown, the page's diff has its XML`;
    const link = sec.status === 'deleted' ? xmlLink('L', sec.oldXml) : sec.status !== 'same' || snapshot ? xmlLink('R', sec.newXml) : '';
    const threads = placement?.sections.get(`${i}:${s}`);
    return `<div class="sec sec-${sec.status}"><div class="sec-head">${label}<span class="muted">${note}</span>${link}</div>${
      threads ? `<div class="sec-threads">${threads.map(p => threadHtml(p)).join('')}</div>` : ''}</div>`;
  }
  if (sec.lines.length === 0) return `<div class="sec"><div class="sec-head">${label}<span class="muted">empty</span></div></div>`;
  // In a changed object an unchanged section is folded, unless a thread is on it; an unchanged object, once opened, shows its code.
  const folded = sec.status === 'same' && o.change !== 'unchanged' && !sectionHasThreads(i, s);
  const status = snapshot ? '' : sec.status === 'changed' ? stat(sec.added, sec.deleted) : `<span class="muted">${sec.status === 'same' ? 'unchanged' : sec.status}</span>`;
  return `<div class="sec sec-${sec.status}${folded ? '' : ' open'}" data-o="${i}" data-s="${s}">
    <div class="sec-head"${folded ? ' role="button" tabindex="0" aria-expanded="false"' : ''}>${folded ? '<span class="chev"></span>' : ''}${label}${status}</div>
    <div class="sec-body">${folded ? '' : tableHtml(i, s)}</div></div>`;
}

function tableHtml(i: number, s: number): string {
  const sec = view!.objects[i].sections[s];
  const lines = sec.lines;
  // A changed line or a line with threads, with its context; an unchanged section without threads, whole.
  const marked = lines.map((l, k) => l.kind !== 'same' || !!threadsAt(i, s, k));
  const folding = sec.status === 'changed' || sectionHasThreads(i, s);
  const show = marked.map(m => m || !folding);
  if (folding) {
    marked.forEach((m, k) => {
      if (!m) return;
      for (let x = Math.max(0, k - CONTEXT); x <= Math.min(lines.length - 1, k + CONTEXT); x++) show[x] = true;
    });
  }
  const rows: string[] = [];
  for (let k = 0; k < lines.length;) {
    let end = k;
    while (end < lines.length && show[end] === show[k]) end++;
    // A fold of one line would take as much room as the line. A run of changes is never folded: never cut in two.
    rows.push(show[k] || end - k === 1 ? rowsHtml(i, s, k, end) : foldHtml(i, s, k, end));
    k = end;
  }
  // Split: the number, mark, code and XML link of each side, both halves as wide.
  const cols = split() ? '<colgroup><col class="cn"><col class="cm"><col><col class="cx"><col class="cn"><col class="cm"><col><col class="cx"></colgroup>' : '';
  return `<table class="diff${split() ? ' split' : snapshot ? ' snapshot' : ''}">${cols}<tbody>${rows.join('')}</tbody></table>`;
}

const columns = () => (split() ? 8 : snapshot ? 4 : 5);

function foldHtml(i: number, s: number, from: number, to: number): string {
  return `<tr class="fold" data-o="${i}" data-s="${s}" data-from="${from}" data-to="${to}"><td colspan="${columns()}">⋯ ${to - from} unchanged lines</td></tr>`;
}

/** The rows of the section lines `[from, to)`: one a line, or in a split diff, a deleted line beside an added one. */
function rowsHtml(i: number, s: number, from: number, to: number): string {
  if (!split()) {
    let out = '';
    for (let k = from; k < to; k++) out += rowHtml(i, s, k);
    return out;
  }
  return splitRows(view!.objects[i].sections[s].lines, from, to).map(r => splitRowHtml(i, s, r)).join('');
}

/**
 * A link to an XML line in the page's diff, where it can be commented on. An unchanged line's is dimmed, and has its
 * line at the base too, which the page may know the line by.
 */
function xmlLink(side: Side, line: number | undefined, oldLine?: number): string {
  if (!line) return '';
  if (snapshot) return `<a class="xml same" href="#" data-side="R" data-line="${line}" title="Line ${line} of the file: show it in the page">L${line}</a>`;
  const version = side === 'L' ? 'base' : 'head';
  return `<a class="xml${oldLine ? ' same' : ''}" href="#" data-side="${side}" data-line="${line}"${oldLine ? ` data-old="${oldLine}"` : ''} title="Line ${line} of the XML file at the ${version}: show it in the page's diff">${side}${line}</a>`;
}

// ------------------------------------------------------------------ review threads

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function noteHtml(n: ReviewNote): string {
  return `<div class="note"><div class="note-head"><span class="author">${esc(n.author)}</span><time datetime="${esc(n.created)}">${esc(when(n.created))}</time></div>
    <div class="note-body">${esc(n.body.trim())}</div></div>`;
}

/**
 * A thread, read-only: its first note (author, time, text as written), whether it is resolved, its replies (folded),
 * and a link to it in the page's diff, or for an outdated one, to the thread on the site. Open unless resolved.
 */
function threadHtml(p: PlacedThread, where = '', outdated = false): string {
  const t = p.thread;
  const [first, ...replies] = t.notes;
  const state = t.resolved === undefined ? '' : `<span class="state ${t.resolved ? 'resolved' : 'unresolved'}">${t.resolved ? 'Resolved' : 'Unresolved'}</span>`;
  const count = replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : '';
  // Only a link to the page's own site.
  const url = t.url && params && t.url.startsWith(`${params.origin}/`) ? t.url : undefined;
  const old = p.side === 'R' ? p.position?.oldLine : undefined;
  const line = p.side && p.line ? ` data-side="${p.side}" data-line="${p.line}"${old ? ` data-old="${old}"` : ''}` : '';
  const go = !outdated
    ? `<a class="go" href="#" data-thread="${esc(t.id)}"${line} title="Show this thread in the page's diff">Show in the diff</a>`
    : url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open this thread on the site, in a new tab">Open ↗</a>` : '';
  return `<details class="thread${t.resolved ? ' resolved' : ''}" data-t="${esc(t.id)}"${t.resolved ? '' : ' open'}>
    <summary><span class="author">${esc(first.author)}</span><time datetime="${esc(first.created)}">${esc(when(first.created))}</time>${
      where ? `<span class="where">${esc(where)}</span>` : ''}${state}${count ? `<span class="muted">${count}</span>` : ''}${go}</summary>
    <div class="note-body">${esc(first.body.trim())}</div>${
      replies.length ? `<details class="replies"><summary>${count}</summary>${replies.map(noteHtml).join('')}</details>` : ''}</details>`;
}

/** The threads in no section line: on the XML (and on the whole file), and the outdated ones. */
function commentListsHtml(): string {
  if (!placement) return '';
  const list = (title: string, note: string, items: string[]) => (items.length === 0 ? '' : `<div class="comments">
    <div class="comments-head">${BUBBLE}<span class="title">${title}</span><span class="muted">${items.length} · ${note}</span></div>${items.join('')}</div>`);
  const xmlWhere = (p: PlacedThread) => (p.position?.file ? 'on the file'
    : `${p.side}${p.line}${p.object !== undefined ? ` · in ${view!.objects[p.object].label}` : ''}`);
  const oldWhere = ({ position: q }: PlacedThread) => {
    const line = q?.file ? 'on the file' : q?.newLine ? `R${q.newLine}` : q?.oldLine ? `L${q.oldLine}` : '';
    return `${line}${q?.head ? ` at ${short(q.head)}` : ''}`;
  };
  return list('Comments on the XML', 'on lines in no declaration or implementation', placement.xml.map(p => threadHtml(p, xmlWhere(p))))
    + list('Outdated comments', 'on other commits than this page compares', placement.outdated.map(p => threadHtml(p, oldWhere(p), true)));
}

/** Token spans of the old and new texts of a section, and the changed middle of the lines paired in each change. */
function sectionHighlights(i: number, s: number) {
  const key = `${i}:${s}`;
  let h = highlights.get(key);
  if (h) return h;
  const lines = view!.objects[i].sections[s].lines;
  const pairs = new Map<number, [number, number]>();
  for (let k = 0; k < lines.length;) {
    if (lines[k].kind === 'same') {
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < lines.length && lines[k].kind !== 'same') (lines[k].kind === 'del' ? dels : adds).push(k++);
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const a = lines[dels[p]].text;
      const b = lines[adds[p]].text;
      const c = lineChange(a, b);
      // Only a part of the line: a line changed all over is marked as a whole already.
      if (c.endA - c.start + c.endB - c.start < 0.6 * (a.length + b.length)) {
        pairs.set(dels[p], [c.start, c.endA]);
        pairs.set(adds[p], [c.start, c.endB]);
      }
    }
  }
  h = {
    old: highlightLines(lines.filter(l => l.kind !== 'add').map(l => l.text).join('\n')),
    now: highlightLines(lines.filter(l => l.kind !== 'del').map(l => l.text).join('\n')),
    pairs,
  };
  highlights.set(key, h);
  return h;
}

function rowHtml(i: number, s: number, k: number): string {
  const l: DiffLine = view!.objects[i].sections[s].lines[k];
  const h = sectionHighlights(i, s);
  const spans = l.kind === 'del' ? h.old[l.oldLine! - 1] : h.now[l.newLine! - 1];
  // An unchanged line links to its line at the head, where a comment on it goes too.
  const link = l.kind === 'del' ? xmlLink('L', l.oldXml) : xmlLink('R', l.newXml, l.kind === 'same' ? l.oldXml : undefined);
  const mark = l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : '';
  const threads = threadsAt(i, s, k);
  if (snapshot) return `<tr class="l-same" data-k="${k}"><td class="n">${l.newLine ?? ''}</td><td class="m"></td><td class="c">${codeHtml(l.text, spans ?? [], undefined)}</td><td class="x">${link}</td></tr>`;
  return `<tr class="l-${l.kind}" data-k="${k}"><td class="n">${l.oldLine ?? ''}</td><td class="n">${l.newLine ?? ''}</td><td class="m">${mark}</td><td class="c">${codeHtml(l.text, spans ?? [], h.pairs.get(k))}</td><td class="x">${link}</td></tr>${
    threads ? `<tr class="threads"><td colspan="5">${threads.map(p => threadHtml(p)).join('')}</td></tr>` : ''}`;
}

/**
 * A row of a split diff: the base's line on the left, the head's on the right. An unchanged line links to its line at
 * the head only, on the right, as in the unified diff. The threads of both lines go under the row.
 */
function splitRowHtml(i: number, s: number, r: SplitRow): string {
  const lines = view!.objects[i].sections[s].lines;
  const h = sectionHighlights(i, s);
  const side = (k: number | undefined, left: boolean) => {
    if (k === undefined) return '<td class="n e"></td><td class="m e"></td><td class="c e"></td><td class="x e"></td>';
    const l: DiffLine = lines[k];
    const cls = l.kind === 'same' ? '' : ` ${l.kind}`;
    const spans = left ? h.old[l.oldLine! - 1] : h.now[l.newLine! - 1];
    const link = left ? (l.kind === 'del' ? xmlLink('L', l.oldXml) : '') : xmlLink('R', l.newXml, l.kind === 'same' ? l.oldXml : undefined);
    const mark = l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : '';
    return `<td class="n${cls}">${(left ? l.oldLine : l.newLine) ?? ''}</td><td class="m${cls}">${mark}</td><td class="c${cls}">${codeHtml(l.text, spans ?? [], h.pairs.get(k))}</td><td class="x${cls}">${link}</td>`;
  };
  const keys = r.left === r.right ? [r.left!] : [r.left, r.right].filter((k): k is number => k !== undefined);
  const threads = keys.flatMap(k => threadsAt(i, s, k) ?? []);
  return `<tr class="l-${r.left === r.right ? 'same' : 'pair'}" data-k="${keys.join(' ')}">${side(r.left, true)}${side(r.right, false)}</tr>${
    threads.length ? `<tr class="threads"><td colspan="8">${threads.map(p => threadHtml(p)).join('')}</td></tr>` : ''}`;
}

/** A line of code with its token classes and, for a paired line, its changed middle marked. */
function codeHtml(text: string, spans: Span[], change: [number, number] | undefined): string {
  if (text === '') return ' ';
  const cuts = new Set([0, text.length]);
  for (const sp of spans) {
    cuts.add(sp.start);
    cuts.add(sp.end);
  }
  if (change) {
    cuts.add(change[0]);
    cuts.add(change[1]);
  }
  const points = [...cuts].filter(p => p >= 0 && p <= text.length).sort((a, b) => a - b);
  let out = '';
  for (let p = 0; p + 1 < points.length; p++) {
    const [a, b] = [points[p], points[p + 1]];
    if (a === b) continue;
    const classes = [spans.find(sp => sp.start <= a && b <= sp.end)?.cls, change && change[0] <= a && b <= change[1] ? 'chg' : undefined]
      .filter(Boolean).join(' ');
    const piece = esc(text.slice(a, b));
    out += classes ? `<span class="${classes}">${piece}</span>` : piece;
  }
  return out;
}

// ------------------------------------------------------------------ diagnostics

function wasm(): string {
  try {
    new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    return 'allowed';
  } catch (e) {
    return `blocked: ${(e as Error).message}`;
  }
}

function attemptsHtml(list: Attempt[]): string {
  return list.map(a => `<li><code>${a.what}</code> via <b>${a.strategy}</b>: ${a.ok ? '✓' : '✗'} ${a.status || ''} ${a.host ? `from ${esc(a.host)}` : ''}
    ${a.error ? `<span class="muted">(${esc(a.error)})</span>` : ''} <span class="muted">${a.ms} ms</span></li>`).join('');
}

function diagnosticsHtml(): string {
  const p = params;
  return `<details class="diag"><summary>Diagnostics</summary><ul>
    ${p ? `<li>${p.snapshot ? `Commit <code>${p.head}</code>` : `Commits: base <code>${p.base}</code>, head <code>${p.head}</code>`} <span class="muted">(${esc(p.source ?? 'unknown source')})</span></li>
    <li>Paths: <code>${esc(p.path)}</code>${p.oldPath ? ` (base: <code>${esc(p.oldPath)}</code>)` : ''}</li>
    <li>Page: <code>${esc(p.origin)}</code>, ways to read in order: ${esc(p.order.join(', '))}</li>` : ''}
    ${attemptsHtml(files.attempts)}
    <li>Comments: ${!threadInfo ? 'not read yet' : threadInfo.problem ? esc(threadInfo.problem)
      : `${threadInfo.threads.length} thread(s) on this file <span class="muted">(${esc(threadInfo.source ?? 'unknown source')})</span>`}</li>
    <li>WebAssembly in this frame: ${esc(wasm())}</li>
    <li>Frame: <code>${esc(location.origin)}</code></li>
  </ul>
  <button type="button" class="probe">Try each way to read the file</button><ul class="probes">${attemptsHtml(probes)}</ul></details>`;
}

/** Reads the file at the head (or the base) each way, for the diagnostics. */
async function probeAll(button: HTMLButtonElement): Promise<void> {
  if (!params) return;
  button.disabled = true;
  const [what, sha, path] = params.deleted ? ['base', params.base, params.oldPath ?? params.path] : ['head', params.head, params.path];
  for (const strategy of ALL_WAYS) await files.attempt(`probe ${what}`, strategy, fileUrl(params.raw, sha, path), probes);
  const list = button.nextElementSibling;
  if (list) list.innerHTML = attemptsHtml(probes);
  button.disabled = false;
}

// ------------------------------------------------------------------ interaction

/** Opens or closes an object, a section or a group of unchanged objects, rendering its contents the first time. */
function setOpen(box: HTMLElement, open: boolean): void {
  const head = box.querySelector(':scope > .obj-head, :scope > .sec-head, :scope > .group-head')!;
  const body = box.querySelector(':scope > .obj-body, :scope > .sec-body, :scope > .group-body')!;
  if (open && body.childElementCount === 0) {
    if (box.classList.contains('obj')) {
      const i = Number(box.dataset.o);
      body.innerHTML = view!.objects[i].sections.map((_, s) => sectionHtml(i, s)).join('');
    } else if (box.classList.contains('sec')) {
      body.innerHTML = tableHtml(Number(box.dataset.o), Number(box.dataset.s));
    } else {
      const items: string[] = [];
      for (let i = Number(box.dataset.from); i < Number(box.dataset.to); i++) items.push(objectHtml(i, false));
      body.innerHTML = items.join('');
    }
  }
  box.classList.toggle('open', open);
  head.setAttribute('aria-expanded', String(open));
}

/** Shows the folded lines of a fold. */
function unfold(fold: HTMLTableRowElement): void {
  const [i, s, from, to] = ['o', 's', 'from', 'to'].map(k => Number(fold.dataset[k]));
  fold.insertAdjacentHTML('afterend', rowsHtml(i, s, from, to));
  fold.remove();
}

/** An object view, opened (out of its group of unchanged objects, if it is in one). */
function openObject(i: number): HTMLElement | null {
  let box = root.querySelector<HTMLElement>(`.obj[data-o="${i}"]`);
  if (!box) {
    const group = [...root.querySelectorAll<HTMLElement>('.group')].find(g => Number(g.dataset.from) <= i && i < Number(g.dataset.to));
    if (group) setOpen(group, true);
    box = root.querySelector<HTMLElement>(`.obj[data-o="${i}"]`);
  }
  if (box) setOpen(box, true);
  return box;
}

/** The row of a section line, its section opened and its fold unfolded. */
function openRow(box: HTMLElement, ref: LineRef): HTMLElement | null {
  const sec = box.querySelector<HTMLElement>(`.sec[data-o="${ref.o}"][data-s="${ref.s}"]`);
  if (!sec) return null;
  if (!sec.classList.contains('open')) setOpen(sec, true);
  const fold = [...sec.querySelectorAll<HTMLTableRowElement>('tr.fold')].find(f => Number(f.dataset.from) <= ref.k && ref.k < Number(f.dataset.to));
  if (fold) unfold(fold);
  // A row of a split diff has the lines of both its sides.
  return sec.querySelector<HTMLElement>(`tr[data-k~="${ref.k}"]`);
}

/** A place the page asked for before the view was rendered. */
let pendingReveal: Reveal | undefined;

/**
 * Opens a place of the view and tells the page where it is: an object view (from the tree), the section line on an
 * XML line or a thread (coming back from the page's diff). Out of the group of unchanged objects, the folded section
 * and the fold it is in.
 */
async function reveal(r: Reveal): Promise<void> {
  pendingReveal = undefined;
  const v = view;
  if (!v) return;
  const where = r.thread ? placement?.where.get(r.thread) : undefined;
  const [o, s, k] = where ? where.key.split(':').map(Number) : [];
  const ref: LineRef | undefined = k !== undefined ? { o, s, k } : r.xml ? (lineIndex ??= xmlLineIndex(v))[r.xml.side].get(r.xml.line) : undefined;
  const i = where?.o ?? ref?.o ?? (r.objectId !== undefined ? v.objects.findIndex(x => x.objectId === r.objectId && x.accessor === r.accessor) : -1);
  const box = i >= 0 ? openObject(i) : null;
  let target: HTMLElement | null = box;
  if (box && ref) target = openRow(box, ref) ?? box;
  // A thread: in the object it is in, or in the lists at the end.
  const thread = r.thread ? root.querySelector<HTMLElement>(`.thread[data-t="${CSS.escape(r.thread)}"]`) : null;
  if (thread) target = thread;
  if (!target) return;
  const flash = target === box ? box.querySelector<HTMLElement>(':scope > .obj-head')! : target;
  flash.classList.remove('flash');
  void flash.offsetWidth;
  flash.classList.add('flash');
  // A frame just shown again is laid out late (a second and more, seen on GitHub): measure once the target has a box.
  for (let n = 0; n < 60 && target.getBoundingClientRect().height === 0; n++) await new Promise(done => setTimeout(done, 50));
  // The height first, before the resize observer tells it: the page can scroll only as far as the frame reaches (the
  // last file of a page, on Bitbucket).
  post({ tcx: 'height', height: Math.ceil(document.body.getBoundingClientRect().height) });
  post({ tcx: 'scroll', top: target.getBoundingClientRect().top + window.scrollY });
}

window.addEventListener('message', e => {
  if (!params || e.origin !== params.origin || e.source !== window.parent) return;
  const m = e.data as PageMessage;
  if (m?.tcx === 'reveal') {
    const r: Reveal = { objectId: m.objectId, accessor: m.accessor, xml: m.xml, thread: m.thread };
    if (view) void reveal(r);
    else pendingReveal = r;
  } else if (m?.tcx === 'style' && (m.style === 'unified' || m.style === 'split')) {
    hostStyle = m.style;
    setStyle(m.style);
  } else if (m?.tcx === 'threads' && Array.isArray(m.threads)) {
    threadInfo = { threads: m.threads, source: m.source, problem: m.problem };
    if (!view) return;
    place();
    rerender();
  }
});

root.addEventListener('click', e => {
  const target = e.target as Element;
  const oldLine = (a: HTMLElement) => (a.dataset.old ? Number(a.dataset.old) : undefined);
  const xml = target.closest<HTMLAnchorElement>('a.xml');
  if (xml) {
    e.preventDefault();
    post({ tcx: 'goto', side: xml.dataset.side === 'L' ? 'L' : 'R', line: Number(xml.dataset.line), oldLine: oldLine(xml) });
    return;
  }
  const go = target.closest<HTMLAnchorElement>('a.go[data-thread]');
  if (go) {
    e.preventDefault();
    const side = go.dataset.side === 'L' || go.dataset.side === 'R' ? go.dataset.side : undefined;
    post({ tcx: 'thread', id: go.dataset.thread!, side, line: side ? Number(go.dataset.line) : undefined, oldLine: oldLine(go) });
    return;
  }
  const style = target.closest<HTMLButtonElement>('button[data-style]');
  if (style) {
    const chosen: DiffStyle = style.dataset.style === 'split' ? 'split' : 'unified';
    setStyle(chosen);
    // The other views of the page follow (storage.onChanged), and the next pages open with it.
    void chrome.storage.local.set({ [STYLE_KEY]: chosen }).catch(() => undefined);
    return;
  }
  const probe = target.closest<HTMLButtonElement>('button.probe');
  if (probe) {
    void probeAll(probe);
    return;
  }
  const fold = target.closest<HTMLTableRowElement>('tr.fold');
  if (fold) {
    unfold(fold);
    return;
  }
  const head = target.closest('.obj-head, .sec-head[role="button"], .group-head');
  if (!head) return;
  const box = head.parentElement as HTMLElement;
  setOpen(box, !box.classList.contains('open'));
});

root.addEventListener('keydown', e => {
  const target = e.target as HTMLElement;
  if ((e.key === 'Enter' || e.key === ' ') && target.getAttribute('role') === 'button') {
    e.preventDefault();
    target.click();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[STYLE_KEY];
  if (area === 'local' && change) setStyle(change.newValue === 'split' ? 'split' : 'unified');
});

// The page sizes the frame to its content: the frame has no scroll bar of its own.
new ResizeObserver(() => post({ tcx: 'height', height: Math.ceil(document.body.getBoundingClientRect().height) })).observe(document.body);

void main().catch(e => {
  root.innerHTML = `<p class="notice error">The TwinCAT view failed: ${esc(String((e as Error).stack ?? e))}</p>`;
});

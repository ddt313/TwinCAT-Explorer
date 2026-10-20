// The TwinCAT view of one file of a pull or merge request, in a frame of the extension inside the host's page
// (GitHub's "Files changed", GitLab's "Changes"), where the page's CSP and CSS do not reach it. It reads the file at the merge base and at the head and
// shows its objects in the layout of the VS Code extension's commit diff: each changed object with its
// Declaration diff above its Implementation diff, unchanged objects collapsed. Read-only.

import { KIND_WORD } from '../../src/core/treeLabels';
import { Span, highlightLines } from './highlight';
import { lineChange } from './lineDiff';
import { DiffLine, FileView, ObjectView, buildFileView } from './model';
import { decodeViewerParams, fileUrl } from './params';
import { FrameMessage, PageMessage } from './protocol';
import { ALL_WAYS, Attempt, Reader } from './reader';
import { isKnownSite } from './sites';
/** Unchanged lines shown around a change; longer runs are folded. */
const CONTEXT = 3;

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
  const base = params.added ? undefined : await files.read('base', fileUrl(params.raw, params.base, params.oldPath ?? params.path));
  const after = files.textOf(head);
  const before = files.textOf(base);
  if (after === null || before === null || (after === undefined && before === undefined)) {
    view = undefined;
    root.innerHTML = `<p class="notice error">The file could not be read from GitHub with this browser's session
      (see Diagnostics). Turn the toggle off for GitHub's diff.</p>${diagnosticsHtml()}`;
    return;
  }
  view = buildFileView({ path: params.path, oldPath: params.oldPath, before, after });
  render();
  if (pendingReveal) reveal(pendingReveal.objectId, pendingReveal.accessor);
}

// ------------------------------------------------------------------ rendering

let view: FileView | undefined;
const highlights = new Map<string, { old: Span[][]; now: Span[][]; pairs: Map<number, [number, number]> }>();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = (sha: string) => sha.slice(0, 7);

const BADGE: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D' };

function render(): void {
  const v = view!;
  const parts = [summaryHtml(v)];
  for (let i = 0; i < v.objects.length;) {
    if (v.objects[i].change !== 'unchanged') {
      parts.push(objectHtml(i, true));
      i++;
      continue;
    }
    let j = i;
    while (j < v.objects.length && v.objects[j].change === 'unchanged') j++;
    parts.push(groupHtml(i, j));
    i = j;
  }
  parts.push(diagnosticsHtml());
  root.innerHTML = parts.join('');
}

function summaryHtml(v: FileView): string {
  const counts = (['modified', 'added', 'deleted'] as const).filter(k => v.counts[k] > 0).map(k => `${v.counts[k]} ${k}`);
  if (v.counts.unchanged > 0) counts.push(`${v.counts.unchanged} unchanged`);
  const file = v.change === 'added' ? 'New file' : v.change === 'deleted' ? 'Deleted file' : v.oldPath ? `Renamed from <code>${esc(v.oldPath)}</code>` : '';
  const commits = params ? `<code>${short(params.base)}</code> → <code>${short(params.head)}</code>` : '';
  let out = `<div class="summary"><span class="title">TwinCAT objects</span>${counts.length ? ` · ${counts.join(' · ')}` : ''}${file ? ` · ${file}` : ''}
    <span class="muted right">read-only · ${commits}</span></div>`;
  if (v.metadataOnly) out += `<p class="notice">No code changed: ${esc(v.metadataOnly)}</p>`;
  if (v.note) out += `<p class="notice">${esc(v.note)}</p>`;
  if (v.error) out += `<p class="notice error">${esc(v.error)}</p>`;
  return out;
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

function objectHtml(i: number, open: boolean): string {
  const o = view!.objects[i];
  const badge = BADGE[o.change];
  return `<div class="obj obj-${o.change} d${o.depth}${open ? ' open' : ''}" data-o="${i}">
    <div class="obj-head" role="button" tabindex="0" aria-expanded="${open}"><span class="chev"></span>${badge ? `<span class="badge b-${o.change}" title="${o.change}">${badge}</span>` : ''}<span class="name">${esc(o.label)}</span><span class="kind">${o.accessor ? `${o.accessor} accessor` : KIND_WORD[o.kind]}</span>${o.renamedFrom ? `<span class="renamed">renamed from ${esc(o.renamedFrom)}</span>` : ''}${o.change === 'unchanged' ? '<span class="muted">unchanged</span>' : stat(o.added, o.deleted)}</div>
    <div class="obj-body">${open ? o.sections.map((_, s) => sectionHtml(i, s)).join('') : ''}</div></div>`;
}

function sectionHtml(i: number, s: number): string {
  const o = view!.objects[i];
  const sec = o.sections[s];
  const label = `<span class="sec-label">${esc(sec.label)}</span>`;
  if (!sec.text) {
    const note = sec.status === 'same' ? 'unchanged' : `${sec.status}: graphical code is not shown, GitHub's diff has its XML`;
    const link = sec.status === 'deleted' ? xmlLink('L', sec.oldXml) : sec.status !== 'same' ? xmlLink('R', sec.newXml) : '';
    return `<div class="sec sec-${sec.status}"><div class="sec-head">${label}<span class="muted">${note}</span>${link}</div></div>`;
  }
  if (sec.lines.length === 0) return `<div class="sec"><div class="sec-head">${label}<span class="muted">empty</span></div></div>`;
  // In a changed object an unchanged section is folded; an unchanged object, once opened, shows its code.
  const folded = sec.status === 'same' && o.change !== 'unchanged';
  const status = sec.status === 'changed' ? stat(sec.added, sec.deleted) : `<span class="muted">${sec.status === 'same' ? 'unchanged' : sec.status}</span>`;
  return `<div class="sec sec-${sec.status}${folded ? '' : ' open'}" data-o="${i}" data-s="${s}">
    <div class="sec-head"${folded ? ' role="button" tabindex="0" aria-expanded="false"' : ''}>${folded ? '<span class="chev"></span>' : ''}${label}${status}</div>
    <div class="sec-body">${folded ? '' : tableHtml(i, s)}</div></div>`;
}

function tableHtml(i: number, s: number): string {
  const lines = view!.objects[i].sections[s].lines;
  const show = lines.map(l => l.kind !== 'same');
  if (view!.objects[i].sections[s].status !== 'changed') show.fill(true);
  else {
    lines.forEach((l, k) => {
      if (l.kind === 'same') return;
      for (let x = Math.max(0, k - CONTEXT); x <= Math.min(lines.length - 1, k + CONTEXT); x++) show[x] = true;
    });
  }
  const rows: string[] = [];
  for (let k = 0; k < lines.length;) {
    if (show[k]) {
      rows.push(rowHtml(i, s, k));
      k++;
      continue;
    }
    let end = k;
    while (end < lines.length && !show[end]) end++;
    // A fold of one line would take as much room as the line.
    if (end - k === 1) rows.push(rowHtml(i, s, k));
    else rows.push(foldHtml(i, s, k, end));
    k = end;
  }
  return `<table class="diff"><tbody>${rows.join('')}</tbody></table>`;
}

function foldHtml(i: number, s: number, from: number, to: number): string {
  return `<tr class="fold" data-o="${i}" data-s="${s}" data-from="${from}" data-to="${to}"><td colspan="5">⋯ ${to - from} unchanged lines</td></tr>`;
}

function xmlLink(side: 'L' | 'R', line: number | undefined): string {
  if (!line) return '';
  const version = side === 'L' ? 'base' : 'head';
  return `<a class="xml" href="#" data-side="${side}" data-line="${line}" title="Line ${line} of the XML file at the ${version}: show it in the page's diff">${side}${line}</a>`;
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
  const link = l.kind === 'del' ? xmlLink('L', l.oldXml) : l.kind === 'add' ? xmlLink('R', l.newXml) : '';
  const mark = l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : '';
  return `<tr class="l-${l.kind}"><td class="n">${l.oldLine ?? ''}</td><td class="n">${l.newLine ?? ''}</td><td class="m">${mark}</td><td class="c">${codeHtml(l.text, spans ?? [], h.pairs.get(k))}</td><td class="x">${link}</td></tr>`;
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
    ${p ? `<li>Commits: base <code>${p.base}</code>, head <code>${p.head}</code> <span class="muted">(${esc(p.source ?? 'unknown source')})</span></li>
    <li>Paths: <code>${esc(p.path)}</code>${p.oldPath ? ` (base: <code>${esc(p.oldPath)}</code>)` : ''}</li>
    <li>Page: <code>${esc(p.origin)}</code>, ways to read in order: ${esc(p.order.join(', '))}</li>` : ''}
    ${attemptsHtml(files.attempts)}
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

/** An object view the tree asked for, before the view was rendered. */
let pendingReveal: { objectId: string; accessor?: string } | undefined;

/** Opens an object view (out of its group of unchanged objects, if it is in one) and tells the page where it is. */
function reveal(objectId: string, accessor?: string): void {
  pendingReveal = undefined;
  const i = view?.objects.findIndex(o => o.objectId === objectId && o.accessor === accessor) ?? -1;
  if (i < 0) return;
  let box = root.querySelector<HTMLElement>(`.obj[data-o="${i}"]`);
  if (!box) {
    const group = [...root.querySelectorAll<HTMLElement>('.group')].find(g => Number(g.dataset.from) <= i && i < Number(g.dataset.to));
    if (group) setOpen(group, true);
    box = root.querySelector<HTMLElement>(`.obj[data-o="${i}"]`);
  }
  if (!box) return;
  setOpen(box, true);
  box.classList.remove('flash');
  void box.offsetWidth;
  box.classList.add('flash');
  post({ tcx: 'scroll', top: box.getBoundingClientRect().top + window.scrollY });
}

window.addEventListener('message', e => {
  if (!params || e.origin !== params.origin || e.source !== window.parent) return;
  const m = e.data as PageMessage;
  if (m?.tcx !== 'reveal') return;
  if (view) reveal(m.objectId, m.accessor);
  else pendingReveal = { objectId: m.objectId, accessor: m.accessor };
});

root.addEventListener('click', e => {
  const target = e.target as Element;
  const xml = target.closest<HTMLAnchorElement>('a.xml');
  if (xml) {
    e.preventDefault();
    post({ tcx: 'goto', side: xml.dataset.side === 'L' ? 'L' : 'R', line: Number(xml.dataset.line) });
    return;
  }
  const probe = target.closest<HTMLButtonElement>('button.probe');
  if (probe) {
    void probeAll(probe);
    return;
  }
  const fold = target.closest<HTMLTableRowElement>('tr.fold');
  if (fold) {
    const [i, s, from, to] = ['o', 's', 'from', 'to'].map(k => Number(fold.dataset[k]));
    const rows: string[] = [];
    for (let k = from; k < to; k++) rows.push(rowHtml(i, s, k));
    fold.insertAdjacentHTML('afterend', rows.join(''));
    fold.remove();
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

// The page sizes the frame to its content: the frame has no scroll bar of its own.
new ResizeObserver(() => post({ tcx: 'height', height: Math.ceil(document.body.getBoundingClientRect().height) })).observe(document.body);

void main().catch(e => {
  root.innerHTML = `<p class="notice error">The TwinCAT view failed: ${esc(String((e as Error).stack ?? e))}</p>`;
});

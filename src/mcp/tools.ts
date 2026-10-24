// What each tool of the MCP server does, apart from the protocol (server.ts): reads, language queries and file
// changes on a Session, each returning the text the agent gets back. Writes go to the files through splice.ts, the
// way the split editor saves; every write is logged for undo_last_edit. Independent of the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import {
  Section, TcObject, normalizeEol, decodeBytes, encodeText, objectAtOffset, parseTcFile, parseTcText, sectionFileLines,
} from '../core/tcfile';
import { Accessor, offsetIn, positionIn, textHash, viewLabel, viewSections } from '../core/objectText';
import { MemberSpec, SpliceError, addMember as addMemberText, applySectionEdits, checkRename, isSpecialMethod, memberNameProblem } from '../core/splice';
import { addMembersToFile, newObjectFile, newObjectFileText, projectFileStyle, removeMemberFromFile, writeNewObject } from '../core/operations';
import { NewObjectKind } from '../core/newObjects';
import { objectTreeLabel } from '../core/treeLabels';
import { PlcProject } from '../core/project';
import { fileKey } from '../core/workspace';
import { describeOwner } from '../lang/features';
import { implementations, typeTree, TypeTree } from '../lang/hierarchy';
import { newObjectStubs, objectNameProblem } from '../lang/objects';
import { PouSym, Sym } from '../lang/symbols';
import { Session, ToolError, View, numbered, shortHash } from './session';
import { FileChange, LiveUndo, UndoEntry, UndoLog } from './undo';
import { ItemCopy, Live, ST, SUBTYPE, folderOf, inXae, liveProject, liveView, propertyType, recreate } from './live';
import { Xae } from './xae';

export interface Tools {
  session: Session;
  undo: UndoLog;
  /** The running TwinCAT XAEs; none in tests, where the files are written. */
  xae?: Xae;
}

type Part = 'decl' | 'impl';

// ------------------------------------------------------------------ reading

export function status(t: Tools): string {
  const s = t.session;
  const lines = [`Folder: ${s.root}`];
  for (const ts of s.ws.tsProjects) {
    lines.push(`${path.relative(s.root, ts.path)}: ${ts.plcProjects.map(r => r.name).join(', ') || 'no PLC project'}`);
  }
  if (!s.ws.tsProjects.length) lines.push('No TwinCAT project (.tsproj) found under this folder.');
  for (const e of s.ws.loadErrors) lines.push(`Not loaded: ${e}`);
  const open = t.undo.list().filter(e => !e.undone).length;
  lines.push(`Edits that undo_last_edit can take back: ${open}`);
  let instances: string[] = [];
  try {
    instances = (t.xae?.instances() ?? []).map(i => `TwinCAT XAE process ${i.pid}: ${i.solution || 'no solution'}`);
  } catch (e) {
    instances = [`TwinCAT XAE: ${(e as Error).message}`];
  }
  lines.push(...instances);
  lines.push(instances.length
    ? 'Code of a project open in TwinCAT XAE is read and written there; XAE saves each change at once.'
    : 'No TwinCAT XAE has these projects open: the files are written.');
  return lines.join('\n');
}

export function objects(t: Tools, a: { project?: string; filter?: string; offset?: number; limit?: number }): string {
  const s = t.session;
  const filter = a.filter?.toUpperCase();
  const project = a.project?.toUpperCase();
  // Once: views() checks every file on disk.
  const views = s.views();
  const roots = views.filter(v => !v.obj.parent && !v.accessor && (!project || v.entry.project.name.toUpperCase() === project));
  const members = (v: View) => views.filter(m => m.file === v.file && m.obj !== v.obj);
  const matching = roots.filter(v => !filter || v.label.toUpperCase().includes(filter) || members(v).some(m => m.label.toUpperCase().includes(filter)));
  const offset = a.offset ?? 0;
  const limit = a.limit ?? 100;
  const out: string[] = [];
  for (const v of matching.slice(offset, offset + limit)) {
    const folder = path.dirname(v.entry.include.replace(/\\/g, '/'));
    out.push(`${objectTreeLabel(v.obj)}  ${s.projects.length > 1 ? v.entry.project.name + ':' : ''}${folder === '.' ? '' : folder}`);
    for (const m of members(v)) out.push(`  ${m.label}${m.accessor ? '' : ` (${m.obj.kind})`}`);
  }
  out.push(`-- ${Math.min(matching.length, offset + limit) - Math.min(offset, matching.length)} of ${matching.length} objects`
    + (matching.length > offset + limit ? `; more with offset ${offset + limit}` : ''));
  return out.join('\n');
}

export function read(t: Tools, a: { object: string; part?: Part; from?: number; to?: number }): string {
  const s = t.session;
  const v = s.resolve(a.object);
  const live = liveView(s, t.xae, v);
  const out = [`${s.qualified(v)} (${v.accessor ? 'accessor' : v.obj.kind}) · ${v.entry.project.name} · ${v.entry.include}`
    + (live ? ` · live in TwinCAT XAE (process ${live.pid})` : '')];
  for (const sec of viewSections(v.obj, v.accessor)) {
    if (a.part && sec.role !== a.part) continue;
    if (!sec.editable) {
      out.push(`── ${sec.role} · not Structured Text: read-only here, edit it in TwinCAT XAE`);
      continue;
    }
    // With XAE open, its text: it has the user's unsaved edits, and it is what a write changes.
    const r = live && inXae(() => live.xae.get(live.item, sec.role));
    const text = r ? r.text : sec.text;
    const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    out.push(`── ${sec.role} · hash ${shortHash(text)} · ${lines} lines${r && (r.dirty || r.text !== sec.text) ? ' · has unsaved edits in XAE' : ''}`);
    if (text) out.push(numbered(text, a.from, a.to));
  }
  return out.join('\n');
}

/**
 * What lines of a source file hold, as git diff and git blame number them (the file as it is now): for each run of
 * lines, the object, part and lines of its code, or the object whose XML (not code) they are.
 */
export function locate(t: Tools, a: { file: string; line: number; to?: number }): string {
  const s = t.session;
  const full = path.resolve(s.root, a.file);
  const entry = s.ws.entry(full);
  if (!entry) throw new ToolError(`${a.file} is not a source file of the PLC projects under ${s.root}`);
  const file = s.ws.getFile(full);
  if (!file || file.error) throw new ToolError(`${a.file} cannot be read${file?.error ? `: ${file.error}` : ''}`);
  const last = Math.max(a.line, a.to ?? a.line);
  const label = (sec: Section) => s.qualified({ entry, file, obj: sec.owner, accessor: sec.accessor, label: viewLabel(sec.owner, sec.accessor) });
  // The line of code on each line of the file (the first one, when lone CRs put several on it).
  const code = new Map<number, { sec: Section; line: number }>();
  for (const sec of file.sections.values()) {
    if (!sec.editable) continue;
    const lines = sectionFileLines(file, sec);
    // After a final line break, the last "line" is the XML that closes the section.
    const n = sec.text.endsWith('\n') ? lines.length - 1 : lines.length;
    for (let i = 0; i < n; i++) if (lines[i] >= a.line && lines[i] <= last && !code.has(lines[i])) code.set(lines[i], { sec, line: i + 1 });
  }
  const starts = [0];
  for (let i = file.text.indexOf('\n'); i >= 0; i = file.text.indexOf('\n', i + 1)) starts.push(i + 1);
  // A final line break ends the last line, as git counts them.
  if (starts.length > 1 && starts[starts.length - 1] === file.text.length) starts.pop();
  // Runs of lines with the same place: [first line of the file, last line, place, first and last line of code].
  const runs: { from: number; to: number; place: string; code?: { sec: Section; from: number; to: number } }[] = [];
  for (let l = a.line; l <= last && l <= starts.length; l++) {
    const c = code.get(l);
    const prev = runs[runs.length - 1];
    if (c) {
      if (prev?.code && prev.to === l - 1 && prev.code.sec === c.sec && prev.code.to === c.line - 1) {
        prev.to = l;
        prev.code.to = c.line;
      } else {
        runs.push({ from: l, to: l, place: `${label(c.sec)} ${c.sec.role}`, code: { sec: c.sec, from: c.line, to: c.line } });
      }
      continue;
    }
    const text = file.text.slice(starts[l - 1], starts[l] ?? file.text.length);
    const obj = objectAtOffset(file, starts[l - 1] + (text.length - text.trimStart().length));
    const place = obj ? `XML of ${s.qualified({ entry, file, obj, label: viewLabel(obj) })}, not code` : 'XML outside the objects';
    if (prev && !prev.code && prev.to === l - 1 && prev.place === place) prev.to = l;
    else runs.push({ from: l, to: l, place });
  }
  const span = (from: number, to: number) => (to > from ? `${from}-${to}` : `${from}`);
  const out = runs.map(r => {
    if (!r.code) return `${span(r.from, r.to)}: ${r.place}`;
    const first = r.code.sec.text.split('\n')[r.code.from - 1].trim();
    return `${span(r.from, r.to)}: ${r.place}:${span(r.code.from, r.code.to)}${r.code.to === r.code.from ? `  ${first}` : ''}`;
  });
  if (last > starts.length) out.push(`${span(Math.max(a.line, starts.length + 1), last)}: after the end of the file (${starts.length} lines)`);
  return [`${entry.include} (${entry.project.name})`, ...out].join('\n');
}

/** Subsequence match, as Ctrl+T does: `fbv` finds `FB_Valve`. */
function fuzzy(query: string, name: string): boolean {
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of name.toLowerCase()) if (ch === q[i]) i++;
  return i === q.length;
}

export function findSymbol(t: Tools, a: { query: string; limit?: number }): string {
  const s = t.session;
  const found: Sym[] = [];
  for (const g of s.index.allGlobals()) {
    if (g.scope.isLibrary) continue;
    const all: Sym[] = [g, ...(g.kind === 'pou' ? g.members : g.kind === 'gvl' ? g.vars : [])];
    for (const x of all) if (fuzzy(a.query, x.kind === 'pou' || x.kind === 'type' || x.kind === 'gvl' ? x.name : `${g.name}.${x.name}`)) found.push(x);
  }
  const exact = (x: Sym) => (x.name.toLowerCase() === a.query.toLowerCase() ? 0 : 1);
  found.sort((x, y) => exact(x) - exact(y) || x.name.length - y.name.length);
  const limit = a.limit ?? 50;
  const out = found.slice(0, limit).map(x => `${symbolName(x)}  — ${describeOwner(x)}${x.loc ? `  @ ${s.describeLoc(x.loc)}` : ''}`);
  if (!found.length) return `Nothing matches '${a.query}'.`;
  if (found.length > limit) out.push(`-- ${limit} of ${found.length}; narrow the query`);
  return out.join('\n');
}

function symbolName(x: Sym): string {
  if (x.kind === 'method' || x.kind === 'property' || x.kind === 'action' || x.kind === 'transition') return `${x.owner.name}.${x.name}`;
  if (x.kind === 'var' && x.owner.kind === 'gvl') return `${x.owner.name}.${x.name}`;
  if (x.kind === 'enumValue') return `${x.owner.name}.${x.name}`;
  return x.name;
}

/** Where a symbol is asked for: by name (`FB_Valve`, `FB_Valve.Open`, `GVL_IO.bStart`, `E_State.Idle`), or at a word of a line. */
export interface SymbolRef {
  symbol?: string;
  object?: string;
  part?: Part;
  line?: number;
  word?: string;
}

function findSym(t: Tools, r: SymbolRef): Sym {
  const s = t.session;
  if (r.symbol) {
    const parts = r.symbol.split('.').map(p => p.trim().toUpperCase());
    const globals = s.index.allGlobals().filter(g => g.name.toUpperCase() === parts[0]).sort((x, y) => Number(x.scope.isLibrary) - Number(y.scope.isLibrary));
    let cur: Sym | undefined = globals[0];
    for (const p of parts.slice(1)) {
      if (!cur) break;
      const kids: Sym[] = cur.kind === 'pou' ? [...cur.members, ...cur.vars]
        : cur.kind === 'method' || cur.kind === 'property' || cur.kind === 'action' || cur.kind === 'transition' ? cur.vars
          : cur.kind === 'gvl' ? cur.vars : cur.kind === 'type' ? [...cur.fields, ...cur.values] : [];
      cur = kids.find(k => k.name.toUpperCase() === p);
    }
    if (!cur) throw new ToolError(`No symbol '${r.symbol}' in the workspace or the library stubs`);
    return cur;
  }
  if (!r.object || !r.part || !r.line || !r.word) throw new ToolError('Give `symbol`, or `object`, `part`, `line` and `word`');
  const v = s.resolve(r.object);
  const sec = s.section(v, r.part);
  const ctx = s.context(v, sec);
  const text = ctx && s.index.sectionText(ctx.fileKey, ctx.sectionKey);
  if (!ctx || text === undefined) throw new ToolError(`${v.label} ${r.part} is not in the language index`);
  const lineText = text.split('\n')[r.line - 1];
  if (lineText === undefined) throw new ToolError(`${v.label} ${r.part} has no line ${r.line}`);
  const m = new RegExp(`(?<![A-Za-z0-9_])${r.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').exec(lineText);
  if (!m) throw new ToolError(`'${r.word}' is not on line ${r.line} of ${v.label} ${r.part}: ${lineText.trim()}`);
  const o = s.features.occurrenceAt(s.features.analysisOf(ctx, text), offsetIn(text, r.line - 1, m.index));
  if (!o) throw new ToolError(`'${r.word}' on line ${r.line} is not a name the language index resolves`);
  return o.sym;
}

export function definition(t: Tools, r: SymbolRef): string {
  const sym = findSym(t, r);
  const out = [`${symbolName(sym)} — ${describeOwner(sym)}`, sym.signature];
  if (sym.doc) out.push(`// ${sym.doc.replace(/\n/g, '\n// ')}`);
  out.push(sym.loc ? `Declared at ${t.session.describeLoc(sym.loc)}` : 'Declared in a library (no source)');
  return out.join('\n');
}

export function references(t: Tools, r: SymbolRef & { limit?: number }): string {
  const s = t.session;
  const sym = findSym(t, r);
  const locs = s.features.referenceLocs(sym, true);
  const limit = r.limit ?? 200;
  const out = [`${symbolName(sym)}: ${locs.length} place(s)`, ...locs.slice(0, limit).map(l => s.describeLoc(l))];
  if (locs.length > limit) out.push(`-- ${limit} of ${locs.length}`);
  return out.join('\n');
}

export function hierarchy(t: Tools, r: SymbolRef): string {
  const sym = findSym(t, r);
  if (sym.kind === 'method' || sym.kind === 'property') {
    const impl = implementations(t.session.index, sym);
    return [`${symbolName(sym)} is implemented or overridden by:`, ...(impl.length ? impl.map(x => `  ${symbolName(x)}`) : ['  nothing in the workspace'])].join('\n');
  }
  if (sym.kind !== 'pou' || sym.pouKind === 'PRG' || sym.pouKind === 'FUN') throw new ToolError(`${symbolName(sym)} is not a function block or interface`);
  const draw = (trees: TypeTree[], depth: number): string[] => trees.flatMap(x => [`${'  '.repeat(depth)}${x.sym.name} (${x.sym.pouKind})`, ...draw(x.children, depth + 1)]);
  const pou = sym as PouSym;
  return [`${pou.name} (${pou.pouKind})`, 'Supertypes:', ...draw(typeTree(t.session.index, pou, 'supertypes'), 1) , 'Subtypes:', ...draw(typeTree(t.session.index, pou, 'subtypes'), 1)].join('\n');
}

function problemsOfView(t: Tools, v: View): string[] {
  const s = t.session;
  const out: string[] = [];
  for (const sec of viewSections(v.obj, v.accessor)) {
    const ctx = s.context(v, sec);
    const text = ctx && s.index.sectionText(ctx.fileKey, ctx.sectionKey);
    if (!ctx || text === undefined || !sec.editable) continue;
    for (const p of s.features.analysisOf(ctx, text).problems) {
      out.push(`${v.label} ${sec.role}:${positionIn(text, p.start).line + 1}  ${p.severity}: ${p.message}`);
    }
  }
  return out;
}

/** TwinCAT XAE's own Check all objects of the PLC projects an XAE has open: the compiler's messages. */
function compilerCheck(t: Tools, limit: number): string {
  const s = t.session;
  const out: string[] = [];
  for (const project of s.projects) {
    const live = liveProject(s, t.xae, project, []);
    if (!live) {
      out.push(`${project.name}: not open in TwinCAT XAE, so not compiled`);
      continue;
    }
    const text = inXae(() => live.xae.check(live.item));
    const messages = text.split(/\r?\n/).filter(l => /\b(error|warning)\b/i.test(l) || /Compile complete/.test(l))
      .map(l => l.replace(project.dir + path.sep, '').trim());
    out.push(`${project.name} (TwinCAT XAE process ${live.pid}):`, ...messages.slice(0, limit));
  }
  return out.join('\n');
}

export function check(t: Tools, a: { object?: string; limit?: number; compiler?: boolean }): string {
  const s = t.session;
  if (a.compiler) return compilerCheck(t, a.limit ?? 200);
  let problems: string[];
  if (a.object) {
    problems = problemsOfView(t, s.resolve(a.object));
  } else {
    problems = [];
    for (const ctx of s.index.allContexts()) {
      const text = s.index.sectionText(ctx.fileKey, ctx.sectionKey);
      if (text === undefined) continue;
      for (const p of s.features.analysisOf(ctx, text).problems) {
        const label = ctx.accessor ? `${ctx.object.qualifiedName}.${ctx.accessor}` : ctx.object.qualifiedName;
        problems.push(`${label} ${ctx.role}:${positionIn(text, p.start).line + 1}  ${p.severity}: ${p.message}`);
      }
    }
  }
  const limit = a.limit ?? 200;
  const head = 'Syntax and name check of the extension (not the TwinCAT compiler): ';
  if (!problems.length) return head + 'no problems.';
  return [head + `${problems.length} problem(s)`, ...problems.slice(0, limit), ...(problems.length > limit ? [`-- ${limit} of ${problems.length}`] : [])].join('\n');
}

// ------------------------------------------------------------------ writing

/** The changed lines of a text, for the answer of a write. */
function diffSummary(before: string, after: string, max = 30): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const lines = [`@@ line ${start + 1}`, ...a.slice(start, endA + 1).map(l => `-${l}`), ...b.slice(start, endB + 1).map(l => `+${l}`)];
  return lines.length > max + 1 ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join('\n') : lines.join('\n');
}


function readText(p: string): string | null {
  try {
    return decodeBytes(fs.readFileSync(p)).text;
  } catch {
    return null;
  }
}

function afterWrite(t: Tools, v: View, entry: UndoEntry, detail: string, how: string): string {
  t.session.refresh();
  let problems: string[] = [];
  try {
    problems = problemsOfView(t, t.session.resolve(t.session.qualified(v)));
  } catch {
    // the object is gone (deleted): no problems to show
  }
  return [detail, `${how} undo_last_edit id=${entry.id} takes it back.`,
    problems.length ? `Problems now:\n${problems.join('\n')}` : 'Problems now: none (syntax and name check).'].join('\n');
}

const savedTo = (t: Tools, file: string) => `Saved to ${path.relative(t.session.root, file)}.`;
const savedByXae = (t: Tools, live: Live, file: string) =>
  `Written in TwinCAT XAE (process ${live.pid}), which shows it and saved ${path.relative(t.session.root, file)}.`;

/**
 * For a change that XAE saves itself (a member or object made or deleted): the files it left as they were. They are
 * told, not saved here: saving the TwinCAT project would rewrite the .tsproj.
 */
const notSavedByXae = (t: Tools, unsaved: string[]) => `did not save ${unsaved.map(f => path.relative(t.session.root, f)).join(' and ')}: `
  + 'the tools here read the files and see the change only once the user saves it in XAE.';

function savedOrNotByXae(t: Tools, live: Live, file: string, unsaved: string[]): string {
  return unsaved.length ? `Written in TwinCAT XAE (process ${live.pid}), which shows it but ${notSavedByXae(t, unsaved)}` : savedByXae(t, live, file);
}

/** The files a change through XAE left as they were on disk. */
const unsavedOf = (files: FileChange[]) => files.filter(f => f.after === f.before).map(f => f.path);

/**
 * Refuses a change through XAE that would save the user's unsaved edits in it (a change through XAE saves the
 * file): the files given, or every file of the folder given.
 */
function refuseDirty(t: Tools, live: Live, files: string[], folder: string | undefined, allow: boolean | undefined): void {
  if (allow) return;
  const dirty = inXae(() => live.xae.dirty(live.pid));
  const keys = new Set(files.map(fileKey));
  const hit = dirty.filter(d => keys.has(fileKey(d)) || (folder && fileKey(d).startsWith(fileKey(folder) + path.sep)));
  if (hit.length) {
    throw new ToolError(`${hit.map(h => path.relative(t.session.root, h)).join(', ')} has unsaved changes in TwinCAT XAE, and this change would save them `
      + 'too. Ask the user to save or undo them in XAE, or pass saveUserEdits: true if they agree.');
  }
}

/**
 * The objects of a view's file whose code in XAE is not the file's: edits not saved yet, which XAE saves along with
 * a change through it. (XAE's DTE documents do not show its PLC editors, so their saved state cannot be asked.)
 * `except`: a section key left out.
 */
function unsavedInXae(live: Live, v: View, except?: string): string[] {
  const disk = parseTcFile(v.entry.path, fs.readFileSync(v.entry.path));
  const rootPath = [...folderOf(v.entry.include), (v.obj.parent ?? v.obj).name];
  const texts = new Map(inXae(() => live.xae.texts({ ...live.item, path: rootPath })).map(e => [e.path, e]));
  const out = new Set<string>();
  for (const sec of disk.sections.values()) {
    if (!sec.editable || sec.key === except) continue;
    const o = sec.owner;
    const rel = [...(o.parent ? [...o.folderPath, o.name] : []), ...(sec.accessor ? [sec.accessor] : [])].join('^');
    const text = texts.get(rel)?.[sec.role];
    if (text !== undefined && text !== sec.text) out.add(viewLabel(o, sec.accessor));
  }
  return [...out];
}

/** Refuses a change through XAE that would save the user's unsaved edits of the view's file (see unsavedInXae). */
function refuseUnsaved(live: Live, v: View, allow: boolean | undefined, except?: string): void {
  if (allow) return;
  const objects = unsavedInXae(live, v, except);
  if (!objects.length) return;
  throw new ToolError(`${objects.join(', ')} ${objects.length > 1 ? 'have' : 'has'} unsaved changes in TwinCAT XAE, and this change `
    + `would save them too. Ask the user to save or undo them in XAE${except ? '' : ', or pass saveUserEdits: true if they agree'}.`);
}

interface WriteArgs {
  object: string;
  part: Part;
  hash?: string;
  saveUserEdits?: boolean;
}

function writeSectionText(t: Tools, a: WriteArgs, change: (current: string) => string, what: string): string {
  const s = t.session;
  s.refresh();
  const v = s.resolve(a.object);
  const sec = s.section(v, a.part);
  if (!sec.editable) throw new ToolError(`${v.label} ${a.part} is not Structured Text; edit it in TwinCAT XAE`);
  const live = liveView(s, t.xae, v);
  if (live) {
    // XAE has the project open: its text (with any unsaved edits) is the one to change.
    const r = inXae(() => live.xae.get(live.item, a.part));
    if (r.dirty && !a.saveUserEdits) refuseDirty(t, live, [v.entry.path], undefined, false);
    refuseUnsaved(live, v, a.saveUserEdits);
    if (a.hash && !r.hash.startsWith(a.hash.toLowerCase())) {
      throw new ToolError(`${v.label} ${a.part} changed since it was read (hash now ${r.hash.slice(0, 12)}). Read it again.`);
    }
    const next = normalizeEol(change(r.text));
    if (next === r.text) return 'No change: the text is already like that.';
    try {
      checkRename(sec, next);
    } catch (e) {
      if (e instanceof SpliceError) throw new ToolError(e.message);
      throw e;
    }
    const res = inXae(() => live.xae.set(live.item, a.part, next, r.hash));
    if (res.conflict) throw new ToolError(`${v.label} ${a.part} changed in TwinCAT XAE meanwhile. Read it again.`);
    if (res.dirty) inXae(() => live.xae.save(live.item, v.entry.path));
    const entry = t.undo.add({ kind: 'section', what: `${what} ${s.qualified(v)} ${a.part}`, path: v.entry.path, key: sec.key, object: s.qualified(v), part: a.part, before: r.text, after: next });
    return afterWrite(t, v, entry, `${s.qualified(v)} ${a.part}: hash ${shortHash(next)}\n${diffSummary(r.text, next)}`, savedByXae(t, live, v.entry.path));
  }
  const file = parseTcFile(v.entry.path, fs.readFileSync(v.entry.path));
  const onDisk = file.sections.get(sec.key);
  if (!onDisk) throw new ToolError(`${v.label} ${a.part} is no longer in ${v.entry.path}`);
  if (a.hash && !textHash(onDisk.text).startsWith(a.hash.toLowerCase())) {
    throw new ToolError(`${v.label} ${a.part} changed since it was read (hash now ${shortHash(onDisk.text)}). Read it again.`);
  }
  const next = normalizeEol(change(onDisk.text));
  let result;
  try {
    result = applySectionEdits(file, [{ key: sec.key, text: next }]);
  } catch (e) {
    if (e instanceof SpliceError) throw new ToolError(e.message);
    throw e;
  }
  if (!result.changedKeys.length) return 'No change: the text is already like that.';
  fs.writeFileSync(v.entry.path, encodeText(result.text, file.bom));
  const entry = t.undo.add({ kind: 'section', what: `${what} ${s.qualified(v)} ${a.part}`, path: v.entry.path, key: sec.key, object: s.qualified(v), part: a.part, before: onDisk.text, after: next });
  return afterWrite(t, v, entry, `${s.qualified(v)} ${a.part}: hash ${shortHash(next)}\n${diffSummary(onDisk.text, next)}`, savedTo(t, v.entry.path));
}

export function editSection(t: Tools, a: WriteArgs & { oldText: string; newText: string }): string {
  return writeSectionText(t, a, current => {
    const old = normalizeEol(a.oldText);
    const first = current.indexOf(old);
    if (!old || first < 0) throw new ToolError(`oldText is not in ${a.object} ${a.part}. Read it again; whitespace and tabs count.`);
    if (current.indexOf(old, first + 1) >= 0) throw new ToolError('oldText occurs more than once; give more of the surrounding text.');
    return current.slice(0, first) + normalizeEol(a.newText) + current.slice(first + old.length);
  }, 'edit_section');
}

export function writeSection(t: Tools, a: WriteArgs & { text: string; hash: string }): string {
  return writeSectionText(t, a, () => a.text, 'write_section');
}

function bomOf(p: string): boolean {
  try {
    const b = fs.readFileSync(p);
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  } catch {
    return false;
  }
}

/** The folders of the paths that are not on disk, deepest first. */
function missingFolders(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    for (let dir = path.dirname(p); !fs.existsSync(dir) && path.dirname(dir) !== dir; dir = path.dirname(dir)) out.add(dir);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

type FilesEntry = Extract<UndoEntry, { kind: 'files' }>;

/** Records a change of whole files, done by `change`, for undo; `live` says how to undo it in XAE. */
function changeFiles(t: Tools, paths: string[], what: string, change: () => void, live?: LiveUndo): FilesEntry {
  const before = paths.map(p => ({ path: p, before: readText(p), bom: bomOf(p) }));
  const missing = missingFolders(paths);
  change();
  const files: FileChange[] = before.map(f => ({ ...f, after: readText(f.path), bom: f.before === null ? bomOf(f.path) : f.bom }));
  const folders = missing.filter(d => fs.existsSync(d));
  return t.undo.add({ kind: 'files', what, files, live, ...(folders.length ? { folders } : {}) }) as FilesEntry;
}

/** Removes the folders an undone change made, when they are empty again. */
function removeFolders(folders: string[] | undefined): void {
  for (const d of folders ?? []) {
    try {
      fs.rmdirSync(d);
    } catch {
      // not empty (something else is there now), or gone already
    }
  }
}

/** The folders below an XAE item, made where they are missing. */
function ensureFolders(live: Live, base: string[], folders: string[]): void {
  for (let i = 0; i < folders.length; i++) {
    const parent = [...base, ...folders.slice(0, i)];
    const names = inXae(() => live.xae.children({ ...live.item, path: parent })).map(c => c.name.toUpperCase());
    if (!names.includes(folders[i].toUpperCase())) inXae(() => live.xae.create({ ...live.item, path: parent }, folders[i], SUBTYPE.folder, undefined));
  }
}

/** A member of a parsed file as CreateChild makes it again: sub-type, vInfo and code, with its accessors. */
function memberCopy(obj: TcObject, itf: boolean): ItemCopy {
  const text = (accessor: Accessor | undefined, role: Part) => obj.sections.find(x => x.accessor === accessor && x.role === role)?.text;
  const decl = text(undefined, 'decl');
  const sub = obj.kind === 'method' ? (itf ? SUBTYPE.itfMethod : SUBTYPE.method)
    : obj.kind === 'property' ? (itf ? SUBTYPE.itfProperty : SUBTYPE.property)
      : obj.kind === 'action' ? SUBTYPE.action : SUBTYPE.transition;
  return {
    name: obj.name, subType: sub, info: obj.kind === 'property' ? [ST, propertyType(decl ?? '')] : undefined, decl, impl: text(undefined, 'impl') || undefined,
    children: obj.accessors.map(acc => ({
      name: acc.kind, subType: acc.kind === 'Get' ? (itf ? SUBTYPE.itfGet : SUBTYPE.get) : (itf ? SUBTYPE.itfSet : SUBTYPE.set),
      decl: text(acc.kind, 'decl'), impl: text(acc.kind, 'impl') || undefined, children: [],
    })),
  };
}

export function addMember(t: Tools, a: { owner: string; kind: 'method' | 'property' | 'action'; name: string; type?: string; accessors?: ('Get' | 'Set')[]; folder?: string; saveUserEdits?: boolean }): string {
  const s = t.session;
  s.refresh();
  const v = s.resolve(a.owner);
  if (v.obj.parent || v.accessor || (v.obj.kind !== 'pou' && v.obj.kind !== 'itf')) throw new ToolError(`${v.label} is not a POU or interface`);
  if (a.kind === 'action' && (v.obj.kind === 'itf' || v.obj.pouKind === 'FUN')) throw new ToolError('Actions are for function blocks and programs');
  const problem = memberNameProblem(v.obj, a.name);
  if (problem) throw new ToolError(problem);
  const folders = a.folder ? a.folder.split(/[\\/]/).filter(Boolean) : [];
  const spec: MemberSpec = { kind: a.kind, name: a.name, type: a.type, accessors: a.accessors, folderPath: folders.length ? folders : undefined };
  const special = a.kind === 'method' && isSpecialMethod(v.obj, a.name) ? ' with the inputs TwinCAT requires' : '';
  const done = `Added ${a.kind} ${v.label}.${a.name}${special}. Read ${v.label}.${a.name} to fill it in.`;
  const live = liveView(s, t.xae, v);
  if (live) {
    refuseDirty(t, live, [v.entry.path], undefined, a.saveUserEdits);
    refuseUnsaved(live, v, a.saveUserEdits);
    // The member as the extension writes it, made in XAE: XAE shows it at once and gives it its GUID.
    const disk = parseTcFile(v.entry.path, fs.readFileSync(v.entry.path));
    let made;
    try {
      made = parseTcText(v.entry.path, addMemberText(disk, v.obj.id, spec), disk.bom);
    } catch (e) {
      if (e instanceof SpliceError) throw new ToolError(e.message);
      throw e;
    }
    const obj = made.ordered.find(o => o.parent?.id === v.obj.id && o.name.toUpperCase() === a.name.toUpperCase());
    if (!obj) throw new ToolError(`${a.name} could not be made`);
    const copy = memberCopy(obj, v.obj.kind === 'itf');
    const parent = [...live.item.path, ...folders];
    const entry = changeFiles(t, [v.entry.path], `add_member ${v.label}.${a.name}`, () => inXae(() => {
      ensureFolders(live, live.item.path, folders);
      recreate(live, { ...live.item, path: parent }, copy);
      live.xae.save(live.item, v.entry.path);
    }), { project: v.entry.project.name, parent, name: a.name, op: 'added', files: [v.entry.path] });
    return afterWrite(t, v, entry, done, savedOrNotByXae(t, live, v.entry.path, unsavedOf(entry.files)));
  }
  const entry = changeFiles(t, [v.entry.path], `add_member ${v.label}.${a.name}`, () => {
    try {
      addMembersToFile(v.entry.path, v.obj.id, [spec]);
    } catch (e) {
      if (e instanceof SpliceError) throw new ToolError(e.message);
      throw e;
    }
  });
  return afterWrite(t, v, entry, done, savedTo(t, v.entry.path));
}

export function deleteMember(t: Tools, a: { object: string; confirm: boolean; saveUserEdits?: boolean }): string {
  const s = t.session;
  s.refresh();
  const v = s.resolve(a.object);
  if (!v.obj.parent && !v.accessor) throw new ToolError(`${v.label} is not a method, property, accessor, action or transition. Whole objects are deleted in the TwinCAT tree or XAE.`);
  if (!a.confirm) throw new ToolError(`Deleting ${v.label} needs confirm: true. What uses it is not changed.`);
  const live = liveView(s, t.xae, v);
  if (live) {
    refuseDirty(t, live, [v.entry.path], undefined, a.saveUserEdits);
    refuseUnsaved(live, v, a.saveUserEdits);
    const itf = (v.obj.parent ?? v.obj).kind === 'itf';
    const whole = memberCopy(v.obj, itf);
    const copy = v.accessor ? whole.children.find(c => c.name === v.accessor)! : whole;
    const parent = live.item.path.slice(0, -1);
    const name = live.item.path[live.item.path.length - 1];
    const entry = changeFiles(t, [v.entry.path], `delete_member ${v.label}`, () => inXae(() => {
      live.xae.delete({ ...live.item, path: parent }, name);
      live.xae.save(live.item, v.entry.path);
    }), { project: v.entry.project.name, parent, name, op: 'deleted', copy, files: [v.entry.path] });
    return afterWrite(t, v, entry, `Deleted ${v.label}.`, savedOrNotByXae(t, live, v.entry.path, unsavedOf(entry.files)));
  }
  const entry = changeFiles(t, [v.entry.path], `delete_member ${v.label}`, () => removeMemberFromFile(v.entry.path, v.obj.id, v.accessor));
  return afterWrite(t, v, entry, `Deleted ${v.label}.`, savedTo(t, v.entry.path));
}

const KINDS: Record<string, NewObjectKind> = {
  FB: 'fb', PRG: 'prg', FUN: 'fun', ITF: 'itf', STRUCT: 'struct', ENUM: 'enum', UNION: 'union', ALIAS: 'alias', GVL: 'gvl',
};

export function addObject(t: Tools, a: { project?: string; folder?: string; kind: string; name: string; extends?: string; implements?: string; type?: string; saveUserEdits?: boolean }): string {
  const s = t.session;
  s.refresh();
  const kind = KINDS[a.kind.toUpperCase()];
  if (!kind) throw new ToolError(`kind is one of ${Object.keys(KINDS).join(', ')}`);
  let project: PlcProject | undefined;
  if (a.project) project = s.projects.find(p => p.name.toUpperCase() === a.project!.toUpperCase());
  else if (s.projects.length === 1) project = s.projects[0];
  if (!project) throw new ToolError(`Give project: one of ${s.projects.map(p => p.name).join(', ') || '(none loaded)'}`);
  const problem = objectNameProblem(s.ws, project, a.name);
  if (problem) throw new ToolError(problem);
  if ((kind === 'fun' || kind === 'alias') && !a.type) throw new ToolError(kind === 'fun' ? 'A function needs its return type (type)' : 'An alias needs the type it names (type)');
  const folder = (a.folder ?? '').replace(/\//g, '\\').replace(/^\\+|\\+$/g, '');
  const { fsPath, include } = newObjectFile(project, folder, a.name, kind);
  if (fs.existsSync(fsPath)) throw new ToolError(`${path.basename(fsPath)} is already on disk in ${path.dirname(fsPath)}`);
  const spec = { kind, name: a.name, extends: a.extends, implements: a.implements, type: a.type };
  const style = projectFileStyle(s.ws, project);
  const found = kind === 'fb' && a.implements ? newObjectStubs(s.index, project, spec) : { stubs: [], missing: [] as string[] };
  const text = newObjectFileText(spec, style, fsPath, found.stubs.map(x => x.spec));
  const target = project;
  const folders = folder ? folder.split('\\') : [];
  const live = liveProject(s, t.xae, project, folders);
  const missing = found.missing.length ? `\nNot found, so their members were not added: ${found.missing.join(', ')}` : '';
  let entry: UndoEntry;
  let how: string;
  if (live) {
    refuseDirty(t, live, [project.path], project.dir, a.saveUserEdits);
    // The object as the extension writes it, made in XAE, which writes its file and its <Compile> item.
    const made = parseTcText(fsPath, text, style.bom);
    const root = made.root!;
    const sub = { fb: SUBTYPE.fb, prg: SUBTYPE.prg, fun: SUBTYPE.fun, itf: SUBTYPE.itf, struct: SUBTYPE.struct, enum: SUBTYPE.enum, union: SUBTYPE.union, alias: SUBTYPE.alias, gvl: SUBTYPE.gvl }[kind];
    const info = kind === 'fun' ? [ST, a.type!] : kind === 'fb' || kind === 'prg' ? [ST] : undefined;
    const copy: ItemCopy = {
      name: a.name, subType: sub, info,
      decl: root.sections.find(x => x.role === 'decl')?.text, impl: root.sections.find(x => x.role === 'impl')?.text || undefined,
      children: made.ordered.filter(o => o.parent === root).map(o => memberCopy(o, kind === 'itf')),
    };
    const changed = changeFiles(t, [fsPath, project.path], `add_object ${a.name}`, () => inXae(() => {
      ensureFolders(live, [], folders);
      recreate(live, live.item, copy);
      live.xae.save(live.item, fsPath);
    }), { project: project.name, parent: folders, name: a.name, op: 'added', files: [fsPath, project.path] });
    const unsaved = unsavedOf(changed.files);
    how = savedOrNotByXae(t, live, fsPath, unsaved);
    // Until XAE saves its file and the .plcproj, the projects the tools read do not have the object.
    if (unsaved.length) return [`Added ${a.name} to ${project.name}.${missing}`, `${how} undo_last_edit id=${changed.id} takes it back.`].join('\n');
    entry = changed;
  } else {
    entry = changeFiles(t, [fsPath, project.path], `add_object ${a.name}`, () => writeNewObject(target, fsPath, include, text, style.bom));
    how = savedTo(t, fsPath);
  }
  s.refresh();
  const v = s.resolve(`${project.name}:${a.name}`);
  return afterWrite(t, v, entry, `Added ${objectTreeLabel(v.obj)} as ${path.relative(s.root, fsPath)} and in ${path.basename(project.path)}.${missing}`, how);
}

/** The XAE to undo an edit in, when one has the project open. */
function liveFor(t: Tools, projectName: string, itemPath: string[], file?: string): Live | undefined {
  const project = t.session.projects.find(p => p.name === projectName);
  return project ? liveProject(t.session, t.xae, project, itemPath, file) : undefined;
}

export function undoLastEdit(t: Tools, a: { id?: number }): string {
  const s = t.session;
  s.refresh();
  const e = t.undo.get(a.id);
  if (!e) return a.id !== undefined ? `No edit ${a.id}.` : 'Nothing to undo.';
  if (e.undone) throw new ToolError(`Edit ${e.id} (${e.what}) is undone already.`);
  let how = 'in the files';
  let note = '';
  if (e.kind === 'section') {
    let v: View | undefined;
    try {
      v = s.resolve(e.object);
    } catch {
      // the object is gone from the projects: the file below says so
    }
    const live = v && liveView(s, t.xae, v);
    if (v && live) {
      const r = inXae(() => live.xae.get(live.item, e.part));
      if (r.text !== e.after) throw new ToolError(`${e.object} ${e.part} changed after edit ${e.id}; undoing it would lose that. Now:\n${diffSummary(e.after, r.text)}`);
      refuseUnsaved(live, v, false, e.key);
      const res = inXae(() => live.xae.set(live.item, e.part, e.before, r.hash));
      if (res.dirty) inXae(() => live.xae.save(live.item, v!.entry.path));
      how = `in TwinCAT XAE (process ${live.pid})`;
    } else {
      const file = parseTcFile(e.path, fs.readFileSync(e.path));
      const sec = file.sections.get(e.key);
      if (!sec) throw new ToolError(`${e.object} ${e.part} is no longer in ${e.path}`);
      if (sec.text !== e.after) {
        throw new ToolError(`${e.object} ${e.part} changed after edit ${e.id}; undoing it would lose that. Now:\n${diffSummary(e.after, sec.text)}`);
      }
      const result = applySectionEdits(file, [{ key: sec.key, text: e.before }]);
      fs.writeFileSync(e.path, encodeText(result.text, file.bom));
    }
  } else {
    const live = e.live && liveFor(t, e.live.project, e.live.parent, e.live.files[0]);
    if (!live) {
      for (const f of e.files) {
        if (readText(f.path) !== f.after) throw new ToolError(`${path.basename(f.path)} changed after edit ${e.id}; undo it by hand.`);
      }
    }
    if (e.live && live) {
      // In XAE only the item counts, not the rest of its file (other edits, made since, stay).
      const u = e.live;
      const names = inXae(() => live.xae.children({ ...live.item, path: u.parent })).map(c => c.name.toUpperCase());
      if (u.op === 'added' && !names.includes(u.name.toUpperCase())) throw new ToolError(`${u.name} is no longer there; nothing to undo.`);
      if (u.op === 'deleted' && names.includes(u.name.toUpperCase())) throw new ToolError(`There is a ${u.name} again; undo it by hand.`);
      const before = e.files.map(f => readText(f.path));
      inXae(() => {
        const parent = { ...live.item, path: u.parent };
        if (u.op === 'added') live.xae.delete(parent, u.name);
        else recreate(live, parent, u.copy!);
        for (const f of u.files) if (fs.existsSync(f) && !s.ws.isProjectFile(f)) live.xae.save(live.item, f);
      });
      // A deleted object's file can stay on disk: it was not there before.
      for (const f of e.files) if (f.before === null && fs.existsSync(f.path)) fs.rmSync(f.path, { force: true });
      removeFolders(e.folders);
      how = `in TwinCAT XAE (process ${live.pid})`;
      // A file the undo left as it was, though not as it was before the edit: XAE did not save it.
      const unsaved = e.files.filter((f, i) => fs.existsSync(f.path) && readText(f.path) === before[i] && before[i] !== f.before).map(f => f.path);
      if (unsaved.length) note = ` TwinCAT XAE ${notSavedByXae(t, unsaved)}`;
    } else {
      for (const f of e.files) {
        if (f.before === null) fs.rmSync(f.path, { force: true });
        else fs.writeFileSync(f.path, encodeText(f.before, f.bom));
      }
      removeFolders(e.folders);
    }
  }
  t.undo.markUndone(e);
  s.refresh();
  return `Undid edit ${e.id} ${how}: ${e.what}.${note}`;
}

export function editHistory(t: Tools, a: { limit?: number }): string {
  const list = t.undo.list().slice(0, a.limit ?? 30);
  if (!list.length) return 'No edits yet.';
  return list.map(e => `${e.id}  ${e.time.slice(0, 19).replace('T', ' ')}  ${e.what}${e.undone ? '  (undone)' : ''}`).join('\n');
}

// What each tool of the MCP server does, apart from the protocol (server.ts): reads, language queries and file
// changes on a Session, each returning the text the agent gets back. Writes go to the files through splice.ts, the
// way the split editor saves; every write is logged for undo_last_edit. Independent of the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import { normalizeEol, decodeBytes, encodeText, parseTcFile } from '../core/tcfile';
import { offsetIn, positionIn, textHash, viewSections } from '../core/objectText';
import { MemberSpec, SpliceError, applySectionEdits, isSpecialMethod, memberNameProblem } from '../core/splice';
import { addMembersToFile, newObjectFile, newObjectFileText, projectFileStyle, removeMemberFromFile, writeNewObject } from '../core/operations';
import { NewObjectKind } from '../core/newObjects';
import { objectTreeLabel } from '../core/treeLabels';
import { PlcProject } from '../core/project';
import { describeOwner } from '../lang/features';
import { implementations, typeTree, TypeTree } from '../lang/hierarchy';
import { newObjectStubs, objectNameProblem } from '../lang/objects';
import { PouSym, Sym } from '../lang/symbols';
import { Session, ToolError, View, numbered, shortHash } from './session';
import { FileChange, UndoEntry, UndoLog } from './undo';

export interface Tools {
  session: Session;
  undo: UndoLog;
}

type Part = 'decl' | 'impl';

const PART_WORD: Record<Part, string> = { decl: 'Declaration', impl: 'Implementation' };

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
  lines.push('Writes go to the files (TwinCAT XAE, when it has the solution open, reloads them or asks to).');
  return lines.join('\n');
}

export function objects(t: Tools, a: { project?: string; filter?: string; offset?: number; limit?: number }): string {
  const s = t.session;
  const filter = a.filter?.toUpperCase();
  const project = a.project?.toUpperCase();
  const roots = s.views().filter(v => !v.obj.parent && !v.accessor && (!project || v.entry.project.name.toUpperCase() === project));
  const members = (v: View) => s.views().filter(m => m.file === v.file && m.obj !== v.obj);
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
  const out = [`${s.qualified(v)} (${v.accessor ? 'accessor' : v.obj.kind}) · ${v.entry.project.name} · ${v.entry.include}`];
  for (const sec of viewSections(v.obj, v.accessor)) {
    if (a.part && sec.role !== a.part) continue;
    if (!sec.editable) {
      out.push(`── ${sec.role} · not Structured Text: read-only here, edit it in TwinCAT XAE`);
      continue;
    }
    const lines = sec.text.split('\n').length - (sec.text.endsWith('\n') ? 1 : 0);
    out.push(`── ${sec.role} · hash ${shortHash(sec.text)} · ${lines} lines`);
    out.push(numbered(sec.text, a.from, a.to));
  }
  return out.join('\n');
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

export function check(t: Tools, a: { object?: string; limit?: number }): string {
  const s = t.session;
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

function afterWrite(t: Tools, v: View, entry: UndoEntry, detail: string): string {
  t.session.refresh();
  let problems: string[] = [];
  try {
    problems = problemsOfView(t, t.session.resolve(t.session.qualified(v)));
  } catch {
    // the object is gone (deleted): no problems to show
  }
  return [detail, `Saved to ${path.relative(t.session.root, v.entry.path)}. undo_last_edit id=${entry.id} takes it back.`,
    problems.length ? `Problems now:\n${problems.join('\n')}` : 'Problems now: none (syntax and name check).'].join('\n');
}

function writeSectionText(t: Tools, a: { object: string; part: Part; hash?: string }, change: (current: string) => string, what: string): string {
  const s = t.session;
  s.refresh();
  const v = s.resolve(a.object);
  const sec = s.section(v, a.part);
  if (!sec.editable) throw new ToolError(`${v.label} ${a.part} is not Structured Text; edit it in TwinCAT XAE`);
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
  return afterWrite(t, v, entry, `${s.qualified(v)} ${a.part}: hash ${shortHash(next)}\n${diffSummary(onDisk.text, next)}`);
}

export function editSection(t: Tools, a: { object: string; part: Part; oldText: string; newText: string; hash?: string }): string {
  return writeSectionText(t, a, current => {
    const old = normalizeEol(a.oldText);
    const first = current.indexOf(old);
    if (!old || first < 0) throw new ToolError(`oldText is not in ${a.object} ${a.part}. Read it again; whitespace and tabs count.`);
    if (current.indexOf(old, first + 1) >= 0) throw new ToolError('oldText occurs more than once; give more of the surrounding text.');
    return current.slice(0, first) + normalizeEol(a.newText) + current.slice(first + old.length);
  }, 'edit_section');
}

export function writeSection(t: Tools, a: { object: string; part: Part; text: string; hash: string }): string {
  return writeSectionText(t, a, () => a.text, 'write_section');
}

/** Records a change of whole files, done by `change`, for undo. */
function changeFiles(t: Tools, paths: string[], what: string, change: () => void): UndoEntry {
  const bom = (p: string) => {
    try {
      const b = fs.readFileSync(p);
      return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    } catch {
      return false;
    }
  };
  const before = paths.map(p => ({ path: p, before: readText(p), bom: bom(p) }));
  change();
  const files: FileChange[] = before.map(f => ({ ...f, after: readText(f.path), bom: f.before === null ? bom(f.path) : f.bom }));
  return t.undo.add({ kind: 'files', what, files });
}

export function addMember(t: Tools, a: { owner: string; kind: 'method' | 'property' | 'action'; name: string; type?: string; accessors?: ('Get' | 'Set')[]; folder?: string }): string {
  const s = t.session;
  s.refresh();
  const v = s.resolve(a.owner);
  if (v.obj.parent || v.accessor || (v.obj.kind !== 'pou' && v.obj.kind !== 'itf')) throw new ToolError(`${v.label} is not a POU or interface`);
  if (a.kind === 'action' && (v.obj.kind === 'itf' || v.obj.pouKind === 'FUN')) throw new ToolError('Actions are for function blocks and programs');
  const problem = memberNameProblem(v.obj, a.name);
  if (problem) throw new ToolError(problem);
  const spec: MemberSpec = { kind: a.kind, name: a.name, type: a.type, accessors: a.accessors, folderPath: a.folder ? a.folder.split(/[\\/]/) : undefined };
  const entry = changeFiles(t, [v.entry.path], `add_member ${v.label}.${a.name}`, () => {
    try {
      addMembersToFile(v.entry.path, v.obj.id, [spec]);
    } catch (e) {
      if (e instanceof SpliceError) throw new ToolError(e.message);
      throw e;
    }
  });
  const special = a.kind === 'method' && isSpecialMethod(v.obj, a.name) ? ' with the inputs TwinCAT requires' : '';
  return afterWrite(t, v, entry, `Added ${a.kind} ${v.label}.${a.name}${special}. Read ${v.label}.${a.name} to fill it in.`);
}

export function deleteMember(t: Tools, a: { object: string; confirm: boolean }): string {
  const s = t.session;
  s.refresh();
  const v = s.resolve(a.object);
  if (!v.obj.parent && !v.accessor) throw new ToolError(`${v.label} is not a method, property, accessor, action or transition. Whole objects are deleted in the TwinCAT tree or XAE.`);
  if (!a.confirm) throw new ToolError(`Deleting ${v.label} needs confirm: true. What uses it is not changed.`);
  const entry = changeFiles(t, [v.entry.path], `delete_member ${v.label}`, () => removeMemberFromFile(v.entry.path, v.obj.id, v.accessor));
  return afterWrite(t, v, entry, `Deleted ${v.label}.`);
}

const KINDS: Record<string, NewObjectKind> = {
  FB: 'fb', PRG: 'prg', FUN: 'fun', ITF: 'itf', STRUCT: 'struct', ENUM: 'enum', UNION: 'union', ALIAS: 'alias', GVL: 'gvl',
};

export function addObject(t: Tools, a: { project?: string; folder?: string; kind: string; name: string; extends?: string; implements?: string; type?: string }): string {
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
  const entry = changeFiles(t, [fsPath, project.path], `add_object ${a.name}`, () => writeNewObject(target, fsPath, include, text, style.bom));
  s.refresh();
  const v = s.resolve(`${project.name}:${a.name}`);
  const missing = found.missing.length ? `\nNot found, so their members were not added: ${found.missing.join(', ')}` : '';
  return afterWrite(t, v, entry, `Added ${objectTreeLabel(v.obj)} as ${path.relative(s.root, fsPath)} and in ${path.basename(project.path)}.${missing}`);
}

export function undoLastEdit(t: Tools, a: { id?: number }): string {
  const e = t.undo.get(a.id);
  if (!e) return a.id !== undefined ? `No edit ${a.id}.` : 'Nothing to undo.';
  if (e.undone) throw new ToolError(`Edit ${e.id} (${e.what}) is undone already.`);
  if (e.kind === 'section') {
    const file = parseTcFile(e.path, fs.readFileSync(e.path));
    const sec = file.sections.get(e.key);
    if (!sec) throw new ToolError(`${e.object} ${e.part} is no longer in ${e.path}`);
    if (sec.text !== e.after) {
      throw new ToolError(`${e.object} ${e.part} changed after edit ${e.id}; undoing it would lose that. Now:\n${diffSummary(e.after, sec.text)}`);
    }
    const result = applySectionEdits(file, [{ key: sec.key, text: e.before }]);
    fs.writeFileSync(e.path, encodeText(result.text, file.bom));
  } else {
    for (const f of e.files) {
      if (readText(f.path) !== f.after) throw new ToolError(`${path.basename(f.path)} changed after edit ${e.id}; undo it by hand.`);
    }
    for (const f of e.files) {
      if (f.before === null) fs.rmSync(f.path, { force: true });
      else fs.writeFileSync(f.path, encodeText(f.before, f.bom));
    }
  }
  t.undo.markUndone(e);
  t.session.refresh();
  return `Undid edit ${e.id}: ${e.what}.`;
}

export function editHistory(t: Tools, a: { limit?: number }): string {
  const list = t.undo.list().slice(0, a.limit ?? 30);
  if (!list.length) return 'No edits yet.';
  return list.map(e => `${e.id}  ${e.time.slice(0, 19).replace('T', ' ')}  ${e.what}${e.undone ? '  (undone)' : ''}`).join('\n');
}


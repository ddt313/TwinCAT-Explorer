// Rename with the uses, as XAE's rename changes them: where the language index finds a POU, DUT, GVL, interface,
// member, variable, parameter, DUT field or enum value used, as edits per section; the texts of the files with
// them (only the CDATA of the edited sections changes, see applySectionEdits; the renamed object's own Name,
// header and LineIds through renameObject and renameMember); what the index cannot follow (names it does not
// resolve, implementations in other languages); and the places whose meaning the new name would change.

import { Analysis, analyze } from './analyzer';
import { ancestors, descendants } from './hierarchy';
import { LanguageIndex, SectionContext } from './index';
import { Tk, lex } from './lexer';
import { nameProblem } from './members';
import { EnumValueSym, Loc, Scope, Sym, TypeSym, VarSym, isLibrarySym } from './symbols';
import { SectionEdit, SpliceError, applySectionEdits, blankTrivia, nameRanges, renameMember, renameObject } from '../core/splice';
import { ObjectKind, TcSourceFile, parseTcText } from '../core/tcfile';
import { fileKey } from '../core/workspace';

/** The analysis of a section with a text (the language features keep them, for the whole workspace). */
export type Analyse = (ctx: SectionContext, text: string) => Analysis;

/** A section a rename edits: where the old name is in its text. */
export interface RenameSection {
  fileKey: string;
  filePath: string;
  sectionKey: string;
  /** The text the ranges are in: the index's, which is the disk's in a file without unsaved edits. */
  text: string;
  ranges: { start: number; end: number }[];
  /** The object the section belongs to; the sections of an accessor belong to its property. */
  object: { id: string; kind: ObjectKind; qualifiedName: string };
  accessor?: 'Get' | 'Set';
  /** `Declaration`, `Get · Implementation`, ... */
  label: string;
}

/** An object or member whose Name, header and LineIds change (see renameObject and renameMember). */
export interface RenameDeclaration {
  fileKey: string;
  filePath: string;
  objectId: string;
  /** The POU, DUT, GVL or interface of the file, not a member of it. */
  root: boolean;
}

/** A place the rename does not read that has the old name: an implementation in another language, another file. */
export interface UnreadPlace {
  filePath: string;
  /** The object, for an implementation. */
  object?: string;
  /** The element of the implementation in the file: CFC, SFC, NWL (FBD, LD and IL), ... */
  language?: string;
}

export interface RenamePlan {
  oldName: string;
  newName: string;
  /** What is renamed: a symbol, or a method or property with those that implement or override it. */
  symbols: Sym[];
  declarations: RenameDeclaration[];
  /** The objects (see objectKey) that declare what is renamed: the rest is what the rename changes elsewhere. */
  homes: string[];
  /** The uses, and the declarations of variables, parameters, fields and enum values, by section. */
  sections: RenameSection[];
  /** Places with the old name that the language index does not resolve: they keep it. */
  unresolved: Loc[];
  unread: UnreadPlace[];
}

/** A file after a rename. */
export interface RenamedFile {
  filePath: string;
  text: string;
  bom: boolean;
}

/** A place whose meaning the rename would change. */
export interface RenameConflict {
  /** Where it is, in the text before the rename. */
  loc: Loc;
  message: string;
}

/** The key of the object (and accessor) of a section: what the confirmation lists and can leave out. */
export function objectKey(s: { fileKey: string; object: { id: string }; accessor?: string }): string {
  return `${s.fileKey}|${s.object.id}|${s.accessor ?? ''}`;
}

/** The name of a symbol with what holds it: `FB_Pump.M_Start`, `FB_Pump.M_Start.fSpeed`, `E_State.Idle`. */
export function symbolLabel(s: Sym): string {
  switch (s.kind) {
    case 'var': return `${symbolLabel(s.owner)}${s.accessor ? `.${s.accessor}` : ''}.${s.name}`;
    case 'method':
    case 'property':
    case 'action':
    case 'transition':
    case 'enumValue':
      return `${s.owner.name}.${s.name}`;
    default: return s.name;
  }
}

/**
 * What a rename at an offset of a section renames (the symbol of the name there) and the range of the name; or
 * why it renames nothing there.
 */
export function renameTargetAt(analysis: Analysis, offset: number): { sym: Sym; start: number; end: number } | { problem: string } {
  const o = analysis.occurrences.find(x => x.start <= offset && offset <= x.end);
  if (!o) return { problem: 'Only a name the language index resolves can be renamed here.' };
  const s = o.sym;
  const word = analysis.text.slice(o.start, o.end);
  // THIS and SUPER stand for a function block without being its name.
  if (word.toUpperCase() !== s.name.toUpperCase()) return { problem: `${word} cannot be renamed.` };
  if (s.kind === 'builtin') return { problem: `${s.name} is built in.` };
  if (s.kind === 'namespace') return { problem: `${s.name} is the namespace of a library.` };
  if (isLibrarySym(s)) return { problem: `${s.name} is declared in the library ${s.scope.name}.` };
  return { sym: s, start: o.start, end: o.end };
}

/**
 * Why a variable, parameter, field or enum value cannot take a new name: not an identifier, a keyword, or a name
 * declared next to it (in its POU, member, GVL, structure or enumeration, in those it extends or that extend
 * it); undefined when it can. What the new name would change elsewhere is renameConflicts' to find.
 */
export function symbolNameProblem(index: LanguageIndex, sym: VarSym | EnumValueSym, newName: string): string | undefined {
  const problem = nameProblem(newName);
  if (problem) return problem;
  const upper = newName.toUpperCase();
  if (upper === sym.name.toUpperCase()) return undefined;
  const taken = (where: string, list: { name: string }[]) => {
    const t = list.find(x => x !== sym && x.name.toUpperCase() === upper);
    return t ? `${where} already has ${t.name}` : undefined;
  };
  if (sym.kind === 'enumValue') return taken(sym.owner.name, sym.owner.values);
  const owner = sym.owner;
  switch (owner.kind) {
    case 'pou': {
      for (const p of [owner, ...ancestors(index, owner), ...descendants(index, owner)]) {
        const t = taken(p.name, [...p.vars, ...p.members]);
        if (t) return t;
      }
      return undefined;
    }
    case 'type': {
      // The structure, those it extends and those that extend it.
      const base = (t: TypeSym) => {
        const b = t.extendsName && index.resolveGlobal(t.extendsName.parts, t.scope);
        return b && b.kind === 'type' ? b : undefined;
      };
      const chain = (t: TypeSym) => {
        const out = [t];
        for (let b = base(t); b && out.length < 20 && !out.includes(b); b = base(b)) out.push(b);
        return out;
      };
      const types = index.allGlobals().filter((g): g is TypeSym => g.kind === 'type');
      for (const t of new Set([...chain(owner), ...types.filter(t => chain(t).includes(owner))])) {
        const clash = taken(t.name, t.fields);
        if (clash) return clash;
      }
      return undefined;
    }
    case 'gvl':
      return taken(owner.name, owner.vars);
    default: {
      // A member: its variables, those of its accessor for an accessor's.
      const vars = sym.accessor === 'Get' ? owner.getVars : sym.accessor === 'Set' ? owner.setVars : owner.vars;
      if (upper === owner.name.toUpperCase()) return `${newName} is the name of the ${owner.kind} itself`;
      return taken(`${owner.owner.name}.${owner.name}`, vars);
    }
  }
}

/** Whether a scope sees another: the same, or one it references (as a library), whatever the depth. */
function sees(scope: Scope, target: Scope, seen = new Set<Scope>()): boolean {
  if (scope === target) return true;
  if (seen.has(scope)) return false;
  seen.add(scope);
  return scope.refs.some(r => sees(r, target, seen));
}

/** The section context a POU, DUT, GVL, interface or member is declared in (its declaration, else its first section). */
function homeOf(contexts: SectionContext[], s: Sym): SectionContext | undefined {
  switch (s.kind) {
    case 'pou': return contexts.find(c => c.pou === s && !c.member);
    case 'type': return contexts.find(c => c.types.includes(s));
    case 'gvl': return contexts.find(c => c.gvl === s);
    case 'method':
    case 'property':
    case 'action':
    case 'transition':
      return contexts.find(c => c.member === s);
    case 'var': return homeOf(contexts, s.owner);
    case 'enumValue': return homeOf(contexts, s.owner);
    default: return undefined;
  }
}

/**
 * The symbol as the index has it now (a rebuild makes new symbols), found where it is declared; undefined when
 * it is no longer there.
 */
function current(index: LanguageIndex, contexts: SectionContext[], s: Sym): Sym | undefined {
  const same = (x: Sym | undefined) => (x && x.kind === s.kind && x.name.toUpperCase() === s.name.toUpperCase() ? x : undefined);
  if (s.kind === 'var' || s.kind === 'enumValue') {
    return s.loc && same(index.declaredAt(s.loc.fileKey, s.loc.sectionKey, s.loc.start));
  }
  if (homeOf(contexts, s)) return s;
  if (s.kind === 'method' || s.kind === 'property' || s.kind === 'action' || s.kind === 'transition') {
    const owner = current(index, contexts, s.owner);
    return owner?.kind === 'pou' ? same(owner.members.find(m => m.name.toUpperCase() === s.name.toUpperCase())) : undefined;
  }
  const loc = s.loc;
  const ctx = loc && index.context(loc.fileKey, loc.sectionKey);
  return same(s.kind === 'pou' ? ctx?.pou : s.kind === 'gvl' ? ctx?.gvl : s.kind === 'type' ? ctx?.types.find(t => same(t)) : undefined);
}

/**
 * Whether a name in a text is used as a member or a named parameter: after a dot or `#`, or before `:=` or `=>`
 * after `(` or `,`. Such a name can be one of a variable declared elsewhere.
 */
function memberLike(text: string, start: number, end: number): boolean {
  let before = start - 1;
  while (before >= 0 && /\s/.test(text[before])) before--;
  if (text[before] === '.' || text[before] === '#') return true;
  let after = end;
  while (after < text.length && /\s/.test(text[after])) after++;
  return (text.startsWith(':=', after) || text.startsWith('=>', after)) && (text[before] === '(' || text[before] === ',');
}

/** Whether uses of the symbol outside the file it is declared in can only be members or named parameters. */
function isLocal(s: Sym): boolean {
  if (s.kind === 'var') return s.owner.kind !== 'gvl';
  return s.kind === 'method' || s.kind === 'property' || s.kind === 'action' || s.kind === 'transition';
}

/**
 * What renaming the symbols (one, or a member with those that go with it, see relatedMembers) changes: where the
 * language index finds them in the sections of the workspace, unsaved edits included; the objects and members
 * whose own declaration changes; and what it does not change, the places with the old name it does not resolve
 * and those it does not read. The symbols must be the index's current ones.
 */
export function planRename(index: LanguageIndex, symbols: Sym[], newName: string,
  analyse: Analyse = (ctx, text) => analyze(index, ctx, text)): RenamePlan {
  const contexts = index.allContexts();
  if (symbols.length === 0) throw new SpliceError('Nothing to rename');
  const targets = symbols.map(s => {
    const c = current(index, contexts, s);
    if (!c) throw new SpliceError(`${symbolLabel(s)} is no longer where it was declared`);
    return c;
  });
  const oldName = targets[0].name;
  const upperOld = oldName.toUpperCase();
  if (targets.some(t => t.name.toUpperCase() !== upperOld)) throw new SpliceError('The symbols renamed together have one name');

  // Objects and members: their declaration and their name inside them change with renameObject and renameMember.
  const declarations: RenameDeclaration[] = [];
  const renamedThere = new Set<string>();
  const homeFiles = new Set<string>();
  const homes: string[] = [];
  for (const t of targets) {
    const home = homeOf(contexts, t);
    if (!home) throw new SpliceError(`${symbolLabel(t)} is not declared in a file of the workspace`);
    homeFiles.add(home.fileKey);
    if (t.kind === 'var' || t.kind === 'enumValue') {
      // The object (or accessor) of its declaration.
      const at = t.loc && index.context(t.loc.fileKey, t.loc.sectionKey);
      if (at) homes.push(objectKey(at));
      continue;
    }
    const root = !(t.kind === 'method' || t.kind === 'property' || t.kind === 'action' || t.kind === 'transition');
    const file = index.ws.getFile(home.filePath);
    if (!file) throw new SpliceError(`${home.filePath} cannot be read`);
    declarations.push({ fileKey: home.fileKey, filePath: home.filePath, objectId: home.object.id, root });
    homes.push(...['', 'Get', 'Set'].map(accessor => objectKey({ fileKey: home.fileKey, object: home.object, accessor })));
    for (const r of nameRanges(file, home.object.id)) renamedThere.add(`${home.fileKey}|${r.section.key}:${r.start}`);
  }

  const wanted = new Set<Sym>(targets);
  const scopes = targets.map(t => t.scope);
  const visible = (scope: Scope) => scopes.some(s => sees(scope, s));
  const local = targets.every(isLocal);
  const sections: RenameSection[] = [];
  const unresolved: Loc[] = [];
  for (const ctx of contexts) {
    const text = index.sectionText(ctx.fileKey, ctx.sectionKey);
    if (!text) continue;
    const analysis = analyse(ctx, text);
    const ranges: { start: number; end: number }[] = [];
    for (const o of analysis.occurrences) {
      if (!wanted.has(o.sym) || (o.decl && o.sym.kind !== 'var' && o.sym.kind !== 'enumValue')) continue;
      if (renamedThere.has(`${ctx.fileKey}|${ctx.sectionKey}:${o.start}`)) continue;
      // THIS^ and SUPER^ stand for a function block without being its name.
      if (text.slice(o.start, o.end).toUpperCase() !== upperOld) continue;
      if (!ranges.some(r => r.start === o.start)) ranges.push({ start: o.start, end: o.end });
    }
    if (ranges.length) {
      ranges.sort((a, b) => a.start - b.start);
      sections.push({
        fileKey: ctx.fileKey, filePath: ctx.filePath, sectionKey: ctx.sectionKey, text, ranges, accessor: ctx.accessor, label: ctx.label,
        object: { id: ctx.object.id, kind: ctx.object.kind, qualifiedName: ctx.object.qualifiedName },
      });
    }
    // The old name where the index resolves no name: in code it cannot follow (a member of an unknown type).
    if (!visible(ctx.scope)) continue;
    const blanked = blankTrivia(text);
    const word = /\b[A-Za-z_]\w*/g;
    for (let m = word.exec(blanked); m; m = word.exec(blanked)) {
      if (m[0].toUpperCase() !== upperOld) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (analysis.occurrences.some(o => o.start <= start && start < o.end)) continue;
      if (renamedThere.has(`${ctx.fileKey}|${ctx.sectionKey}:${start}`)) continue;
      if (local && !homeFiles.has(ctx.fileKey) && !memberLike(blanked, start, end)) continue;
      unresolved.push({ fileKey: ctx.fileKey, sectionKey: ctx.sectionKey, start, end });
    }
  }

  // Implementations in other languages, and the other files of the projects (visualizations, ...), are not read.
  // Outside its own file, a member or local variable is named after a dot (`MAIN.fbPump.P_Speed`).
  const unread: UnreadPlace[] = [];
  const named = new RegExp(`(?<![\\w])${oldName}(?![\\w])`, 'i');
  const asMember = new RegExp(`\\.\\s*${oldName}(?![\\w])`, 'i');
  for (const e of index.ws.sourceEntries) {
    const scope = index.projectScope(e.project);
    if (!scope || !visible(scope)) continue;
    const mentions = local && !homeFiles.has(e.key) ? asMember : named;
    const file = index.ws.getFile(e.path);
    if (!file) continue;
    if (!file.root) {
      if (file.fileKind === 'other' && mentions.test(file.text)) unread.push({ filePath: e.path });
      continue;
    }
    for (const s of file.sections.values()) {
      const el = s.element;
      if (s.editable || !mentions.test(file.text.slice(el.start, el.end))) continue;
      unread.push({ filePath: e.path, object: `${s.owner.qualifiedName}${s.accessor ? `.${s.accessor}` : ''}`, language: el.name });
    }
  }
  return { oldName, newName, symbols: targets, declarations, homes, sections, unresolved, unread };
}

/** The plan of a rename of an object or member alone, which the language index does not know (no uses). */
export function renameAlone(filePath: string, objectId: string, root: boolean, oldName: string, newName: string): RenamePlan {
  const key = fileKey(filePath);
  return {
    oldName, newName, symbols: [], declarations: [{ fileKey: key, filePath, objectId, root }], homes: [], sections: [], unresolved: [], unread: [],
  };
}

/** The file and object that declare a symbol; for a variable, parameter, field or enum value, those that hold it. */
export function symbolHome(index: LanguageIndex, s: Sym): { filePath: string; objectId: string } | undefined {
  const home = homeOf(index.allContexts(), s);
  return home && { filePath: home.filePath, objectId: home.object.id };
}

/** Whether a rename changes code outside the objects that declare what it renames. */
export function changesElsewhere(plan: RenamePlan): boolean {
  return plan.sections.some(s => !plan.homes.includes(objectKey(s)));
}

/** The text with the ranges (in order, not overlapping) replaced by a name. */
function replaceRanges(text: string, ranges: { start: number; end: number }[], name: string): string {
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    out += text.slice(pos, r.start) + name;
    pos = r.end;
  }
  return out + text.slice(pos);
}

/**
 * The files a rename changes, as they are after it, by file key: each file as `read` gives it (from disk), with
 * the new name in the sections of the plan (less those of the objects left out, see objectKey) and the renamed
 * objects and members (see renameObject and renameMember). Everything else in a file stays byte for byte. Throws,
 * before anything is written, when a section is no longer the text the plan was made on.
 */
export function renameTexts(plan: RenamePlan, read: (filePath: string) => TcSourceFile | undefined,
  leaveOut: ReadonlySet<string> = new Set()): Map<string, RenamedFile> {
  const byFile = new Map<string, { filePath: string; sections: RenameSection[]; declarations: RenameDeclaration[] }>();
  const of = (key: string, filePath: string) => {
    let f = byFile.get(key);
    if (!f) byFile.set(key, f = { filePath, sections: [], declarations: [] });
    return f;
  };
  for (const s of plan.sections) if (!leaveOut.has(objectKey(s))) of(s.fileKey, s.filePath).sections.push(s);
  for (const d of plan.declarations) of(d.fileKey, d.filePath).declarations.push(d);
  const out = new Map<string, RenamedFile>();
  for (const [key, f] of byFile) {
    const file = read(f.filePath);
    if (!file || file.error) throw new SpliceError(`${f.filePath} cannot be read${file?.error ? `: ${file.error}` : ''}`);
    const edits: SectionEdit[] = f.sections.map(s => {
      if (file.sections.get(s.sectionKey)?.text !== s.text) {
        throw new SpliceError(`${s.object.qualifiedName} (${s.label}) is not as it was when its uses of ${plan.oldName} were found: rename again`);
      }
      return { key: s.sectionKey, text: replaceRanges(s.text, s.ranges, plan.newName) };
    });
    let text = applySectionEdits(file, edits).text;
    for (const d of f.declarations) {
      const edited = parseTcText(file.path, text, file.bom);
      text = d.root ? renameObject(edited, plan.newName) : renameMember(edited, d.objectId, plan.newName);
    }
    out.set(key, { filePath: f.filePath, text, bom: file.bom });
  }
  return out;
}

/** The id a symbol has once renamed, as the index makes ids (see LanguageIndex.makePou and the others). */
function renamedId(s: Sym, newName: string): string {
  const upper = newName.toUpperCase();
  switch (s.kind) {
    case 'gvl': return `${s.scope.name}::${newName}`;
    case 'var': return `${s.owner.id}#${s.accessor ? `${s.accessor}.` : ''}${upper}`;
    case 'method':
    case 'property':
    case 'action':
    case 'transition':
    case 'enumValue':
      return `${s.owner.id}.${upper}`;
    default: return `${s.scope.name}::${upper}`;
  }
}

/** The starts of the names in a text, in order: identifiers, and the type and the value of a typed literal. */
function nameStarts(text: string): number[] {
  const out: number[] = [];
  for (const t of lex(text).tokens) {
    if (t.kind === Tk.Ident) out.push(t.start);
    else if (t.kind === Tk.TypedLiteral) {
      out.push(t.start);
      if (/^[A-Za-z_]\w*$/.test(t.value ?? '')) out.push(t.prefixEnd! + 1);
    }
  }
  return out;
}

/**
 * The places whose meaning the rename would change: a name that the language index resolves before it and that,
 * once the files are as `texts` has them, means something else, or nothing, though it is not a use of what is
 * renamed in an object left out. Found by resolving the code again as it would be (see LanguageIndex.withFiles):
 * for example a variable renamed to the name of another one that its uses would then mean, or one that a local
 * variable of the new name would hide.
 */
export function renameConflicts(index: LanguageIndex, plan: RenamePlan, texts: Map<string, RenamedFile>,
  leaveOut: ReadonlySet<string> = new Set(), analyse: Analyse = (ctx, text) => analyze(index, ctx, text)): RenameConflict[] {
  const after = index.withFiles(new Map([...texts].map(([key, f]): [string, TcSourceFile] => [key, parseTcText(f.filePath, f.text, f.bom)])));
  const renamed = plan.symbols.map(s => [s.id, renamedId(s, plan.newName)] as const);
  // A renamed POU takes its members and variables along (`FB_X.M_Run`, `FB_X#NSPEED`), a renamed member its variables.
  const mapId = (id: string) => {
    for (const [old, now] of renamed) {
      if (id === old) return now;
      if (id.startsWith(old) && (id[old.length] === '.' || id[old.length] === '#')) return now + id.slice(old.length);
    }
    return id;
  };
  const leftOut = plan.sections.some(s => leaveOut.has(objectKey(s)));
  const names = new RegExp(`\\b(?:${plan.oldName}|${plan.newName})\\b`, 'i');
  const conflicts: RenameConflict[] = [];
  for (const ctx of index.allContexts()) {
    const before = index.sectionText(ctx.fileKey, ctx.sectionKey);
    if (!before) continue;
    const a = analyse(ctx, before);
    if (!texts.has(ctx.fileKey) && !names.test(before) && !a.occurrences.some(o => mapId(o.sym.id) !== o.sym.id)) continue;
    const actx = after.context(ctx.fileKey, ctx.sectionKey);
    const text = after.sectionText(ctx.fileKey, ctx.sectionKey);
    if (!actx || text === undefined) continue;
    const b = analyze(after, actx, text);
    const startsBefore = nameStarts(before);
    const startsAfter = nameStarts(text);
    const at = (start: number) => ({ fileKey: ctx.fileKey, sectionKey: ctx.sectionKey, start, end: start });
    if (startsBefore.length !== startsAfter.length) {
      conflicts.push({ loc: at(0), message: 'its names would change in a way the check cannot follow' });
      continue;
    }
    const indexOf = new Map(startsBefore.map((s, i) => [s, i] as const));
    const resolved = new Map(b.occurrences.map(o => [o.start, o] as const));
    for (const o of a.occurrences) {
      const i = indexOf.get(o.start);
      if (i === undefined) continue;
      const now = resolved.get(startsAfter[i]);
      const expected = mapId(o.sym.id);
      const loc = { fileKey: ctx.fileKey, sectionKey: ctx.sectionKey, start: o.start, end: o.end };
      if (!now) {
        // A use left with the old name in an object left out stops resolving: that is what leaving it out does.
        if (!(leftOut && expected !== o.sym.id)) conflicts.push({ loc, message: `would no longer refer to ${symbolLabel(o.sym)}` });
      } else if (now.sym.id !== expected) {
        conflicts.push({ loc, message: `would refer to ${symbolLabel(now.sym)} instead of ${symbolLabel(o.sym)}` });
      }
    }
  }
  return conflicts;
}

/** The objects a plan changes, each with the number of places and its first changed line: what the confirmation lists. */
export function planObjects(plan: RenamePlan): { key: string; filePath: string; label: string; kind: ObjectKind; changes: number; line: string }[] {
  const out = new Map<string, { key: string; filePath: string; label: string; kind: ObjectKind; changes: number; line: string }>();
  for (const s of plan.sections) {
    const key = objectKey(s);
    let o = out.get(key);
    if (!o) {
      const lineStart = s.text.lastIndexOf('\n', s.ranges[0].start - 1) + 1;
      const lineEnd = s.text.indexOf('\n', s.ranges[0].start);
      out.set(key, o = {
        key, filePath: s.filePath, label: `${s.object.qualifiedName}${s.accessor ? `.${s.accessor}` : ''}`, kind: s.object.kind, changes: 0,
        line: s.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim(),
      });
    }
    o.changes += s.ranges.length;
  }
  return [...out.values()];
}

/** The paths of the files a rename writes: those of its declarations and of its uses, less those of the objects left out. */
export function planFiles(plan: RenamePlan, leaveOut: ReadonlySet<string> = new Set()): string[] {
  const out = new Map<string, string>();
  for (const d of plan.declarations) out.set(d.fileKey, d.filePath);
  for (const s of plan.sections) if (!leaveOut.has(objectKey(s))) out.set(s.fileKey, s.filePath);
  return [...out.values()];
}

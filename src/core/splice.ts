// Writes edited Structured Text back into a TwinCAT file by replacing only the
// CDATA content of the changed sections. Everything else (BOM, EOL, attribute
// order, GUIDs, untouched sections) stays byte-identical. New members (methods,
// properties, actions) are inserted as whole elements, the rest of the file
// staying as it is.

import { randomUUID } from 'crypto';
import { viewChange, viewExists } from './objectChanges';
import { Accessor, viewLabel, viewSections } from './objectText';
import {
  Section, TcObject, TcSourceFile, normalizeEol, normalizeId, parseTcText, sectionOffsetToFileOffset, stripTrivia, toEol,
} from './tcfile';
import { XmlElement, attributeRange, elementLines, escapeAttr, indentBefore } from './xml';

export interface SectionEdit {
  key: string;
  text: string;
}

export class SpliceError extends Error {}

const MODIFIERS = '(?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL|ABSTRACT)\\s+)*';
const HEADER_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:FUNCTION_BLOCK|PROGRAM|FUNCTION|METHOD|PROPERTY|INTERFACE)\\s+${MODIFIERS}([A-Za-z_]\\w*)`, 'i'),
  /\bTYPE\s+([A-Za-z_]\w*)/i,
];

/** Name declared in the header of a declaration (`METHOD Foo : BOOL` gives `Foo`). */
export function declaredName(declaration: string): string | undefined {
  const stripped = stripTrivia(declaration);
  let best: { index: number; name: string } | undefined;
  for (const re of HEADER_PATTERNS) {
    const m = re.exec(stripped);
    if (m && (!best || m.index < best.index)) best = { index: m.index, name: m[1] };
  }
  return best?.name;
}

export function escapeCdata(text: string): string {
  return text.split(']]>').join(']]]]><![CDATA[>');
}

/** Throws if the edit renames the object through its declaration header. */
export function checkRename(section: Section, newText: string): void {
  if (section.role !== 'decl' || section.accessor) return;
  const before = declaredName(section.text);
  if (!before) return;
  const after = declaredName(newText);
  if (after === before) return;
  const what = after
    ? `renames '${before}' to '${after}'`
    : `removes the declaration header of '${before}'`;
  throw new SpliceError(
    `The declaration ${what}. A save does not rename: use Rename Symbol (F2) on the name, or Rename in the TwinCAT tree.`);
}

export interface SpliceResult {
  text: string;
  changedKeys: string[];
}

/** The edit that gives a section another text: its CDATA, with the line breaks of the file. */
function cdataEdit(file: TcSourceFile, section: Section, text: string): TextEdit {
  const el = section.element;
  const inner = `<![CDATA[${escapeCdata(toEol(text, file.eol))}]]>`;
  return el.selfClosing ? { start: el.start, end: el.end, value: `<${el.name}>${inner}</${el.name}>` }
    : { start: el.contentStart, end: el.contentEnd, value: inner };
}

export function applySectionEdits(file: TcSourceFile, edits: SectionEdit[]): SpliceResult {
  const replacements: { start: number; end: number; value: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    // Two replacements of one section would overlap and corrupt the XML.
    if (seen.has(edit.key)) throw new SpliceError(`Section ${edit.key} is edited twice`);
    seen.add(edit.key);
    const section = file.sections.get(edit.key);
    if (!section) throw new SpliceError(`Section ${edit.key} no longer exists in ${file.path}`);
    if (normalizeEol(edit.text) === section.text) continue;
    if (!section.editable) throw new SpliceError(`${section.label} of ${section.owner.qualifiedName} is read-only`);
    checkRename(section, edit.text);
    replacements.push({ ...cdataEdit(file, section, edit.text), key: edit.key });
  }
  replacements.sort((a, b) => b.start - a.start);
  let text = file.text;
  for (const r of replacements) {
    text = text.slice(0, r.start) + r.value + text.slice(r.end);
  }
  return { text, changedKeys: replacements.map(r => r.key) };
}

/**
 * The file with the Structured Text of one object view put back as it is in another version (`base`, HEAD).
 * Only the code changes: an object whose sections differ (an accessor added or removed) is refused, and so is
 * a renamed one (see checkRename).
 */
export function restoreView(file: TcSourceFile, base: TcSourceFile, objectId: string, accessor?: Accessor): string {
  const obj = file.objects.get(objectId);
  const old = base.objects.get(objectId);
  if (!obj || !old) throw new SpliceError('The object is not in both versions of the file');
  const keys = viewSections(obj, accessor).map(s => s.key);
  const oldKeys = new Set(viewSections(old, accessor).map(s => s.key));
  if (keys.length !== oldKeys.size || keys.some(k => !oldKeys.has(k))) {
    throw new SpliceError(`${obj.qualifiedName} changed more than its code: discard the whole file instead`);
  }
  return applySectionEdits(file, keys.map(key => ({ key, text: base.sections.get(key)!.text }))).text;
}

interface TextEdit {
  start: number;
  end: number;
  value: string;
}

/** The text with the edits (ranges that do not overlap) made. */
function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.value + t.slice(e.end), text);
}

/** The edit that removes an element, with the line it is alone on (see elementLines). */
function elementBlock(text: string, el: XmlElement): TextEdit {
  return { ...elementLines(text, el), value: '' };
}

/**
 * The LineIds elements (XAE's line maps, in files of projects that write them) of an object of a POU: `FB_X.M_Run`,
 * with `prefix` also those under it (`FB_X.P_Speed.Get`, `FB_X.M_Run` under `FB_X`).
 */
function lineIdsOf(root: XmlElement, qualifiedName: string, prefix: boolean): XmlElement[] {
  const upper = qualifiedName.toUpperCase();
  return root.children.filter(c => {
    if (c.name !== 'LineIds') return false;
    const name = (c.attrs.get('Name') ?? '').toUpperCase();
    return name === upper || (prefix && name.startsWith(`${upper}.`));
  });
}

/**
 * Edits that rename the LineIds of an object: `FB_X.M_Old` and `FB_X.M_Old.Get` become `FB_X.M_New` and
 * `FB_X.M_New.Get`. `depth` is the number of names before the renamed one (1 for a member, 0 for the POU).
 */
function lineIdRenames(text: string, root: XmlElement, qualifiedName: string, depth: number, newName: string): TextEdit[] {
  return lineIdsOf(root, qualifiedName, true).flatMap(li => {
    const range = attributeRange(text, li, 'Name');
    if (!range) return [];
    const parts = range.value.split('.');
    parts[depth] = newName;
    return [{ ...range, value: parts.join('.') }];
  });
}

/**
 * The file without one member of its POU (a method, property, action or transition) or one accessor of a
 * property, as when it is deleted in XAE: its element goes, with the indentation and line break around it
 * when it is alone on its lines, and so do its LineIds.
 */
export function removeMember(file: TcSourceFile, objectId: string, accessor?: 'Get' | 'Set'): string {
  const obj = file.objects.get(objectId);
  if (!obj) throw new SpliceError(`The object no longer exists in ${file.path}`);
  if (!obj.parent) throw new SpliceError(`${obj.qualifiedName} is a whole file, not a member`);
  const el = accessor ? obj.element.children.find(c => c.name === accessor) : obj.element;
  if (!el) throw new SpliceError(`${obj.qualifiedName} has no ${accessor} accessor to remove`);
  const lineIds = lineIdsOf(obj.parent.element, accessor ? `${obj.qualifiedName}.${accessor}` : obj.qualifiedName, !accessor);
  return applyEdits(file.text, [el, ...lineIds].map(e => elementBlock(file.text, e)));
}

// ------------------------------------------------------------------ an object view from another version of the file

/** The text of an element of `from`, with the line breaks `eol`. */
function copyOf(from: TcSourceFile, el: XmlElement, eol: string): string {
  const text = from.text.slice(el.start, el.end);
  return from.eol === eol ? text : toEol(text, eol);
}

/**
 * The element among `candidates` (children of an element of another version of the file) that stands for `el`:
 * the same tag with the same Id (members), else the same Name (LineIds, folders); a Get or Set by its tag.
 */
function counterpart(el: XmlElement, candidates: XmlElement[]): XmlElement | undefined {
  const key = (e: XmlElement) => (e.name === 'Get' || e.name === 'Set' ? ''
    : normalizeId(e.attrs.get('Id')) ?? `name:${e.attrs.get('Name') ?? ''}`);
  return candidates.find(c => c.name === el.name && key(c) === key(el));
}

/**
 * `into`'s text with `el`, an element of another version of the file (`from`), as a child of `parent`, an element
 * of `into`: after the nearest element before it in `from` that `parent` has too (its declaration at least), else
 * last; on a line of its own, indented as in `from`.
 */
function insertChild(into: TcSourceFile, from: TcSourceFile, el: XmlElement, parent: XmlElement): string {
  const siblings = el.parent?.children ?? [];
  let after: XmlElement | undefined;
  for (let i = siblings.indexOf(el) - 1; i >= 0 && !after; i--) after = counterpart(siblings[i], parent.children);
  after ??= parent.children[parent.children.length - 1];
  if (!after) throw new SpliceError(`${parent.attrs.get('Name') ?? parent.name} in ${into.path} has no place for ${el.name}`);
  const indent = indentBefore(from.text, el.start) ?? indentBefore(into.text, after.start) ?? '';
  return into.text.slice(0, after.end) + into.eol + indent + copyOf(from, el, into.eol) + into.text.slice(after.end);
}

/**
 * `into`'s text with the LineIds of an object view (with `prefix` also those under it: a member's accessors) as
 * `from` has them: changed, put in at their place or removed. Only when both versions name the view alike (not
 * when its POU or property has another name there), as LineIds are named after it.
 */
function withLineIds(into: TcSourceFile, from: TcSourceFile, objectId: string, accessor: Accessor | undefined, prefix: boolean): string {
  const mine = into.objects.get(objectId);
  const theirs = from.objects.get(objectId);
  if (!into.root || !from.root || !mine || !theirs) return into.text;
  const name = viewLabel(mine, accessor);
  if (name.toUpperCase() !== viewLabel(theirs, accessor).toUpperCase()) return into.text;
  const nameOf = (e: XmlElement) => (e.attrs.get('Name') ?? '').toUpperCase();
  const wanted = lineIdsOf(from.root.element, name, prefix);
  const edits: TextEdit[] = [];
  for (const li of lineIdsOf(into.root.element, name, prefix)) {
    const w = wanted.find(x => nameOf(x) === nameOf(li));
    if (!w) edits.push(elementBlock(into.text, li));
    else edits.push({ start: li.start, end: li.end, value: copyOf(from, w, into.eol) });
  }
  let file = edits.length ? parseTcText(into.path, applyEdits(into.text, edits), into.bom) : into;
  for (const w of wanted) {
    if (lineIdsOf(file.root!.element, w.attrs.get('Name') ?? '', false).length) continue;
    file = parseTcText(into.path, insertChild(file, from, w, file.root!.element), into.bom);
  }
  return file.text;
}

/**
 * The file `into` with a member of its POU or interface (a method, property, action or transition), or an
 * accessor of a property, that another version of the file (`from`) has and `into` lacks: copied from `from`
 * with its LineIds, at its place there (see insertChild); with a property `into` lacks, that property comes too,
 * with this accessor only. The rest of the file stays byte-identical.
 */
export function insertMember(into: TcSourceFile, from: TcSourceFile, objectId: string, accessor?: Accessor): string {
  const obj = from.objects.get(objectId);
  if (!obj?.parent) throw new SpliceError(obj ? `${obj.qualifiedName} is a whole file, not a member` : `The object is not in ${from.path}`);
  const prop = into.objects.get(objectId);
  if (accessor && !prop) {
    let trimmed = from;
    for (const other of obj.accessors) {
      if (other.kind !== accessor) trimmed = parseTcText(from.path, removeMember(trimmed, objectId, other.kind), from.bom);
    }
    return insertMember(into, trimmed, objectId);
  }
  if (accessor ? prop!.accessors.some(a => a.kind === accessor) : prop) {
    throw new SpliceError(`${viewLabel(obj, accessor)} is already in ${into.path}`);
  }
  const owner = accessor ? prop : into.objects.get(obj.parent.id);
  if (!owner) throw new SpliceError(`${obj.parent.qualifiedName} is not in ${into.path}`);
  // Another member of that name (deleted there, and not yet in this version): two of a name do not compile.
  const clash = accessor ? undefined : memberNameProblem(owner, obj.name);
  if (clash) throw new SpliceError(clash);
  const el = accessor ? obj.element.children.find(c => c.name === accessor) : obj.element;
  if (!el) throw new SpliceError(`${obj.qualifiedName} has no ${accessor} accessor`);
  const text = insertChild(into, from, el, owner.element);
  return withLineIds(parseTcText(into.path, text, into.bom), from, objectId, accessor, !accessor);
}

/**
 * The file `into` with the code of an object view that both versions have as `from` has it, and its name when
 * it was renamed: its Name, as renameMember and renameObject change it with the LineIds named after it. Its own
 * LineIds come along.
 */
function changeView(into: TcSourceFile, from: TcSourceFile, objectId: string, accessor?: Accessor): string {
  const obj = into.objects.get(objectId)!;
  const src = from.objects.get(objectId)!;
  const sections = viewSections(obj, accessor);
  const wanted = new Map(viewSections(src, accessor).map(s => [s.key, s.text]));
  if (sections.length !== wanted.size || sections.some(s => !wanted.has(s.key))) {
    throw new SpliceError(`${viewLabel(obj, accessor)} changed more than its code`);
  }
  let text: string;
  if (accessor || obj.name === src.name) {
    text = restoreView(into, from, objectId, accessor);
  } else {
    const name = attributeRange(into.text, obj.element, 'Name');
    const newName = attributeRange(from.text, src.element, 'Name')?.value;
    if (!name || !newName) throw new SpliceError(`${obj.qualifiedName} has no Name attribute`);
    const clash = obj.parent && memberNameProblem(obj.parent, src.name, obj);
    if (clash) throw new SpliceError(clash);
    const edits: TextEdit[] = [
      { ...name, value: newName }, ...lineIdRenames(into.text, (obj.parent ?? obj).element, obj.qualifiedName, obj.parent ? 1 : 0, newName),
      ...sections.filter(s => s.text !== wanted.get(s.key)).map(s => cdataEdit(into, s, wanted.get(s.key)!)),
    ];
    text = applyEdits(into.text, edits);
  }
  return withLineIds(parseTcText(into.path, text, into.bom), from, objectId, accessor, false);
}

/**
 * The file `into` with one object view (a POU, DUT, GVL or interface, a method, the declaration of a property, an
 * accessor, an action or a transition) as another version of the file (`from`) has it: its code and name (see
 * changeView), or the whole member put in (see insertMember) or removed (see removeMember) when only one version
 * has it. Everything else stays byte-identical; the caller writes the text with the BOM `into` had. Staging an
 * object takes it from the working tree into the index's version, unstaging from HEAD, and Discard Changes from
 * the index into the working file.
 */
export function takeView(into: TcSourceFile, from: TcSourceFile, objectId: string, accessor?: Accessor): string {
  for (const f of [into, from]) if (f.error) throw new SpliceError(`${f.path} cannot be read: ${f.error}`);
  const had = viewExists(into, objectId, accessor);
  const has = viewExists(from, objectId, accessor);
  if (!had && !has) return into.text;
  const text = !has ? removeMember(into, objectId, accessor) : !had ? insertMember(into, from, objectId, accessor)
    : changeView(into, from, objectId, accessor);
  // The view reads back as in `from`, the other sections as they were (a whole member's accessors are its own).
  const whole = !accessor && had !== has;
  const own = (s: Section) => s.owner.id === objectId && (accessor ? s.accessor === accessor : whole || !s.accessor);
  const out = parseTcText(into.path, text, into.bom);
  const kept = [...into.sections.values()].every(s => own(s) || out.sections.get(s.key)?.text === s.text);
  if (out.error || viewChange(from, out, objectId, accessor) || !kept) {
    const obj = from.objects.get(objectId) ?? into.objects.get(objectId)!;
    throw new SpliceError(`${viewLabel(obj, accessor)} could not be taken over in ${into.path}`);
  }
  return text;
}

/** A member addMember creates: a method, a property with its accessors, or an action. */
export interface MemberSpec {
  kind: 'method' | 'property' | 'action';
  name: string;
  /** Return type of a method (none when empty), type of a property. */
  type?: string;
  /** Accessors of a property: Get and Set when not given. */
  accessors?: Accessor[];
  /** Declaration used instead of the one made of the name and type (Implement Interfaces copies the interface's). */
  declaration?: string;
  /** Folder inside the POU that the member is shown in, XAE's FolderPath. */
  folderPath?: string[];
}

const MEMBER_TAGS = { method: 'Method', property: 'Property', action: 'Action' } as const;
const MEMBER_ELEMENTS = new Set(['Method', 'Property', 'Action', 'Transition']);

/**
 * The order XAE keeps the members of a POU in, whatever their kind, in the file as in its tree: case aside,
 * underscores before digits before letters, character by character (`Get_Value`, `Get2`, `getAll`, `GetValue`;
 * `M10` before `M9`), as TwinCAT 3.1.4026 writes them.
 */
const memberOrder = new Intl.Collator('en', { sensitivity: 'base' }).compare;

/**
 * Methods TwinCAT calls by itself: they return BOOL and need the inputs it passes, or the compiler refuses them
 * (C0119, C0120), so their declaration has them.
 */
const SPECIAL_METHODS: Record<string, string> = {
  FB_INIT: '\nVAR_INPUT\n\tbInitRetains : BOOL; // TRUE: the retain variables are initialized (warm or cold start)\n'
    + '\tbInCopyCode : BOOL; // TRUE: the instance is moved into the copy code afterwards (online change)\nEND_VAR',
  FB_EXIT: '\nVAR_INPUT\n\tbInCopyCode : BOOL; // TRUE: the instance is copied afterwards (online change)\nEND_VAR',
  FB_REINIT: '',
};

/** Whether a new method of the object gets the fixed declaration of FB_init, FB_reinit or FB_exit. */
export function isSpecialMethod(owner: TcObject, name: string): boolean {
  return owner.pouKind === 'FB' && SPECIAL_METHODS[name.toUpperCase()] !== undefined;
}

/** A new object id as TwinCAT writes it: a lower case GUID in braces. */
export function newGuid(): string {
  return `{${randomUUID()}}`;
}

/** Why a text cannot name an object or member (empty, not an identifier); undefined when it can. */
export function identifierProblem(name: string): string | undefined {
  if (!name) return 'Enter a name';
  if (!/^[A-Za-z_]\w*$/.test(name)) return `'${name}' is not an identifier: letters, digits and underscores, not starting with a digit`;
  return undefined;
}

/** Why a new member of the POU or interface (or `renamed`, given a new name) cannot have this name; undefined when it can. */
export function memberNameProblem(owner: TcObject, name: string, renamed?: TcObject): string | undefined {
  const problem = identifierProblem(name);
  if (problem) return problem;
  const upper = name.toUpperCase();
  const clash = owner.members.find(m => m !== renamed && m.name.toUpperCase() === upper);
  return clash ? `${owner.name} already has a ${clash.kind} named ${clash.name}` : undefined;
}

/**
 * Comments, pragmas and strings of a text as spaces, line breaks kept: unlike stripTrivia, offsets stay those of
 * the text.
 */
export function blankTrivia(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  const blank = (to: number) => {
    out += text.slice(i, to).replace(/[^\r\n]/g, ' ');
    i = to;
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
      blank(j);
    } else if (c === '(' && d === '*') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === '(' && text[j + 1] === '*') { depth++; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === ')') { depth--; j += 2; continue; }
        j++;
      }
      blank(j);
    } else if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2);
      blank(close < 0 ? n : close + 2);
    } else if (c === '{') {
      let j = i + 1;
      let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === "'") { j++; while (j < n && text[j] !== "'") j++; }
        else if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      blank(j);
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '$' ? 2 : 1;
      blank(Math.min(j + 1, n));
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const NAME_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:FUNCTION_BLOCK|PROGRAM|FUNCTION|METHOD|PROPERTY|INTERFACE)\\s+${MODIFIERS}([A-Za-z_]\\w*)`, 'i'),
  /\bTYPE\s+([A-Za-z_]\w*)/i,
];

/** Where the name of the first header of a declaration is (`METHOD Foo : BOOL`, `TYPE ST_X :`): offsets in the text. */
export function declaredNameRange(declaration: string): { start: number; end: number; name: string } | undefined {
  const blanked = blankTrivia(declaration);
  let best: { start: number; end: number; name: string } | undefined;
  for (const re of NAME_PATTERNS) {
    const m = re.exec(blanked);
    if (!m) continue;
    const start = m.index + m[0].length - m[1].length;
    if (!best || start < best.start) best = { start, end: start + m[1].length, name: m[1] };
  }
  return best;
}

/** A range of the text of a section. */
export interface SectionRange {
  section: Section;
  start: number;
  end: number;
}

/**
 * Where the sections of an object hold its name, for a rename: the name its declaration declares (a method's,
 * property's, POU's, DUT's or interface's; a GVL declares none), and inside a member or a function, where the name
 * stands for the object itself: a method's or function's return value (`M_Run := TRUE;`), a property's value in its
 * Get and Set, a call of itself. Not a name after a dot (`THIS^.M_Run`, `fbOther.M_Run`), nor comments, pragmas and
 * strings. XAE renames these with the object.
 */
export function nameRanges(file: TcSourceFile, objectId: string): SectionRange[] {
  const obj = file.objects.get(objectId);
  if (!obj) return [];
  const upper = obj.name.toUpperCase();
  const decl = obj.sections.find(s => s.role === 'decl' && !s.accessor);
  const declares = obj.kind !== 'gvl' && obj.kind !== 'action' && obj.kind !== 'transition';
  const header = declares && decl ? declaredNameRange(decl.text) : undefined;
  if (declares && decl && header?.name.toUpperCase() !== upper) {
    throw new SpliceError(`The declaration of ${obj.qualifiedName} does not declare ${obj.name}`);
  }
  if (!obj.parent && obj.pouKind !== 'FUN') return header ? [{ section: decl!, start: header.start, end: header.end }] : [];
  const out: SectionRange[] = [];
  for (const section of obj.sections) {
    const blanked = blankTrivia(section.text);
    const word = /\w+/g;
    for (let m = word.exec(blanked); m; m = word.exec(blanked)) {
      if (m[0].toUpperCase() !== upper) continue;
      let before = m.index - 1;
      while (before >= 0 && /\s/.test(blanked[before])) before--;
      if (blanked[before] === '.' || blanked[before] === '#') continue;
      out.push({ section, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** The edits that put the new name at the ranges. */
function nameEdits(file: TcSourceFile, ranges: SectionRange[], newName: string): TextEdit[] {
  return ranges.map(r => ({ start: sectionOffsetToFileOffset(file, r.section, r.start), end: sectionOffsetToFileOffset(file, r.section, r.end), value: newName }));
}

/** Whether the file reads back with the object renamed and its sections changed at the ranges only. */
function renamedAsExpected(file: TcSourceFile, out: string, objectId: string, newName: string, ranges: SectionRange[]): boolean {
  const expected = (s: Section) => applyEdits(s.text, ranges.filter(r => r.section === s).map(r => ({ start: r.start, end: r.end, value: newName })));
  const check = parseTcText(file.path, out, file.bom);
  const before = file.objects.get(objectId)!;
  const after = check.objects.get(objectId);
  return !check.error && after?.name === newName && after.kind === before.kind
    && [...file.sections].every(([k, s]) => check.sections.get(k)?.text === expected(s));
}

/**
 * The file of a POU, DUT, GVL or interface with the object renamed, as XAE renames one: the Name attribute of its
 * root element, its name in its sections (see nameRanges), and the LineIds of it and of its members (`FB_X`,
 * `FB_X.M_Run`). Its members follow, their qualified names coming from it. What refers to it from elsewhere is
 * not changed here (see planRename). The file itself and its <Compile> item are the caller's to rename.
 */
export function renameObject(file: TcSourceFile, newName: string): string {
  if (file.error) throw new SpliceError(`${file.path} cannot be read: ${file.error}`);
  const root = file.root;
  if (!root) throw new SpliceError(`${file.path} has no POU, DUT, GVL or interface`);
  const problem = identifierProblem(newName);
  if (problem) throw new SpliceError(problem);
  if (newName === root.name) return file.text;
  const nameAttr = attributeRange(file.text, root.element, 'Name');
  if (!nameAttr) throw new SpliceError(`${root.name} has no Name attribute`);
  const ranges = nameRanges(file, root.id);
  const out = applyEdits(file.text, [
    { ...nameAttr, value: newName }, ...nameEdits(file, ranges, newName), ...lineIdRenames(file.text, root.element, root.name, 0, newName),
  ]);
  if (!renamedAsExpected(file, out, root.id, newName, ranges)) throw new SpliceError(`${root.name} could not be renamed in ${file.path}`);
  return out;
}

/**
 * The file with a member of its POU or interface (method, property, action, transition) renamed, as XAE renames
 * one: its Name attribute, its name in its sections (see nameRanges), its LineIds and those of the
 * accessors of a property. Then it moves to its place in XAE's order when the other members are in that order,
 * as XAE writes the file after a rename. What refers to the member from elsewhere is not changed here (see
 * planRename).
 */
export function renameMember(file: TcSourceFile, objectId: string, newName: string): string {
  if (file.error) throw new SpliceError(`${file.path} cannot be read: ${file.error}`);
  const obj = file.objects.get(objectId);
  const owner = obj?.parent;
  if (!obj || !owner) throw new SpliceError(`The member no longer exists in ${file.path}`);
  const problem = memberNameProblem(owner, newName, obj);
  if (problem) throw new SpliceError(problem);
  if (newName === obj.name) return file.text;
  const text = file.text;
  const nameAttr = attributeRange(text, obj.element, 'Name');
  if (!nameAttr) throw new SpliceError(`${obj.qualifiedName} has no Name attribute`);
  const renamed = nameRanges(file, objectId);
  const edits: TextEdit[] = [
    { ...nameAttr, value: newName }, ...nameEdits(file, renamed, newName), ...lineIdRenames(text, owner.element, obj.qualifiedName, 1, newName),
  ];
  let out = applyEdits(text, edits);

  // XAE keeps the members in its name order: the renamed one moves when the others are in that order.
  const members = owner.element.children.filter(c => MEMBER_ELEMENTS.has(c.name));
  const others = members.filter(m => m !== obj.element);
  const names = others.map(m => m.attrs.get('Name') ?? '');
  const sorted = names.every((n, i) => i === 0 || memberOrder(names[i - 1], n) <= 0);
  const next = others.find((_, i) => memberOrder(names[i], newName) > 0);
  const atPlace = members[members.indexOf(obj.element) + 1] === next;
  if (sorted && others.length && !atPlace) {
    const renamed = parseTcText(file.path, out, file.bom);
    const el = renamed.objects.get(objectId)!.element;
    const elementText = out.slice(el.start, el.end);
    out = applyEdits(out, [elementBlock(out, el)]);
    const without = parseTcText(file.path, out, file.bom);
    const rest = without.root!.element.children.filter(c => MEMBER_ELEMENTS.has(c.name));
    const before = next && rest.find(m => m.attrs.get('Name') === next.attrs.get('Name'));
    const anchor = before ?? rest[rest.length - 1];
    const indent = indentBefore(out, anchor.start) ?? '    ';
    out = before
      ? out.slice(0, before.start) + elementText + file.eol + indent + out.slice(before.start)
      : out.slice(0, anchor.end) + file.eol + indent + elementText + out.slice(anchor.end);
  }

  // The file reads back with the member renamed, its sections changed where its name was, the rest as it was.
  if (!renamedAsExpected(file, out, objectId, newName, renamed)) throw new SpliceError(`${obj.qualifiedName} could not be renamed in ${file.path}`);
  return out;
}

/**
 * The declaration of a new member, as TwinCAT 3.1.4026 makes it: `METHOD Start : BOOL` in a POU,
 * `METHOD Start : BOOL` with an empty VAR_INPUT in an interface, `PROPERTY PUBLIC Speed : LREAL` in a POU and
 * `PROPERTY Speed : LREAL` in an interface.
 */
function memberDeclaration(owner: TcObject, spec: MemberSpec): string | undefined {
  if (spec.kind === 'action') return undefined;
  const keyword = spec.kind === 'method' ? 'METHOD' : 'PROPERTY';
  if (spec.declaration !== undefined) {
    // The Name attribute and the declaration header agree, as in every member XAE writes.
    if (declaredName(spec.declaration)?.toUpperCase() !== spec.name.toUpperCase()
      || !new RegExp(`\\b${keyword}\\b`, 'i').test(stripTrivia(spec.declaration))) {
      throw new SpliceError(`The declaration given for ${spec.name} does not declare the ${spec.kind} ${spec.name}`);
    }
    return spec.declaration;
  }
  const itf = owner.kind === 'itf';
  const type = (spec.type ?? '').trim();
  if (/[\r\n]/.test(type)) throw new SpliceError('The type must be on one line');
  if (spec.kind === 'property') {
    if (!type) throw new SpliceError(`The property ${spec.name} needs a type`);
    return `PROPERTY ${itf ? '' : 'PUBLIC '}${spec.name} : ${type}`;
  }
  if (isSpecialMethod(owner, spec.name)) return `METHOD ${spec.name} : BOOL${SPECIAL_METHODS[spec.name.toUpperCase()]}`;
  return `METHOD ${spec.name}${type ? ` : ${type}` : ''}${itf ? '\nVAR_INPUT\nEND_VAR' : ''}`;
}

/**
 * The file with a new method, property or action in its POU or interface, as XAE writes one: a new GUID, the
 * declaration and an empty Structured Text implementation (none in an interface; for a property, its Get and
 * Set have them, with an empty VAR block), with the indentation and line breaks of the file. The rest of the
 * file stays byte-identical; the caller writes it back with the BOM it had (`encodeText(text, file.bom)`).
 *
 * The member goes at its place in XAE's order (see memberOrder) when the members of the POU are in that order,
 * else after the last one; without members, after the declaration, implementation and folders. No LineIds are
 * written for it, and TwinCAT 3.1.4026 writes none either.
 */
export function addMember(file: TcSourceFile, ownerId: string, spec: MemberSpec, newId: () => string = newGuid): string {
  if (file.error) throw new SpliceError(`${file.path} cannot be read: ${file.error}`);
  const owner = file.objects.get(ownerId);
  if (!owner) throw new SpliceError(`The object no longer exists in ${file.path}`);
  if (owner !== file.root || (owner.kind !== 'pou' && owner.kind !== 'itf')) {
    throw new SpliceError('Methods, properties and actions are added to a POU or an interface');
  }
  const itf = owner.kind === 'itf';
  if (!itf && owner.pouKind !== 'FB' && owner.pouKind !== 'PRG') {
    throw new SpliceError(`${owner.name} is not a function block or a program: it cannot have methods, properties or actions`);
  }
  if (itf && spec.kind === 'action') throw new SpliceError(`${owner.name} is an interface: interfaces have no actions`);
  const problem = memberNameProblem(owner, spec.name);
  if (problem) throw new SpliceError(problem);
  const accessors = (['Get', 'Set'] as const).filter(a => !spec.accessors || spec.accessors.includes(a));
  if (spec.kind === 'property' && accessors.length === 0) throw new SpliceError(`The property ${spec.name} needs a Get or a Set`);
  const declaration = memberDeclaration(owner, spec);

  const text = file.text;
  const eol = file.eol;
  const root = owner.element;
  const members = root.children.filter(c => MEMBER_ELEMENTS.has(c.name));
  const names = members.map(m => m.attrs.get('Name') ?? '');
  let before: XmlElement | undefined;
  let after: XmlElement | undefined;
  if (members.length) {
    if (names.every((n, i) => i === 0 || memberOrder(names[i - 1], n) <= 0)) {
      before = members.find((_, i) => memberOrder(names[i], spec.name) > 0);
    }
    if (!before) after = members[members.length - 1];
  } else {
    before = root.children.find(c => c.name === 'LineIds');
    if (!before) after = root.children[root.children.length - 1];
  }
  const rootIndent = indentBefore(text, root.start) ?? '';
  const first = root.children[0];
  const anchor = before ?? after;
  const indent = (anchor && indentBefore(text, anchor.start)) ?? (first && indentBefore(text, first.start)) ?? `${rootIndent}  `;
  const step = indent.length > rootIndent.length && indent.startsWith(rootIndent) ? indent.slice(rootIndent.length) : '  ';

  const cdata = (s: string) => `<![CDATA[${escapeCdata(toEol(s, eol))}]]>`;
  const lines: [depth: number, line: string][] = [];
  const implementation = (depth: number) => {
    lines.push([depth, '<Implementation>'], [depth + 1, `<ST>${cdata('')}</ST>`], [depth, '</Implementation>']);
  };
  const tag = MEMBER_TAGS[spec.kind];
  const folder = spec.folderPath?.length ? ` FolderPath="${escapeAttr(`${spec.folderPath.join('\\')}\\`)}"` : '';
  lines.push([0, `<${tag} Name="${spec.name}" Id="${newId()}"${folder}>`]);
  if (declaration !== undefined) lines.push([1, `<Declaration>${cdata(declaration)}</Declaration>`]);
  if (spec.kind === 'property') {
    for (const acc of accessors) {
      // TwinCAT 3.1.4026 writes PUBLIC before the VAR block: left out, the accessor has the property's access anyway.
      lines.push([1, `<${acc} Name="${acc}" Id="${newId()}">`], [2, `<Declaration>${cdata('VAR\nEND_VAR')}</Declaration>`]);
      if (!itf) implementation(2);
      lines.push([1, `</${acc}>`]);
    }
  } else if (!itf) {
    implementation(1);
  }
  lines.push([0, `</${tag}>`]);
  const element = lines.map(([depth, line], i) => (i === 0 ? '' : indent + step.repeat(depth)) + line).join(eol);

  let out: string;
  if (before) out = text.slice(0, before.start) + element + eol + indent + text.slice(before.start);
  else if (after) out = text.slice(0, after.end) + eol + indent + element + text.slice(after.end);
  else if (!root.selfClosing) out = text.slice(0, root.contentStart) + eol + indent + element + eol + rootIndent + text.slice(root.contentEnd);
  else throw new SpliceError(`${owner.name} has no declaration`);

  // The file reads back with the new member and every section as it was.
  const check = parseTcText(file.path, out, file.bom);
  const added = check.root?.members.find(m => m.name === spec.name && m.kind === spec.kind);
  if (check.error || !added || [...file.sections].some(([k, s]) => check.sections.get(k)?.text !== s.text)) {
    throw new SpliceError(`${spec.name} could not be added to ${file.path}`);
  }
  return out;
}

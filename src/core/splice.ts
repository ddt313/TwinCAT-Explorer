// Writes edited Structured Text back into a TwinCAT file by replacing only the
// CDATA content of the changed sections. Everything else (BOM, EOL, attribute
// order, GUIDs, untouched sections) stays byte-identical. New members (methods,
// properties, actions) are inserted as whole elements, the rest of the file
// staying as it is.

import { randomUUID } from 'crypto';
import { Accessor, viewSections } from './objectText';
import { Section, TcObject, TcSourceFile, normalizeEol, parseTcText, stripTrivia, toEol } from './tcfile';
import { XmlElement, escapeAttr, indentBefore } from './xml';

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
    `The declaration ${what}. Renaming is not supported here: rename the object in TwinCAT XAE.`);
}

export interface SpliceResult {
  text: string;
  changedKeys: string[];
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
    const el = section.element;
    const inner = `<![CDATA[${escapeCdata(toEol(edit.text, file.eol))}]]>`;
    if (el.selfClosing) {
      replacements.push({ start: el.start, end: el.end, value: `<${el.name}>${inner}</${el.name}>`, key: edit.key });
    } else {
      replacements.push({ start: el.contentStart, end: el.contentEnd, value: inner, key: edit.key });
    }
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

/**
 * The file without one member of its POU (a method, property, action or transition) or one accessor of a
 * property, as when it is deleted in XAE: its element goes, with the indentation and line break around it
 * when it is alone on its lines.
 */
export function removeMember(file: TcSourceFile, objectId: string, accessor?: 'Get' | 'Set'): string {
  const obj = file.objects.get(objectId);
  if (!obj) throw new SpliceError(`The object no longer exists in ${file.path}`);
  let el: XmlElement | undefined;
  if (accessor) {
    // The accessor's Declaration sits directly in its Get or Set element.
    el = obj.accessors.find(a => a.kind === accessor)?.sections.find(s => s.role === 'decl')?.element.parent;
    if (el?.name !== accessor) throw new SpliceError(`${obj.qualifiedName} has no ${accessor} accessor to remove`);
  } else {
    if (!obj.parent) throw new SpliceError(`${obj.qualifiedName} is a whole file: delete it in TwinCAT XAE`);
    el = obj.element;
  }
  const text = file.text;
  let start = el.start;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  let end = el.end;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  const aloneOnLines = (start === 0 || text[start - 1] === '\n') && (end === text.length || text[end] === '\r' || text[end] === '\n');
  if (!aloneOnLines) return text.slice(0, el.start) + text.slice(el.end);
  if (text.startsWith('\r\n', end)) end += 2;
  else if (text[end] === '\n') end++;
  return text.slice(0, start) + text.slice(end);
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

/** Why a new member of the POU or interface cannot have this name; undefined when it can. */
export function memberNameProblem(owner: TcObject, name: string): string | undefined {
  const problem = identifierProblem(name);
  if (problem) return problem;
  const upper = name.toUpperCase();
  const clash = owner.members.find(m => m.name.toUpperCase() === upper);
  return clash ? `${owner.name} already has a ${clash.kind} named ${clash.name}` : undefined;
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

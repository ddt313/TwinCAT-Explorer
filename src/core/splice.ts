// Writes edited Structured Text back into a TwinCAT file by replacing only the
// CDATA content of the changed sections. Everything else (BOM, EOL, attribute
// order, GUIDs, untouched sections) stays byte-identical.

import { Accessor, viewSections } from './objectText';
import { Section, TcSourceFile, normalizeEol, stripTrivia } from './tcfile';
import { XmlElement } from './xml';

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

function toEol(text: string, eol: string): string {
  const lf = normalizeEol(text);
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
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

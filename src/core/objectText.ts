// Text form of one opened TwinCAT object (a POU, method, property or accessor):
// a header line describing its sections, then each section after a marker
// line. It is what the `twincat:` file system serves and accepts, behind both
// the split editor and the notebook. Marker lines start with a private-use
// character, so they cannot clash with Structured Text.

import { Section, TcObject } from './tcfile';

export const HEADER_PREFIX = 'twincat-object ';
export const SECTION_PREFIX = 'section ';
const SECTION_SEPARATOR = '\n' + SECTION_PREFIX;

export type Accessor = 'Get' | 'Set';

export interface SectionMeta {
  key: string;
  role: 'decl' | 'impl';
  label: string;
  editable: boolean;
  accessor?: Accessor;
  /** Hash of the disk text when the document was loaded: tells edited sections from untouched ones at save time. */
  base?: string;
}

export interface ObjectTextHeader {
  v: 1;
  /** Tab title, e.g. `FB_X.Method` or `FB_X.Prop.Get`. */
  label: string;
  kind: string;
  /** Sections when the document was loaded, in order. */
  sections: SectionMeta[];
  /**
   * Id of this load of the object (a new one each time the file system serves it): two documents of the
   * same URI (a split editor and a notebook) keep apart what each of them saved.
   */
  load?: string;
}

export interface TextSection {
  key: string;
  text: string;
  /** Offset of the first character of the text in the whole document. */
  start: number;
  end: number;
}

export interface ParsedObjectText {
  header: ObjectTextHeader;
  /** Sections in the document, in order (normally the header's sections). */
  sections: TextSection[];
}

export class ObjectTextError extends Error {}

/**
 * The sections shown together, like one XAE editor: the declaration and implementation of a
 * POU, method, action or transition; only the declaration of a property; the declaration and
 * implementation of one accessor of a property.
 */
export function viewSections(obj: TcObject, accessor?: Accessor): Section[] {
  if (accessor) return obj.sections.filter(s => s.accessor === accessor);
  return obj.sections.filter(s => !s.accessor);
}

export function viewLabel(obj: { qualifiedName: string }, accessor?: Accessor): string {
  return accessor ? `${obj.qualifiedName}.${accessor}` : obj.qualifiedName;
}

export function formatObjectText(header: ObjectTextHeader, texts: { key: string; text: string }[]): string {
  let out = HEADER_PREFIX + JSON.stringify(header);
  for (const s of texts) {
    if (s.key.includes('\n')) throw new ObjectTextError(`Invalid section key '${s.key}'`);
    if (s.text.includes(SECTION_SEPARATOR) || s.text.startsWith(SECTION_PREFIX)) {
      throw new ObjectTextError('The section contains a line starting with U+E000 and cannot be edited here');
    }
    out += SECTION_SEPARATOR + s.key + '\n' + s.text;
  }
  return out;
}

export function parseObjectText(text: string): ParsedObjectText {
  if (!text.startsWith(HEADER_PREFIX)) throw new ObjectTextError('Not a TwinCAT object document');
  const firstMarker = text.indexOf(SECTION_SEPARATOR);
  const headerEnd = firstMarker < 0 ? text.length : firstMarker;
  let header: ObjectTextHeader;
  try {
    header = JSON.parse(text.slice(HEADER_PREFIX.length, headerEnd));
  } catch {
    throw new ObjectTextError('The header line of the TwinCAT object document is damaged');
  }
  if (!header || header.v !== 1 || !Array.isArray(header.sections)) throw new ObjectTextError('Unknown TwinCAT object document version');
  const sections: TextSection[] = [];
  let pos = firstMarker;
  while (pos >= 0) {
    const keyStart = pos + SECTION_SEPARATOR.length;
    const keyEnd = text.indexOf('\n', keyStart);
    if (keyEnd < 0) throw new ObjectTextError('A section marker of the TwinCAT object document is damaged');
    const key = text.slice(keyStart, keyEnd);
    const next = text.indexOf(SECTION_SEPARATOR, keyEnd);
    const end = next < 0 ? text.length : next;
    sections.push({ key, text: text.slice(keyEnd + 1, end), start: keyEnd + 1, end });
    pos = next;
  }
  return { header, sections };
}

/** Header of an object view as served from disk, with the bases taken from the given texts. */
export function headerOf(label: string, kind: string, sections: Section[], hash: (text: string) => string, load?: string): ObjectTextHeader {
  const header: ObjectTextHeader = {
    v: 1,
    label,
    kind,
    sections: sections.map(s => ({
      key: s.key, role: s.role, label: s.label, editable: s.editable, accessor: s.accessor, base: hash(s.text),
    })),
  };
  if (load) header.load = load;
  return header;
}

/** Keys that occur more than once (a copied section or cell): such a document cannot be saved. */
export function duplicateKeys(sections: { key: string }[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.key)) dup.add(s.key);
    seen.add(s.key);
  }
  return [...dup];
}

/** Applies the text changes of one webview edit to a section text (changes refer to the text before the edit). */
export function applyChanges(text: string, changes: { offset: number; length: number; text: string }[]): string | undefined {
  const sorted = [...changes].sort((a, b) => b.offset - a.offset);
  let out = text;
  let limit = text.length;
  for (const c of sorted) {
    if (c.offset < 0 || c.length < 0 || c.offset + c.length > limit) return undefined;
    out = out.slice(0, c.offset) + c.text + out.slice(c.offset + c.length);
    limit = c.offset;
  }
  return out;
}

/** Line and character of an offset in a text with LF line breaks. */
export function positionIn(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: end - lineStart };
}

export function offsetIn(text: string, line: number, character: number): number {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf('\n', offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  return Math.min(offset + character, lineEnd < 0 ? text.length : lineEnd);
}

/**
 * Maps an offset in one version of a text to another version (the same section as the language index
 * sees it and as an editor shows it). Offsets before or after the changed middle part keep their place.
 */
export function mapOffset(from: string, to: string, offset: number): number {
  if (from === to) return offset;
  const max = Math.min(from.length, to.length);
  let prefix = 0;
  while (prefix < max && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix++;
  if (offset <= prefix) return offset;
  let suffix = 0;
  while (suffix < max - prefix && from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)) suffix++;
  if (offset >= from.length - suffix) return Math.max(prefix, offset + to.length - from.length);
  return prefix;
}

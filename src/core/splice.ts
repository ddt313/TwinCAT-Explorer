// Writes edited Structured Text back into a TwinCAT file by replacing only the
// CDATA content of the changed sections. Everything else (BOM, EOL, attribute
// order, GUIDs, untouched sections) stays byte-identical.

import { Section, TcSourceFile, normalizeEol, stripTrivia } from './tcfile';

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

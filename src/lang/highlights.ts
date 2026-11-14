// What to highlight in a section around the cursor: the keywords of the block the cursor is on (IF, ELSIF, ELSE,
// END_IF), or the occurrences of the symbol it is on in the same section, written or read. Serves the split
// editor and the notebook cells (VS Code's document highlights); written or read as the analysis says (Occurrence.access).
// Independent of the VS Code API.

import { Analysis, Occurrence } from './analyzer';
import { keywordBlocks } from './blocks';
import { Tk, Token, lex } from './lexer';
import { RESERVED } from './parser';

export type HighlightKind = 'text' | 'read' | 'write';

export interface Highlight {
  start: number;
  end: number;
  kind: HighlightKind;
}

/** The token the cursor is on or right after; an identifier before any other token. */
function tokenAt(tokens: Token[], offset: number): Token | undefined {
  let found: Token | undefined;
  for (const t of tokens) {
    if (t.start > offset) break;
    if (offset > t.end || t.kind === Tk.EOF) continue;
    if (!found || t.kind === Tk.Ident) found = t;
  }
  return found;
}

/**
 * Whether a use writes the variable as a whole: the target of an assignment (`x := `, `x[i] := `, `x REF= `, `x S= `),
 * of a call's output (`Q => x`), passed to a VAR_IN_OUT, or a declaration. Of `a.b := 1` only `b` is written.
 */
function written(o: Occurrence): boolean {
  if (o.decl) return true;
  if (o.access !== 'write' && o.access !== 'readwrite') return false;
  // Through indexes only (`aPos[i]`, `a[b[1]]`), not through a member or bit.
  let path = o.path ?? '';
  for (let inner = path.replace(/\[[^[\]]*\]/g, ''); inner !== path; inner = path.replace(/\[[^[\]]*\]/g, '')) path = inner;
  return path === '';
}

/** A section the highlights are in: its text, and its analysis (none outside the language index). */
export interface HighlightSection {
  analysis: Analysis | undefined;
  text: string;
}

/** The uses of a symbol (by its id) or of an identifier (by its upper-case name) in a section. */
function usesIn(section: HighlightSection, target: { symId: string } | { upper: string }): Highlight[] {
  if ('upper' in target) {
    const tokens = lex(section.text).tokens;
    return tokens.filter(t => t.kind === Tk.Ident && t.upper === target.upper).map(t => ({ start: t.start, end: t.end, kind: 'text' }));
  }
  return (section.analysis?.occurrences ?? []).filter(o => o.sym.id === target.symId)
    .map(o => ({ start: o.start, end: o.end, kind: written(o) ? 'write' : 'read' }));
}

/**
 * What to highlight at an offset of a section: the keywords of the block of the keyword there, else the occurrences
 * in this section of the symbol there (with the analysis of the section), else the same identifier. The uses of
 * that symbol or identifier in `others` too (the other sections shown with it, the declaration of an
 * implementation), one list each; a block's keywords stay in their section.
 */
export function highlightsAcross(section: HighlightSection, offset: number, others: HighlightSection[]): { own: Highlight[]; others: Highlight[][] } {
  const none = { own: [], others: others.map(() => []) };
  const tokens = lex(section.text).tokens;
  const t = tokenAt(tokens, offset);
  if (!t || t.kind !== Tk.Ident) return none;
  const block = keywordBlocks(tokens).find(b => b.keywords.includes(t));
  if (block) return { ...none, own: block.keywords.map(k => ({ start: k.start, end: k.end, kind: 'text' })) };
  const occ = section.analysis?.occurrences.find(o => o.start <= offset && offset <= o.end);
  // An identifier the analysis does not know: the same one elsewhere, in any case (ST ignores case).
  const target = occ ? { symId: occ.sym.id } : RESERVED.has(t.upper) ? undefined : { upper: t.upper };
  if (!target) return none;
  return { own: usesIn(section, target), others: others.map(o => usesIn(o, target)) };
}

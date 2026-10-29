// What to highlight in a section around the cursor: the keywords of the block the cursor is on (IF, ELSIF, ELSE,
// END_IF), or the occurrences of the symbol it is on in the same section, written or read. Serves the split
// editor and the notebook cells (VS Code's document highlights). Independent of the VS Code API.

import { Analysis } from './analyzer';
import { keywordBlocks } from './blocks';
import { Tk, Token, lex } from './lexer';
import { RESERVED } from './parser';

export type HighlightKind = 'text' | 'read' | 'write';

export interface Highlight {
  start: number;
  end: number;
  kind: HighlightKind;
}

const isOp = (t: Token | undefined, text: string) => t?.kind === Tk.Op && t.text === text;

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

/** Index of the bracket that matches the one at `i` (`[` forwards, `]` backwards), or -1. */
function matching(tokens: Token[], i: number, step: 1 | -1): number {
  const [open, close] = step === 1 ? ['[', ']'] : [']', '['];
  let depth = 0;
  for (let j = i; j >= 0 && j < tokens.length; j += step) {
    if (isOp(tokens[j], open)) depth++;
    else if (isOp(tokens[j], close) && --depth === 0) return j;
  }
  return -1;
}

/**
 * Whether the name at token `i` is written: the target of an assignment (`x := `, `a.b[i] := `, `x REF= `, `x S= `),
 * of a call's output (`Q => x`), or a declaration. Of `a.b := 1` only `b` is written.
 */
function written(tokens: Token[], i: number): boolean {
  // The end of the name with its indexes and dereferences (`x[i]^`).
  let k = i;
  for (;;) {
    if (isOp(tokens[k + 1], '[')) {
      const j = matching(tokens, k + 1, 1);
      if (j < 0) return false;
      k = j;
    } else if (isOp(tokens[k + 1], '^')) {
      k++;
    } else {
      break;
    }
  }
  const next = tokens[k + 1];
  if (isOp(next, ':=')) return true;
  if (next?.kind === Tk.Ident && ['S', 'R', 'REF'].includes(next.upper) && isOp(tokens[k + 2], '=') && tokens[k + 2].start === next.end) {
    return true;
  }
  // The start of the access path it ends (`fb.aData[2].x`).
  let s = i;
  while (isOp(tokens[s - 1], '.')) {
    let j = s - 2;
    if (isOp(tokens[j], '^')) j--;
    if (isOp(tokens[j], ']')) j = matching(tokens, j, -1) - 1;
    if (j < 0 || tokens[j].kind !== Tk.Ident) break;
    s = j;
  }
  return isOp(tokens[s - 1], '=>') && (isOp(next, ')') || isOp(next, ','));
}

/** A section the highlights are in: its text, and its analysis (none outside the language index). */
export interface HighlightSection {
  analysis: Analysis | undefined;
  text: string;
}

/** The uses of a symbol (by its id) or of an identifier (by its upper-case name) in a section. */
function usesIn(section: HighlightSection, target: { symId: string } | { upper: string }): Highlight[] {
  const tokens = lex(section.text).tokens;
  if ('upper' in target) {
    return tokens.filter(t => t.kind === Tk.Ident && t.upper === target.upper).map(t => ({ start: t.start, end: t.end, kind: 'text' }));
  }
  const index = new Map(tokens.map((t, i) => [t.start, i]));
  return (section.analysis?.occurrences ?? []).filter(o => o.sym.id === target.symId).map(o => {
    const i = index.get(o.start);
    return { start: o.start, end: o.end, kind: o.decl || (i !== undefined && written(tokens, i)) ? 'write' : 'read' };
  });
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

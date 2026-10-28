// What to highlight in a section around the cursor: the keywords of the block the cursor is on (IF, ELSIF, ELSE,
// END_IF), or the occurrences of the symbol it is on in the same section, written or read. Serves the split
// editor and the notebook cells (VS Code's document highlights). Independent of the VS Code API.

import { Analysis } from './analyzer';
import { Tk, Token, lex } from './lexer';
import { RESERVED } from './parser';

export type HighlightKind = 'text' | 'read' | 'write';

export interface Highlight {
  start: number;
  end: number;
  kind: HighlightKind;
}

const VAR_SECTIONS = ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_INST',
  'VAR_EXTERNAL', 'VAR_CONFIG', 'VAR_ACCESS'];

/** Blocks by their opening keyword: the keyword that closes them. */
const CLOSERS: Record<string, string> = {
  IF: 'END_IF', CASE: 'END_CASE', FOR: 'END_FOR', WHILE: 'END_WHILE', REPEAT: 'END_REPEAT',
  STRUCT: 'END_STRUCT', UNION: 'END_UNION', TYPE: 'END_TYPE',
  ...Object.fromEntries(VAR_SECTIONS.map(v => [v, 'END_VAR'])),
};
const CLOSING = new Set(Object.values(CLOSERS));
const LOOPS = new Set(['FOR', 'WHILE', 'REPEAT']);

const isOp = (t: Token | undefined, text: string) => t?.kind === Tk.Op && t.text === text;

interface Block {
  opener: string;
  /** Keyword tokens of the block, the opener first. */
  keywords: Token[];
}

/** A keyword in the middle of the innermost block: whether it belongs to it (THEN of an IF, OF of a CASE, ...). */
function belongsTo(block: Block, kw: string): boolean {
  // EXIT and CONTINUE in a loop's body do not count (REPEAT ... EXIT ... UNTIL).
  const last = block.keywords.map(k => k.upper).filter(k => k !== 'EXIT' && k !== 'CONTINUE').pop();
  switch (kw) {
    case 'THEN': return block.opener === 'IF' && (last === 'IF' || last === 'ELSIF');
    case 'ELSIF': return block.opener === 'IF' && last === 'THEN';
    case 'ELSE': return (block.opener === 'IF' && last === 'THEN') || (block.opener === 'CASE' && last === 'OF');
    case 'OF': return block.opener === 'CASE' && last === 'CASE';
    case 'TO': return block.opener === 'FOR' && last === 'FOR';
    case 'BY': return block.opener === 'FOR' && last === 'TO';
    case 'DO': return (block.opener === 'FOR' && (last === 'TO' || last === 'BY')) || (block.opener === 'WHILE' && last === 'WHILE');
    case 'UNTIL': return block.opener === 'REPEAT' && last === 'REPEAT';
    default: return false;
  }
}

/** The blocks of a section's keywords (IF ... END_IF), the unclosed ones included. */
function blocks(tokens: Token[]): Block[] {
  const all: Block[] = [];
  const stack: Block[] = [];
  tokens.forEach((t, i) => {
    if (t.kind !== Tk.Ident) return;
    const kw = t.upper;
    // A member spelled like a keyword (stAxis.Type) is no keyword.
    if (isOp(tokens[i - 1], '.')) return;
    if (kw in CLOSERS) {
      const b: Block = { opener: kw, keywords: [t] };
      stack.push(b);
      all.push(b);
    } else if (CLOSING.has(kw)) {
      // The innermost block it closes; the blocks inside that are left unclosed.
      for (let j = stack.length - 1; j >= 0; j--) {
        if (CLOSERS[stack[j].opener] !== kw) continue;
        stack[j].keywords.push(t);
        stack.length = j;
        break;
      }
    } else if (kw === 'EXIT' || kw === 'CONTINUE') {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (!LOOPS.has(stack[j].opener)) continue;
        stack[j].keywords.push(t);
        break;
      }
    } else {
      const top = stack[stack.length - 1];
      if (top && belongsTo(top, kw)) top.keywords.push(t);
    }
  });
  return all;
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

/**
 * What to highlight at an offset of a section: the keywords of the block of the keyword there, else the occurrences
 * in this section of the symbol there (with the analysis of the section), else the same identifier.
 */
export function highlightsAt(analysis: Analysis | undefined, text: string, offset: number): Highlight[] {
  const tokens = lex(text).tokens;
  const t = tokenAt(tokens, offset);
  if (!t || t.kind !== Tk.Ident) return [];
  const block = blocks(tokens).find(b => b.keywords.includes(t));
  if (block) return block.keywords.map(k => ({ start: k.start, end: k.end, kind: 'text' }));
  const occ = analysis?.occurrences.find(o => o.start <= offset && offset <= o.end);
  if (occ) {
    const index = new Map(tokens.map((tk, i) => [tk.start, i]));
    return analysis!.occurrences.filter(o => o.sym.id === occ.sym.id).map(o => {
      const i = index.get(o.start);
      return { start: o.start, end: o.end, kind: o.decl || (i !== undefined && written(tokens, i)) ? 'write' : 'read' };
    });
  }
  if (RESERVED.has(t.upper)) return [];
  // An identifier the analysis does not know: the same one elsewhere, in any case (ST ignores case).
  return tokens.filter(o => o.kind === Tk.Ident && o.upper === t.upper).map(o => ({ start: o.start, end: o.end, kind: 'text' }));
}

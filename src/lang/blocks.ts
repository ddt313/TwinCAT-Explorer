// The blocks of Structured Text by their keywords (IF ... ELSIF ... ELSE ... END_IF, VAR ... END_VAR), from the
// tokens alone, so code being typed still has them. For highlights and folding. Independent of the VS Code API,
// and of Node (the split editor's webview folds with it).

import { Tk, Token } from './lexer';

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

export interface Block {
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

/** The blocks of a section's keywords (IF ... END_IF), the unclosed ones included, in the order they open. */
export function keywordBlocks(tokens: Token[]): Block[] {
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

/** The block ends with its closing keyword (END_IF), not where the text ends or an outer block closes. */
export function isClosed(block: Block): boolean {
  return block.keywords[block.keywords.length - 1].upper === CLOSERS[block.opener];
}

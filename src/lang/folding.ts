// Folding of Structured Text by its blocks, not by indentation: IF ... END_IF with each branch (ELSIF, ELSE) of
// its own, CASE, FOR, WHILE, REPEAT, VAR ... END_VAR, STRUCT, UNION, TYPE; comments over several lines; and
// {region} ... {endregion}. Serves the split editor's webview and the notebook cells. Independent of the VS Code
// API, and of Node.

import { isClosed, keywordBlocks } from './blocks';
import { lex } from './lexer';

/** Lines are 0-based; `endLine` is the last line folded away. */
export interface Fold {
  startLine: number;
  endLine: number;
  kind?: 'comment' | 'region';
}

/** Keywords that start a part of their block of their own: the branches of an IF or a CASE, a REPEAT's condition. */
const SPLITS = new Set(['ELSIF', 'ELSE', 'UNTIL']);

export function foldingRanges(text: string): Fold[] {
  const { tokens, trivia } = lex(text);
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const folds: Fold[] = [];
  const add = (startLine: number, endLine: number, kind?: Fold['kind']) => {
    if (endLine > startLine) folds.push(kind ? { startLine, endLine, kind } : { startLine, endLine });
  };
  for (const b of keywordBlocks(tokens)) {
    // A block being typed has no end to fold to.
    if (!isClosed(b)) continue;
    const last = b.keywords.length - 1;
    const parts = b.keywords.filter((k, i) => i === 0 || i === last || SPLITS.has(k.upper));
    // Each part up to the line before the next one: the closing keyword stays in sight.
    for (let i = 0; i + 1 < parts.length; i++) add(lineOf(parts[i].start), lineOf(parts[i + 1].start) - 1);
  }
  const regions: number[] = [];
  for (const t of trivia) {
    if (t.kind === 'comment') add(lineOf(t.start), lineOf(t.end - 1), 'comment');
    else if (/^\{\s*region\b/i.test(t.text)) regions.push(lineOf(t.start));
    else if (/^\{\s*endregion\b/i.test(t.text) && regions.length) add(regions.pop()!, lineOf(t.start), 'region');
  }
  return folds.sort((a, b) => a.startLine - b.startLine);
}

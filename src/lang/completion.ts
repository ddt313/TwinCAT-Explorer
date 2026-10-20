// Helpers for completion that do not depend on the VS Code API.

import { Tk, Token, lex } from './lexer';

/** Text of the expression before the dot that precedes `offset` (for `a.b[i]^.c.|`). */
export function expressionBeforeDot(text: string, offset: number): string | undefined {
  const dot = dotBefore(text, offset);
  if (dot === undefined) return undefined;
  const expr = text.slice(expressionStart(text, dot), dot).trim();
  return expr.length > 0 ? expr : undefined;
}

/** Offset of the dot before the word that ends at `offset`, if there is one. */
function dotBefore(text: string, offset: number): number | undefined {
  let p = offset;
  while (p > 0 && /\w/.test(text[p - 1])) p--;
  while (p > 0 && /[ \t]/.test(text[p - 1])) p--;
  return text[p - 1] === '.' ? p - 1 : undefined;
}

/** Start of the expression (`a.b[i]^.c`, `GetThing(a).Value`) that ends at `end`. */
export function expressionStart(text: string, end: number): number {
  let p = end;
  for (;;) {
    while (p > 0 && /\s/.test(text[p - 1])) p--;
    const c = text[p - 1];
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      while (p > 0) {
        const ch = text[p - 1];
        if (ch === c) depth++;
        else if (ch === open) {
          depth--;
          if (depth === 0) {
            p--;
            break;
          }
        }
        p--;
      }
      continue;
    }
    if (c === '^') {
      p--;
      continue;
    }
    if (c !== undefined && /\w/.test(c)) {
      while (p > 0 && /\w/.test(text[p - 1])) p--;
      let q = p;
      while (q > 0 && /\s/.test(text[q - 1])) q--;
      if (text[q - 1] === '.' && !(q >= 2 && text[q - 2] === '.')) {
        p = q - 1;
        continue;
      }
      break;
    }
    break;
  }
  return p;
}

export interface TextBefore {
  /** Tokens of the text before the offset. */
  tokens: Token[];
  /** The offset is inside a comment, a pragma or a string. */
  inComment: boolean;
}

/** The tokens before an offset, and whether the offset is in a comment, a pragma or a string. */
export function textBefore(text: string, offset: number): TextBefore {
  const { tokens, trivia, errors } = lex(text.slice(0, offset));
  tokens.pop();
  const open = (start: number) => errors.some(e => e.start === start && e.message.startsWith('Unterminated'));
  const comment = trivia[trivia.length - 1];
  const last = tokens[tokens.length - 1];
  const inComment = !!comment && comment.end === offset && (comment.text.startsWith('//') || open(comment.start));
  const inString = !!last && last.end === offset && (last.kind === Tk.String || last.kind === Tk.WString) && open(last.start);
  return { tokens, inComment: inComment || inString };
}

/** Keywords a statement can follow without a `;` before it. */
const STATEMENT_AFTER = new Set(['THEN', 'ELSE', 'DO', 'REPEAT', 'END_IF', 'END_CASE', 'END_FOR', 'END_WHILE', 'END_REPEAT']);

export interface CompletionContext {
  /** The word being completed: from its start to the end of its last character (it may go on after the cursor). */
  wordStart: number;
  wordEnd: number;
  /** In a comment, a pragma or a string. */
  inComment: boolean;
  /**
   * The word (or the expression it is a member of) starts a statement: at the start, or after a `;`, a label or
   * THEN, ELSE, DO, ..., and no assignment, member or index follows it.
   */
  statement: boolean;
  /** Nothing but blanks or a comment follows the word on its line. */
  lineEnd: boolean;
  /** A `;` follows the word on its line. */
  semicolonFollows: boolean;
  /** The word follows `=>`: it is the variable an output goes to. */
  outputTarget: boolean;
  /** An opening parenthesis follows the word on its line: its arguments are written already. */
  callFollows: boolean;
  /** Only blanks are before the word on its line (and a `{` typed for a pragma). */
  lineStart: boolean;
  /** A `{` typed right before the word, and the `}` closing it right after, if there is one. */
  brace?: { start: number; end: number };
}

export function completionContext(text: string, offset: number): CompletionContext {
  let wordStart = offset;
  while (wordStart > 0 && /\w/.test(text[wordStart - 1])) wordStart--;
  let wordEnd = offset;
  while (wordEnd < text.length && /\w/.test(text[wordEnd])) wordEnd++;
  const before = textBefore(text, offset);
  // The token before the word, or before the expression the word is a member of.
  const dot = dotBefore(text, offset);
  const start = dot === undefined ? wordStart : expressionStart(text, dot);
  let k = before.tokens.length - 1;
  while (k >= 0 && before.tokens[k].end > start) k--;
  const prev = before.tokens[k];
  const startsStatement = !prev
    || (prev.kind === Tk.Op && (prev.text === ';' || prev.text === ':'))
    || (prev.kind === Tk.Ident && STATEMENT_AFTER.has(prev.upper));
  const lineEnd = text.indexOf('\n', wordEnd);
  const rest = text.slice(wordEnd, lineEnd < 0 ? text.length : lineEnd);
  const brace = text[wordStart - 1] === '{' ? { start: wordStart - 1, end: wordEnd + (text[wordEnd] === '}' ? 1 : 0) } : undefined;
  const lineStart = text.lastIndexOf('\n', (brace?.start ?? wordStart) - 1) + 1;
  return {
    wordStart,
    wordEnd,
    inComment: before.inComment,
    statement: startsStatement && !/^[ \t]*[:.\[^]/.test(rest),
    lineEnd: /^\s*(\/\/.*|\(\*.*)?$/.test(rest),
    semicolonFollows: /^[ \t]*;/.test(rest),
    outputTarget: prev?.kind === Tk.Op && prev.text === '=>',
    // `(*` starts a comment.
    callFollows: /^[ \t]*\((?!\*)/.test(rest),
    lineStart: /^[ \t]*$/.test(text.slice(lineStart, brace?.start ?? wordStart)),
    brace,
  };
}

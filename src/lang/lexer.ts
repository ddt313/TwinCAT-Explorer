// Lexer for TwinCAT Structured Text. Comments and pragmas are kept aside as
// trivia (for hover documentation), everything else becomes a token.

export const enum Tk {
  Ident,
  Number,
  /** `T#1s`, `DINT#5`, `E_State#Idle`, `16#FF` with a type prefix. */
  TypedLiteral,
  String,
  WString,
  DirectAddress,
  Op,
  EOF,
}

export interface Token {
  kind: Tk;
  /** Source text of the token. */
  text: string;
  /** Upper-case text for identifiers (ST is case-insensitive). */
  upper: string;
  start: number;
  end: number;
  /** For typed literals: the prefix before `#` and the value after it. */
  prefix?: string;
  prefixEnd?: number;
  value?: string;
}

export interface Trivia {
  kind: 'comment' | 'pragma';
  start: number;
  end: number;
  text: string;
}

export interface LexResult {
  tokens: Token[];
  trivia: Trivia[];
  errors: { start: number; end: number; message: string }[];
}

const TIME_PREFIXES = new Set([
  'T', 'TIME', 'LT', 'LTIME', 'D', 'DATE', 'LD', 'LDATE', 'DT', 'DATE_AND_TIME', 'LDT', 'LDATE_AND_TIME',
  'TOD', 'TIME_OF_DAY', 'LTOD', 'LTIME_OF_DAY',
]);

const OPERATORS = [':=', '=>', '<=', '>=', '<>', '..', '**', '+', '-', '*', '/', '=', '<', '>', '(', ')', '[', ']',
  ',', ';', ':', '.', '^', '&', '#'];

function isIdentStart(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const trivia: Trivia[] = [];
  const errors: LexResult['errors'] = [];
  const n = text.length;
  let i = 0;

  const push = (kind: Tk, start: number, end: number, extra?: Partial<Token>) => {
    const t = text.slice(start, end);
    tokens.push({ kind, text: t, upper: kind === Tk.Ident ? t.toUpperCase() : t, start, end, ...extra });
  };

  const readNumberBody = (j: number): number => {
    // digits with underscores, optional fraction and exponent, or based number (16#FF).
    while (j < n && (isDigit(text[j]) || text[j] === '_')) j++;
    if (text[j] === '#') {
      j++;
      while (j < n && (isIdentPart(text[j]))) j++;
      return j;
    }
    if (text[j] === '.' && isDigit(text[j + 1] ?? '')) {
      j++;
      while (j < n && (isDigit(text[j]) || text[j] === '_')) j++;
    }
    if ((text[j] === 'e' || text[j] === 'E') &&
      (isDigit(text[j + 1] ?? '') || ((text[j + 1] === '+' || text[j + 1] === '-') && isDigit(text[j + 2] ?? '')))) {
      j += 2;
      while (j < n && isDigit(text[j])) j++;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && d === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      trivia.push({ kind: 'comment', start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (c === '(' && d === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '(' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === ')') { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) errors.push({ start, end: n, message: 'Unterminated comment' });
      trivia.push({ kind: 'comment', start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (c === '/' && d === '*') {
      const start = i;
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      if (close < 0) errors.push({ start, end: n, message: 'Unterminated comment' });
      trivia.push({ kind: 'comment', start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (c === '{') {
      const start = i;
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = text[i];
        if (ch === "'" || ch === '"') {
          i++;
          while (i < n && text[i] !== ch) i++;
        } else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      if (depth > 0) errors.push({ start, end: n, message: 'Unterminated pragma' });
      trivia.push({ kind: 'pragma', start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '$' ? 2 : 1;
      if (text[i] !== c) errors.push({ start, end: i, message: 'Unterminated string' });
      else i++;
      push(c === "'" ? Tk.String : Tk.WString, start, i);
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      i = readNumberBody(i);
      push(Tk.Number, start, i);
      continue;
    }
    if (c === '%' && /[IQM]/i.test(d ?? '')) {
      const start = i;
      i += 2;
      while (i < n && /[A-Za-z0-9.*]/.test(text[i])) i++;
      push(Tk.DirectAddress, start, i);
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(text[i])) i++;
      const word = text.slice(start, i);
      if (text[i] === '#' && i + 1 < n) {
        const upper = word.toUpperCase();
        const prefixEnd = i;
        let j = i + 1;
        if (TIME_PREFIXES.has(upper)) {
          while (j < n && /[0-9A-Za-z_:.+\-]/.test(text[j])) j++;
        } else if (isDigit(text[j]) || ((text[j] === '-' || text[j] === '+') && isDigit(text[j + 1] ?? ''))) {
          if (text[j] === '-' || text[j] === '+') j++;
          j = readNumberBody(j);
        } else if (isIdentStart(text[j])) {
          while (j < n && isIdentPart(text[j])) j++;
        } else if (text[j] === "'" || text[j] === '"') {
          const q = text[j];
          j++;
          while (j < n && text[j] !== q && text[j] !== '\n') j += text[j] === '$' ? 2 : 1;
          j++;
        } else {
          push(Tk.Ident, start, i);
          continue;
        }
        push(Tk.TypedLiteral, start, j, { prefix: word, prefixEnd, value: text.slice(prefixEnd + 1, j) });
        i = j;
        continue;
      }
      push(Tk.Ident, start, i);
      continue;
    }
    const op = OPERATORS.find(o => text.startsWith(o, i));
    if (op) {
      // `1..5` must lex as number, '..', number (handled by readNumberBody not consuming '..').
      push(Tk.Op, i, i + op.length);
      i += op.length;
      continue;
    }
    errors.push({ start: i, end: i + 1, message: `Unexpected character '${c}'` });
    i++;
  }
  tokens.push({ kind: Tk.EOF, text: '', upper: '', start: n, end: n });
  return { tokens, trivia, errors };
}

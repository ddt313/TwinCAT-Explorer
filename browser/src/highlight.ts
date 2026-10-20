// Structured Text highlighting for the viewer, from the lexer of the language features (src/lang): keywords,
// types, literals, comments and pragmas, as spans per line.

import { Tk, lex } from '../../src/lang/lexer';

export interface Span {
  start: number;
  end: number;
  cls: 'kw' | 'ty' | 'num' | 'str' | 'com' | 'pra';
}

const KEYWORDS = new Set(`IF THEN ELSIF ELSE END_IF CASE OF END_CASE FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT
EXIT CONTINUE RETURN JMP VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_GLOBAL VAR_TEMP VAR_STAT VAR_INST VAR_EXTERNAL VAR_CONFIG END_VAR
CONSTANT RETAIN PERSISTENT FUNCTION_BLOCK FUNCTION PROGRAM METHOD PROPERTY ACTION INTERFACE TRANSITION END_FUNCTION_BLOCK
END_FUNCTION END_PROGRAM END_METHOD END_PROPERTY END_ACTION END_INTERFACE END_TRANSITION EXTENDS IMPLEMENTS ABSTRACT FINAL
PUBLIC PRIVATE PROTECTED INTERNAL TYPE END_TYPE STRUCT END_STRUCT UNION END_UNION AND OR XOR NOT MOD AND_THEN OR_ELSE
TRUE FALSE THIS SUPER AT REFERENCE POINTER ARRAY REF_TO NULL`.split(/\s+/));

const TYPES = new Set(`BOOL BYTE WORD DWORD LWORD SINT USINT INT UINT DINT UDINT LINT ULINT REAL LREAL STRING WSTRING TIME LTIME
DATE LDATE TIME_OF_DAY TOD LTOD DATE_AND_TIME DT LDT ANY ANY_NUM ANY_INT ANY_REAL ANY_BIT PVOID XINT UXINT XWORD BIT HRESULT`.split(/\s+/));

/** The highlighted spans of each line of a text (lines split at LF), sorted and not overlapping. */
export function highlightLines(text: string): Span[][] {
  const spans: Span[] = [];
  try {
    const { tokens, trivia } = lex(text);
    for (const t of tokens) {
      const cls = t.kind === Tk.Ident ? (KEYWORDS.has(t.upper) ? 'kw' : TYPES.has(t.upper) ? 'ty' : undefined)
        : t.kind === Tk.Number || t.kind === Tk.TypedLiteral || t.kind === Tk.DirectAddress ? 'num'
          : t.kind === Tk.String || t.kind === Tk.WString ? 'str' : undefined;
      if (cls) spans.push({ start: t.start, end: t.end, cls });
    }
    for (const t of trivia) spans.push({ start: t.start, end: t.end, cls: t.kind === 'comment' ? 'com' : 'pra' });
  } catch {
    // Highlighting is a nicety: unhighlighted text then.
  }
  spans.sort((a, b) => a.start - b.start);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const out: Span[][] = lineStarts.map(() => []);
  let line = 0;
  for (const s of spans) {
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= s.start) line++;
    // A span over several lines (a block comment) is cut at each line break.
    for (let l = line; l < lineStarts.length && lineStarts[l] < s.end; l++) {
      const lineEnd = l + 1 < lineStarts.length ? lineStarts[l + 1] - 1 : text.length;
      const start = Math.max(s.start, lineStarts[l]) - lineStarts[l];
      const end = Math.min(s.end, lineEnd) - lineStarts[l];
      if (end > start) out[l].push({ start, end, cls: s.cls });
    }
  }
  return out;
}

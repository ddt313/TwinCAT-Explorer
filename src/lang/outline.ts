// The outline of a section, for Go to Symbol (Ctrl+Shift+O) in the split editor and the outline of notebook
// cells: what it declares (the POU, method or type, its VAR blocks and their variables, members, enumeration
// values), its {region}s, and the branches of its CASEs (the steps of a state machine, with their comments).
// Independent of the VS Code API.

import type { Analysis } from './analyzer';
import { isClosed, keywordBlocks } from './blocks';
import { Tk, Token, lex } from './lexer';
import type { Sym } from './symbols';

/** Names of VS Code's and Monaco's SymbolKind, which share them. */
export type OutlineKind = 'Class' | 'Interface' | 'Function' | 'Module' | 'Method' | 'Property' | 'Event' | 'Enum' | 'Struct'
  | 'EnumMember' | 'Namespace' | 'Package' | 'Constant' | 'Variable' | 'Object';

export interface OutlineSymbol {
  name: string;
  detail: string;
  kind: OutlineKind;
  /** All of it (a VAR block from VAR to END_VAR, a CASE branch up to the next one). */
  start: number;
  end: number;
  /** Its name (the keyword of a block, the label of a branch). */
  nameStart: number;
  nameEnd: number;
  children: OutlineSymbol[];
}

export function symbolKindOf(s: Sym): OutlineKind {
  switch (s.kind) {
    case 'pou':
      if (s.pouKind === 'ITF') return 'Interface';
      if (s.pouKind === 'FUN') return 'Function';
      if (s.pouKind === 'PRG') return 'Module';
      return 'Class';
    case 'method': return 'Method';
    case 'property': return 'Property';
    case 'action':
    case 'transition':
      return 'Event';
    case 'type': return s.dutKind === 'enum' ? 'Enum' : 'Struct';
    case 'enumValue': return 'EnumMember';
    case 'gvl': return 'Namespace';
    case 'var': return s.constant ? 'Constant' : 'Variable';
    default: return 'Object';
  }
}

/** What a section's declaration header declares: everything after it in the section belongs to it. */
const HEADERS = new Set(['pou', 'method', 'property', 'action', 'transition', 'type', 'gvl']);

const isOp = (t: Token | undefined, text: string) => t?.kind === Tk.Op && t.text === text;

/** The comment on the line of an offset, after it (`10: // Wait for the axis`), without its markers. */
function commentAfter(text: string, trivia: { kind: string; start: number; end: number; text: string }[], offset: number): string {
  const eol = text.indexOf('\n', offset);
  const c = trivia.find(t => t.kind === 'comment' && t.start >= offset && (eol < 0 || t.start < eol));
  if (!c) return '';
  return c.text.replace(/^\/\/|^\(\*|\*\)$/g, '').split('\n')[0].trim();
}

export function outline(analysis: Analysis | undefined, text: string): OutlineSymbol[] {
  const { tokens, trivia } = lex(text);
  const index = new Map(tokens.map((t, i) => [t.start, i]));
  const flat: OutlineSymbol[] = [];
  const add = (name: string, detail: string, kind: OutlineKind, start: number, end: number, nameStart = start, nameEnd = end) =>
    flat.push({ name, detail, kind, start, end, nameStart, nameEnd, children: [] });

  // What the section declares.
  for (const o of analysis?.occurrences ?? []) {
    if (!o.decl) continue;
    const s = o.sym;
    const detail = s.kind === 'var' ? s.typeText : '';
    add(s.name, detail, symbolKindOf(s), o.start, HEADERS.has(s.kind) ? text.length : o.end, o.start, o.end);
  }

  const blocks = keywordBlocks(tokens).filter(isClosed);
  for (const b of blocks) {
    const open = b.keywords[0];
    const close = b.keywords[b.keywords.length - 1];
    if (b.opener.startsWith('VAR')) {
      // With its qualifiers: VAR CONSTANT, VAR_GLOBAL PERSISTENT.
      let i = index.get(open.start)! + 1;
      const words = [open.text];
      while (tokens[i]?.kind === Tk.Ident && ['CONSTANT', 'RETAIN', 'PERSISTENT', 'NON_RETAIN'].includes(tokens[i].upper)) words.push(tokens[i++].text);
      add(words.join(' '), '', 'Namespace', open.start, close.end, open.start, tokens[i - 1].end);
    } else if (b.opener === 'CASE') {
      caseBranches(b.keywords, close);
    }
  }

  /** A CASE with its branches: each label (`10:`, `E_State.Idle, E_State.Init:`, `1..5:`) up to the next one. */
  function caseBranches(keywords: Token[], close: Token): void {
    const caseTok = keywords[0];
    const of = keywords.find(k => k.upper === 'OF');
    if (!of) return;
    const ofIndex = index.get(of.start)!;
    const selector = text.slice(tokens[index.get(caseTok.start)! + 1].start, tokens[ofIndex - 1].end).replace(/\s+/g, ' ');
    add(`CASE ${selector}`, '', 'Enum', caseTok.start, close.end, caseTok.start, of.end);
    const elseTok = keywords.find(k => k.upper === 'ELSE');
    const endIndex = index.get((elseTok ?? close).start)!;
    // Blocks nested in the CASE: their tokens hold no labels of this one.
    const nested = blocks.filter(n => n.keywords[0].start > of.start && n.keywords[0].start < close.start)
      .map(n => [index.get(n.keywords[0].start)!, index.get(n.keywords[n.keywords.length - 1].start)!] as const);
    const labels: { start: number; colon: number }[] = [];
    let atStatement = true;
    for (let i = ofIndex + 1; i < endIndex; i++) {
      const block = nested.find(([a]) => a === i);
      if (block) {
        i = block[1];
        atStatement = true;
        continue;
      }
      if (atStatement) {
        // A label: values, ranges and enumeration values up to a ':' (not ':=').
        let j = i;
        while (j < endIndex && (tokens[j].kind !== Tk.Op || [',', '..', '.', '-', '#'].includes(tokens[j].text))) j++;
        if (j > i && isOp(tokens[j], ':')) {
          labels.push({ start: i, colon: j });
          i = j;
          continue;
        }
      }
      atStatement = isOp(tokens[i], ';');
    }
    labels.forEach((l, k) => {
      const nameStart = tokens[l.start].start;
      const nameEnd = tokens[l.colon - 1].end;
      const end = k + 1 < labels.length ? tokens[labels[k + 1].start].start : (elseTok ?? close).start;
      add(text.slice(nameStart, nameEnd).replace(/\s+/g, ' '), commentAfter(text, trivia, tokens[l.colon].end), 'EnumMember',
        nameStart, end, nameStart, nameEnd);
    });
    if (elseTok) add('ELSE', commentAfter(text, trivia, elseTok.end), 'EnumMember', elseTok.start, close.start, elseTok.start, elseTok.end);
  }

  // {region "Name"} ... {endregion}
  const open: { start: number; end: number; name: string }[] = [];
  for (const t of trivia) {
    if (t.kind !== 'pragma') continue;
    const m = /^\{\s*region\b\s*(?:"([^"]*)")?/i.exec(t.text);
    if (m) open.push({ start: t.start, end: t.end, name: m[1]?.trim() || 'region' });
    else if (/^\{\s*endregion\b/i.test(t.text) && open.length) {
      const r = open.pop()!;
      add(r.name, '', 'Package', r.start, t.end, r.start, r.end);
    }
  }

  // Nested by what holds what: the variables in their VAR block, the branches in their CASE, all in the header.
  flat.sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: OutlineSymbol[] = [];
  const stack: OutlineSymbol[] = [];
  for (const s of flat) {
    while (stack.length && !(s.start >= stack[stack.length - 1].start && s.end <= stack[stack.length - 1].end)) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(s);
    stack.push(s);
  }
  return roots;
}

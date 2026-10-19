// Calls of functions, function block instances, programs, methods, actions and built-ins: the call the cursor
// is in and its active parameter (signature help), the parameters of what is called, and the text of a call
// with all its parameters (completion, like "Insert with arguments" of XAE's Input Assistant).

import { Tk, Token } from './lexer';
import { RESERVED } from './parser';
import { Analyzer } from './analyzer';
import { LanguageIndex, SectionContext } from './index';
import { BuiltinSym, MemberSym, PouSym, Sym, Ty, VarSym } from './symbols';
import { textBefore } from './completion';

export interface CallParam {
  name: string;
  section: string;
  /** Declared type and initial value; empty for the parameters of built-ins. */
  type: string;
  init?: string;
  /** Passed with `=>` (VAR_OUTPUT); inputs and in-outs are passed with `:=`. */
  output: boolean;
  sym?: VarSym;
}

export interface Callable {
  kind: 'function' | 'functionBlock' | 'program' | 'method' | 'action' | 'fbInit' | 'builtin';
  /** Shown before the parameters: the instance (`fbTimer`), function, method or action. */
  name: string;
  /** The inputs and in-outs in declaration order, then the outputs. */
  params: CallParam[];
  returnType?: string;
  /** What is called: the function block of an instance, the function, method, action or built-in. */
  sym: PouSym | MemberSym | BuiltinSym;
  /** A built-in taking more arguments of the kind of its last parameter (`...`). */
  variadic?: boolean;
}

const PARAM_SECTIONS = new Set(['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT']);
/** Inputs of FB_init that TwinCAT passes itself. */
const IMPLICIT_INIT = new Set(['BINITRETAINS', 'BINCOPYCODE']);

function params(vars: VarSym[]): CallParam[] {
  const list = vars.filter(v => PARAM_SECTIONS.has(v.section)).map((v): CallParam => ({
    name: v.name, section: v.section, type: v.typeText, init: v.initText, output: v.section === 'VAR_OUTPUT', sym: v,
  }));
  return [...list.filter(p => !p.output), ...list.filter(p => p.output)];
}

/** Variables of a function block or program, those of the function blocks it extends first. */
function instanceVars(analyzer: Analyzer, pou: PouSym, seen = new Set<PouSym>()): VarSym[] {
  if (seen.has(pou) || seen.size > 20) return [];
  seen.add(pou);
  const vars = [...analyzer.basesOf(pou).flatMap(b => instanceVars(analyzer, b, seen)), ...pou.vars];
  const names = new Set<string>();
  return vars.filter(v => {
    const name = v.name.toUpperCase();
    if (names.has(name)) return false;
    names.add(name);
    return true;
  });
}

function instanceCall(analyzer: Analyzer, name: string, pou: PouSym): Callable {
  return { kind: pou.pouKind === 'PRG' ? 'program' : 'functionBlock', name, params: params(instanceVars(analyzer, pou)), sym: pou };
}

function memberCall(analyzer: Analyzer, m: MemberSym): Callable | undefined {
  if (m.kind === 'method') return { kind: 'method', name: m.name, params: params(m.vars), returnType: m.returnText, sym: m };
  // An action takes the inputs and outputs of its POU: `fbValve.A_Close(bForce := TRUE)`.
  if (m.kind === 'action') return { kind: 'action', name: m.name, params: params(instanceVars(analyzer, m.owner)), sym: m };
  return undefined;
}

function builtinCall(b: BuiltinSym): Callable | undefined {
  const m = /^(\w+)\((.*)\)(?:\s*:\s*(.+))?$/.exec(b.signature);
  if (b.value || !m) return undefined;
  const names = m[2].split(',').map(n => n.trim()).filter(n => n.length > 0);
  return {
    kind: 'builtin', name: m[1], params: names.map(name => ({ name, section: 'VAR_INPUT', type: '', output: false })),
    returnType: m[3], sym: b, variadic: names[names.length - 1] === '...',
  };
}

/** What a completion item calls, if it is called (function block instances, programs, functions, methods, actions). */
export function callableOfSymbol(analyzer: Analyzer, s: Sym, ty: Ty): Callable | undefined {
  switch (s.kind) {
    case 'var': {
      const t = ty.k === 'ref' ? ty.to : ty;
      return t.k === 'pou' && t.sym.pouKind === 'FB' ? instanceCall(analyzer, s.name, t.sym) : undefined;
    }
    case 'pou':
      if (s.pouKind === 'FUN') return { kind: 'function', name: s.name, params: params(s.vars), returnType: s.returnText, sym: s };
      // A program does not call itself.
      return s.pouKind === 'PRG' && s !== analyzer.ctx.pou ? instanceCall(analyzer, s.name, s) : undefined;
    case 'method':
    case 'action':
      return memberCall(analyzer, s);
    default:
      return undefined;
  }
}

/**
 * What an expression of this type calls: `fbTimer`, `F_Scale`, `fbValve.Open`, `fbValve.A_Close`, `LIMIT`, and in
 * a declaration the FB_init of a function block (`fbValve : FB_Valve(nId := 3)`).
 */
export function callableOfType(analyzer: Analyzer, ty: Ty, callee: string, role: 'decl' | 'impl'): Callable | undefined {
  let t = ty;
  for (let i = 0; i < 4 && (t.k === 'ref' || t.k === 'ptr'); i++) t = t.to;
  if (t.k === 'callable') {
    const s = t.sym;
    if (s.kind === 'builtin') return builtinCall(s);
    if (s.kind === 'pou') return callableOfSymbol(analyzer, s, t);
    return memberCall(analyzer, s);
  }
  if (t.k === 'pou' && (t.sym.pouKind === 'FB' || t.sym.pouKind === 'PRG')) return instanceCall(analyzer, callee, t.sym);
  if (t.k === 'typeName' && t.sym.kind === 'pou' && t.sym.pouKind === 'FB' && role === 'decl') {
    const init = analyzer.findInPou(t.sym, 'FB_INIT')?.sym;
    if (init?.kind !== 'method') return undefined;
    const vars = init.vars.filter(v => !IMPLICIT_INIT.has(v.name.toUpperCase()));
    return { kind: 'fbInit', name: t.sym.name, params: params(vars), sym: init };
  }
  return undefined;
}

/** Whether a call of it has a value (a function or method with a return type), so it can be part of an expression. */
export function returnsValue(c: Callable): boolean {
  return c.returnType !== undefined && (c.kind === 'function' || c.kind === 'method' || c.kind === 'builtin');
}

// ------------------------------------------------------------------ signature help

export interface CallSite {
  /** Text of what is called: `fbTimer`, `fbValve.Open`, `aPumps[i]`, `SUPER^`. */
  callee: string;
  /** Names of the arguments before the cursor's (undefined for a positional one). */
  before: (string | undefined)[];
  /** The argument at the cursor: its name when it is named, or the name being typed. */
  current: { name?: string; typing?: string };
}

/** Keywords no call goes on after (an unclosed parenthesis before them is a mistake, not the call the cursor is in). */
const CALL_BREAKS = new Set([
  'THEN', 'ELSE', 'ELSIF', 'DO', 'REPEAT', 'UNTIL', 'END_IF', 'END_CASE', 'END_FOR', 'END_WHILE', 'END_REPEAT',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_INST', 'END_VAR', 'STRUCT', 'END_STRUCT',
]);

const isOp = (t: Token | undefined, op: string) => t?.kind === Tk.Op && t.text === op;
const isName = (t: Token | undefined) => t?.kind === Tk.Ident && !RESERVED.has(t.upper);

/** Index of the bracket that `close` closes. */
function opening(tokens: Token[], close: number): number {
  const c = tokens[close].text;
  const o = c === ')' ? '(' : '[';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (isOp(tokens[i], c)) depth++;
    else if (isOp(tokens[i], o) && --depth === 0) return i;
  }
  return -1;
}

/** First token of what a parenthesis calls (`fbTimer`, `THIS^.Open`, `aPumps[i]`), or -1 for a parenthesized expression. */
function calleeStart(tokens: Token[], paren: number): number {
  let i = paren - 1;
  const t = tokens[i];
  if (!isName(t) && !isOp(t, ')') && !isOp(t, ']') && !isOp(t, '^')) return -1;
  for (;;) {
    const x = tokens[i];
    if (isOp(x, ')') || isOp(x, ']')) {
      const o = opening(tokens, i);
      if (o < 0) return -1;
      const before = tokens[o - 1];
      if (!isName(before) && !isOp(before, ')') && !isOp(before, ']') && !isOp(before, '^')) return o;
      i = o - 1;
    } else if (isOp(x, '^')) {
      i--;
    } else if (isName(x)) {
      if (!isOp(tokens[i - 1], '.')) return i;
      i -= 2;
    } else {
      return -1;
    }
  }
}

/** The tokens as one text, without the comments and blanks between them (`aPumps[i+1]`, `THIS^.Open`). */
function joined(tokens: Token[]): string {
  let s = '';
  for (const t of tokens) {
    if (/\w$/.test(s) && /^\w/.test(t.text)) s += ' ';
    s += t.text;
  }
  return s;
}

/** The name of a named argument (`IN := x`, `Q => b`, `NOT Q => b`). */
function argName(arg: Token[]): string | undefined {
  const i = arg[0]?.kind === Tk.Ident && arg[0].upper === 'NOT' ? 1 : 0;
  return isName(arg[i]) && (isOp(arg[i + 1], ':=') || isOp(arg[i + 1], '=>')) ? arg[i].text : undefined;
}

/** The innermost call whose arguments the cursor is in. */
export function findCall(text: string, offset: number): CallSite | undefined {
  const { tokens, inComment } = textBefore(text, offset);
  if (inComment) return undefined;
  const open: number[] = [];
  tokens.forEach((t, i) => {
    if (isOp(t, '(') || isOp(t, '[')) {
      open.push(i);
    } else if (isOp(t, ')') || isOp(t, ']')) {
      const o = t.text === ')' ? '(' : '[';
      const j = open.map(k => tokens[k].text).lastIndexOf(o);
      if (j >= 0) open.length = j;
    } else if (isOp(t, ';') || (t.kind === Tk.Ident && CALL_BREAKS.has(t.upper))) {
      open.length = 0;
    }
  });
  for (let j = open.length - 1; j >= 0; j--) {
    const paren = open[j];
    if (!isOp(tokens[paren], '(')) continue;
    const start = calleeStart(tokens, paren);
    if (start < 0) continue;
    const args: Token[][] = [[]];
    let depth = 0;
    for (let i = paren + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (isOp(t, '(') || isOp(t, '[')) depth++;
      else if (isOp(t, ')') || isOp(t, ']')) depth = Math.max(0, depth - 1);
      else if (depth === 0 && isOp(t, ',')) {
        args.push([]);
        continue;
      }
      args[args.length - 1].push(t);
    }
    const cur = args.pop()!;
    const name = argName(cur);
    // A name alone, or with the first character of `:=` or `=>`.
    const rest = cur[0]?.kind === Tk.Ident && cur[0].upper === 'NOT' ? cur.slice(1) : cur;
    const typing = isName(rest[0]) && (rest.length === 1 || (rest.length === 2 && (isOp(rest[1], ':') || isOp(rest[1], '='))));
    return {
      callee: joined(tokens.slice(start, paren)),
      before: args.map(argName),
      current: name !== undefined ? { name } : typing ? { typing: rest[0].text } : {},
    };
  }
  return undefined;
}

/**
 * The parameter the cursor is at: the one named there or whose name is being typed, else in a call with named
 * arguments the next one not named yet, else the input at the argument's position.
 */
export function activeParameter(c: Callable, site: CallSite): number {
  const index = (name: string) => c.params.findIndex(p => p.name.toUpperCase() === name.toUpperCase());
  if (site.current.name !== undefined) return index(site.current.name);
  const typing = site.current.typing?.toUpperCase();
  if (typing) {
    const typed = index(typing);
    const i = typed >= 0 ? typed : c.params.findIndex(p => p.name.toUpperCase().startsWith(typing));
    if (i >= 0) return i;
  }
  const named = site.before.filter((n): n is string => n !== undefined).map(n => n.toUpperCase());
  if (named.length > 0) {
    const free = (i: number) => !named.includes(c.params[i].name.toUpperCase());
    for (let i = index(named[named.length - 1]) + 1; i < c.params.length; i++) if (free(i)) return i;
    for (let i = 0; i < c.params.length; i++) if (free(i)) return i;
    return -1;
  }
  const inputs = c.params.filter(p => !p.output).length;
  const i = site.before.length;
  if (i < inputs) return i;
  return c.variadic ? inputs - 1 : -1;
}

export interface SignatureLabel {
  /** `fbTimer(IN : BOOL, PT : TIME, Q => BOOL, ET => TIME)`, `F_Scale(fIn : LREAL) : LREAL`. */
  label: string;
  /** Where each parameter is in the label. */
  params: [number, number][];
}

/** Inputs and in-outs as declared (`PT : TIME := T#1S`), outputs with the `=>` they are passed with (`Q => BOOL`). */
export function signatureLabel(c: Callable): SignatureLabel {
  let label = `${c.name}(`;
  const ranges: [number, number][] = [];
  c.params.forEach((p, i) => {
    if (i > 0) label += ', ';
    const text = !p.type ? p.name
      : p.output ? `${p.name} => ${p.type}` : `${p.name} : ${p.type}${p.init !== undefined ? ` := ${p.init}` : ''}`;
    ranges.push([label.length, label.length + text.length]);
    label += text;
  });
  label += ')';
  if (c.returnType) label += ` : ${c.returnType}`;
  return { label, params: ranges };
}

export interface Signature extends SignatureLabel {
  callable: Callable;
  /** Index of the active parameter, -1 for none. */
  active: number;
}

/** The signature of the call the cursor is in, with its active parameter. */
export function signatureAt(index: LanguageIndex, ctx: SectionContext, text: string, offset: number): Signature | undefined {
  const site = findCall(text, offset);
  if (!site) return undefined;
  const analyzer = new Analyzer(index, ctx, text);
  const callable = callableOfType(analyzer, analyzer.typeOfText(site.callee), site.callee, ctx.role);
  if (!callable) return undefined;
  return { ...signatureLabel(callable), callable, active: activeParameter(callable, site) };
}

// ------------------------------------------------------------------ calls inserted by completion

/** `(IN := , PT := , Q => , ET => )`: what the call completion inserts after the name, without the values. */
export function callArguments(c: Callable): string {
  return `(${c.params.map(p => `${p.name} ${p.output ? '=>' : ':='} `).join(', ')})`;
}

/** The call with every parameter and a tab stop for each value; as a statement of its own it ends with `;`. */
export function callSnippet(c: Callable, name: string, statement: boolean): string {
  const args = c.params.map((p, i) => `${p.name} ${p.output ? '=>' : ':='} \${${i + 1}}`);
  return `${escapeSnippet(name)}(${args.join(', ')})${statement ? ';' : ''}`;
}

/** Text that a snippet inserts as it is. */
function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, m => `\\${m}`);
}

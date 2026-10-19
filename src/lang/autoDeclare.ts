// What XAE's Auto Declare needs from the language, apart from VS Code: the blocks the declaration of an object can
// have, the type the uses of a name give it (BOOL when they give none, the type XAE's Auto Declare dialog starts
// with), the edit that declares `bDone : BOOL;` in a VAR block of a declaration or in a new block, and the quick
// fixes of the problems "Unknown identifier" (declare it) and "not a member" of a function block, program or
// interface of the workspace (add a method or property to it).

import * as A from './ast';
import { Analyzer, Problem } from './analyzer';
import { LanguageIndex, SectionContext } from './index';
import { Tk, lex } from './lexer';
import { nameProblem, typeProblem } from './members';
import { parseDeclaration } from './parser';
import { GlobalSym, PouSym, Sym, Ty, VarSym, isLibrarySym } from './symbols';

/** A block a variable is declared in: its keyword, and CONSTANT, RETAIN or PERSISTENT after it. */
export interface VarScope {
  section: string;
  qualifier?: 'CONSTANT' | 'RETAIN' | 'PERSISTENT';
}

/** The scope as its block starts: `VAR`, `VAR_INPUT`, `VAR CONSTANT`. */
export function scopeLabel(scope: VarScope): string {
  return scope.qualifier ? `${scope.section} ${scope.qualifier}` : scope.section;
}

/** What a declaration belongs to, which decides the blocks it can have. */
export type DeclarationKind = 'FB' | 'PRG' | 'FUN' | 'method' | 'interface method' | 'accessor' | 'gvl';

const PLAIN_SCOPES: Record<DeclarationKind, string[]> = {
  FB: ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP'],
  PRG: ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP'],
  FUN: ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'],
  method: ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'],
  'interface method': ['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'],
  accessor: ['VAR'],
  gvl: ['VAR_GLOBAL'],
};

const RETAINED = (section: string): VarScope[] => [
  { section, qualifier: 'CONSTANT' }, { section, qualifier: 'RETAIN' }, { section, qualifier: 'PERSISTENT' },
];

const MORE_SCOPES: Record<DeclarationKind, VarScope[]> = {
  FB: RETAINED('VAR'),
  PRG: RETAINED('VAR'),
  FUN: [{ section: 'VAR', qualifier: 'CONSTANT' }],
  method: [{ section: 'VAR', qualifier: 'CONSTANT' }, { section: 'VAR_INST' }],
  'interface method': [],
  accessor: [{ section: 'VAR', qualifier: 'CONSTANT' }],
  gvl: RETAINED('VAR_GLOBAL'),
};

/**
 * The blocks a variable can be declared in, the default first: those the quick fixes offer (VAR_TEMP only in
 * function blocks and programs, VAR_GLOBAL in a GVL), with `all` also the CONSTANT, RETAIN and PERSISTENT blocks
 * and a method's VAR_INST, which Auto Declare... offers.
 */
export function declarationScopes(kind: DeclarationKind, all = false): VarScope[] {
  const plain = PLAIN_SCOPES[kind].map(section => ({ section }));
  return all ? [...plain, ...MORE_SCOPES[kind]] : plain;
}

/** What the declaration of a section's object belongs to; undefined when variables are not declared there. */
export function declarationKind(ctx: SectionContext): DeclarationKind | undefined {
  const pouKind = ctx.pou?.pouKind;
  switch (ctx.object.kind) {
    case 'gvl': return 'gvl';
    case 'pou': return pouKind === 'FB' || pouKind === 'PRG' || pouKind === 'FUN' ? pouKind : undefined;
    case 'method': return pouKind === 'ITF' ? 'interface method' : 'method';
    // The declaration of a property itself has no blocks, those of its Get and Set have.
    case 'property': return ctx.accessor && pouKind !== 'ITF' ? 'accessor' : undefined;
    default: return undefined;
  }
}

/** The declaration that the variables used in a section are declared in. */
export interface DeclarationTarget {
  /** Its section key. */
  key: string;
  ctx: SectionContext;
  kind: DeclarationKind;
  /** It is not in the section's own view: the declaration of the POU of an action or transition. */
  other: boolean;
}

/**
 * Where a variable used in a section is declared, as XAE's Auto Declare does: in the declaration of the same view
 * (of the POU, method or GVL, or of the property's Get or Set), or for an action or transition in that of its POU.
 */
export function declarationTarget(index: LanguageIndex, ctx: SectionContext): DeclarationTarget | undefined {
  let key = ctx.role === 'decl' ? ctx.sectionKey : ctx.sectionKey.replace(/:impl$/, ':decl');
  let target = index.context(ctx.fileKey, key);
  let other = false;
  if (!target && (ctx.object.kind === 'action' || ctx.object.kind === 'transition') && ctx.pou?.loc?.fileKey === ctx.fileKey) {
    key = ctx.pou.loc.sectionKey;
    target = index.context(ctx.fileKey, key);
    other = true;
  }
  const kind = target && declarationKind(target);
  return target && kind ? { key, ctx: target, kind, other } : undefined;
}

// ------------------------------------------------------------------ the declaration

/** A variable to declare. */
export interface NewVariable {
  name: string;
  type: string;
  /** Initial value, none when empty. */
  init?: string;
  /** Comment after the declaration, none when empty. */
  comment?: string;
}

/** The declaration of a variable: `bDone : BOOL;`, `nCount : INT := 5; // parts made`. */
export function declarationLine(v: NewVariable): string {
  const init = v.init?.trim() ? ` := ${v.init.trim()}` : '';
  const comment = v.comment?.trim() ? ` // ${v.comment.trim().replace(/\s*[\r\n]+\s*/g, ' ')}` : '';
  return `${v.name.trim()} : ${v.type.trim()}${init};${comment}`;
}

/** An edit that declares a variable: text inserted at an offset of the declaration, nothing replaced. */
export interface DeclarationEdit {
  offset: number;
  text: string;
  /** Where the new declaration is in the declaration once edited. */
  start: number;
  end: number;
}

interface Block {
  block: A.VarBlock;
  /** Offset of its END_VAR; none in a declaration with a syntax error there. */
  endVar?: number;
}

function blocksOf(text: string): { blocks: Block[]; header?: A.Header } {
  const parsed = parseDeclaration(text);
  const endVars = lex(text).tokens.filter(t => t.kind === Tk.Ident && t.upper === 'END_VAR');
  const blocks = parsed.units.flatMap(u => u.varBlocks).sort((a, b) => a.start - b.start).map(block => ({
    block, endVar: endVars.filter(t => t.start >= block.start && t.end <= block.end).pop()?.start,
  }));
  return { blocks, header: parsed.units.find(u => u.header)?.header };
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;

function lineEnd(text: string, offset: number): number {
  const i = text.indexOf('\n', offset);
  return i < 0 ? text.length : i;
}

/** The spaces and tabs before an offset, when nothing else is before it on its line. */
function indentBefore(text: string, offset: number): string | undefined {
  const before = text.slice(lineStart(text, offset), offset);
  return /^[ \t]*$/.test(before) ? before : undefined;
}

/** How far the declarations of the blocks are indented from the keyword of their block (a tab in XAE's files). */
function declarationIndent(text: string, blocks: Block[]): string | undefined {
  for (const { block } of blocks) {
    const keyword = indentBefore(text, block.start) ?? '';
    for (const d of block.decls) {
      const indent = indentBefore(text, d.start);
      if (indent !== undefined) return indent.startsWith(keyword) ? indent.slice(keyword.length) : indent;
    }
  }
  return undefined;
}

/** The order of the blocks in XAE's templates: VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, then VAR and the others. */
const SECTION_ORDER = ['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR', 'VAR_INST', 'VAR_STAT', 'VAR_TEMP'];
const QUALIFIER_ORDER = ['CONSTANT', 'RETAIN', 'PERSISTENT'];

function rank(section: string, qualifiers: readonly string[]): number {
  const s = SECTION_ORDER.indexOf(section);
  const q = QUALIFIER_ORDER.findIndex(x => qualifiers.includes(x)) + 1;
  return (s < 0 ? SECTION_ORDER.length : s) * 10 + q;
}

/** Whether a line holds a comment only (it belongs to the block below it). */
function commentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || (t.startsWith('(*') && t.endsWith('*)'));
}

/**
 * The edit that declares a variable (`line`, see declarationLine) in a declaration, as XAE's Auto Declare does:
 * on a line of its own before the END_VAR of the first block of the scope (a plain one for VAR: without CONSTANT,
 * RETAIN or PERSISTENT), indented like the declarations of the block. Without such a block, a new one goes after
 * the blocks that XAE's templates put before it (after the header when there are none), indented like the others,
 * with `indentUnit` when no declaration shows how. Undefined for a declaration with a block without END_VAR.
 */
export function declarationEdit(text: string, scope: VarScope, line: string, indentUnit = '\t'): DeclarationEdit | undefined {
  const { blocks, header } = blocksOf(text);
  if (blocks.some(b => b.endVar === undefined)) return undefined;
  const qualifiers = scope.qualifier ? [scope.qualifier] : [];
  const target = blocks.find(b => b.block.section === scope.section
    && b.block.qualifiers.length === qualifiers.length && qualifiers.every(q => b.block.qualifiers.includes(q)));
  const relative = declarationIndent(text, blocks) ?? indentUnit;
  if (target) {
    const endVar = target.endVar!;
    const keyword = indentBefore(text, target.block.start) ?? '';
    let indent = `${keyword}${relative}`;
    for (const d of [...target.block.decls].reverse()) {
      const own = indentBefore(text, d.start);
      if (own !== undefined) {
        indent = own;
        break;
      }
    }
    const at = lineStart(text, endVar);
    if (indentBefore(text, endVar) !== undefined) {
      return { offset: at, text: `${indent}${line}\n`, start: at + indent.length, end: at + indent.length + line.length };
    }
    // END_VAR after code on its line (`VAR x : INT; END_VAR`): the declaration goes before it, on that line.
    return { offset: endVar, text: `${line} `, start: endVar, end: endVar + line.length };
  }

  const keyword = blocks.length ? indentBefore(text, blocks[0].block.start) ?? '' : '';
  const label = scopeLabel(scope);
  const block = `${keyword}${label}\n${keyword}${relative}${line}\n${keyword}END_VAR`;
  const lineAt = keyword.length + label.length + 1 + keyword.length + relative.length;
  const own = rank(scope.section, qualifiers);
  const before = blocks.filter(b => rank(b.block.section, b.block.qualifiers) <= own).pop();
  const afterLineOf = (offset: number) => {
    const end = lineEnd(text, offset);
    return end < text.length ? { at: end + 1, prefix: '', suffix: '\n' } : { at: text.length, prefix: '\n', suffix: '' };
  };
  let place: { at: number; prefix: string; suffix: string };
  if (before) {
    place = afterLineOf(before.block.end);
  } else if (blocks.length) {
    // Before the first block, and the comment lines right above it, which belong to it.
    let at = lineStart(text, blocks[0].block.start);
    while (at > 0) {
      const above = lineStart(text, at - 1);
      if (!commentLine(text.slice(above, at - 1))) break;
      at = above;
    }
    place = { at, prefix: '', suffix: '\n' };
  } else if (header) {
    place = afterLineOf(header.end);
  } else {
    // Nothing declared yet (a GVL with its pragmas only, the Get of a property): at the end.
    place = !text.trim() ? { at: text.length, prefix: '', suffix: '' }
      : text.endsWith('\n') ? { at: text.length, prefix: '', suffix: '\n' } : { at: text.length, prefix: '\n', suffix: '' };
  }
  const start = place.at + place.prefix.length + lineAt;
  return { offset: place.at, text: `${place.prefix}${block}${place.suffix}`, start, end: start + line.length };
}

/** Why a variable cannot be declared with this name in the declaration: not a name, a keyword, declared there already. */
export function variableNameProblem(declaration: string, name: string): string | undefined {
  const problem = nameProblem(name);
  if (problem) return problem;
  const upper = name.toUpperCase();
  for (const unit of parseDeclaration(declaration).units) {
    if (unit.header?.name?.upper === upper) return `${unit.header.name.name} is the name of the ${unit.header.pouKind.toLowerCase().replace('_', ' ')} itself`;
    for (const block of unit.varBlocks) {
      for (const d of block.decls) {
        const n = d.names.find(x => x.upper === upper);
        if (n) return `${n.name} is declared already, in ${[block.section, ...block.qualifiers].join(' ')}`;
      }
    }
  }
  return undefined;
}

/** Why a text is not an initial value of a variable of the type; undefined when it is one. */
export function initialValueProblem(type: string, init: string): string | undefined {
  const value = init.trim();
  if (/[\r\n]/.test(value)) return 'The initial value must be on one line';
  const r = parseDeclaration(`VAR\n\tx : ${type.trim()} := ${value};\nEND_VAR`);
  if (r.errors.length || !r.units[0]?.varBlocks[0]?.decls[0]?.init) {
    return `'${value}' is not an initial value${r.errors[0] ? `: ${r.errors[0].message}` : ''}`;
  }
  return undefined;
}

// ------------------------------------------------------------------ the type a use gives

const PARAM_SECTIONS = new Set(['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT']);
const COMPARISON = new Set(['=', '<>', '<', '>', '<=', '>=']);
const LOGICAL = new Set(['AND', 'OR', 'XOR', 'AND_THEN', 'OR_ELSE', '&']);

/**
 * The type of an integer: INT, DINT or LINT, the smallest that holds it; WORD, DWORD or LWORD when it is written
 * with a base (`16#FF`), as bit patterns are. Undefined for what is not a number (`%IX0.0`).
 */
export function integerType(text: string, negative = false): string | undefined {
  const t = text.replace(/_/g, '');
  const based = /^(\d+)#([0-9A-Za-z]+)$/.exec(t);
  if (based && based[1] !== '10') {
    const radix = Number(based[1]);
    if (radix !== 2 && radix !== 8 && radix !== 16) return undefined;
    const v = parseInt(based[2], radix);
    if (Number.isNaN(v)) return undefined;
    return v <= 0xffff ? 'WORD' : v <= 0xffffffff ? 'DWORD' : 'LWORD';
  }
  const digits = based ? based[2] : t;
  if (!/^\d+$/.test(digits)) return undefined;
  const v = Number(digits) * (negative ? -1 : 1);
  if (v >= -32768 && v <= 32767) return 'INT';
  if (v >= -2147483648 && v <= 2147483647) return 'DINT';
  return 'LINT';
}

function literalType(e: A.Expr & { kind: 'Literal' }, negative = false): string | undefined {
  switch (e.litType) {
    case 'bool': return 'BOOL';
    case 'real': return 'LREAL';
    case 'string': return 'STRING';
    case 'wstring': return 'WSTRING';
    case 'int': return integerType(e.text, negative);
    default: return undefined;
  }
}

function isNumber(e: A.Expr): boolean {
  if (e.kind === 'Paren') return isNumber(e.expr);
  if (e.kind === 'Unary' && e.op !== 'NOT') return isNumber(e.operand);
  return e.kind === 'Literal' && (e.litType === 'int' || e.litType === 'real');
}

function deref(t: Ty): Ty {
  let cur = t;
  for (let i = 0; i < 4 && (cur.k === 'ref' || cur.k === 'ptr'); i++) cur = cur.to;
  return cur;
}

/** A type as a declaration writes it, on one line, without the arguments of FB_init; empty when there is none. */
function specText(text: string, spec: A.TypeSpec): string {
  const s = spec.kind === 'NamedType' ? text.slice(spec.name.start, spec.name.end) : text.slice(spec.start, spec.end);
  return s.replace(/\s+/g, ' ').trim();
}

/** The type that the place of an expression in the code gives it, when it gives one. */
type Expect = () => string | undefined;

const NONE: Expect = () => undefined;

interface NameUse {
  id: A.Ident;
  expect: Expect;
}

interface MemberUse {
  e: A.Expr & { kind: 'Member' };
  expect: Expect;
  /** Called (`fbValve.M_Reset()`), in a statement of its own or not. */
  call?: { statement: boolean };
}

/** The identifiers and members used in a section, each with the type its place gives. */
class Uses {
  readonly analyzer: Analyzer;
  readonly names: NameUse[] = [];
  readonly members: MemberUse[] = [];

  constructor(readonly index: LanguageIndex, readonly ctx: SectionContext, readonly text: string) {
    this.analyzer = new Analyzer(index, ctx, text);
    if (ctx.role === 'decl') for (const unit of index.parseDecl(text).units) this.unit(unit);
    else this.stmts(index.parseBody(text).body);
  }

  // ---------------------------------------------------------------- declarations

  private unit(unit: A.DeclUnit): void {
    if (unit.header?.returnType) this.typeSpec(unit.header.returnType);
    for (const block of unit.varBlocks) {
      for (const d of block.decls) {
        if (d.type) this.typeSpec(d.type);
        if (d.init) this.init(d.init, d.type ? () => specText(this.text, d.type!) || undefined : NONE, d.type);
      }
    }
  }

  private init(e: A.Expr, expect: Expect, spec?: A.TypeSpec): void {
    if (e.kind === 'ArrayInit') {
      const of = spec?.kind === 'ArrayType' ? spec.of : undefined;
      for (const item of e.items) this.init(item, of ? () => specText(this.text, of) || undefined : NONE, of);
      return;
    }
    if (e.kind === 'StructInit') {
      const t = spec ? deref(this.analyzer.resolveTypeSpec(spec, this.ctx.scope)) : undefined;
      for (const f of e.fields) {
        const field = t && t.k !== 'unknown' ? this.analyzer.memberOf(t, f.name.upper)?.sym : undefined;
        this.init(f.value, field?.kind === 'var' ? () => this.declaredText(field, field.typeSpec) : NONE);
      }
      return;
    }
    this.expr(e, expect);
  }

  private typeSpec(spec: A.TypeSpec): void {
    switch (spec.kind) {
      case 'NamedType': {
        if (spec.range) {
          const base: Expect = () => specText(this.text, spec) || undefined;
          this.expr(spec.range.lo, base);
          this.expr(spec.range.hi, base);
        }
        if (spec.args) {
          // The arguments of FB_init, without the two TwinCAT passes itself.
          const params = (): VarSym[] | undefined => {
            const t = this.analyzer.resolveTypeSpec(spec, this.ctx.scope);
            const fbInit = t.k === 'pou' ? this.analyzer.findInPou(t.sym, 'FB_INIT')?.sym : undefined;
            return fbInit?.kind === 'method'
              ? fbInit.vars.filter(v => PARAM_SECTIONS.has(v.section) && !['BINITRETAINS', 'BINCOPYCODE'].includes(v.name.toUpperCase()))
              : undefined;
          };
          spec.args.forEach((a, i) => {
            if (a.value) this.expr(a.value, () => this.paramType(params(), a, i));
          });
        }
        return;
      }
      case 'StringType':
        if (spec.length) this.expr(spec.length, () => 'INT');
        return;
      case 'ArrayType':
        for (const d of spec.dims) {
          if (d === '*') continue;
          this.expr(d.lo, () => 'INT');
          this.expr(d.hi, () => 'INT');
        }
        this.typeSpec(spec.of);
        return;
      case 'PointerType':
      case 'ReferenceType':
        this.typeSpec(spec.to);
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- statements

  private stmts(list: A.Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: A.Stmt): void {
    switch (s.kind) {
      case 'Assign':
        if (s.op === 'S=' || s.op === 'R=') {
          this.expr(s.target, () => 'BOOL');
          this.expr(s.value, () => 'BOOL');
        } else if (s.op === 'REF=') {
          this.expr(s.target, () => {
            const t = this.typeOf(s.value);
            return t && `REFERENCE TO ${t}`;
          });
          this.expr(s.value, () => this.typeOf(s.target)?.replace(/^REFERENCE TO /i, ''));
        } else {
          this.expr(s.target, () => this.typeOf(s.value));
          this.expr(s.value, () => this.typeOf(s.target));
        }
        return;
      case 'ExprStmt':
        this.expr(s.expr, NONE, true);
        return;
      case 'If':
        for (const b of s.branches) {
          this.expr(b.cond, () => 'BOOL');
          this.stmts(b.body);
        }
        if (s.elseBody) this.stmts(s.elseBody);
        return;
      case 'Case': {
        const labels = s.cases.flatMap(c => c.labels).map(l => (l.kind === 'Range' ? l.lo : l));
        this.expr(s.expr, () => labels.map(l => this.typeOf(l)).find(t => t !== undefined));
        for (const c of s.cases) {
          for (const l of c.labels) this.expr(l, () => this.typeOf(s.expr));
          this.stmts(c.body);
        }
        if (s.elseBody) this.stmts(s.elseBody);
        return;
      }
      case 'For':
        this.expr(s.variable, () => this.typeOf(s.from) ?? this.typeOf(s.to) ?? 'INT');
        for (const e of [s.from, s.to, s.by]) if (e) this.expr(e, () => this.typeOf(s.variable) ?? 'INT');
        this.stmts(s.body);
        return;
      case 'While':
        this.expr(s.cond, () => 'BOOL');
        this.stmts(s.body);
        return;
      case 'Repeat':
        this.stmts(s.body);
        this.expr(s.cond, () => 'BOOL');
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- expressions

  private expr(e: A.Expr, expect: Expect, statement = false): void {
    switch (e.kind) {
      case 'Ident':
        this.names.push({ id: e, expect });
        return;
      case 'Member':
        this.members.push({ e, expect });
        this.expr(e.object, NONE);
        return;
      case 'BitAccess':
      case 'Deref':
        this.expr(e.object, NONE);
        return;
      case 'Index':
        this.expr(e.object, NONE);
        for (const i of e.indices) this.expr(i, () => 'INT');
        return;
      case 'Call':
        if (e.callee.kind === 'Member') {
          this.members.push({ e: e.callee, expect, call: { statement } });
          this.expr(e.callee.object, NONE);
        } else {
          this.expr(e.callee, NONE);
        }
        e.args.forEach((a, i) => {
          if (a.value) this.expr(a.value, () => this.paramType(this.paramsOf(e), a, i));
        });
        return;
      case 'Unary':
        this.expr(e.operand, e.op === 'NOT' ? () => expect() ?? 'BOOL' : expect);
        return;
      case 'Binary':
        if (COMPARISON.has(e.op)) {
          this.expr(e.left, () => this.typeOf(e.right));
          this.expr(e.right, () => this.typeOf(e.left));
        } else {
          // What it is computed with, else what the result must be; AND, OR and XOR of conditions by default.
          const fallback = () => expect() ?? (LOGICAL.has(e.op) ? 'BOOL' : undefined);
          this.expr(e.left, () => this.typeOf(e.right) ?? fallback());
          this.expr(e.right, () => this.typeOf(e.left) ?? fallback());
        }
        return;
      case 'Paren':
        this.expr(e.expr, expect);
        return;
      case 'Range':
        this.expr(e.lo, expect);
        this.expr(e.hi, expect);
        return;
      case 'ArrayInit':
        for (const item of e.items) this.expr(item, NONE);
        return;
      case 'StructInit':
        for (const f of e.fields) this.expr(f.value, NONE);
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- types

  /** The parameters of what is called: of a function or method, or the inputs and outputs of a function block. */
  private paramsOf(call: A.Expr & { kind: 'Call' }): VarSym[] | undefined {
    const t = deref(this.analyzer.expr(call.callee));
    if (t.k === 'callable' && t.sym.kind !== 'builtin') return t.sym.vars.filter(v => PARAM_SECTIONS.has(v.section));
    if (t.k === 'pou') {
      return this.analyzer.listMembers(t).map(r => r.sym).filter((v): v is VarSym => v.kind === 'var' && PARAM_SECTIONS.has(v.section));
    }
    return undefined;
  }

  /** The type of the parameter an argument is passed to: by its name, else by its place among the inputs. */
  private paramType(params: VarSym[] | undefined, arg: A.Arg, i: number): string | undefined {
    const p = arg.name ? params?.find(v => v.name.toUpperCase() === arg.name!.upper) : params?.filter(v => v.section !== 'VAR_OUTPUT')[i];
    return p && (this.declaredText(p, p.typeSpec) ?? this.declarable(this.analyzer.varType(p)));
  }

  /** The type of an expression as a declaration writes it (`INT`, `STRING(80)`, `FB_Valve`); undefined when unknown. */
  typeOf(e: A.Expr): string | undefined {
    switch (e.kind) {
      case 'Paren':
        return this.typeOf(e.expr);
      case 'Literal':
        return literalType(e);
      case 'Unary':
        if (e.op !== 'NOT' && e.operand.kind === 'Literal') return literalType(e.operand, e.op === '-');
        return this.typeOf(e.operand);
      case 'Binary': {
        if (COMPARISON.has(e.op)) return 'BOOL';
        const l = this.typeOf(e.left);
        const r = this.typeOf(e.right);
        // A number takes the type of what it is computed with: nCount + 1 is an INT, whatever 1 alone is.
        return l === undefined || (isNumber(e.left) && r !== undefined) ? r : l;
      }
      default: {
        const declared = this.declaredSpec(e);
        const text = declared && specText(declared.text, declared.spec);
        return text || this.declarable(this.analyzer.expr(e));
      }
    }
  }

  /** The symbol a name or member stands for. */
  private symbolOf(e: A.Expr): Sym | undefined {
    if (e.kind === 'Ident') return this.analyzer.lookupName(e)?.sym;
    if (e.kind !== 'Member') return undefined;
    const t = deref(this.analyzer.expr(e.object));
    return t.k === 'unknown' ? undefined : this.analyzer.memberOf(t, e.member.upper)?.sym;
  }

  /** The declared type of an expression, when it is a variable, property, function or method of the workspace (or part of one). */
  private declaredSpec(e: A.Expr): { spec: A.TypeSpec; text: string } | undefined {
    switch (e.kind) {
      case 'Paren':
        return this.declaredSpec(e.expr);
      case 'Ident':
      case 'Member': {
        const s = this.symbolOf(e);
        if (s?.kind === 'var') return this.specIn(s, s.typeSpec);
        if (s?.kind === 'property' || s?.kind === 'method' || (s?.kind === 'pou' && s.pouKind === 'FUN')) return this.specIn(s, s.returnType);
        return undefined;
      }
      case 'Call': {
        const s = this.symbolOf(e.callee);
        return s?.kind === 'method' || (s?.kind === 'pou' && s.pouKind === 'FUN') ? this.specIn(s, s.returnType) : undefined;
      }
      case 'Index': {
        const d = this.declaredSpec(e.object);
        return d?.spec.kind === 'ArrayType' && d.spec.dims.length === e.indices.length ? { spec: d.spec.of, text: d.text } : undefined;
      }
      case 'Deref': {
        const d = this.declaredSpec(e.object);
        return d && (d.spec.kind === 'PointerType' || d.spec.kind === 'ReferenceType') ? { spec: d.spec.to, text: d.text } : undefined;
      }
      default:
        return undefined;
    }
  }

  /** A type of a symbol's declaration, with the text of that declaration (none for library stubs). */
  private specIn(s: Sym, spec: A.TypeSpec | undefined): { spec: A.TypeSpec; text: string } | undefined {
    const text = spec && s.loc ? this.index.sectionText(s.loc.fileKey, s.loc.sectionKey) : undefined;
    return spec && text !== undefined ? { spec, text } : undefined;
  }

  private declaredText(s: Sym, spec: A.TypeSpec | undefined): string | undefined {
    const d = this.specIn(s, spec);
    return (d && specText(d.text, d.spec)) || undefined;
  }

  /** A type that a variable can be declared with; undefined for generic types (ANY_NUM), arrays and programs. */
  private declarable(t: Ty): string | undefined {
    switch (t.k) {
      case 'elem':
        if (t.name.startsWith('ANY') || t.name.startsWith('__SYSTEM')) return undefined;
        return t.name === 'BIT' ? 'BOOL' : t.name;
      case 'string': return t.wide ? 'WSTRING' : 'STRING';
      case 'pou': return t.sym.pouKind === 'FB' || t.sym.pouKind === 'ITF' ? this.globalName(t.sym) : undefined;
      case 'struct':
      case 'enum':
        return this.globalName(t.sym);
      case 'ptr':
      case 'ref': {
        const to = this.declarable(t.to);
        return to && `${t.k === 'ptr' ? 'POINTER' : 'REFERENCE'} TO ${to}`;
      }
      default:
        return undefined;
    }
  }

  /** The name of a type as the section can write it: its own, or with its library's name when that is another. */
  private globalName(s: GlobalSym): string {
    return this.index.lookupGlobal(this.ctx.scope, s.name.toUpperCase()) === s ? s.name : `${s.scope.name}.${s.name}`;
  }
}

// ------------------------------------------------------------------ unknown names and members

/** An identifier that the analysis does not know, and the type to declare it with. */
export interface UnknownName {
  name: string;
  start: number;
  end: number;
  /** The type its uses in the section give it, else BOOL. */
  type: string;
  /** The type comes from a use, not from want of a better one. */
  fromUse: boolean;
}

function unknownName(uses: Uses, offset: number): UnknownName | undefined {
  const at = uses.names.find(u => u.id.start <= offset && offset <= u.id.end);
  if (!at || uses.analyzer.lookupName(at.id)) return undefined;
  const { id } = at;
  // The use at the offset first, then the others of the same name.
  for (const u of [at, ...uses.names.filter(u => u !== at && u.id.upper === id.upper)]) {
    const type = u.expect();
    if (type && !typeProblem(type)) return { name: id.name, start: id.start, end: id.end, type, fromUse: true };
  }
  return { name: id.name, start: id.start, end: id.end, type: 'BOOL', fromUse: false };
}

/** The unknown identifier at an offset of a section (its start to its end) and the type its uses give. */
export function unknownNameAt(index: LanguageIndex, ctx: SectionContext, text: string, offset: number): UnknownName | undefined {
  return unknownName(new Uses(index, ctx, text), offset);
}

/** A member that a function block, program or interface of the workspace does not have. */
export interface UnknownMember {
  name: string;
  start: number;
  end: number;
  owner: PouSym;
  /** The use calls it, as a method is. */
  called: boolean;
  /** The type its use gives: a method's return type (none for a call that is a statement of its own), a property's type. */
  type?: string;
}

function unknownMember(uses: Uses, offset: number): UnknownMember | undefined {
  const at = uses.members.find(u => u.e.member.start <= offset && offset <= u.e.member.end);
  if (!at) return undefined;
  const t = deref(uses.analyzer.expr(at.e.object));
  if (t.k !== 'pou' || t.sym.pouKind === 'FUN' || isLibrarySym(t.sym) || uses.analyzer.memberOf(t, at.e.member.upper)) return undefined;
  const type = at.call?.statement ? undefined : at.expect();
  const { member } = at.e;
  return { name: member.name, start: member.start, end: member.end, owner: t.sym, called: !!at.call, type: type && !typeProblem(type) ? type : undefined };
}

/** The member at an offset of a section that its function block, program or interface does not have. */
export function unknownMemberAt(index: LanguageIndex, ctx: SectionContext, text: string, offset: number): UnknownMember | undefined {
  return unknownMember(new Uses(index, ctx, text), offset);
}

// ------------------------------------------------------------------ quick fixes and Auto Declare...

/** A quick fix of a problem: declare an unknown name, or add a method or property a member use asks for. */
export type QuickFix =
  | {
    kind: 'declare'; title: string; problem: A.Span; preferred: boolean;
    target: DeclarationTarget; scope: VarScope; variable: NewVariable;
  }
  | {
    kind: 'member'; title: string; problem: A.Span; preferred: boolean;
    member: 'method' | 'property'; name: string; type?: string; owner: PouSym;
  };

/**
 * The quick fixes of problems of a section: an unknown identifier is declared in VAR, VAR_INPUT, VAR_OUTPUT,
 * VAR_IN_OUT or VAR_TEMP of the declaration (those it can have, VAR_GLOBAL in a GVL; see declarationTarget), with
 * the type its uses give (see unknownNameAt); a member that a function block, program or interface of the
 * workspace lacks is added to it as a method or property, the one its use asks for first.
 */
export function quickFixes(index: LanguageIndex, ctx: SectionContext, text: string, problems: readonly Problem[]): QuickFix[] {
  const out: QuickFix[] = [];
  if (problems.length === 0) return out;
  const uses = new Uses(index, ctx, text);
  for (const problem of problems) {
    const name = unknownName(uses, problem.start);
    if (name?.start === problem.start) {
      const target = declarationTarget(index, ctx);
      if (!target || nameProblem(name.name)) continue;
      const of = target.other ? ` of ${target.ctx.object.name}` : '';
      declarationScopes(target.kind).forEach((scope, i) => out.push({
        kind: 'declare', title: `Declare ${name.name} in ${scopeLabel(scope)}${of}`, problem, preferred: i === 0, target, scope,
        variable: { name: name.name, type: name.type },
      }));
      continue;
    }
    const member = unknownMember(uses, problem.start);
    if (member?.start !== problem.start || nameProblem(member.name)) continue;
    const kinds: ('method' | 'property')[] = member.called ? ['method', 'property'] : ['property', 'method'];
    for (const kind of kinds) {
      out.push({
        kind: 'member', title: `Add ${kind} ${member.name} to ${member.owner.name}`, problem, preferred: kind === kinds[0],
        member: kind, name: member.name, owner: member.owner, type: kind === 'property' ? member.type ?? 'BOOL' : member.type,
      });
    }
  }
  return out;
}

/** What Auto Declare... starts with: where the variable goes, the blocks to choose from, and the name and type at the cursor. */
export interface AutoDeclareStart {
  target: DeclarationTarget;
  /** The default first. */
  scopes: VarScope[];
  /** The unknown identifier at the cursor, else empty. */
  name: string;
  /** The type its uses give, else BOOL, as XAE's dialog starts with. */
  type: string;
}

/** What Auto Declare... at an offset of a section starts with; undefined where no variable can be declared. */
export function autoDeclareStart(index: LanguageIndex, ctx: SectionContext, text: string, offset: number): AutoDeclareStart | undefined {
  const target = declarationTarget(index, ctx);
  if (!target) return undefined;
  const unknown = unknownNameAt(index, ctx, text, offset);
  const name = unknown && !nameProblem(unknown.name) ? unknown : undefined;
  return { target, scopes: declarationScopes(target.kind, true), name: name?.name ?? '', type: name?.type ?? 'BOOL' };
}

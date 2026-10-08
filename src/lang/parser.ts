// Error-tolerant recursive descent parser for TwinCAT Structured Text.
// Declarations (POU headers, VAR blocks, TYPE) and bodies (statements) are
// parsed separately, the same way TwinCAT stores them.

import { Tk, Token, Trivia, lex } from './lexer';
import * as A from './ast';

export const RESERVED = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'CONTINUE', 'RETURN', 'JMP',
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'AND_THEN', 'OR_ELSE',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_INST',
  'VAR_EXTERNAL', 'VAR_CONFIG', 'VAR_ACCESS', 'END_VAR', 'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',
  'UNION', 'END_UNION', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'PROGRAM', 'END_PROGRAM', 'FUNCTION',
  'END_FUNCTION', 'METHOD', 'END_METHOD', 'PROPERTY', 'END_PROPERTY', 'INTERFACE', 'END_INTERFACE',
  'END_ACTION', 'EXTENDS', 'IMPLEMENTS', 'ARRAY', 'POINTER', 'REFERENCE', 'AT',
]);

const VAR_SECTIONS = new Set(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP',
  'VAR_STAT', 'VAR_INST', 'VAR_EXTERNAL', 'VAR_CONFIG', 'VAR_ACCESS']);
const VAR_QUALIFIERS = new Set(['CONSTANT', 'RETAIN', 'PERSISTENT', 'NON_RETAIN']);
const POU_KEYWORDS = new Set(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'METHOD', 'PROPERTY', 'INTERFACE', 'ACTION']);
const MODIFIERS = new Set(['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL', 'FINAL', 'ABSTRACT']);
const END_MEMBER = new Set(['END_METHOD', 'END_PROPERTY', 'END_ACTION']);
const END_POU = new Set(['END_FUNCTION_BLOCK', 'END_PROGRAM', 'END_FUNCTION', 'END_INTERFACE']);
const STATEMENT_KEYWORDS = new Set(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'EXIT', 'CONTINUE', 'RETURN', 'JMP',
  'ELSIF', 'ELSE', 'END_IF', 'END_CASE', 'END_FOR', 'END_WHILE', 'UNTIL', 'END_REPEAT']);

export interface DeclParseResult {
  units: A.DeclUnit[];
  errors: A.ParseError[];
  trivia: Trivia[];
}

export interface BodyParseResult {
  body: A.Stmt[];
  errors: A.ParseError[];
  trivia: Trivia[];
}

function mkIdent(t: Token): A.Ident {
  return { kind: 'Ident', name: t.text, upper: t.upper, start: t.start, end: t.end };
}

class Parser {
  pos = 0;
  errors: A.ParseError[] = [];

  constructor(readonly tokens: Token[]) {}

  get tok(): Token {
    return this.tokens[this.pos];
  }

  atEnd(): boolean {
    return this.tokens[this.pos].kind === Tk.EOF;
  }

  peek(k = 1): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)];
  }

  get prevEnd(): number {
    return this.pos > 0 ? this.tokens[this.pos - 1].end : 0;
  }

  next(): Token {
    const t = this.tok;
    if (t.kind !== Tk.EOF) this.pos++;
    return t;
  }

  isKw(word: string, t: Token = this.tok): boolean {
    return t.kind === Tk.Ident && t.upper === word;
  }

  isOp(op: string, t: Token = this.tok): boolean {
    return t.kind === Tk.Op && t.text === op;
  }

  acceptKw(word: string): boolean {
    if (!this.isKw(word)) return false;
    this.next();
    return true;
  }

  acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.next();
    return true;
  }

  expectOp(op: string): boolean {
    if (this.acceptOp(op)) return true;
    this.error(`'${op}' expected`);
    return false;
  }

  expectKw(word: string): boolean {
    if (this.acceptKw(word)) return true;
    this.error(`'${word}' expected`);
    return false;
  }

  error(message: string, t: Token = this.tok): void {
    const last = this.errors[this.errors.length - 1];
    if (last && last.start === t.start) return;
    this.errors.push({ message, start: t.start, end: Math.max(t.end, t.start + 1) });
  }

  isIdentToken(t: Token = this.tok): boolean {
    return t.kind === Tk.Ident && !RESERVED.has(t.upper);
  }

  ident(): A.Ident | undefined {
    const t = this.tok;
    if (this.isIdentToken(t)) {
      this.next();
      return mkIdent(t);
    }
    this.error('Identifier expected');
    return undefined;
  }

  qualName(): A.QualName | undefined {
    const first = this.ident();
    if (!first) return undefined;
    const parts = [first];
    while (this.isOp('.') && this.peek().kind === Tk.Ident) {
      this.next();
      parts.push(mkIdent(this.next()));
    }
    return { parts, start: first.start, end: parts[parts.length - 1].end };
  }

  synchronize(): void {
    while (!this.atEnd()) {
      if (this.acceptOp(';')) return;
      if (this.tok.kind === Tk.Ident && (STATEMENT_KEYWORDS.has(this.tok.upper) || this.tok.upper.startsWith('END_'))) return;
      this.next();
    }
  }

  // ---------------------------------------------------------------- declarations

  parseDeclUnits(): A.DeclUnit[] {
    const units: A.DeclUnit[] = [];
    let current: A.DeclUnit | undefined;
    let currentClosed = false;
    let member: A.DeclUnit | undefined;
    let typesUnit: A.DeclUnit | undefined;
    const newUnit = (header?: A.Header): A.DeclUnit => ({
      header, varBlocks: [], typeDecls: [], members: [], start: header?.start ?? this.tok.start, end: this.tok.end,
    });
    const ensure = (): A.DeclUnit => {
      if (!current || currentClosed) {
        current = newUnit();
        currentClosed = false;
        units.push(current);
      }
      return current;
    };
    while (!this.atEnd()) {
      const t = this.tok;
      const before = this.pos;
      if (t.kind === Tk.Ident && POU_KEYWORDS.has(t.upper)) {
        const header = this.parseHeader();
        const canNest = current?.header && !currentClosed &&
          ['FUNCTION_BLOCK', 'INTERFACE', 'PROGRAM'].includes(current.header.pouKind);
        if ((header.pouKind === 'METHOD' || header.pouKind === 'PROPERTY' || header.pouKind === 'ACTION') && canNest && current) {
          member = newUnit(header);
          current.members.push(member);
        } else {
          current = newUnit(header);
          currentClosed = false;
          member = undefined;
          units.push(current);
        }
      } else if (t.kind === Tk.Ident && VAR_SECTIONS.has(t.upper)) {
        const block = this.parseVarBlock();
        (member ?? ensure()).varBlocks.push(block);
      } else if (this.isKw('TYPE')) {
        const td = this.parseTypeDecl();
        if (td) {
          if (!typesUnit) {
            typesUnit = newUnit();
            units.push(typesUnit);
          }
          typesUnit.typeDecls.push(td);
        }
      } else if (t.kind === Tk.Ident && END_MEMBER.has(t.upper)) {
        this.next();
        this.acceptOp(';');
        member = undefined;
      } else if (t.kind === Tk.Ident && END_POU.has(t.upper)) {
        this.next();
        this.acceptOp(';');
        member = undefined;
        currentClosed = true;
      } else if (this.acceptOp(';')) {
        // stray semicolon
      } else {
        this.error(`Unexpected '${t.text}' in declaration`);
        this.next();
      }
      if (this.pos === before) this.next();
    }
    if (units.length === 0) units.push(newUnit());
    for (const u of units) u.end = this.tok.end;
    return units;
  }

  parseHeader(): A.Header {
    const kw = this.next();
    const header: A.Header = {
      pouKind: kw.upper, modifiers: [], extends: [], implements: [], start: kw.start, end: kw.end,
    };
    while (this.tok.kind === Tk.Ident && MODIFIERS.has(this.tok.upper) && this.isIdentToken(this.peek())) {
      header.modifiers.push(this.next().upper);
    }
    header.name = this.ident();
    for (;;) {
      if (this.acceptOp(':')) {
        header.returnType = this.parseTypeSpec(false);
      } else if (this.acceptKw('EXTENDS')) {
        do {
          const q = this.qualName();
          if (q) header.extends.push(q);
        } while (this.acceptOp(','));
      } else if (this.acceptKw('IMPLEMENTS')) {
        do {
          const q = this.qualName();
          if (q) header.implements.push(q);
        } while (this.acceptOp(','));
      } else {
        break;
      }
    }
    this.acceptOp(';');
    header.end = this.prevEnd;
    return header;
  }

  parseVarBlock(): A.VarBlock {
    const kw = this.next();
    const block: A.VarBlock = { section: kw.upper, qualifiers: [], decls: [], start: kw.start, end: kw.end };
    while (this.tok.kind === Tk.Ident && VAR_QUALIFIERS.has(this.tok.upper)) block.qualifiers.push(this.next().upper);
    while (!this.atEnd() && !this.isKw('END_VAR')) {
      const t = this.tok;
      if (t.kind === Tk.Ident && (VAR_SECTIONS.has(t.upper) || POU_KEYWORDS.has(t.upper) ||
        (t.upper.startsWith('END_') && t.upper !== 'END_VAR'))) {
        break;
      }
      const before = this.pos;
      const decl = this.parseVarDecl();
      if (decl) block.decls.push(decl);
      if (this.pos === before) {
        this.error(`Unexpected '${t.text}'`);
        this.next();
      }
    }
    this.expectKw('END_VAR');
    this.acceptOp(';');
    block.end = this.prevEnd;
    return block;
  }

  parseVarDecl(): A.VarDecl | undefined {
    const start = this.tok.start;
    const names: A.Ident[] = [];
    const first = this.ident();
    if (!first) {
      this.synchronizeDecl();
      return undefined;
    }
    names.push(first);
    while (this.acceptOp(',')) {
      const n = this.ident();
      if (n) names.push(n);
    }
    const decl: A.VarDecl = { names, start, end: first.end };
    if (this.acceptKw('AT')) {
      if (this.tok.kind === Tk.DirectAddress) decl.at = this.next().text;
      else this.error('Direct address expected');
    }
    if (!this.expectOp(':')) {
      this.synchronizeDecl();
      decl.end = this.prevEnd;
      return decl;
    }
    decl.type = this.parseTypeSpec(false);
    if (this.acceptOp(':=')) decl.init = this.parseInitializer();
    if (!this.acceptOp(';')) this.error("';' expected");
    decl.end = this.prevEnd;
    return decl;
  }

  synchronizeDecl(): void {
    while (!this.atEnd()) {
      if (this.acceptOp(';')) return;
      if (this.tok.kind === Tk.Ident && (this.tok.upper.startsWith('END_') || VAR_SECTIONS.has(this.tok.upper))) return;
      this.next();
    }
  }

  parseTypeDecl(): A.TypeDecl | undefined {
    const kw = this.next();
    const name = this.ident();
    if (!name) {
      this.synchronizeDecl();
      return undefined;
    }
    let ext: A.QualName | undefined;
    if (this.acceptKw('EXTENDS')) ext = this.qualName();
    this.expectOp(':');
    const spec = this.parseTypeSpec(true);
    const td: A.TypeDecl = { name, extends: ext, spec, start: kw.start, end: this.prevEnd };
    if (this.acceptOp(':=')) td.init = this.parseInitializer();
    this.acceptOp(';');
    this.expectKw('END_TYPE');
    this.acceptOp(';');
    td.end = this.prevEnd;
    return td;
  }

  parseTypeSpec(allowComplex: boolean): A.TypeSpec {
    const t = this.tok;
    const start = t.start;
    if (this.acceptKw('ARRAY')) {
      const dims: ({ lo: A.Expr; hi: A.Expr } | '*')[] = [];
      this.expectOp('[');
      do {
        if (this.acceptOp('*')) {
          dims.push('*');
        } else {
          const lo = this.parseExpr();
          this.expectOp('..');
          const hi = this.parseExpr();
          dims.push({ lo, hi });
        }
      } while (this.acceptOp(','));
      this.expectOp(']');
      this.expectKw('OF');
      const of = this.parseTypeSpec(false);
      return { kind: 'ArrayType', dims, of, start, end: this.prevEnd };
    }
    if (this.acceptKw('POINTER')) {
      this.expectKw('TO');
      const to = this.parseTypeSpec(false);
      return { kind: 'PointerType', to, start, end: this.prevEnd };
    }
    if (this.acceptKw('REFERENCE')) {
      this.expectKw('TO');
      const to = this.parseTypeSpec(false);
      return { kind: 'ReferenceType', to, start, end: this.prevEnd };
    }
    if (t.kind === Tk.Ident && (t.upper === 'STRING' || t.upper === 'WSTRING')) {
      this.next();
      let length: A.Expr | undefined;
      if (this.acceptOp('(')) {
        length = this.parseExpr();
        this.expectOp(')');
      } else if (this.acceptOp('[')) {
        length = this.parseExpr();
        this.expectOp(']');
      }
      return { kind: 'StringType', wide: t.upper === 'WSTRING', length, start, end: this.prevEnd };
    }
    if (allowComplex && this.isOp('(')) {
      this.next();
      const values: A.EnumValueDecl[] = [];
      while (!this.isOp(')') && !this.atEnd()) {
        const name = this.ident();
        if (!name) {
          this.next();
          continue;
        }
        const v: A.EnumValueDecl = { name, start: name.start, end: name.end };
        if (this.acceptOp(':=')) v.init = this.parseExpr();
        v.end = this.prevEnd;
        values.push(v);
        if (!this.acceptOp(',')) break;
      }
      this.expectOp(')');
      let base: A.TypeSpec | undefined;
      if (this.isIdentToken() || this.isKw('STRING')) base = this.parseTypeSpec(false);
      return { kind: 'EnumType', values, base, start, end: this.prevEnd };
    }
    if (allowComplex && (this.isKw('STRUCT') || this.isKw('UNION'))) {
      const union = this.next().upper === 'UNION';
      const endKw = union ? 'END_UNION' : 'END_STRUCT';
      const fields: A.VarDecl[] = [];
      while (!this.atEnd() && !this.isKw(endKw) && !this.isKw('END_TYPE')) {
        const before = this.pos;
        const f = this.parseVarDecl();
        if (f) fields.push(f);
        if (this.pos === before) this.next();
      }
      this.expectKw(endKw);
      return { kind: 'StructType', union, fields, start, end: this.prevEnd };
    }
    const name = this.qualName();
    if (!name) {
      return { kind: 'NamedType', name: { parts: [], start, end: start }, start, end: start };
    }
    const spec: A.TypeSpec = { kind: 'NamedType', name, start, end: this.prevEnd };
    if (this.isOp('(')) {
      const save = this.pos;
      const saveErrors = this.errors.length;
      this.next();
      const lo = this.parseExpr();
      if (this.acceptOp('..')) {
        const hi = this.parseExpr();
        this.expectOp(')');
        spec.range = { lo, hi };
      } else {
        this.pos = save;
        this.errors.length = saveErrors;
        this.next();
        spec.args = this.parseArgsAfterParen();
      }
      spec.end = this.prevEnd;
    }
    return spec;
  }

  parseInitializer(): A.Expr {
    const start = this.tok.start;
    if (this.acceptOp('[')) {
      const items: A.Expr[] = [];
      if (!this.isOp(']')) {
        do items.push(this.parseInitializer()); while (this.acceptOp(','));
      }
      this.expectOp(']');
      return { kind: 'ArrayInit', items, start, end: this.prevEnd };
    }
    if (this.isOp('(') && this.isIdentToken(this.peek()) && this.isOp(':=', this.peek(2))) {
      this.next();
      const fields: { name: A.Ident; value: A.Expr }[] = [];
      do {
        if (this.isOp(')')) break;
        const name = this.ident();
        if (!name) break;
        this.expectOp(':=');
        fields.push({ name, value: this.parseInitializer() });
      } while (this.acceptOp(','));
      this.expectOp(')');
      return { kind: 'StructInit', fields, start, end: this.prevEnd };
    }
    return this.parseExpr();
  }

  // ---------------------------------------------------------------- statements

  parseStatements(isEnd: (t: Token) => boolean): A.Stmt[] {
    const out: A.Stmt[] = [];
    while (!this.atEnd() && !isEnd(this.tok)) {
      const before = this.pos;
      const s = this.parseStatement();
      if (s) out.push(s);
      if (this.pos === before) {
        this.error(`Unexpected '${this.tok.text}'`);
        this.next();
      }
    }
    return out;
  }

  endsWith(...words: string[]): (t: Token) => boolean {
    return t => t.kind === Tk.Ident && words.includes(t.upper);
  }

  parseStatement(): A.Stmt | undefined {
    const t = this.tok;
    const start = t.start;
    if (this.acceptOp(';')) return { kind: 'Empty', start, end: t.end };
    if (t.kind === Tk.Ident) {
      switch (t.upper) {
        case 'IF': return this.parseIf();
        case 'CASE': return this.parseCase();
        case 'FOR': return this.parseFor();
        case 'WHILE': return this.parseWhile();
        case 'REPEAT': return this.parseRepeat();
        case 'EXIT':
        case 'CONTINUE':
        case 'RETURN':
          this.next();
          this.expectSemicolon();
          return { kind: 'Jump', keyword: t.upper, start, end: this.prevEnd };
        case 'JMP': {
          this.next();
          const label = this.ident();
          this.expectSemicolon();
          return label ? { kind: 'Jmp', label, start, end: this.prevEnd } : undefined;
        }
      }
      if (this.isIdentToken(t) && this.isOp(':', this.peek())) {
        this.next();
        this.next();
        return { kind: 'Label', label: mkIdent(t), start, end: this.prevEnd };
      }
    }
    const errorsBefore = this.errors.length;
    const expr = this.parseExpr();
    if (expr.kind === 'Error') {
      this.synchronize();
      return undefined;
    }
    let stmt: A.Stmt;
    if (this.acceptOp(':=')) {
      const value = this.parseExpr();
      stmt = { kind: 'Assign', target: expr, op: ':=', value, start, end: this.prevEnd };
    } else if (this.tok.kind === Tk.Ident && ['S', 'R', 'REF'].includes(this.tok.upper) &&
      this.isOp('=', this.peek()) && this.peek().start === this.tok.end) {
      const op = this.next().upper + '=';
      this.next();
      const value = this.parseExpr();
      stmt = { kind: 'Assign', target: expr, op, value, start, end: this.prevEnd };
    } else {
      stmt = { kind: 'ExprStmt', expr, start, end: this.prevEnd };
    }
    if (this.errors.length > errorsBefore) {
      this.synchronize();
      stmt.end = this.prevEnd;
      return stmt;
    }
    this.expectSemicolon();
    stmt.end = this.prevEnd;
    return stmt;
  }

  expectSemicolon(): void {
    if (this.acceptOp(';')) return;
    const prev = this.tokens[this.pos - 1];
    this.errors.push({ message: "';' expected", start: prev?.end ?? this.tok.start, end: (prev?.end ?? this.tok.start) + 1 });
  }

  parseIf(): A.Stmt {
    const start = this.next().start;
    const branches: { cond: A.Expr; body: A.Stmt[] }[] = [];
    const cond = this.parseExpr();
    this.expectKw('THEN');
    branches.push({ cond, body: this.parseStatements(this.endsWith('ELSIF', 'ELSE', 'END_IF')) });
    let elseBody: A.Stmt[] | undefined;
    while (this.acceptKw('ELSIF')) {
      const c = this.parseExpr();
      this.expectKw('THEN');
      branches.push({ cond: c, body: this.parseStatements(this.endsWith('ELSIF', 'ELSE', 'END_IF')) });
    }
    if (this.acceptKw('ELSE')) elseBody = this.parseStatements(this.endsWith('END_IF'));
    this.expectKw('END_IF');
    this.acceptOp(';');
    return { kind: 'If', branches, elseBody, start, end: this.prevEnd };
  }

  /** Tries to read `label, label..label :` at the current position without consuming it. */
  peekCaseLabels(): boolean {
    const save = this.pos;
    const saveErrors = this.errors.length;
    const labels = this.tryCaseLabels();
    this.pos = save;
    this.errors.length = saveErrors;
    return labels !== undefined;
  }

  tryCaseLabels(): A.Expr[] | undefined {
    const saveErrors = this.errors.length;
    const labels: A.Expr[] = [];
    do {
      const lo = this.parseExpr();
      if (lo.kind === 'Error' || this.errors.length > saveErrors) return undefined;
      if (this.acceptOp('..')) {
        const hi = this.parseExpr();
        labels.push({ kind: 'Range', lo, hi, start: lo.start, end: hi.end });
      } else {
        labels.push(lo);
      }
    } while (this.acceptOp(','));
    if (!this.isOp(':') || this.errors.length > saveErrors) return undefined;
    this.next();
    return labels;
  }

  parseCase(): A.Stmt {
    const start = this.next().start;
    const expr = this.parseExpr();
    this.expectKw('OF');
    const cases: { labels: A.Expr[]; body: A.Stmt[] }[] = [];
    let elseBody: A.Stmt[] | undefined;
    while (!this.atEnd() && !this.isKw('ELSE') && !this.isKw('END_CASE')) {
      if (this.acceptOp(';')) continue;
      const save = this.pos;
      const saveErrors = this.errors.length;
      const labels = this.tryCaseLabels();
      if (!labels) {
        this.pos = save;
        this.errors.length = saveErrors;
        this.error('Case label expected');
        this.synchronize();
        if (this.pos === save) this.next();
        continue;
      }
      const body: A.Stmt[] = [];
      while (!this.atEnd() && !this.isKw('ELSE') && !this.isKw('END_CASE') && !this.peekCaseLabels()) {
        const before = this.pos;
        const s = this.parseStatement();
        if (s) body.push(s);
        if (this.pos === before) {
          this.error(`Unexpected '${this.tok.text}'`);
          this.next();
        }
      }
      cases.push({ labels, body });
    }
    if (this.acceptKw('ELSE')) elseBody = this.parseStatements(this.endsWith('END_CASE'));
    this.expectKw('END_CASE');
    this.acceptOp(';');
    return { kind: 'Case', expr, cases, elseBody, start, end: this.prevEnd };
  }

  parseFor(): A.Stmt {
    const start = this.next().start;
    const variable = this.ident() ?? { kind: 'Ident', name: '', upper: '', start, end: start };
    this.expectOp(':=');
    const from = this.parseExpr();
    this.expectKw('TO');
    const to = this.parseExpr();
    let by: A.Expr | undefined;
    if (this.acceptKw('BY')) by = this.parseExpr();
    this.expectKw('DO');
    const body = this.parseStatements(this.endsWith('END_FOR'));
    this.expectKw('END_FOR');
    this.acceptOp(';');
    return { kind: 'For', variable, from, to, by, body, start, end: this.prevEnd };
  }

  parseWhile(): A.Stmt {
    const start = this.next().start;
    const cond = this.parseExpr();
    this.expectKw('DO');
    const body = this.parseStatements(this.endsWith('END_WHILE'));
    this.expectKw('END_WHILE');
    this.acceptOp(';');
    return { kind: 'While', cond, body, start, end: this.prevEnd };
  }

  parseRepeat(): A.Stmt {
    const start = this.next().start;
    const body = this.parseStatements(this.endsWith('UNTIL', 'END_REPEAT'));
    this.expectKw('UNTIL');
    const cond = this.parseExpr();
    this.expectKw('END_REPEAT');
    this.acceptOp(';');
    return { kind: 'Repeat', body, cond, start, end: this.prevEnd };
  }

  // ---------------------------------------------------------------- expressions

  parseExpr(): A.Expr {
    return this.parseBinary(0);
  }

  private static readonly LEVELS: string[][] = [
    ['OR', 'OR_ELSE'],
    ['XOR'],
    ['AND', 'AND_THEN', '&'],
    ['=', '<>'],
    ['<', '>', '<=', '>='],
    ['+', '-'],
    ['*', '/', 'MOD'],
    ['**'],
  ];

  binaryOp(level: number): string | undefined {
    const t = this.tok;
    const ops = Parser.LEVELS[level];
    if (t.kind === Tk.Op && ops.includes(t.text)) return t.text;
    if (t.kind === Tk.Ident && ops.includes(t.upper)) return t.upper;
    return undefined;
  }

  parseBinary(level: number): A.Expr {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const op = this.binaryOp(level);
      if (!op) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      left = { kind: 'Binary', op, left, right, start: left.start, end: right.end };
    }
  }

  parseUnary(): A.Expr {
    const t = this.tok;
    if (this.isOp('-') || this.isOp('+') || this.isKw('NOT')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'Unary', op: t.upper, operand, start: t.start, end: operand.end };
    }
    return this.parsePostfix();
  }

  parsePostfix(): A.Expr {
    let e = this.parsePrimary();
    if (e.kind === 'Error') return e;
    for (;;) {
      if (this.acceptOp('(')) {
        const args = this.parseArgsAfterParen();
        e = { kind: 'Call', callee: e, args, start: e.start, end: this.prevEnd };
      } else if (this.acceptOp('[')) {
        const indices: A.Expr[] = [];
        do indices.push(this.parseExpr()); while (this.acceptOp(','));
        this.expectOp(']');
        e = { kind: 'Index', object: e, indices, start: e.start, end: this.prevEnd };
      } else if (this.acceptOp('^')) {
        e = { kind: 'Deref', object: e, start: e.start, end: this.prevEnd };
      } else if (this.isOp('.')) {
        const next = this.peek();
        if (next.kind === Tk.Ident) {
          this.next();
          const member = mkIdent(this.next());
          e = { kind: 'Member', object: e, member, start: e.start, end: member.end };
        } else if (next.kind === Tk.Number) {
          this.next();
          const bit = this.next();
          e = { kind: 'BitAccess', object: e, bit: bit.text, start: e.start, end: bit.end };
        } else {
          this.next();
          this.error('Member name expected');
          return e;
        }
      } else {
        return e;
      }
    }
  }

  parseArgsAfterParen(): A.Arg[] {
    const args: A.Arg[] = [];
    if (this.acceptOp(')')) return args;
    do {
      const start = this.tok.start;
      let negated = false;
      let save = this.pos;
      if (this.isKw('NOT') && this.isIdentToken(this.peek()) && this.isOp('=>', this.peek(2))) {
        negated = true;
        this.next();
        save = this.pos;
      }
      if (this.isIdentToken() && (this.isOp(':=', this.peek()) || this.isOp('=>', this.peek()))) {
        const name = mkIdent(this.next());
        const op = this.next().text as ':=' | '=>';
        let value: A.Expr | undefined;
        if (!(op === '=>' && (this.isOp(',') || this.isOp(')')))) value = this.parseExpr();
        args.push({ name, op, negated, value, start, end: this.prevEnd });
      } else {
        this.pos = save;
        const value = this.parseExpr();
        args.push({ value, start, end: this.prevEnd });
        if (value.kind === 'Error') break;
      }
    } while (this.acceptOp(','));
    this.expectOp(')');
    return args;
  }

  parsePrimary(): A.Expr {
    const t = this.tok;
    switch (t.kind) {
      case Tk.Number:
        this.next();
        return { kind: 'Literal', litType: /[.eE]/.test(t.text) && !t.text.includes('#') ? 'real' : 'int', text: t.text, start: t.start, end: t.end };
      case Tk.String:
        this.next();
        return { kind: 'Literal', litType: 'string', text: t.text, start: t.start, end: t.end };
      case Tk.WString:
        this.next();
        return { kind: 'Literal', litType: 'wstring', text: t.text, start: t.start, end: t.end };
      case Tk.TypedLiteral: {
        this.next();
        const prefix: A.Ident = { kind: 'Ident', name: t.prefix!, upper: t.prefix!.toUpperCase(), start: t.start, end: t.prefixEnd! };
        const value = t.value ?? '';
        const lit: A.Expr = { kind: 'TypedLiteral', prefix, value, start: t.start, end: t.end };
        if (/^[A-Za-z_]\w*$/.test(value)) {
          lit.valueIdent = { kind: 'Ident', name: value, upper: value.toUpperCase(), start: t.prefixEnd! + 1, end: t.end };
        }
        return lit;
      }
      case Tk.DirectAddress:
        this.next();
        return { kind: 'Literal', litType: 'int', text: t.text, start: t.start, end: t.end };
      case Tk.Ident:
        if (t.upper === 'TRUE' || t.upper === 'FALSE') {
          this.next();
          return { kind: 'Literal', litType: 'bool', text: t.text, start: t.start, end: t.end };
        }
        if (RESERVED.has(t.upper)) {
          this.error(`Unexpected keyword '${t.text}'`);
          return { kind: 'Error', start: t.start, end: t.end };
        }
        this.next();
        return mkIdent(t);
      case Tk.Op:
        if (t.text === '(') {
          this.next();
          const inner = this.parseExpr();
          this.expectOp(')');
          return { kind: 'Paren', expr: inner, start: t.start, end: this.prevEnd };
        }
        if (t.text === '[') return this.parseInitializer();
        break;
    }
    this.error(this.atEnd() ? 'Unexpected end of text' : `Unexpected '${t.text}'`);
    return { kind: 'Error', start: t.start, end: t.end };
  }
}

export function parseDeclaration(text: string): DeclParseResult {
  const { tokens, trivia, errors } = lex(text);
  const p = new Parser(tokens);
  const units = p.parseDeclUnits();
  return { units, errors: [...errors, ...p.errors], trivia };
}

export function parseBody(text: string): BodyParseResult {
  const { tokens, trivia, errors } = lex(text);
  const p = new Parser(tokens);
  const body = p.parseStatements(() => false);
  return { body, errors: [...errors, ...p.errors], trivia };
}

/** Parses a standalone expression (used for completion on `a.b.`). */
export function parseExpression(text: string): A.Expr | undefined {
  const { tokens } = lex(text);
  const p = new Parser(tokens);
  const e = p.parseExpr();
  return p.errors.length === 0 && p.tok.kind === Tk.EOF ? e : undefined;
}

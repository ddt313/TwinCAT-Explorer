// Name, member and type resolution for one Structured Text section.
// Produces the occurrences (which symbol each identifier refers to) used by
// go-to-definition, hover, references, and the problems used by diagnostics.

import * as A from './ast';
import { LanguageIndex, SectionContext } from './index';
import { parseExpression } from './parser';
import {
  BOOL, GlobalSym, MemberSym, NamespaceSym, PouSym, Scope, Sym, Ty, TypeSym, UNKNOWN, VarSym, elem, isLibrarySym,
} from './symbols';
import { ELEMENTARY, TIME_LITERAL_TYPES } from './builtins';

export interface Occurrence {
  start: number;
  end: number;
  sym: Sym;
  decl: boolean;
  role: 'name' | 'member' | 'type' | 'arg';
}

export interface Problem {
  start: number;
  end: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface Analysis {
  ctx: SectionContext;
  text: string;
  occurrences: Occurrence[];
  problems: Problem[];
}

export interface AnalyzeOptions {
  /** Upper-case identifiers never reported as unknown. */
  ignore?: Set<string>;
}

interface Resolved {
  sym: Sym;
  ty: Ty;
}

const PARAM_SECTIONS = new Set(['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT']);
const COMPARISON = new Set(['=', '<>', '<', '>', '<=', '>=']);
const LITERAL_TYPES: Record<A.LiteralType, Ty> = {
  int: elem('DINT'), real: elem('LREAL'), bool: BOOL, string: { k: 'string', wide: false },
  wstring: { k: 'string', wide: true }, time: elem('TIME'), ltime: elem('LTIME'), date: elem('DATE'), tod: elem('TOD'), dt: elem('DT'),
};

export class Analyzer {
  readonly occurrences: Occurrence[] = [];
  readonly problems: Problem[] = [];
  private recording = true;
  private readonly namespaceSyms = new Map<Scope, NamespaceSym>();

  constructor(readonly index: LanguageIndex, readonly ctx: SectionContext, readonly text: string,
    readonly options: AnalyzeOptions = {}) {}

  run(): Analysis {
    if (this.ctx.role === 'decl') {
      const r = this.index.parseDecl(this.text);
      for (const e of r.errors) this.problem(e, e.message);
      for (const unit of r.units) this.declUnit(unit);
    } else {
      const r = this.index.parseBody(this.text);
      for (const e of r.errors) this.problem(e, e.message);
      this.stmts(r.body);
    }
    this.occurrences.sort((a, b) => a.start - b.start);
    return { ctx: this.ctx, text: this.text, occurrences: this.occurrences, problems: this.problems };
  }

  // ------------------------------------------------------------------ recording

  private occ(span: A.Span, sym: Sym, role: Occurrence['role'], decl = false): void {
    if (this.recording) this.occurrences.push({ start: span.start, end: span.end, sym, decl, role });
  }

  private problem(span: A.Span, message: string, severity: Problem['severity'] = 'error'): void {
    if (this.recording) this.problems.push({ start: span.start, end: Math.max(span.end, span.start + 1), message, severity });
  }

  private unknown(id: A.Ident, message: string): void {
    if (this.options.ignore?.has(id.upper)) return;
    this.problem(id, message);
  }

  // ------------------------------------------------------------------ types

  resolveTypeSpec(spec: A.TypeSpec | undefined, scope: Scope, depth = 0): Ty {
    if (!spec || depth > 20) return UNKNOWN;
    switch (spec.kind) {
      case 'NamedType': {
        const parts = spec.name.parts;
        if (parts.length === 0) return UNKNOWN;
        if (parts.length === 1 && ELEMENTARY.has(parts[0].upper)) return elem(parts[0].upper);
        const g = this.resolveGlobalName(parts, scope);
        return g ? this.instanceType(g, depth) : UNKNOWN;
      }
      case 'StringType': return { k: 'string', wide: spec.wide };
      case 'ArrayType': return { k: 'array', of: this.resolveTypeSpec(spec.of, scope, depth + 1) };
      case 'PointerType': return { k: 'ptr', to: this.resolveTypeSpec(spec.to, scope, depth + 1) };
      case 'ReferenceType': return { k: 'ref', to: this.resolveTypeSpec(spec.to, scope, depth + 1) };
      default: return UNKNOWN;
    }
  }

  private resolveGlobalName(parts: A.Ident[], scope: Scope): GlobalSym | undefined {
    return this.index.resolveGlobal(parts, scope);
  }

  instanceType(g: GlobalSym, depth = 0): Ty {
    switch (g.kind) {
      case 'pou': return g.pouKind === 'FUN' ? UNKNOWN : { k: 'pou', sym: g };
      case 'type':
        if (g.dutKind === 'enum') return { k: 'enum', sym: g };
        if (g.dutKind === 'alias') return this.resolveTypeSpec(g.aliasSpec, g.scope, depth + 1);
        return { k: 'struct', sym: g };
      case 'gvl': return UNKNOWN;
    }
  }

  varType(v: VarSym): Ty {
    let t = this.index.typeCache.get(v);
    if (!t) {
      t = this.resolveTypeSpec(v.typeSpec, v.scope);
      this.index.typeCache.set(v, t);
    }
    return t;
  }

  /** Type of an expression that names the symbol. */
  symType(s: Sym): Ty {
    switch (s.kind) {
      case 'var': return this.varType(s);
      case 'pou':
        if (s.pouKind === 'PRG') return { k: 'pou', sym: s };
        if (s.pouKind === 'FUN') return { k: 'callable', sym: s };
        return { k: 'typeName', sym: s };
      case 'method':
      case 'action':
      case 'transition':
        return { k: 'callable', sym: s };
      case 'property': {
        let t = this.index.typeCache.get(s);
        if (!t) {
          t = this.resolveTypeSpec(s.returnType, s.scope);
          this.index.typeCache.set(s, t);
        }
        return t;
      }
      case 'type': return { k: 'typeName', sym: s };
      case 'enumValue': return { k: 'enum', sym: s.owner };
      case 'gvl': return { k: 'gvl', sym: s };
      case 'namespace': return { k: 'ns', scope: s.target };
      case 'builtin': return s.value ? s.returns([]) : { k: 'callable', sym: s };
    }
  }

  private deref(t: Ty): Ty {
    let cur = t;
    for (let i = 0; i < 4 && (cur.k === 'ref' || cur.k === 'ptr'); i++) cur = cur.to;
    return cur;
  }

  // ------------------------------------------------------------------ POU members

  basesOf(pou: PouSym): PouSym[] {
    const out: PouSym[] = [];
    for (const q of pou.extendsNames) {
      const g = this.resolveGlobalName(q.parts, pou.scope);
      if (g?.kind === 'pou') out.push(g);
    }
    return out;
  }

  /** True when the POU and all its bases are workspace sources (so a missing member is a real error). */
  private chainComplete(pou: PouSym, depth = 0): boolean {
    if (isLibrarySym(pou) || depth > 20) return false;
    const bases = this.basesOf(pou);
    if (bases.length !== pou.extendsNames.length) return false;
    return bases.every(b => this.chainComplete(b, depth + 1));
  }

  findInPou(pou: PouSym, upper: string, depth = 0): Resolved | undefined {
    if (depth > 20) return undefined;
    for (const v of pou.vars) if (v.name.toUpperCase() === upper) return { sym: v, ty: this.varType(v) };
    for (const m of pou.members) if (m.name.toUpperCase() === upper) return { sym: m, ty: this.symType(m) };
    for (const b of this.basesOf(pou)) {
      const r = this.findInPou(b, upper, depth + 1);
      if (r) return r;
    }
    return undefined;
  }

  private findField(t: TypeSym, upper: string, depth = 0): Resolved | undefined {
    if (depth > 20) return undefined;
    for (const f of t.fields) if (f.name.toUpperCase() === upper) return { sym: f, ty: this.varType(f) };
    if (t.extendsName) {
      const base = this.resolveGlobalName(t.extendsName.parts, t.scope);
      if (base?.kind === 'type') return this.findField(base, upper, depth + 1);
    }
    return undefined;
  }

  private namespaceSym(scope: Scope): NamespaceSym {
    let s = this.namespaceSyms.get(scope);
    if (!s) {
      s = { kind: 'namespace', id: `ns:${scope.name}`, name: scope.name, scope, target: scope, signature: `library ${scope.name}` };
      this.namespaceSyms.set(scope, s);
    }
    return s;
  }

  memberOf(t: Ty, upper: string): Resolved | undefined {
    switch (t.k) {
      case 'pou': return this.findInPou(t.sym, upper);
      case 'struct': return this.findField(t.sym, upper);
      case 'typeName':
        if (t.sym.kind === 'type') {
          const v = t.sym.values.find(x => x.name.toUpperCase() === upper);
          return v ? { sym: v, ty: { k: 'enum', sym: t.sym } } : undefined;
        }
        return this.findInPou(t.sym, upper);
      case 'gvl': {
        const v = t.sym.vars.find(x => x.name.toUpperCase() === upper);
        return v ? { sym: v, ty: this.varType(v) } : undefined;
      }
      case 'ns': {
        // A library namespace also exposes the libraries it references (Modules.T_MaxString).
        const g = this.index.lookupGlobal(t.scope, upper);
        if (g) return { sym: g, ty: this.symType(g) };
        const v = this.index.lookupGvlVar(t.scope, upper);
        if (v) return { sym: v, ty: this.varType(v) };
        const ev = this.index.lookupEnumValue(t.scope, upper);
        if (ev) return { sym: ev, ty: { k: 'enum', sym: ev.owner } };
        const b = this.index.builtins.lookup(upper);
        if (b) return { sym: b, ty: this.symType(b) };
        return undefined;
      }
      default: return undefined;
    }
  }

  /** Whether a missing member of this type is certainly an error. */
  private membersKnown(t: Ty): boolean {
    switch (t.k) {
      case 'pou': return this.chainComplete(t.sym);
      case 'struct': return !isLibrarySym(t.sym) && !t.sym.extendsName;
      case 'typeName': return !isLibrarySym(t.sym) && (t.sym.kind === 'type' ? t.sym.dutKind === 'enum' : this.chainComplete(t.sym));
      case 'gvl': return !isLibrarySym(t.sym);
      case 'ns': return !t.scope.isLibrary;
      default: return false;
    }
  }

  /** All members of a type, for completion. */
  listMembers(t: Ty): Resolved[] {
    const out = new Map<string, Resolved>();
    const add = (r: Resolved) => {
      const k = r.sym.name.toUpperCase();
      if (!out.has(k)) out.set(k, r);
    };
    const addPou = (pou: PouSym, depth: number) => {
      if (depth > 20) return;
      for (const v of pou.vars) {
        if (v.section !== 'VAR_TEMP') add({ sym: v, ty: this.varType(v) });
      }
      for (const m of pou.members) add({ sym: m, ty: this.symType(m) });
      for (const b of this.basesOf(pou)) addPou(b, depth + 1);
    };
    const addFields = (ts: TypeSym, depth: number) => {
      if (depth > 20) return;
      for (const f of ts.fields) add({ sym: f, ty: this.varType(f) });
      if (ts.extendsName) {
        const base = this.resolveGlobalName(ts.extendsName.parts, ts.scope);
        if (base?.kind === 'type') addFields(base, depth + 1);
      }
    };
    switch (t.k) {
      case 'pou': addPou(t.sym, 0); break;
      case 'struct': addFields(t.sym, 0); break;
      case 'typeName':
        if (t.sym.kind === 'type') for (const v of t.sym.values) add({ sym: v, ty: { k: 'enum', sym: t.sym } });
        else addPou(t.sym, 0);
        break;
      case 'gvl': for (const v of t.sym.vars) add({ sym: v, ty: this.varType(v) }); break;
      case 'ns':
        for (const g of t.scope.globals.values()) add({ sym: g, ty: this.symType(g) });
        for (const v of t.scope.gvlVars.values()) add({ sym: v, ty: this.varType(v) });
        break;
      default: break;
    }
    return [...out.values()];
  }

  /** Names visible without qualification at this place, for completion. */
  listScope(): Resolved[] {
    const out = new Map<string, Resolved>();
    const add = (s: Sym) => {
      const k = s.name.toUpperCase();
      if (!out.has(k)) out.set(k, { sym: s, ty: this.symType(s) });
    };
    const c = this.ctx;
    if (c.member) {
      const vars = c.accessor === 'Get' ? c.member.getVars : c.accessor === 'Set' ? c.member.setVars : c.member.vars;
      vars.forEach(add);
    }
    if (c.pou) {
      for (const r of this.listMembers({ k: 'pou', sym: c.pou })) add(r.sym);
    }
    const seen = new Set<Scope>();
    const visit = (s: Scope) => {
      if (seen.has(s)) return;
      seen.add(s);
      s.globals.forEach(add);
      s.gvlVars.forEach(add);
      s.enumValues.forEach(add);
      s.refs.forEach(visit);
    };
    visit(c.scope);
    return [...out.values()];
  }

  // ------------------------------------------------------------------ names

  lookupName(id: A.Ident, expected?: Ty): Resolved | undefined {
    const upper = id.upper;
    const c = this.ctx;
    if (upper === 'THIS' && c.pou) return { sym: c.pou, ty: { k: 'ptr', to: { k: 'pou', sym: c.pou } } };
    if (upper === 'SUPER' && c.pou) {
      const base = this.basesOf(c.pou)[0];
      if (base) return { sym: base, ty: { k: 'ptr', to: { k: 'pou', sym: base } } };
    }
    const exp = expected ? this.deref(expected) : undefined;
    if (exp?.k === 'enum') {
      const v = exp.sym.values.find(x => x.name.toUpperCase() === upper);
      if (v) return { sym: v, ty: exp };
    }
    if (c.member) {
      const vars = c.accessor === 'Get' ? c.member.getVars : c.accessor === 'Set' ? c.member.setVars : c.member.vars;
      for (const v of vars) if (v.name.toUpperCase() === upper) return { sym: v, ty: this.varType(v) };
      if (c.member.name.toUpperCase() === upper) {
        const ty = c.member.kind === 'property' ? this.symType(c.member) : this.resolveTypeSpec(c.member.returnType, c.member.scope);
        return { sym: c.member, ty };
      }
    }
    if (c.pou) {
      if (c.pou.pouKind === 'FUN' && c.pou.name.toUpperCase() === upper) {
        return { sym: c.pou, ty: this.resolveTypeSpec(c.pou.returnType, c.pou.scope) };
      }
      const r = this.findInPou(c.pou, upper);
      if (r) return r;
    }
    if (c.gvl) {
      const v = c.gvl.vars.find(x => x.name.toUpperCase() === upper);
      if (v) return { sym: v, ty: this.varType(v) };
    }
    for (const t of c.types) {
      const v = t.values.find(x => x.name.toUpperCase() === upper);
      if (v) return { sym: v, ty: { k: 'enum', sym: t } };
    }
    const g = this.index.lookupGlobal(c.scope, upper);
    if (g) return { sym: g, ty: this.symType(g) };
    const gv = this.index.lookupGvlVar(c.scope, upper);
    if (gv) return { sym: gv, ty: this.varType(gv) };
    const ev = this.index.lookupEnumValue(c.scope, upper);
    if (ev) return { sym: ev, ty: { k: 'enum', sym: ev.owner } };
    const ns = this.index.lookupNamespace(c.scope, upper);
    if (ns) {
      const s = this.namespaceSym(ns);
      return { sym: s, ty: { k: 'ns', scope: ns } };
    }
    const b = this.index.builtins.lookup(upper);
    if (b) return { sym: b, ty: this.symType(b) };
    return undefined;
  }

  // ------------------------------------------------------------------ declarations

  /** Symbol declared at this identifier; the name must match because the text may be another version (diff history). */
  private declared(id: A.Ident): Sym | undefined {
    const s = this.index.declaredAt(this.ctx.fileKey, this.ctx.sectionKey, id.start);
    return s && s.name.toUpperCase() === id.upper ? s : undefined;
  }

  private declUnit(unit: A.DeclUnit): void {
    const h = unit.header;
    if (h) {
      if (h.name) {
        const s = this.declared(h.name);
        if (s) this.occ(h.name, s, 'name', true);
      }
      for (const q of [...h.extends, ...h.implements]) this.typeName(q);
      if (h.returnType) this.typeSpec(h.returnType);
    }
    for (const block of unit.varBlocks) {
      for (const decl of block.decls) this.varDecl(decl);
    }
    for (const td of unit.typeDecls) this.typeDecl(td);
  }

  private varDecl(decl: A.VarDecl): void {
    for (const n of decl.names) {
      const s = this.declared(n);
      if (s) this.occ(n, s, 'name', true);
    }
    const ty = decl.type ? this.typeSpec(decl.type) : UNKNOWN;
    if (decl.init) this.expr(decl.init, ty);
  }

  private typeDecl(td: A.TypeDecl): void {
    const s = this.declared(td.name);
    if (s) this.occ(td.name, s, 'name', true);
    if (td.extends) this.typeName(td.extends);
    const spec = td.spec;
    let ty: Ty = UNKNOWN;
    if (spec.kind === 'EnumType') {
      if (s?.kind === 'type') ty = { k: 'enum', sym: s };
      for (const v of spec.values) {
        const vs = this.declared(v.name);
        if (vs) this.occ(v.name, vs, 'name', true);
        if (v.init) this.expr(v.init, ty);
      }
      if (spec.base) this.typeSpec(spec.base);
    } else if (spec.kind === 'StructType') {
      for (const f of spec.fields) this.varDecl(f);
    } else {
      ty = this.typeSpec(spec);
    }
    if (td.init) this.expr(td.init, ty);
  }

  private typeSpec(spec: A.TypeSpec): Ty {
    switch (spec.kind) {
      case 'NamedType': {
        const ty = this.typeName(spec.name);
        if (spec.range) {
          this.expr(spec.range.lo);
          this.expr(spec.range.hi);
        }
        if (spec.args) {
          // Arguments of FB_init.
          const fbInit = ty.k === 'pou' ? this.findInPou(ty.sym, 'FB_INIT') : undefined;
          const params = fbInit && fbInit.sym.kind === 'method'
            ? fbInit.sym.vars.filter(v => PARAM_SECTIONS.has(v.section) && !['BINITRETAINS', 'BINCOPYCODE'].includes(v.name.toUpperCase()))
            : undefined;
          this.args(spec.args, params, false);
        }
        return ty;
      }
      case 'StringType':
        if (spec.length) this.expr(spec.length);
        return { k: 'string', wide: spec.wide };
      case 'ArrayType':
        for (const d of spec.dims) {
          if (d !== '*') {
            this.expr(d.lo);
            this.expr(d.hi);
          }
        }
        return { k: 'array', of: this.typeSpec(spec.of) };
      case 'PointerType': return { k: 'ptr', to: this.typeSpec(spec.to) };
      case 'ReferenceType': return { k: 'ref', to: this.typeSpec(spec.to) };
      default: return UNKNOWN;
    }
  }

  private typeName(q: A.QualName): Ty {
    const parts = q.parts;
    if (parts.length === 0) return UNKNOWN;
    if (parts.length === 1 && ELEMENTARY.has(parts[0].upper)) return elem(parts[0].upper);
    if (parts.length > 1) {
      const ns = this.index.lookupNamespace(this.ctx.scope, parts[0].upper);
      if (ns) this.occ(parts[0], this.namespaceSym(ns), 'type');
      const g = this.index.lookupGlobal(ns ?? this.ctx.scope, parts[parts.length - 1].upper);
      if (g) {
        this.occ(parts[parts.length - 1], g, 'type');
        return this.instanceType(g);
      }
      if (!ns || !ns.isLibrary) this.unknown(parts[parts.length - 1], `Unknown type '${q.parts.map(p => p.name).join('.')}'`);
      return UNKNOWN;
    }
    const g = this.index.lookupGlobal(this.ctx.scope, parts[0].upper);
    if (g) {
      this.occ(parts[0], g, 'type');
      return this.instanceType(g);
    }
    this.unknown(parts[0], `Unknown type '${parts[0].name}'`);
    return UNKNOWN;
  }

  // ------------------------------------------------------------------ statements

  private stmts(list: A.Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: A.Stmt): void {
    switch (s.kind) {
      case 'Assign': {
        const t = this.expr(s.target);
        this.expr(s.value, t);
        break;
      }
      case 'ExprStmt':
        this.expr(s.expr);
        break;
      case 'If':
        for (const b of s.branches) {
          this.expr(b.cond, BOOL);
          this.stmts(b.body);
        }
        if (s.elseBody) this.stmts(s.elseBody);
        break;
      case 'Case': {
        const t = this.expr(s.expr);
        for (const c of s.cases) {
          for (const l of c.labels) this.expr(l, t);
          this.stmts(c.body);
        }
        if (s.elseBody) this.stmts(s.elseBody);
        break;
      }
      case 'For': {
        const t = this.expr(s.variable);
        this.expr(s.from, t);
        this.expr(s.to, t);
        if (s.by) this.expr(s.by, t);
        this.stmts(s.body);
        break;
      }
      case 'While':
        this.expr(s.cond, BOOL);
        this.stmts(s.body);
        break;
      case 'Repeat':
        this.stmts(s.body);
        this.expr(s.cond, BOOL);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ expressions

  expr(e: A.Expr, expected?: Ty): Ty {
    switch (e.kind) {
      case 'Ident': {
        const r = this.lookupName(e, expected);
        if (!r) {
          this.unknown(e, `Unknown identifier '${e.name}'`);
          return UNKNOWN;
        }
        this.occ(e, r.sym, 'name');
        return r.ty;
      }
      case 'Member': {
        const objTy = this.deref(this.expr(e.object));
        if (objTy.k === 'unknown') return UNKNOWN;
        const r = this.memberOf(objTy, e.member.upper);
        if (!r) {
          if (this.membersKnown(objTy)) this.unknown(e.member, `'${e.member.name}' is not a member of ${describeTy(objTy)}`);
          return UNKNOWN;
        }
        this.occ(e.member, r.sym, 'member');
        return r.ty;
      }
      case 'BitAccess':
        this.expr(e.object);
        return BOOL;
      case 'Index': {
        const t = this.deref(this.expr(e.object));
        for (const i of e.indices) this.expr(i);
        if (t.k === 'array') return t.of;
        if (t.k === 'string') return elem('BYTE');
        return UNKNOWN;
      }
      case 'Deref': {
        const t = this.expr(e.object);
        return t.k === 'ptr' || t.k === 'ref' ? t.to : UNKNOWN;
      }
      case 'Call': return this.call(e);
      case 'Unary': return this.expr(e.operand, expected);
      case 'Binary': {
        const l = this.expr(e.left);
        const r = this.expr(e.right, l);
        if (COMPARISON.has(e.op)) return BOOL;
        return l.k === 'unknown' ? r : l;
      }
      case 'Literal': return LITERAL_TYPES[e.litType];
      case 'TypedLiteral': return this.typedLiteral(e);
      case 'Paren': return this.expr(e.expr, expected);
      case 'ArrayInit': {
        const of = expected && this.deref(expected).k === 'array' ? (this.deref(expected) as { k: 'array'; of: Ty }).of : undefined;
        for (const item of e.items) this.expr(item, of);
        return expected ?? UNKNOWN;
      }
      case 'StructInit': {
        const t = expected ? this.deref(expected) : UNKNOWN;
        for (const f of e.fields) {
          const r = t.k !== 'unknown' ? this.memberOf(t, f.name.upper) : undefined;
          if (r) this.occ(f.name, r.sym, 'member');
          else if (this.membersKnown(t)) this.unknown(f.name, `'${f.name.name}' is not a member of ${describeTy(t)}`);
          this.expr(f.value, r?.ty);
        }
        return t;
      }
      case 'Range':
        this.expr(e.lo, expected);
        this.expr(e.hi, expected);
        return expected ?? UNKNOWN;
      case 'Error':
        return UNKNOWN;
    }
  }

  private typedLiteral(e: A.Expr & { kind: 'TypedLiteral' }): Ty {
    const u = e.prefix.upper;
    if (TIME_LITERAL_TYPES[u]) return elem(TIME_LITERAL_TYPES[u]);
    if (ELEMENTARY.has(u)) return elem(u);
    if (u === 'STRING' || u === 'WSTRING') return { k: 'string', wide: u === 'WSTRING' };
    const g = this.index.lookupGlobal(this.ctx.scope, u);
    if (!g) {
      this.unknown(e.prefix, `Unknown type '${e.prefix.name}'`);
      return UNKNOWN;
    }
    this.occ(e.prefix, g, 'type');
    if (g.kind === 'type' && g.dutKind === 'enum' && e.valueIdent) {
      const v = g.values.find(x => x.name.toUpperCase() === e.valueIdent!.upper);
      if (v) this.occ(e.valueIdent, v, 'member');
      else if (!isLibrarySym(g)) this.unknown(e.valueIdent, `'${e.valueIdent.name}' is not a value of ${g.name}`);
    }
    return this.instanceType(g);
  }

  private call(e: A.Expr & { kind: 'Call' }): Ty {
    const calleeTy = this.expr(e.callee);
    const t = this.deref(calleeTy);
    if (t.k === 'callable') {
      const s = t.sym;
      if (s.kind === 'builtin') {
        const argTys = e.args.map(a => (a.value ? this.expr(a.value) : UNKNOWN));
        return s.returns(argTys);
      }
      if (s.kind === 'pou') {
        this.args(e.args, s.vars.filter(v => PARAM_SECTIONS.has(v.section)), !isLibrarySym(s));
        return this.resolveTypeSpec(s.returnType, s.scope);
      }
      const m = s as MemberSym;
      if (m.kind === 'action') {
        // An action takes the inputs and outputs of its POU: fbValve.A_Close(bForce := TRUE).
        this.args(e.args, this.instanceParams(m.owner), this.chainComplete(m.owner));
        return UNKNOWN;
      }
      this.args(e.args, m.vars.filter(v => PARAM_SECTIONS.has(v.section)), !isLibrarySym(m));
      return this.resolveTypeSpec(m.returnType, m.scope);
    }
    if (t.k === 'pou') {
      // Function block instance call: fbTimer(IN := x, PT := T#1s).
      this.args(e.args, this.instanceParams(t.sym), this.chainComplete(t.sym));
      return UNKNOWN;
    }
    this.args(e.args, undefined, false);
    return UNKNOWN;
  }

  /** Inputs, outputs and in-outs of a function block or program, inherited ones included. */
  private instanceParams(pou: PouSym): VarSym[] {
    return this.listMembers({ k: 'pou', sym: pou }).map(r => r.sym).filter((v): v is VarSym => v.kind === 'var' && PARAM_SECTIONS.has(v.section));
  }

  private args(args: A.Arg[], params: VarSym[] | undefined, complete: boolean): void {
    const positional = params?.filter(p => p.section === 'VAR_INPUT' || p.section === 'VAR_IN_OUT');
    args.forEach((a, i) => {
      let p: VarSym | undefined;
      if (a.name) {
        p = params?.find(x => x.name.toUpperCase() === a.name!.upper);
        if (p) this.occ(a.name, p, 'arg');
        else if (complete) this.unknown(a.name, `Unknown parameter '${a.name.name}'`);
      } else {
        p = positional?.[i];
      }
      if (a.value) this.expr(a.value, p ? this.varType(p) : undefined);
    });
  }

  /** Type of a standalone expression (for completion after a dot), without recording anything. */
  typeOfText(exprText: string): Ty {
    const e = parseExpression(exprText);
    if (!e) return UNKNOWN;
    const saved = this.recording;
    this.recording = false;
    try {
      return this.expr(e);
    } finally {
      this.recording = saved;
    }
  }
}

export function describeTy(t: Ty): string {
  switch (t.k) {
    case 'pou': return t.sym.name;
    case 'struct':
    case 'enum':
      return t.sym.name;
    case 'typeName': return t.sym.name;
    case 'gvl': return t.sym.name;
    case 'ns': return t.scope.name;
    default: return 'this type';
  }
}

export function analyze(index: LanguageIndex, ctx: SectionContext, text: string, options?: AnalyzeOptions): Analysis {
  return new Analyzer(index, ctx, text, options).run();
}

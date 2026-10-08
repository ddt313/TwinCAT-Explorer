// Symbol index over all PLC projects of the workspace plus library stubs.
// Each PLC project and each stub library is a Scope; projects see the scopes
// of the libraries (or workspace PLC projects) they reference.

import * as A from './ast';
import { Trivia } from './lexer';
import { DeclParseResult, BodyParseResult, parseDeclaration, parseBody } from './parser';
import {
  GlobalSym, GvlSym, MemberSym, PouSym, Scope, Sym, TypeSym, VarSym, EnumValueSym, Loc, MemberKind, PouKindSym,
} from './symbols';
import { Builtins } from './builtins';
import { TcWorkspace, SourceEntry, fileKey } from '../core/workspace';
import { ObjectKind, Section, TcObject, TcSourceFile } from '../core/tcfile';
import { PlcProject, resolutionLibraryName } from '../core/project';

export interface SectionContext {
  fileKey: string;
  filePath: string;
  sectionKey: string;
  label: string;
  role: 'decl' | 'impl';
  scope: Scope;
  object: { id: string; kind: ObjectKind; name: string; qualifiedName: string };
  pou?: PouSym;
  member?: MemberSym;
  accessor?: 'Get' | 'Set';
  types: TypeSym[];
  gvl?: GvlSym;
}

interface FileSyms {
  key: string;
  path: string;
  scope: Scope;
  pous: PouSym[];
  types: TypeSym[];
  gvls: GvlSym[];
  contexts: Map<string, SectionContext>;
  /** Declared symbols by `<sectionKey>:<name start offset>`. */
  decls: Map<string, Sym>;
  texts: Map<string, string>;
}

export interface StubSource {
  path: string;
  text: string;
}

/** Comments right before a declaration and on the same line after it. */
export function docComment(text: string, trivia: Trivia[], span: A.Span): string | undefined {
  const parts: string[] = [];
  let cursor = span.start;
  for (let i = trivia.length - 1; i >= 0; i--) {
    const t = trivia[i];
    if (t.kind !== 'comment' || t.end > cursor) continue;
    const between = text.slice(t.end, cursor);
    if (!/^\s*$/.test(between) || (between.match(/\n/g)?.length ?? 0) > 1) break;
    // A comment that ends a previous code line belongs to that line, not to us.
    const lineStart = text.lastIndexOf('\n', t.start - 1) + 1;
    if (text.slice(lineStart, t.start).trim().length > 0) break;
    parts.unshift(t.text);
    cursor = t.start;
  }
  const lineEnd = text.indexOf('\n', span.end);
  const trailing = trivia.find(t => t.kind === 'comment' && t.start >= span.end && (lineEnd < 0 || t.start < lineEnd));
  if (trailing) parts.push(trailing.text);
  if (parts.length === 0) return undefined;
  return parts.map(cleanComment).join('\n').trim() || undefined;
}

function cleanComment(c: string): string {
  if (c.startsWith('//')) return c.slice(2).trim();
  if (c.startsWith('(*')) return c.slice(2, -2).trim();
  if (c.startsWith('/*')) return c.slice(2, -2).trim();
  return c;
}

function hasAttribute(trivia: Trivia[], name: string, before = Number.MAX_SAFE_INTEGER): boolean {
  const re = new RegExp(`\\{\\s*attribute\\s+'${name}'`, 'i');
  return trivia.some(t => t.kind === 'pragma' && t.start < before && re.test(t.text));
}

const POU_KIND: Record<string, PouKindSym> = {
  FUNCTION_BLOCK: 'FB', PROGRAM: 'PRG', FUNCTION: 'FUN', INTERFACE: 'ITF',
};

export class LanguageIndex {
  readonly builtinScope = new Scope('(built-in)', true);
  readonly builtins = new Builtins(this.builtinScope);
  version = 0;
  private readonly projectScopes = new Map<PlcProject, Scope>();
  private libraryScopes = new Map<string, Scope>();
  private readonly files = new Map<string, FileSyms>();
  private readonly dirty = new Set<string>();
  private allDirty = true;
  private readonly overlays = new Map<string, Map<string, string>>();
  private readonly declCache = new Map<string, DeclParseResult>();
  private readonly bodyCache = new Map<string, BodyParseResult>();
  private stubSources: StubSource[] = [];
  private builtWorkspaceVersion = -1;

  constructor(readonly ws: TcWorkspace) {}

  // ------------------------------------------------------------------ parsing

  parseDecl(text: string): DeclParseResult {
    let r = this.declCache.get(text);
    if (!r) {
      r = parseDeclaration(text);
      if (this.declCache.size > 20000) this.declCache.clear();
      this.declCache.set(text, r);
    }
    return r;
  }

  parseBody(text: string): BodyParseResult {
    let r = this.bodyCache.get(text);
    if (!r) {
      r = parseBody(text);
      if (this.bodyCache.size > 20000) this.bodyCache.clear();
      this.bodyCache.set(text, r);
    }
    return r;
  }

  // ------------------------------------------------------------------ change tracking

  setStubs(sources: StubSource[]): void {
    this.stubSources = sources;
    this.allDirty = true;
  }

  setOverlay(key: string, sectionKey: string, text: string | undefined): void {
    let m = this.overlays.get(key);
    if (text === undefined) {
      if (!m?.delete(sectionKey)) return;
      if (m.size === 0) this.overlays.delete(key);
    } else {
      if (!m) {
        m = new Map();
        this.overlays.set(key, m);
      }
      if (m.get(sectionKey) === text) return;
      m.set(sectionKey, text);
    }
    this.dirty.add(key);
  }

  invalidateFile(path: string): void {
    this.dirty.add(fileKey(path));
  }

  invalidateAll(): void {
    this.allDirty = true;
  }

  // ------------------------------------------------------------------ building

  ensure(): void {
    if (this.builtWorkspaceVersion !== this.ws.version && !this.allDirty) {
      // Projects reloaded or files invalidated in the workspace: re-check everything cheaply.
      this.allDirty = this.projectScopes.size !== this.ws.plcProjects.length ||
        this.ws.plcProjects.some(p => !this.projectScopes.has(p));
      for (const e of this.ws.sourceEntries) this.dirty.add(e.key);
    }
    if (!this.allDirty && this.dirty.size === 0) return;
    if (this.allDirty) {
      this.buildLibraries();
      this.projectScopes.clear();
      for (const p of this.ws.plcProjects) this.projectScopes.set(p, new Scope(p.name, false));
      this.files.clear();
      for (const e of this.ws.sourceEntries) this.dirty.add(e.key);
    }
    const byKey = new Map(this.ws.sourceEntries.map(e => [e.key, e]));
    for (const key of this.dirty) {
      const entry = byKey.get(key);
      if (!entry) {
        this.files.delete(key);
        continue;
      }
      const scope = this.projectScopes.get(entry.project);
      if (!scope) continue;
      this.files.set(key, this.buildFile(entry, scope));
    }
    this.dirty.clear();
    this.allDirty = false;
    this.assembleScopes();
    this.builtWorkspaceVersion = this.ws.version;
    this.version++;
  }

  private buildLibraries(): void {
    this.libraryScopes = new Map();
    for (const src of this.stubSources) {
      const re = /\bLIBRARY\s+([A-Za-z_][\w.]*)([\s\S]*?)\bEND_LIBRARY\b/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src.text))) {
        const name = m[1];
        const scope = this.libraryScopes.get(name.toUpperCase()) ?? new Scope(name, true);
        this.libraryScopes.set(name.toUpperCase(), scope);
        this.addStubDeclarations(scope, m[2], `stub:${src.path}#${name}`);
      }
    }
    // Stubs share the basic types of Tc2_System/Tc2_Standard (T_MaxString, ...).
    const common = ['TC2_SYSTEM', 'TC2_STANDARD'].map(n => this.libraryScopes.get(n)).filter((x): x is Scope => !!x);
    for (const scope of this.libraryScopes.values()) {
      scope.refs = common.filter(c => c !== scope);
    }
  }

  private addStubDeclarations(scope: Scope, text: string, key: string): void {
    const parsed = this.parseDecl(text);
    const fake: FileSyms = {
      key, path: key, scope, pous: [], types: [], gvls: [], contexts: new Map(), decls: new Map(), texts: new Map(),
    };
    for (const unit of parsed.units) {
      if (unit.header && POU_KIND[unit.header.pouKind]) {
        const pou = this.makePou(fake, scope, unit, text, parsed.trivia, undefined, undefined, unit.header.name?.name ?? '?');
        for (const mu of unit.members) {
          if (!mu.header) continue;
          const kind: MemberKind = mu.header.pouKind === 'PROPERTY' ? 'property' : mu.header.pouKind === 'ACTION' ? 'action' : 'method';
          const member = this.makeMember(fake, pou, kind, mu, text, parsed.trivia, undefined, undefined, mu.header.name?.name ?? '?');
          pou.members.push(member);
        }
        this.addGlobal(scope, pou);
      }
      for (const td of unit.typeDecls) {
        this.addGlobal(scope, this.makeType(fake, scope, td, text, parsed.trivia, undefined, undefined));
      }
      if (!unit.header && unit.varBlocks.length > 0) {
        const gvl: GvlSym = {
          kind: 'gvl', id: `${scope.name}::(globals)`, name: scope.name, scope, signature: '', vars: [], qualifiedOnly: false,
        };
        for (const block of unit.varBlocks) {
          for (const decl of block.decls) {
            for (const n of decl.names) {
              const v = this.makeVar(fake, gvl, block, decl, n, text, parsed.trivia, undefined, undefined);
              gvl.vars.push(v);
              scope.gvlVars.set(n.upper, v);
            }
          }
        }
      }
    }
  }

  private addGlobal(scope: Scope, sym: GlobalSym): void {
    const key = sym.name.toUpperCase();
    if (!scope.globals.has(key)) scope.globals.set(key, sym);
  }

  private assembleScopes(): void {
    for (const scope of this.projectScopes.values()) scope.clear();
    for (const f of this.files.values()) {
      for (const p of f.pous) this.addGlobal(f.scope, p);
      for (const t of f.types) this.addGlobal(f.scope, t);
      for (const g of f.gvls) this.addGlobal(f.scope, g);
    }
    for (const scope of this.projectScopes.values()) {
      for (const g of scope.globals.values()) {
        if (g.kind === 'gvl' && !g.qualifiedOnly) {
          for (const v of g.vars) if (!scope.gvlVars.has(v.name.toUpperCase())) scope.gvlVars.set(v.name.toUpperCase(), v);
        }
        if (g.kind === 'type' && g.dutKind === 'enum' && !g.qualifiedOnly) {
          for (const v of g.values) if (!scope.enumValues.has(v.name.toUpperCase())) scope.enumValues.set(v.name.toUpperCase(), v);
        }
      }
    }
    for (const [project, scope] of this.projectScopes) {
      for (const lib of project.libraries) {
        const libName = resolutionLibraryName(lib).toUpperCase();
        const target = this.ws.plcProjects.find(p => p !== project &&
          (p.name.toUpperCase() === libName || p.title?.toUpperCase() === libName || p.name.toUpperCase() === lib.name.toUpperCase()));
        const targetScope = target ? this.projectScopes.get(target) : this.libraryScopes.get(libName) ?? this.libraryScopes.get(lib.name.toUpperCase());
        if (targetScope) {
          scope.refs.push(targetScope);
          scope.namespaces.set(lib.namespace.toUpperCase(), targetScope);
          scope.namespaces.set(lib.name.toUpperCase(), targetScope);
        } else {
          scope.unknownLibraries.push(lib.name);
        }
      }
      // TwinCAT's standard library is always available implicitly through Tc2_Standard
      // in practice; keep the stub visible for projects that reference it indirectly.
      for (const always of ['TC2_STANDARD', 'TC2_SYSTEM', 'TC3_MODULE']) {
        const s = this.libraryScopes.get(always);
        if (s && !scope.refs.includes(s)) scope.refs.push(s);
      }
    }
  }

  private buildFile(entry: SourceEntry, scope: Scope): FileSyms {
    const f: FileSyms = {
      key: entry.key, path: entry.path, scope, pous: [], types: [], gvls: [], contexts: new Map(), decls: new Map(), texts: new Map(),
    };
    const file = this.ws.getFile(entry.path);
    if (!file?.root) return f;
    const overlay = this.overlays.get(entry.key);
    const textOf = (s: Section) => overlay?.get(s.key) ?? s.text;
    for (const s of file.sections.values()) f.texts.set(s.key, textOf(s));
    const root = file.root;
    const ctxBase = (s: Section, obj: TcObject): SectionContext => ({
      fileKey: entry.key, filePath: entry.path, sectionKey: s.key, label: s.label, role: s.role, scope,
      object: { id: obj.id, kind: obj.kind, name: obj.name, qualifiedName: obj.qualifiedName }, types: [],
      accessor: s.accessor,
    });

    if (root.kind === 'pou' || root.kind === 'itf') {
      const declSec = root.sections.find(s => s.role === 'decl');
      const declText = declSec ? textOf(declSec) : '';
      const parsed = this.parseDecl(declText);
      const unit = parsed.units.find(u => u.header) ?? parsed.units[0];
      const pou = this.makePou(f, scope, unit, declText, parsed.trivia, declSec?.key, root, root.name);
      if (root.kind === 'itf') pou.pouKind = 'ITF';
      f.pous.push(pou);
      for (const s of root.sections) f.contexts.set(s.key, { ...ctxBase(s, root), pou });
      for (const m of root.members) {
        const mDecl = m.sections.find(s => s.role === 'decl' && !s.accessor);
        const mText = mDecl ? textOf(mDecl) : '';
        const mParsed = this.parseDecl(mText);
        const mUnit = mParsed.units.find(u => u.header) ?? mParsed.units[0];
        const kind = m.kind as MemberKind;
        const member = this.makeMember(f, pou, kind, mUnit, mText, mParsed.trivia, mDecl?.key, m, m.name);
        for (const acc of m.accessors) {
          const accDecl = acc.sections.find(s => s.role === 'decl');
          if (!accDecl) continue;
          const accText = textOf(accDecl);
          const accParsed = this.parseDecl(accText);
          const target = acc.kind === 'Get' ? member.getVars : member.setVars;
          for (const u of accParsed.units) {
            for (const block of u.varBlocks) {
              for (const decl of block.decls) {
                for (const n of decl.names) {
                  target.push(this.makeVar(f, member, block, decl, n, accText, accParsed.trivia, accDecl.key, acc.kind));
                }
              }
            }
          }
        }
        pou.members.push(member);
        for (const s of m.sections) f.contexts.set(s.key, { ...ctxBase(s, m), pou, member });
      }
    } else if (root.kind === 'dut') {
      const declSec = root.sections.find(s => s.role === 'decl');
      const declText = declSec ? textOf(declSec) : '';
      const parsed = this.parseDecl(declText);
      const types: TypeSym[] = [];
      for (const u of parsed.units) {
        for (const td of u.typeDecls) types.push(this.makeType(f, scope, td, declText, parsed.trivia, declSec?.key, root));
      }
      f.types.push(...types);
      for (const s of root.sections) f.contexts.set(s.key, { ...ctxBase(s, root), types });
    } else if (root.kind === 'gvl') {
      const declSec = root.sections.find(s => s.role === 'decl');
      const declText = declSec ? textOf(declSec) : '';
      const parsed = this.parseDecl(declText);
      const gvl: GvlSym = {
        kind: 'gvl', id: `${scope.name}::${root.name}`, name: root.name, scope, vars: [],
        qualifiedOnly: hasAttribute(parsed.trivia, 'qualified_only'), objectId: root.id,
        signature: `VAR_GLOBAL ${root.name}`, loc: declSec ? { fileKey: entry.key, sectionKey: declSec.key, start: 0, end: 0 } : undefined,
      };
      for (const u of parsed.units) {
        for (const block of u.varBlocks) {
          for (const decl of block.decls) {
            for (const n of decl.names) gvl.vars.push(this.makeVar(f, gvl, block, decl, n, declText, parsed.trivia, declSec?.key));
          }
        }
      }
      f.gvls.push(gvl);
      for (const s of root.sections) f.contexts.set(s.key, { ...ctxBase(s, root), gvl });
    }
    return f;
  }

  private loc(f: FileSyms, sectionKey: string | undefined, span: A.Span | undefined): Loc | undefined {
    if (!sectionKey || !span) return undefined;
    return { fileKey: f.key, sectionKey, start: span.start, end: span.end };
  }

  private register(f: FileSyms, sectionKey: string | undefined, span: A.Span | undefined, sym: Sym): void {
    if (sectionKey && span) f.decls.set(`${sectionKey}:${span.start}`, sym);
  }

  private makePou(f: FileSyms, scope: Scope, unit: A.DeclUnit, text: string, trivia: Trivia[], sectionKey: string | undefined,
    obj: TcObject | undefined, fallbackName: string): PouSym {
    const header = unit.header;
    const name = header?.name?.name ?? fallbackName;
    const pouKind: PouKindSym = (header && POU_KIND[header.pouKind]) ?? (obj?.pouKind ?? 'FB');
    const pou: PouSym = {
      kind: 'pou', pouKind, id: `${scope.name}::${name.toUpperCase()}`, name, scope,
      loc: this.loc(f, sectionKey, header?.name), vars: [], members: [],
      extendsNames: header?.extends ?? [], implementsNames: header?.implements ?? [], returnType: header?.returnType,
      objectId: obj?.id, fileKey: obj ? f.key : undefined,
      signature: header ? text.slice(header.start, header.end).replace(/;\s*$/, '').trim() : name,
      doc: header ? docComment(text, trivia, header) : undefined,
    };
    this.register(f, sectionKey, header?.name, pou);
    for (const block of unit.varBlocks) {
      for (const decl of block.decls) {
        for (const n of decl.names) pou.vars.push(this.makeVar(f, pou, block, decl, n, text, trivia, sectionKey));
      }
    }
    return pou;
  }

  private makeMember(f: FileSyms, pou: PouSym, kind: MemberKind, unit: A.DeclUnit, text: string, trivia: Trivia[],
    sectionKey: string | undefined, obj: TcObject | undefined, fallbackName: string): MemberSym {
    const header = unit?.header;
    const name = header?.name?.name ?? fallbackName;
    const member: MemberSym = {
      kind, id: `${pou.id}.${name.toUpperCase()}`, name, owner: pou, scope: pou.scope, vars: [], getVars: [], setVars: [],
      returnType: header?.returnType, objectId: obj?.id, loc: this.loc(f, sectionKey, header?.name),
      signature: header ? text.slice(header.start, header.end).replace(/;\s*$/, '').trim() : `${kind.toUpperCase()} ${name}`,
      doc: header ? docComment(text, trivia, header) : undefined,
    };
    this.register(f, sectionKey, header?.name, member);
    for (const block of unit?.varBlocks ?? []) {
      for (const decl of block.decls) {
        for (const n of decl.names) member.vars.push(this.makeVar(f, member, block, decl, n, text, trivia, sectionKey));
      }
    }
    const params = member.vars.filter(v => v.section === 'VAR_INPUT' || v.section === 'VAR_OUTPUT' || v.section === 'VAR_IN_OUT');
    if (params.length > 0) {
      member.signature += '\n' + params.map(p => `    ${p.section} ${p.signature}`).join('\n');
    }
    return member;
  }

  private makeVar(f: FileSyms, owner: VarSym['owner'], block: A.VarBlock, decl: A.VarDecl, n: A.Ident, text: string,
    trivia: Trivia[], sectionKey: string | undefined, accessor?: 'Get' | 'Set'): VarSym {
    const typeText = decl.type ? text.slice(decl.type.start, decl.type.end) : '?';
    const init = decl.init ? ` := ${text.slice(decl.init.start, decl.init.end)}` : '';
    const v: VarSym = {
      kind: 'var', id: `${owner.id}#${accessor ? accessor + '.' : ''}${n.upper}`, name: n.name, scope: owner.scope,
      section: block.section, constant: block.qualifiers.includes('CONSTANT'), typeSpec: decl.type, owner, accessor,
      loc: this.loc(f, sectionKey, n), signature: `${n.name} : ${typeText}${init}`, doc: docComment(text, trivia, decl),
    };
    this.register(f, sectionKey, n, v);
    return v;
  }

  private makeType(f: FileSyms, scope: Scope, td: A.TypeDecl, text: string, trivia: Trivia[], sectionKey: string | undefined,
    obj: TcObject | undefined): TypeSym {
    const spec = td.spec;
    const dutKind = spec.kind === 'EnumType' ? 'enum' : spec.kind === 'StructType' ? (spec.union ? 'union' : 'struct') : 'alias';
    const t: TypeSym = {
      kind: 'type', dutKind, id: `${scope.name}::${td.name.upper}`, name: td.name.name, scope, fields: [], values: [],
      qualifiedOnly: hasAttribute(trivia, 'qualified_only', td.start), extendsName: td.extends,
      aliasSpec: spec.kind === 'EnumType' || spec.kind === 'StructType' ? undefined : spec,
      baseSpec: spec.kind === 'EnumType' ? spec.base : undefined, objectId: obj?.id,
      loc: this.loc(f, sectionKey, td.name), signature: '', doc: docComment(text, trivia, td),
    };
    this.register(f, sectionKey, td.name, t);
    if (spec.kind === 'EnumType') {
      for (const v of spec.values) {
        const ev: EnumValueSym = {
          kind: 'enumValue', id: `${t.id}.${v.name.upper}`, name: v.name.name, owner: t, scope,
          loc: this.loc(f, sectionKey, v.name), signature: `${t.name}.${text.slice(v.start, v.end)}`,
          doc: docComment(text, trivia, v),
        };
        this.register(f, sectionKey, v.name, ev);
        t.values.push(ev);
      }
      const shown = t.values.slice(0, 12).map(v => `    ${v.signature.slice(t.name.length + 1)}`).join(',\n');
      t.signature = `TYPE ${t.name} :\n(\n${shown}${t.values.length > 12 ? ',\n    ...' : ''}\n)${spec.base ? ' ' + text.slice(spec.base.start, spec.base.end) : ''}`;
    } else if (spec.kind === 'StructType') {
      const block: A.VarBlock = { section: spec.union ? 'UNION' : 'STRUCT', qualifiers: [], decls: spec.fields, start: spec.start, end: spec.end };
      for (const decl of spec.fields) {
        for (const n of decl.names) t.fields.push(this.makeVar(f, t, block, decl, n, text, trivia, sectionKey));
      }
      const head = `TYPE ${t.name}${td.extends ? ' EXTENDS ' + td.extends.parts.map(p => p.name).join('.') : ''} :`;
      const shown = t.fields.slice(0, 15).map(fl => `    ${fl.signature};`).join('\n');
      t.signature = `${head}\n${spec.union ? 'UNION' : 'STRUCT'}\n${shown}${t.fields.length > 15 ? '\n    ...' : ''}\nEND_${spec.union ? 'UNION' : 'STRUCT'}`;
    } else {
      t.signature = `TYPE ${t.name} : ${text.slice(spec.start, spec.end)}`;
    }
    return t;
  }

  // ------------------------------------------------------------------ queries

  context(key: string, sectionKey: string): SectionContext | undefined {
    this.ensure();
    return this.files.get(key)?.contexts.get(sectionKey);
  }

  /** Current text of a section (unsaved edits included). */
  sectionText(key: string, sectionKey: string): string | undefined {
    this.ensure();
    return this.files.get(key)?.texts.get(sectionKey);
  }

  declaredAt(key: string, sectionKey: string, start: number): Sym | undefined {
    return this.files.get(key)?.decls.get(`${sectionKey}:${start}`);
  }

  allContexts(): SectionContext[] {
    this.ensure();
    const out: SectionContext[] = [];
    for (const f of this.files.values()) out.push(...f.contexts.values());
    return out;
  }

  allGlobals(): GlobalSym[] {
    this.ensure();
    const out: GlobalSym[] = [];
    for (const f of this.files.values()) out.push(...f.pous, ...f.types, ...f.gvls);
    return out;
  }

  libraryScopeNames(): string[] {
    this.ensure();
    return [...this.libraryScopes.values()].map(s => s.name);
  }

  // ------------------------------------------------------------------ lookups

  lookupGlobal(scope: Scope, upper: string, seen = new Set<Scope>()): GlobalSym | undefined {
    if (seen.has(scope)) return undefined;
    seen.add(scope);
    const g = scope.globals.get(upper);
    if (g) return g;
    for (const r of scope.refs) {
      const found = this.lookupGlobal(r, upper, seen);
      if (found) return found;
    }
    return undefined;
  }

  lookupGvlVar(scope: Scope, upper: string, seen = new Set<Scope>()): VarSym | undefined {
    if (seen.has(scope)) return undefined;
    seen.add(scope);
    const v = scope.gvlVars.get(upper);
    if (v) return v;
    for (const r of scope.refs) {
      const found = this.lookupGvlVar(r, upper, seen);
      if (found) return found;
    }
    return undefined;
  }

  lookupEnumValue(scope: Scope, upper: string, seen = new Set<Scope>()): EnumValueSym | undefined {
    if (seen.has(scope)) return undefined;
    seen.add(scope);
    const v = scope.enumValues.get(upper);
    if (v) return v;
    for (const r of scope.refs) {
      const found = this.lookupEnumValue(r, upper, seen);
      if (found) return found;
    }
    return undefined;
  }

  lookupNamespace(scope: Scope, upper: string): Scope | undefined {
    const direct = scope.namespaces.get(upper);
    if (direct) return direct;
    if (scope.name.toUpperCase() === upper) return scope;
    const lib = this.libraryScopes.get(upper);
    if (lib) return lib;
    return undefined;
  }
}

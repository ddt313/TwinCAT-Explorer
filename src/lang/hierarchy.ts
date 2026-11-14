// Inheritance of function blocks and interfaces, as the language index resolves EXTENDS and IMPLEMENTS: what a
// POU extends or implements and what extends or implements it, the methods and properties that go with one in a
// rename (relatedMembers), the methods and properties a function block lacks to implement its interfaces
// (unimplementedMembers), what Go to Implementation lists, and the supertypes and subtypes of the type hierarchy.

import { Analysis } from './analyzer';
import * as A from './ast';
import { LanguageIndex, SectionContext } from './index';
import { MemberSym, PouSym, Scope, Sym, isLibrarySym } from './symbols';

/** The function blocks and interfaces a function block or interface extends or implements, and theirs. */
export function ancestors(index: LanguageIndex, pou: PouSym): Set<PouSym> {
  const out = new Set<PouSym>();
  const visit = (p: PouSym, depth: number) => {
    if (depth > 20) return;
    for (const q of [...p.extendsNames, ...p.implementsNames]) {
      const g = index.resolveGlobal(q.parts, p.scope);
      if (g?.kind !== 'pou' || out.has(g)) continue;
      out.add(g);
      visit(g, depth + 1);
    }
  };
  visit(pou, 0);
  return out;
}

/**
 * The POUs of the workspace that extend or implement a function block or interface, whatever the depth: the
 * function blocks that extend a function block; for an interface, also the interfaces that extend it and the
 * function blocks that implement either.
 */
export function descendants(index: LanguageIndex, pou: PouSym): PouSym[] {
  return index.allGlobals().filter((g): g is PouSym => g.kind === 'pou' && g !== pou && ancestors(index, g).has(pou));
}

/** What a function block lacks to implement its interfaces (see unimplementedMembers). */
export interface Unimplemented {
  /** Each method or property lacking, with the name after IMPLEMENTS it comes through and the interface declaring it. */
  members: { via: A.QualName; from: PouSym; member: MemberSym }[];
  /** The interfaces implemented, those they extend included. */
  interfaces: PouSym[];
  /** Names in IMPLEMENTS or in an interface's EXTENDS that are not interfaces of the workspace or of the library stubs. */
  missing: string[];
  /**
   * Whether the function blocks it is or extends are all found and declared (not known by their names only). When
   * not, a member listed may be one that an unknown base has.
   */
  basesKnown: boolean;
}

/**
 * The methods and properties of the interfaces named after IMPLEMENTS (`implementsNames`, resolved in `scope`) and
 * of those they extend, less the ones named in `own` and those of `bases`, the function blocks it is or extends,
 * and of their bases. A method or property lacking twice (an interface reached through two names) is listed once.
 */
export function unimplementedMembers(index: LanguageIndex, scope: Scope, implementsNames: A.QualName[], bases: PouSym[],
  own: string[]): Unimplemented {
  const out: Unimplemented = { members: [], interfaces: [], missing: [], basesKnown: true };
  const taken = new Set(own.map(n => n.toUpperCase()));
  const pous = new Set<PouSym>();
  const take = (p: PouSym, depth: number) => {
    if (depth > 20 || pous.has(p)) return;
    pous.add(p);
    if (p.namesOnly) out.basesKnown = false;
    for (const m of p.members) taken.add(m.name.toUpperCase());
    for (const q of p.extendsNames) {
      const b = index.resolveGlobal(q.parts, p.scope);
      if (b?.kind === 'pou') take(b, depth + 1);
      else out.basesKnown = false;
    }
  };
  for (const b of bases) take(b, 0);
  const seen = new Set<PouSym>();
  const visit = (via: A.QualName, q: A.QualName, scope: Scope, depth: number) => {
    const itf = index.resolveGlobal(q.parts, scope);
    if (itf?.kind !== 'pou' || itf.pouKind !== 'ITF') {
      const name = q.parts.map(p => p.name).join('.');
      if (!out.missing.includes(name)) out.missing.push(name);
      return;
    }
    if (depth > 20 || seen.has(itf)) return;
    seen.add(itf);
    out.interfaces.push(itf);
    for (const m of itf.members) {
      if ((m.kind !== 'method' && m.kind !== 'property') || taken.has(m.name.toUpperCase())) continue;
      taken.add(m.name.toUpperCase());
      out.members.push({ via, from: itf, member: m });
    }
    for (const e of itf.extendsNames) visit(via, e, itf.scope, depth + 1);
  };
  for (const q of implementsNames) visit(q, q, scope, 0);
  return out;
}

/**
 * The methods or properties that go with one in a rename: those of the same name and kind in the interfaces it
 * implements and the function blocks it overrides, and in the function blocks that implement or override it
 * (whatever the depth), and then those that go with these. `library` holds those of library interfaces and
 * function blocks, which stay as they are.
 */
export function relatedMembers(index: LanguageIndex, target: MemberSym): { members: MemberSym[]; library: MemberSym[] } {
  if (target.kind !== 'method' && target.kind !== 'property') return { members: [], library: [] };
  const pous = index.allGlobals().filter((g): g is PouSym => g.kind === 'pou');
  const above = new Map<PouSym, Set<PouSym>>(pous.map(p => [p, ancestors(index, p)]));
  const upper = target.name.toUpperCase();
  const family = new Set<MemberSym>([target]);
  const queue = [target];
  for (let m = queue.pop(); m; m = queue.pop()) {
    const owner = m.owner;
    const linked = [...(above.get(owner) ?? ancestors(index, owner)), ...pous.filter(p => above.get(p)!.has(owner))];
    for (const p of linked) {
      const same = p.members.find(x => x.kind === target.kind && x.name.toUpperCase() === upper);
      if (!same || family.has(same)) continue;
      family.add(same);
      // A library member says nothing of what else implements it in the workspace.
      if (!isLibrarySym(same)) queue.push(same);
    }
  }
  family.delete(target);
  const all = [...family];
  return { members: all.filter(m => !isLibrarySym(m)), library: all.filter(isLibrarySym) };
}

/** Whether a symbol is a function block or an interface: what has a type hierarchy and implementations. */
export function isHierarchyType(s: Sym): s is PouSym {
  return s.kind === 'pou' && (s.pouKind === 'FB' || s.pouKind === 'ITF');
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** The method or property of a function block of this kind and name: its own, else the nearest of those it extends. */
function memberIn(index: LanguageIndex, pou: PouSym, kind: MemberSym['kind'], upper: string, depth = 0): MemberSym | undefined {
  if (depth > 20) return undefined;
  const own = pou.members.find(m => m.kind === kind && m.name.toUpperCase() === upper);
  if (own) return own;
  for (const q of pou.extendsNames) {
    const base = index.resolveGlobal(q.parts, pou.scope);
    const found = base?.kind === 'pou' && base.pouKind !== 'ITF' ? memberIn(index, base, kind, upper, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * What Go to Implementation lists for a symbol. For an interface, the function blocks that implement it: directly,
 * through an interface that extends it, or by extending a function block that implements it; for a function block,
 * those that extend it, whatever the depth. For a method or property of either, the methods or properties of the
 * same name and kind that these function blocks have, their own or one they inherit (which relatedMembers links to
 * it): those that implement or override it. Only the workspace's, by name: a library has no source to go to.
 */
export function implementations(index: LanguageIndex, sym: Sym): (PouSym | MemberSym)[] {
  if (sym.kind === 'pou') {
    return isHierarchyType(sym) ? descendants(index, sym).filter(p => p.pouKind === 'FB').sort(byName) : [];
  }
  if ((sym.kind !== 'method' && sym.kind !== 'property') || !isHierarchyType(sym.owner)) return [];
  const upper = sym.name.toUpperCase();
  const found = new Set<MemberSym>();
  for (const fb of implementations(index, sym.owner) as PouSym[]) {
    const m = memberIn(index, fb, sym.kind, upper);
    if (m && m !== sym && !isLibrarySym(m)) found.add(m);
  }
  return [...found].sort((a, b) => byName(a.owner, b.owner));
}

/** The function blocks and interfaces a POU names after EXTENDS and then IMPLEMENTS: its direct supertypes. */
export function supertypes(index: LanguageIndex, pou: PouSym): PouSym[] {
  const out: PouSym[] = [];
  for (const q of [...pou.extendsNames, ...pou.implementsNames]) {
    const g = index.resolveGlobal(q.parts, pou.scope);
    if (g?.kind === 'pou' && g !== pou && !out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * The POUs of the workspace that name a function block or interface after EXTENDS or IMPLEMENTS, by name: its
 * direct subtypes. A library's are not known.
 */
export function subtypes(index: LanguageIndex, pou: PouSym): PouSym[] {
  return index.allGlobals().filter((g): g is PouSym => g.kind === 'pou' && g !== pou && supertypes(index, g).includes(pou)).sort(byName);
}

/** A function block or interface of a type hierarchy, with those above it (its supertypes) or below it (its subtypes). */
export interface TypeTree {
  sym: PouSym;
  /** Empty for one that is already on the way from the root (EXTENDS that go round). */
  children: TypeTree[];
}

/** The supertypes of a function block or interface up to the roots, or its subtypes, theirs and so on. */
export function typeTree(index: LanguageIndex, pou: PouSym, direction: 'supertypes' | 'subtypes'): TypeTree[] {
  const next = direction === 'supertypes' ? supertypes : subtypes;
  const grow = (p: PouSym, path: PouSym[]): TypeTree[] => (path.length > 20 ? [] : next(index, p).map(q => ({
    sym: q, children: path.includes(q) ? [] : grow(q, [...path, q]),
  })));
  return grow(pou, [pou]);
}

/**
 * The function block or interface whose type hierarchy shows at an offset of a section: the one named there, or
 * the one whose method or property is; else the one the section belongs to.
 */
export function hierarchyTypeAt(analysis: Analysis, ctx: SectionContext, offset: number): PouSym | undefined {
  const s = analysis.occurrences.find(o => o.start <= offset && offset <= o.end)?.sym;
  if (s && isHierarchyType(s)) return s;
  if ((s?.kind === 'method' || s?.kind === 'property') && isHierarchyType(s.owner)) return s.owner;
  return ctx.pou && isHierarchyType(ctx.pou) ? ctx.pou : undefined;
}

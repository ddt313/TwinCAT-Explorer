// What adding members to a POU or interface needs from the language: checks of the name and the type typed
// in, and the methods and properties a function block lacks to implement its interfaces.

import * as A from './ast';
import { Analyzer } from './analyzer';
import { ELEMENTARY } from './builtins';
import { LanguageIndex } from './index';
import { RESERVED, parseDeclaration } from './parser';
import { MemberSym, PouSym, Scope } from './symbols';
import { MemberSpec, memberNameProblem } from '../core/splice';
import { TcObject, TcSourceFile } from '../core/tcfile';
import { fileKey } from '../core/workspace';

/** Words that cannot name a member although they look like identifiers. */
const NOT_NAMES = new Set([
  ...RESERVED, ...ELEMENTARY, 'STRING', 'WSTRING', 'TRUE', 'FALSE', 'THIS', 'SUPER', 'ACTION',
  'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL', 'FINAL', 'ABSTRACT',
]);

/** Why a new member of the POU or interface cannot have this name (not an identifier, a keyword, taken); undefined when it can. */
export function newMemberNameProblem(owner: TcObject, name: string): string | undefined {
  return memberNameProblem(owner, name) ?? (NOT_NAMES.has(name.toUpperCase()) ? `${name} is a keyword` : undefined);
}

/** Why the text is not a data type (a return type, the type of a property); undefined when it is one. */
export function typeProblem(type: string): string | undefined {
  const t = type.trim();
  if (!t) return 'Enter a type';
  if (/[\r\n]/.test(t)) return 'The type must be on one line';
  const r = parseDeclaration(`METHOD M : ${t}`);
  if (r.errors.length || !r.units[0]?.header?.returnType) return `'${t}' is not a data type${r.errors[0] ? `: ${r.errors[0].message}` : ''}`;
  return undefined;
}

export interface InterfaceStub {
  /** The interface that declares the member. */
  from: string;
  spec: MemberSpec;
}

export interface InterfaceStubs {
  stubs: InterfaceStub[];
  /** The interfaces implemented, those they extend included. */
  interfaces: string[];
  /** Names in IMPLEMENTS or EXTENDS that are not interfaces of the workspace or of the library stubs. */
  missing: string[];
}

const PARAMETER_SECTIONS = ['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'];

/** A method or property like the interface's: its declaration and, for a property, its accessors. */
function stubSpec(index: LanguageIndex, m: MemberSym): MemberSpec {
  const kind = m.kind === 'property' ? 'property' : 'method';
  const source = m.loc && index.context(m.loc.fileKey, m.loc.sectionKey);
  const declaration = m.loc && index.sectionText(m.loc.fileKey, m.loc.sectionKey);
  if (source && declaration !== undefined) {
    const accessors = index.ws.getFile(source.filePath)?.objects.get(source.object.id)?.accessors.map(a => a.kind);
    return { kind, name: m.name, declaration, accessors: kind === 'property' && accessors?.length ? accessors : undefined };
  }
  // A library interface: the declaration is rebuilt from the stub's header and parameters.
  const header = m.signature.split('\n')[0];
  if (kind === 'property') return { kind, name: m.name, declaration: header };
  const blocks = PARAMETER_SECTIONS.map(section => {
    const vars = m.vars.filter(v => v.section === section);
    return vars.length ? `${section}\n${vars.map(v => `\t${v.signature};\n`).join('')}END_VAR\n` : '';
  }).join('');
  return { kind, name: m.name, declaration: `${header}\n${blocks || 'VAR_INPUT\nEND_VAR\n'}` };
}

/**
 * The methods and properties a function block lacks to implement its interfaces: those of the interfaces it
 * names after IMPLEMENTS, and of the interfaces these extend, that neither it nor a function block it extends
 * has. Each comes with the declaration of the interface's.
 */
export function interfaceStubs(index: LanguageIndex, file: TcSourceFile): InterfaceStubs {
  const root = file.root;
  const decl = root?.sections.find(s => s.role === 'decl' && !s.accessor);
  const ctx = decl && index.context(fileKey(file.path), decl.key);
  const pou = ctx?.pou;
  if (!root || !ctx || !pou) throw new Error(`${file.path} is not a POU of a PLC project of the workspace`);
  const analyzer = new Analyzer(index, ctx, '');
  const taken = new Set(root.members.map(m => m.name.toUpperCase()));
  const pous = new Set<PouSym>();
  const take = (p: PouSym, depth: number) => {
    if (depth > 20 || pous.has(p)) return;
    pous.add(p);
    for (const m of p.members) taken.add(m.name.toUpperCase());
    for (const b of analyzer.basesOf(p)) take(b, depth + 1);
  };
  take(pou, 0);
  const out: InterfaceStubs = { stubs: [], interfaces: [], missing: [] };
  const interfaces = new Set<PouSym>();
  const visit = (q: A.QualName, scope: Scope, depth: number) => {
    const itf = analyzer.resolveGlobalName(q.parts, scope);
    if (itf?.kind !== 'pou' || itf.pouKind !== 'ITF') {
      const name = q.parts.map(p => p.name).join('.');
      if (!out.missing.includes(name)) out.missing.push(name);
      return;
    }
    if (depth > 20 || interfaces.has(itf)) return;
    interfaces.add(itf);
    out.interfaces.push(itf.name);
    for (const m of itf.members) {
      if ((m.kind !== 'method' && m.kind !== 'property') || taken.has(m.name.toUpperCase())) continue;
      taken.add(m.name.toUpperCase());
      out.stubs.push({ from: itf.name, spec: stubSpec(index, m) });
    }
    for (const e of itf.extendsNames) visit(e, itf.scope, depth + 1);
  };
  for (const q of pou.implementsNames) visit(q, pou.scope, 0);
  return out;
}

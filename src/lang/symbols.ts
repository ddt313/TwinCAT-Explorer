// Symbols and types produced by the language index.

import * as A from './ast';

/** Position of a name inside a section of a source file (offsets in LF-normalized section text). */
export interface Loc {
  fileKey: string;
  sectionKey: string;
  start: number;
  end: number;
}

interface SymBase {
  /** Stable identity used to compare symbols across index rebuilds. */
  id: string;
  name: string;
  loc?: Loc;
  scope: Scope;
  /** Declaration text shown in hovers. */
  signature: string;
  doc?: string;
}

export type PouKindSym = 'FB' | 'PRG' | 'FUN' | 'ITF';

export interface PouSym extends SymBase {
  kind: 'pou';
  pouKind: PouKindSym;
  vars: VarSym[];
  members: MemberSym[];
  extendsNames: A.QualName[];
  implementsNames: A.QualName[];
  returnType?: A.TypeSpec;
  /** The return type as written. */
  returnText?: string;
}

export type MemberKind = 'method' | 'property' | 'action' | 'transition';

export interface MemberSym extends SymBase {
  kind: MemberKind;
  owner: PouSym;
  vars: VarSym[];
  getVars: VarSym[];
  setVars: VarSym[];
  returnType?: A.TypeSpec;
  /** The return type (of a property: its type) as written. */
  returnText?: string;
}

export interface VarSym extends SymBase {
  kind: 'var';
  section: string;
  constant: boolean;
  typeSpec?: A.TypeSpec;
  /** The type and the initial value as written. */
  typeText: string;
  initText?: string;
  owner: PouSym | MemberSym | TypeSym | GvlSym;
  accessor?: 'Get' | 'Set';
}

export type DutKindSym = 'struct' | 'enum' | 'union' | 'alias';

export interface TypeSym extends SymBase {
  kind: 'type';
  dutKind: DutKindSym;
  fields: VarSym[];
  values: EnumValueSym[];
  qualifiedOnly: boolean;
  extendsName?: A.QualName;
  aliasSpec?: A.TypeSpec;
  baseSpec?: A.TypeSpec;
}

export interface EnumValueSym extends SymBase {
  kind: 'enumValue';
  owner: TypeSym;
}

export interface GvlSym extends SymBase {
  kind: 'gvl';
  vars: VarSym[];
  qualifiedOnly: boolean;
}

export interface NamespaceSym extends SymBase {
  kind: 'namespace';
  target: Scope;
}

export interface BuiltinSym extends SymBase {
  kind: 'builtin';
  returns: (args: Ty[]) => Ty;
  /** A constant (NULL) rather than a function. */
  value: boolean;
}

export type Sym = PouSym | MemberSym | VarSym | TypeSym | EnumValueSym | GvlSym | NamespaceSym | BuiltinSym;
export type GlobalSym = PouSym | TypeSym | GvlSym;

export class Scope {
  readonly globals = new Map<string, GlobalSym>();
  readonly gvlVars = new Map<string, VarSym>();
  readonly enumValues = new Map<string, EnumValueSym>();
  readonly namespaces = new Map<string, Scope>();
  refs: Scope[] = [];

  constructor(readonly name: string, readonly isLibrary: boolean) {}

  clear(): void {
    this.globals.clear();
    this.gvlVars.clear();
    this.enumValues.clear();
    this.namespaces.clear();
    this.refs = [];
  }
}

export type Ty =
  | { k: 'elem'; name: string }
  | { k: 'string'; wide: boolean }
  | { k: 'pou'; sym: PouSym }
  | { k: 'struct'; sym: TypeSym }
  | { k: 'enum'; sym: TypeSym }
  | { k: 'ptr'; to: Ty }
  | { k: 'ref'; to: Ty }
  | { k: 'array'; of: Ty }
  /** A type name used as an expression: `E_State` in `E_State.Idle`. */
  | { k: 'typeName'; sym: TypeSym | PouSym }
  | { k: 'gvl'; sym: GvlSym }
  | { k: 'ns'; scope: Scope }
  | { k: 'callable'; sym: MemberSym | PouSym | BuiltinSym }
  | { k: 'unknown' };

export const UNKNOWN: Ty = { k: 'unknown' };
export const BOOL: Ty = { k: 'elem', name: 'BOOL' };

export function elem(name: string): Ty {
  return { k: 'elem', name };
}

export function tyToString(t: Ty): string {
  switch (t.k) {
    case 'elem': return t.name;
    case 'string': return t.wide ? 'WSTRING' : 'STRING';
    case 'pou':
    case 'struct':
    case 'enum':
    case 'typeName':
    case 'gvl':
    case 'callable':
      return t.sym.name;
    case 'ptr': return `POINTER TO ${tyToString(t.to)}`;
    case 'ref': return `REFERENCE TO ${tyToString(t.to)}`;
    case 'array': return `ARRAY OF ${tyToString(t.of)}`;
    case 'ns': return t.scope.name;
    case 'unknown': return '?';
  }
}

/** Whether the symbol comes from a library stub (no source in the workspace). */
export function isLibrarySym(s: Sym): boolean {
  return s.scope.isLibrary;
}

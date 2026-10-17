// Elementary data types, operators and standard functions known to TwinCAT
// without any library.

import { BuiltinSym, Scope, Ty, UNKNOWN, elem, BOOL } from './symbols';

export const ELEMENTARY = new Set([
  'BOOL', 'BIT', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
  'REAL', 'LREAL', 'TIME', 'LTIME', 'DATE', 'LDATE', 'TIME_OF_DAY', 'TOD', 'LTOD', 'LTIME_OF_DAY', 'DATE_AND_TIME',
  'DT', 'LDT', 'LDATE_AND_TIME', 'ANY', 'ANY_NUM', 'ANY_INT', 'ANY_REAL', 'ANY_BIT', 'ANY_STRING', 'ANY_DATE',
  'ANY_ELEMENTARY', 'ANY_MAGNITUDE', 'ANY_DERIVED', 'ANY_SIGNED', 'ANY_UNSIGNED', 'ANY_DURATION', 'ANY_CHAR',
  '__XWORD', 'XWORD', '__UXINT', '__XINT', 'UXINT', 'XINT', 'PVOID', 'HRESULT', 'CHAR', 'WCHAR', '__SYSTEM.TYPE_CLASS',
]);

export const TIME_LITERAL_TYPES: Record<string, string> = {
  T: 'TIME', TIME: 'TIME', LT: 'LTIME', LTIME: 'LTIME', D: 'DATE', DATE: 'DATE', LD: 'LDATE', LDATE: 'LDATE',
  DT: 'DT', DATE_AND_TIME: 'DT', LDT: 'LDT', LDATE_AND_TIME: 'LDT', TOD: 'TOD', TIME_OF_DAY: 'TOD',
  LTOD: 'LTOD', LTIME_OF_DAY: 'LTOD',
};

const first = (args: Ty[]): Ty => args[0] ?? UNKNOWN;
const second = (args: Ty[]): Ty => args[1] ?? UNKNOWN;
const fixed = (name: string) => (): Ty => elem(name);

const BUILTINS: Record<string, { returns: (args: Ty[]) => Ty; signature: string; value?: boolean }> = {
  NULL: { returns: fixed('PVOID'), signature: 'NULL : PVOID (null pointer)', value: true },
  ADR: { returns: a => ({ k: 'ptr', to: first(a) }), signature: 'ADR(x) : POINTER TO type of x' },
  ADRINST: { returns: fixed('PVOID'), signature: 'ADRINST() : PVOID' },
  BITADR: { returns: fixed('DWORD'), signature: 'BITADR(x) : DWORD' },
  SIZEOF: { returns: fixed('UDINT'), signature: 'SIZEOF(x) : UDINT' },
  XSIZEOF: { returns: fixed('__UXINT'), signature: 'XSIZEOF(x) : __UXINT' },
  INDEXOF: { returns: fixed('INT'), signature: 'INDEXOF(pou) : INT' },
  __NEW: { returns: a => ({ k: 'ptr', to: typeFromTypeName(first(a)) }), signature: '__NEW(type) : POINTER TO type' },
  __DELETE: { returns: fixed('BOOL'), signature: '__DELETE(pointer)' },
  __QUERYINTERFACE: { returns: () => BOOL, signature: '__QUERYINTERFACE(itfSource, itfDest) : BOOL' },
  __QUERYPOINTER: { returns: () => BOOL, signature: '__QUERYPOINTER(itfSource, pDest) : BOOL' },
  __ISVALIDREF: { returns: () => BOOL, signature: '__ISVALIDREF(reference) : BOOL' },
  __VARINFO: { returns: () => UNKNOWN, signature: '__VARINFO(variable) : __SYSTEM.VAR_INFO' },
  __POUNAME: { returns: () => ({ k: 'string', wide: false }), signature: '__POUNAME() : STRING' },
  __POSITION: { returns: () => ({ k: 'string', wide: false }), signature: '__POSITION() : STRING' },
  __CURRENTTASK: { returns: () => UNKNOWN, signature: '__CURRENTTASK() : __SYSTEM.TaskInfo' },
  __TRY: { returns: () => UNKNOWN, signature: '__TRY' },
  TEST_AND_SET: { returns: () => BOOL, signature: 'TEST_AND_SET(dw) : BOOL' },
  INI: { returns: () => BOOL, signature: 'INI(fbInstance, bInitRetains) : BOOL' },
  MIN: { returns: first, signature: 'MIN(in1, in2, ...)' },
  MAX: { returns: first, signature: 'MAX(in1, in2, ...)' },
  LIMIT: { returns: second, signature: 'LIMIT(min, in, max)' },
  SEL: { returns: second, signature: 'SEL(g, in0, in1)' },
  MUX: { returns: second, signature: 'MUX(k, in0, in1, ...)' },
  ABS: { returns: first, signature: 'ABS(in)' },
  SQRT: { returns: fixed('LREAL'), signature: 'SQRT(in) : LREAL' },
  LN: { returns: fixed('LREAL'), signature: 'LN(in) : LREAL' },
  LOG: { returns: fixed('LREAL'), signature: 'LOG(in) : LREAL' },
  EXP: { returns: fixed('LREAL'), signature: 'EXP(in) : LREAL' },
  EXPT: { returns: first, signature: 'EXPT(in1, in2)' },
  SIN: { returns: fixed('LREAL'), signature: 'SIN(in) : LREAL' },
  COS: { returns: fixed('LREAL'), signature: 'COS(in) : LREAL' },
  TAN: { returns: fixed('LREAL'), signature: 'TAN(in) : LREAL' },
  ASIN: { returns: fixed('LREAL'), signature: 'ASIN(in) : LREAL' },
  ACOS: { returns: fixed('LREAL'), signature: 'ACOS(in) : LREAL' },
  ATAN: { returns: fixed('LREAL'), signature: 'ATAN(in) : LREAL' },
  MOVE: { returns: first, signature: 'MOVE(in)' },
  SHL: { returns: first, signature: 'SHL(in, n)' },
  SHR: { returns: first, signature: 'SHR(in, n)' },
  ROL: { returns: first, signature: 'ROL(in, n)' },
  ROR: { returns: first, signature: 'ROR(in, n)' },
  TRUNC: { returns: fixed('DINT'), signature: 'TRUNC(in) : DINT' },
  TRUNC_INT: { returns: fixed('INT'), signature: 'TRUNC_INT(in) : INT' },
  LOWER_BOUND: { returns: fixed('DINT'), signature: 'LOWER_BOUND(array, dim) : DINT' },
  UPPER_BOUND: { returns: fixed('DINT'), signature: 'UPPER_BOUND(array, dim) : DINT' },
  LEN: { returns: fixed('INT'), signature: 'LEN(str) : INT' },
  LEFT: { returns: () => ({ k: 'string', wide: false }), signature: 'LEFT(str, size) : STRING' },
  RIGHT: { returns: () => ({ k: 'string', wide: false }), signature: 'RIGHT(str, size) : STRING' },
  MID: { returns: () => ({ k: 'string', wide: false }), signature: 'MID(str, len, pos) : STRING' },
  CONCAT: { returns: () => ({ k: 'string', wide: false }), signature: 'CONCAT(str1, str2) : STRING' },
  INSERT: { returns: () => ({ k: 'string', wide: false }), signature: 'INSERT(str1, str2, pos) : STRING' },
  DELETE: { returns: () => ({ k: 'string', wide: false }), signature: 'DELETE(str, len, pos) : STRING' },
  REPLACE: { returns: () => ({ k: 'string', wide: false }), signature: 'REPLACE(str1, str2, len, pos) : STRING' },
  FIND: { returns: fixed('INT'), signature: 'FIND(str1, str2) : INT' },
  WLEN: { returns: fixed('INT'), signature: 'WLEN(str) : INT' },
  WCONCAT: { returns: () => ({ k: 'string', wide: true }), signature: 'WCONCAT(str1, str2) : WSTRING' },
};

function typeFromTypeName(t: Ty): Ty {
  if (t.k !== 'typeName') return t;
  const s = t.sym;
  if (s.kind === 'pou') return { k: 'pou', sym: s };
  return s.dutKind === 'enum' ? { k: 'enum', sym: s } : { k: 'struct', sym: s };
}

const CONVERSION = /^(?:([A-Z_]+?)_)?TO_([A-Z]+(?:_[A-Z]+)*)$/;

export class Builtins {
  private readonly cache = new Map<string, BuiltinSym>();

  constructor(private readonly scope: Scope) {}

  lookup(upper: string): BuiltinSym | undefined {
    const cached = this.cache.get(upper);
    if (cached) return cached;
    let def = BUILTINS[upper];
    if (!def) {
      const m = CONVERSION.exec(upper);
      if (m && (ELEMENTARY.has(m[2]) || m[2] === 'STRING' || m[2] === 'WSTRING')) {
        const target = m[2];
        def = {
          returns: () => (target === 'STRING' || target === 'WSTRING' ? { k: 'string', wide: target === 'WSTRING' } : elem(target)),
          signature: `${upper}(in) : ${target}`,
        };
      }
    }
    if (!def) return undefined;
    const sym: BuiltinSym = {
      kind: 'builtin', id: `builtin:${upper}`, name: upper, scope: this.scope, signature: def.signature, returns: def.returns,
      value: def.value === true,
    };
    this.cache.set(upper, sym);
    return sym;
  }
}

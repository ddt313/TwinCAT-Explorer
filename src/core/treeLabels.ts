// How the TwinCAT trees name, sort and draw objects, as XAE's Solution Explorer does: the VS Code views and the
// browser extension share it.

import { Accessor } from './objectText';
import { DutKind, ObjectKind, PouKind } from './tcfile';

/** What the views call each kind of object. */
export const KIND_WORD: Record<ObjectKind, string> = {
  pou: 'POU', method: 'Method', property: 'Property', action: 'Action', transition: 'Transition',
  dut: 'DUT', gvl: 'GVL', itf: 'Interface',
};

/** Compares labels for sorting: case and accents aside, like `localeCompare` with base sensitivity. */
export const compareLabels = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

/** Label as XAE shows it: `MAIN (PRG)`, `FB_X (FB)`, `F_Y (FUN)`, `E_Z (ENUM)`, `ST_W (STRUCT)`. */
export function objectTreeLabel(obj: { kind: ObjectKind; name: string; pouKind?: PouKind; dutKind?: DutKind }): string {
  if (obj.kind === 'pou' && obj.pouKind) return `${obj.name} (${obj.pouKind})`;
  if (obj.kind === 'dut' && obj.dutKind) return `${obj.name} (${obj.dutKind.toUpperCase()})`;
  return obj.name;
}

/** The icon of an object, one of `media/icons/{light,dark}/<name>.svg`. */
export function objectIconName(obj: { kind: ObjectKind; pouKind?: PouKind; dutKind?: DutKind }): string {
  switch (obj.kind) {
    case 'pou':
      if (obj.pouKind === 'PRG') return 'prg';
      if (obj.pouKind === 'FUN') return 'fun';
      return 'fb';
    case 'itf': return 'interface';
    case 'dut': return obj.dutKind ?? 'struct';
    case 'gvl': return 'gvl';
    case 'method': return 'method';
    case 'property': return 'property';
    case 'action': return 'action';
    case 'transition': return 'transition';
  }
}

/** The icon of a property's Get or Set accessor. */
export function accessorIconName(accessor: Accessor): string {
  return accessor === 'Get' ? 'get' : 'set';
}

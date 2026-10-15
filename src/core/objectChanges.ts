// Changes of the objects of a TwinCAT file against another version of it (HEAD): which POUs, methods,
// properties and accessors are new or differ in their Structured Text or name. Metadata outside the
// sections (ProductVersion, folders, GUID order) does not count.

import { Section, TcObject, TcSourceFile } from './tcfile';

export type ObjectChange = 'modified' | 'added';

/** Key of an object view in the result: the object id, or `<id>|Get` / `<id>|Set` for an accessor. */
export function changeKey(objectId: string, accessor?: 'Get' | 'Set'): string {
  return accessor ? `${objectId}|${accessor}` : objectId;
}

function sameSections(now: Section[], before: Section[]): boolean {
  if (now.length !== before.length) return false;
  const old = new Map(before.map(s => [s.key, s.text]));
  return now.every(s => old.get(s.key) === s.text);
}

function accessorSections(obj: TcObject, accessor: 'Get' | 'Set'): Section[] {
  return obj.sections.filter(s => s.accessor === accessor);
}

/**
 * Objects of `now` that are new or changed compared with `before` (undefined: the file is new). An object
 * covers all its sections, so a property is changed when one of its accessors is; the accessors also get
 * their own entry. Unchanged objects are not in the result.
 */
export function objectChanges(before: TcSourceFile | undefined, now: TcSourceFile): Map<string, ObjectChange> {
  const out = new Map<string, ObjectChange>();
  for (const obj of now.ordered) {
    const old = before?.objects.get(obj.id);
    if (!old) {
      out.set(obj.id, 'added');
      for (const acc of obj.accessors) out.set(changeKey(obj.id, acc.kind), 'added');
      continue;
    }
    if (old.name !== obj.name || !sameSections(obj.sections, old.sections)) out.set(obj.id, 'modified');
    for (const acc of obj.accessors) {
      const oldSections = accessorSections(old, acc.kind);
      if (oldSections.length === 0) out.set(changeKey(obj.id, acc.kind), 'added');
      else if (!sameSections(accessorSections(obj, acc.kind), oldSections)) out.set(changeKey(obj.id, acc.kind), 'modified');
    }
  }
  return out;
}

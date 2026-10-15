// Changes of the objects of a TwinCAT file against another version of it (HEAD): which POUs, methods,
// properties and accessors are new or differ in their Structured Text or name. Metadata outside the
// sections (ProductVersion, folders, GUID order) does not count.

import { Accessor, viewLabel, viewSections } from './objectText';
import { ObjectKind, Section, TcObject, TcSourceFile } from './tcfile';

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

export type ViewChangeKind = 'modified' | 'added' | 'deleted';

/** A changed object view: what one tab shows (a POU, method, ... or one accessor of a property). */
export interface ViewChange {
  objectId: string;
  accessor?: Accessor;
  kind: ObjectKind;
  /** `FB_X`, `FB_X.Method` or `FB_X.Prop.Get` (as it was, for a deleted view). */
  label: string;
  change: ViewChangeKind;
  /** The name the object had before, when it was renamed. */
  renamedFrom?: string;
}

/**
 * The object views of a file that differ between two versions (undefined: the file does not exist in that
 * version), in the order of the file; deleted views come last. A deleted object is one entry, its
 * accessors are not listed on their own.
 */
export function viewChanges(before: TcSourceFile | undefined, now: TcSourceFile | undefined): ViewChange[] {
  const out: ViewChange[] = [];
  for (const obj of now?.ordered ?? []) {
    const old = before?.objects.get(obj.id);
    for (const accessor of [undefined, ...obj.accessors.map(a => a.kind)]) {
      const entry = { objectId: obj.id, accessor, kind: obj.kind, label: viewLabel(obj, accessor) };
      const oldSections = old ? viewSections(old, accessor) : [];
      if (!old || (accessor && oldSections.length === 0)) {
        out.push({ ...entry, change: 'added' });
        continue;
      }
      const renamed = !accessor && old.name !== obj.name;
      if (renamed || !sameSections(viewSections(obj, accessor), oldSections)) {
        out.push({ ...entry, change: 'modified', ...(renamed ? { renamedFrom: old.name } : {}) });
      }
    }
    for (const acc of old?.accessors ?? []) {
      if (!obj.accessors.some(a => a.kind === acc.kind)) {
        out.push({ objectId: obj.id, accessor: acc.kind, kind: obj.kind, label: viewLabel(obj, acc.kind), change: 'deleted' });
      }
    }
  }
  for (const old of before?.ordered ?? []) {
    if (now?.objects.has(old.id)) continue;
    out.push({ objectId: old.id, kind: old.kind, label: old.qualifiedName, change: 'deleted' });
  }
  return out;
}

/** True when two versions of a .tsproj differ only in the TmcHash attributes a build rewrites. */
export function onlyTmcHashChanged(before: string, now: string): boolean {
  const strip = (t: string) => t.replace(/\r\n/g, '\n').replace(/TmcHash="\{[^}"]*\}"/g, 'TmcHash=""');
  return before !== now && strip(before) === strip(now);
}

/** What differs in a source file without code changes: its ProductVersion, or other XML. */
export function metadataChange(before: string, now: string): string {
  const version = (t: string) => /ProductVersion="([^"]*)"/.exec(t)?.[1];
  const strip = (t: string) => t.replace(/\r\n/g, '\n').replace(/ProductVersion="[^"]*"/, '');
  if (version(before) !== version(now) && strip(before) === strip(now)) return `ProductVersion ${version(before) ?? '-'} → ${version(now) ?? '-'}`;
  return 'XML only, no code';
}

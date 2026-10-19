// Add > Existing Item and Add > Existing Folder Content, as TwinCAT XAE 3.1.4026 does them: which files go into
// which folder of a PLC project, copied there or added where they are, and the GUIDs that change.

import * as path from 'path';
import { itemOrder } from './project';
import { ObjectKind, TcFileKind, decodeBytes, encodeText, fileKindFromPath, normalizeId, parseTcText } from './tcfile';
import { fileKey } from './workspace';
import { XmlElement, attributeRange, parseXml } from './xml';

/** A file chosen to add: Existing Item gives files, Existing Folder Content those of a folder and its sub-folders. */
export interface ChosenFile {
  /** Where it is on disk. */
  path: string;
  /** Its folder below the folder chosen (`Sub\Deep`, backslash separated); empty for a file chosen itself. */
  subfolder: string;
  /** Its content, or why it could not be read. */
  bytes?: Uint8Array;
  error?: string;
}

/** A file the plan adds to the PLC project. */
export interface AddedFile {
  source: string;
  /** Its item in the .plcproj (`POUs\Valves\FB_Pump.TcPOU`). */
  include: string;
  /** Where it goes: the source itself when it is in the folder of its item already. */
  target: string;
  /** Copied there; else added where it is. */
  copy: boolean;
  /** The object it holds, and its id (normalized, after the GUIDs that change). */
  name: string;
  objectId: string;
  /** What to write at the target: the bytes of the source, with the GUIDs that change; none when it stays as it is. */
  bytes?: Uint8Array;
  /** The GUIDs that change, as written: old and new. */
  newIds: [string, string][];
}

export interface SkippedFile {
  source: string;
  reason: string;
}

export interface ExistingPlan {
  files: AddedFile[];
  /** The <Folder> items to add for the sub-folders (`POUs\Valves\Sub`), in item order. */
  folders: string[];
  skipped: SkippedFile[];
}

/** What a plan needs of the PLC project. */
export interface ProjectState {
  dir: string;
  /** Its <Compile> items. */
  compile: string[];
  /** Its folders, those of its <Folder> items and of its files. */
  folders: string[];
  /** The POUs, DUTs, GVLs and interfaces by upper case name: `a POU named FB_A`. */
  names: Map<string, string>;
  /** The GUIDs of its objects, normalized (see objectIds). */
  ids: Set<string>;
}

const OBJECT_KINDS: Partial<Record<TcFileKind, { kind: ObjectKind; word: string }>> = {
  pou: { kind: 'pou', word: 'a POU' }, dut: { kind: 'dut', word: 'a DUT' }, gvl: { kind: 'gvl', word: 'a GVL' }, itf: { kind: 'itf', word: 'an interface' },
};

const GUID = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/;

function elements(el: XmlElement, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    out.push(c);
    elements(c, out);
  }
  return out;
}

/** The GUID attributes of a TwinCAT file (`Id="{...}"`): of its object, members, accessors and folders. */
function idRanges(text: string): { start: number; end: number; value: string }[] {
  return elements(parseXml(text)).flatMap(el => {
    const value = el.attrs.get('Id');
    const range = value && GUID.test(value) ? attributeRange(text, el, 'Id') : undefined;
    return range ? [range] : [];
  });
}

/** The GUIDs of the objects of a TwinCAT file, normalized (lower case, no braces). */
export function objectIds(text: string): string[] {
  try {
    return idRanges(text).map(r => normalizeId(r.value)!);
  } catch {
    return [];
  }
}

/**
 * The text of a TwinCAT file with a new GUID for each one `taken` holds already, the others kept, as XAE 3.1.4026
 * gives a file it adds the GUIDs the PLC project has already (only those). The rest stays byte for byte.
 */
export function withNewIds(text: string, taken: Set<string>, newId: () => string): { text: string; newIds: [string, string][] } {
  const changes = idRanges(text).filter(r => taken.has(normalizeId(r.value)!)).map(r => ({ ...r, id: newId() }));
  const out = [...changes].sort((a, b) => b.start - a.start).reduce((t, c) => t.slice(0, c.start) + c.id + t.slice(c.end), text);
  return { text: out, newIds: changes.map(c => [c.value, c.id]) };
}

/** `POUs` and `Valves\Deep` make `POUs\Valves\Deep`. */
const join = (...parts: string[]) => parts.filter(p => p).join('\\');

/**
 * What adding the chosen files to `folder` of the PLC project (`POUs\Valves`, empty for the project itself) does,
 * as TwinCAT XAE 3.1.4026 adds an existing item or the content of a folder:
 * - A file in the folder of its item already (left there by a merge or a copy) is added where it is; any other one
 *   is copied there, byte for byte. A file of a sub-folder goes into the sub-folder of the same name, which gets
 *   a <Folder> item when the project has none.
 * - GUIDs the project has already get new ones, the others stay.
 * - Skipped, with the reason: what is not a POU, DUT, GVL or interface file, cannot be read or holds no such object;
 *   an object whose name the project has (they share one namespace, case aside); a file already in the project;
 *   a file that would overwrite one on disk (`exists`).
 */
export function planExistingFiles(project: ProjectState, folder: string, chosen: ChosenFile[], exists: (fsPath: string) => boolean,
  newId: () => string): ExistingPlan {
  const files: AddedFile[] = [];
  const skipped: SkippedFile[] = [];
  const names = new Map(project.names);
  const ids = new Set(project.ids);
  const includes = new Set(project.compile.map(i => i.toUpperCase()));
  const folders = new Set(project.folders.map(f => f.toUpperCase()));
  const newFolders = new Map<string, string>();
  for (const c of chosen) {
    const skip = (reason: string) => skipped.push({ source: c.path, reason });
    const kind = OBJECT_KINDS[fileKindFromPath(c.path)];
    if (!kind) {
      skip('not a POU, DUT, GVL or interface file');
      continue;
    }
    const sub = join(folder, c.subfolder);
    const include = join(sub, path.basename(c.path));
    const target = path.join(project.dir, ...include.split('\\'));
    const copy = fileKey(target) !== fileKey(c.path);
    if (includes.has(include.toUpperCase())) {
      skip(files.some(f => f.include.toUpperCase() === include.toUpperCase()) ? 'another file chosen goes there' : 'in the PLC project already');
      continue;
    }
    if (!c.bytes) {
      skip(`cannot be read: ${c.error ?? 'no content'}`);
      continue;
    }
    const { text, bom } = decodeBytes(c.bytes);
    const file = parseTcText(c.path, text, bom);
    const root = file.root;
    if (file.error || !root || root.kind !== kind.kind) {
      skip(`holds no ${kind.word.replace(/^an? /, '')} TwinCAT can read${file.error ? `: ${file.error}` : ''}`);
      continue;
    }
    const taken = names.get(root.name.toUpperCase());
    if (taken) {
      skip(`the PLC project has ${taken} already`);
      continue;
    }
    if (copy && exists(target)) {
      skip(`${path.basename(c.path)} is on disk in ${sub || 'the PLC project folder'} already`);
      continue;
    }
    const renewed = withNewIds(text, ids, newId);
    const bytes = renewed.newIds.length ? encodeText(renewed.text, bom) : copy ? c.bytes : undefined;
    const objectId = renewed.newIds.find(([old]) => normalizeId(old) === root.id)?.[1] ?? root.id;
    files.push({ source: c.path, include, target, copy, name: root.name, objectId: normalizeId(objectId)!, bytes, newIds: renewed.newIds });
    names.set(root.name.toUpperCase(), `${kind.word} named ${root.name}`);
    includes.add(include.toUpperCase());
    for (const id of objectIds(renewed.text)) ids.add(id);
    // The sub-folders on the way, those the project does not have.
    const parts = c.subfolder.split('\\').filter(p => p);
    for (let i = 1; i <= parts.length; i++) {
      const f = join(folder, ...parts.slice(0, i));
      if (!folders.has(f.toUpperCase())) newFolders.set(f.toUpperCase(), f);
    }
  }
  return { files, folders: [...newFolders.values()].sort(itemOrder), skipped };
}

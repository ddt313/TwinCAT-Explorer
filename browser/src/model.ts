// What the browser extension shows for one TwinCAT file of a pull request: the object views of the file (POU,
// methods, properties and their accessors, actions, transitions) in the order of the file, each added, modified,
// deleted or unchanged, with the line diff of each of its sections (Declaration above Implementation) and the
// line of the XML file each section line is on. Platform-free, like the core it is built on.

import { ViewChange, changeKey, metadataChange, onlyTmcHashChanged, viewChanges } from '../../src/core/objectChanges';
import { Accessor, viewLabel, viewSections } from '../../src/core/objectText';
import {
  DutKind, ObjectKind, PouKind, Section, TcObject, TcSourceFile, fileLineAt, normalizeEol, parseTcText, sectionFileLines,
} from '../../src/core/tcfile';
import { diffLines } from './lineDiff';

export type ObjectChangeKind = 'added' | 'modified' | 'deleted' | 'unchanged';

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** Line in the section (1-based), before and after; undefined on the side the line is not on. */
  oldLine?: number;
  newLine?: number;
  /** Line of the XML file the section line is on (1-based, as git and GitHub count them), before and after. */
  oldXml?: number;
  newXml?: number;
}

export interface SectionView {
  key: string;
  role: 'decl' | 'impl';
  /** `Declaration`, `Implementation`, `Implementation (CFC)`; `Get · Declaration` in a deleted property. */
  label: string;
  /** Structured Text (or a declaration): shown line by line. False for a graphical implementation. */
  text: boolean;
  status: 'same' | 'changed' | 'added' | 'deleted';
  /** All the lines of the section, unchanged ones included (empty for a graphical implementation). */
  lines: DiffLine[];
  added: number;
  deleted: number;
  /** Line of the XML file the section starts on, before and after. */
  oldXml?: number;
  newXml?: number;
  /** Line of the XML file its element ends on, before and after (graphical code spans the lines up to it). */
  oldXmlEnd?: number;
  newXmlEnd?: number;
}

/** What a tree needs to name and draw an object: XAE's label and icon. */
export interface ObjectInfo {
  id: string;
  kind: ObjectKind;
  name: string;
  pouKind?: PouKind;
  dutKind?: DutKind;
}

export interface ObjectView {
  objectId: string;
  accessor?: Accessor;
  kind: ObjectKind;
  /** `FB_X`, `FB_X.Method`, `FB_X.Prop.Get` (as it was, for a deleted view). */
  label: string;
  /** The object's own name (`Method`; the property's, for an accessor) and the folders inside its POU. */
  name: string;
  folderPath: string[];
  pouKind?: PouKind;
  dutKind?: DutKind;
  /** 0 for the POU, DUT or GVL; 1 for its members; 2 for the accessors of a property. */
  depth: number;
  change: ObjectChangeKind;
  /** The name the object had at the base, when it was renamed. */
  renamedFrom?: string;
  sections: SectionView[];
  added: number;
  deleted: number;
  /** First and last line of the object's XML element, before and after (none for a Get or Set view). */
  oldXmlSpan?: [number, number];
  newXmlSpan?: [number, number];
}

export interface FileInput {
  /** Path of the file at the head (for a deleted file: its path at the base). */
  path: string;
  /** Path of the file at the base, when it was renamed. */
  oldPath?: string;
  /** Text of the file at the merge base and at the head; undefined when it is not in that version. */
  before?: string;
  after?: string;
}

export interface FileView {
  path: string;
  oldPath?: string;
  change: 'added' | 'deleted' | 'modified';
  /** The POU, DUT, GVL or interface of the file (at the head, or at the base for a deleted file). */
  root?: ObjectInfo;
  objects: ObjectView[];
  counts: Record<ObjectChangeKind, number>;
  /** No code changed: what changed instead (`ProductVersion 3.1.4024.12 → 3.1.4026.13`, `XML only, no code`, ...). */
  metadataOnly?: string;
  /** The file cannot be shown as objects (a project file with other changes than its TmcHash, a broken file). */
  note?: string;
  error?: string;
}

export const SOURCE_FILE = /\.(tcpou|tcdut|tcgvl|tcio)$/i;
/** Project files whose only change is often the TmcHash a build rewrites. */
export const PROJECT_FILE = /\.(tsproj|xti)$/i;

/** A file of the tree of the changes: shown as TwinCAT objects, or for a project file, checked for a TmcHash-only change. */
export function isTwinCatFile(path: string): boolean {
  return SOURCE_FILE.test(path) || PROJECT_FILE.test(path);
}

/** A file with a TwinCAT view in the page: a source file. A project file keeps the host's diff. */
export function hasObjectView(path: string): boolean {
  return SOURCE_FILE.test(path);
}

export function buildFileView(input: FileInput): FileView {
  const view: FileView = {
    path: input.path,
    oldPath: input.oldPath !== input.path ? input.oldPath : undefined,
    change: input.before === undefined ? 'added' : input.after === undefined ? 'deleted' : 'modified',
    objects: [],
    counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
  };
  if (input.before === undefined && input.after === undefined) {
    view.error = 'The file is in neither version.';
    return view;
  }
  if (PROJECT_FILE.test(input.path)) {
    if (input.before !== undefined && input.after !== undefined && onlyTmcHashChanged(input.before, input.after)) {
      view.metadataOnly = 'TmcHash only, rewritten by a build';
    } else {
      view.note = 'A project file: its changes are in the page\'s diff.';
    }
    return view;
  }
  const before = input.before === undefined ? undefined : parseTcText(input.oldPath ?? input.path, input.before);
  const after = input.after === undefined ? undefined : parseTcText(input.path, input.after);
  const error = before?.error ?? after?.error;
  if (error) {
    view.error = `The file cannot be read as a TwinCAT file: ${error}`;
    return view;
  }
  const root = (after ?? before)?.root;
  if (!root) {
    view.note = 'No TwinCAT object in this file.';
    return view;
  }
  view.root = { id: root.id, kind: root.kind, name: root.name, pouKind: root.pouKind, dutKind: root.dutKind };

  const changes = viewChanges(before, after);
  const byKey = new Map(changes.map(c => [changeKey(c.objectId, c.accessor), c]));
  const push = (objectId: string, accessor: Accessor | undefined, change?: ViewChange) =>
    view.objects.push(objectView(before, after, objectId, accessor, change));
  for (const obj of after?.ordered ?? []) {
    for (const accessor of [undefined, ...obj.accessors.map(a => a.kind)]) push(obj.id, accessor, byKey.get(changeKey(obj.id, accessor)));
    // An accessor deleted from a property that is still there: right after the property.
    for (const c of changes) if (c.change === 'deleted' && c.accessor && c.objectId === obj.id) push(c.objectId, c.accessor, c);
  }
  for (const c of changes) if (c.change === 'deleted' && !after?.objects.has(c.objectId)) push(c.objectId, undefined, c);

  for (const o of view.objects) view.counts[o.change]++;
  if (view.counts.added + view.counts.modified + view.counts.deleted === 0 && before && after) {
    view.metadataOnly = before.text === after.text ? (view.oldPath ? 'Renamed, content unchanged' : 'No changes')
      : metadataChange(before.text, after.text);
  }
  return view;
}

function objectView(before: TcSourceFile | undefined, after: TcSourceFile | undefined, objectId: string,
  accessor: Accessor | undefined, change: ViewChange | undefined): ObjectView {
  const now = after?.objects.get(objectId);
  const old = before?.objects.get(objectId);
  const obj = (now ?? old)!;
  const nowSections = now ? viewSections(now, accessor) : [];
  const oldSections = old ? viewSections(old, accessor) : [];
  const deleted = change?.change === 'deleted';
  const sections = [
    ...nowSections.map(s => sectionView(before, after, oldSections.find(o => o.key === s.key), s, false)),
    ...oldSections.filter(o => !nowSections.some(s => s.key === o.key)).map(o => sectionView(before, after, o, undefined, false)),
  ];
  // A deleted property took its Get and Set with them: their code is shown removed below its declaration.
  if (deleted && !accessor && old?.kind === 'property') {
    for (const acc of old.accessors) sections.push(...viewSections(old, acc.kind).map(s => sectionView(before, after, s, undefined, true)));
  }
  // viewChanges compares the Structured Text only: a graphical implementation that changed makes its object modified.
  const kind: ObjectChangeKind = change?.change ?? (sections.some(s => s.status !== 'same') ? 'modified' : 'unchanged');
  const span = (file: TcSourceFile, o: TcObject): [number, number] => [fileLineAt(file, o.element.start), fileLineAt(file, o.element.end - 1)];
  return {
    objectId,
    accessor,
    kind: obj.kind,
    label: change?.label ?? viewLabel(obj, accessor),
    name: obj.name,
    folderPath: obj.folderPath,
    pouKind: obj.pouKind,
    dutKind: obj.dutKind,
    depth: !obj.parent ? 0 : accessor ? 2 : 1,
    change: kind,
    renamedFrom: change?.renamedFrom,
    sections,
    added: sections.reduce((n, s) => n + s.added, 0),
    deleted: sections.reduce((n, s) => n + s.deleted, 0),
    oldXmlSpan: old && before && !accessor ? span(before, old) : undefined,
    newXmlSpan: now && after && !accessor ? span(after, now) : undefined,
  };
}

function sectionLabel(s: Section, withAccessor: boolean): string {
  const role = s.role === 'decl' ? 'Declaration' : 'Implementation';
  const language = s.editable ? '' : ` (${s.element.name === 'Implementation' ? 'empty' : s.element.name})`;
  return `${withAccessor && s.accessor ? `${s.accessor} · ` : ''}${role}${language}`;
}

function sectionView(before: TcSourceFile | undefined, after: TcSourceFile | undefined, old: Section | undefined,
  now: Section | undefined, withAccessor: boolean): SectionView {
  const s = (now ?? old)!;
  // The XML line of each line of the section, before and after.
  const aXml = old && before ? sectionFileLines(before, old) : [];
  const bXml = now && after ? sectionFileLines(after, now) : [];
  const view: SectionView = {
    key: s.key,
    role: s.role,
    label: sectionLabel(s, withAccessor),
    text: s.editable,
    status: !old ? 'added' : !now ? 'deleted' : 'same',
    lines: [],
    added: 0,
    deleted: 0,
    oldXml: aXml[0],
    newXml: bXml[0],
    oldXmlEnd: old && before ? fileLineAt(before, old.element.end - 1) : undefined,
    newXmlEnd: now && after ? fileLineAt(after, now.element.end - 1) : undefined,
  };
  if (!s.editable) {
    // A graphical implementation: its XML tells whether it changed.
    const xml = (file: TcSourceFile, sec: Section) => normalizeEol(file.text.slice(sec.element.start, sec.element.end));
    if (old && now && xml(before!, old) !== xml(after!, now)) view.status = 'changed';
    return view;
  }
  const a = old ? lines(old.text) : [];
  const b = now ? lines(now.text) : [];
  for (const e of diffLines(a, b)) {
    const line: DiffLine = { kind: e.kind, text: e.kind === 'add' ? b[e.b!] : a[e.a!] };
    if (e.a !== undefined) {
      line.oldLine = e.a + 1;
      line.oldXml = aXml[e.a];
    }
    if (e.b !== undefined) {
      line.newLine = e.b + 1;
      line.newXml = bXml[e.b];
    }
    if (e.kind === 'add') view.added++;
    if (e.kind === 'del') view.deleted++;
    view.lines.push(line);
  }
  if (view.status === 'same' && view.added + view.deleted > 0) view.status = 'changed';
  return view;
}

/** Lines of a section text; an empty section has none. */
function lines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** A row of a split diff: the section line on its left (the base) and on its right (the head), by index in the section. */
export interface SplitRow {
  left?: number;
  right?: number;
}

/**
 * The rows of a split diff of the section lines `[from, to)`, as GitHub's and GitLab's split views lay them out: an
 * unchanged line on both sides, and in each run of changes its deleted lines beside its added ones, in order, the
 * longer side's extra lines beside nothing.
 */
export function splitRows(lines: readonly DiffLine[], from = 0, to = lines.length): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let k = from; k < to;) {
    if (lines[k].kind === 'same') {
      rows.push({ left: k, right: k });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < to && lines[k].kind !== 'same') (lines[k].kind === 'del' ? dels : adds).push(k++);
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) rows.push({ left: dels[p], right: adds[p] });
  }
  return rows;
}

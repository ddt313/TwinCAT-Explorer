// Parsing of TwinCAT project files: .tsproj (system project), the Independent Project Files (.xti) of its PLC
// projects, and .plcproj (PLC project); the items of the .plcproj for new, renamed, moved and deleted source files
// and folders, and for new library references; the calls of a task (.TcTTO).

import * as path from 'path';
import {
  XmlElement, attributeRange, child, children, elementLines, elementText, escapeAttr, escapeText, findAll, indentBefore, parseXml,
} from './xml';

/** A PLC project of a .tsproj. */
export interface PlcProjectRef {
  name: string;
  /**
   * Its .plcproj. Empty for one saved in an Independent Project File until the .xti is read (TcWorkspace.load); the
   * .xti itself when it could not be read, with what went wrong in TcWorkspace.failedPlc.
   */
  plcprojPath: string;
  /** The Independent Project File (.xti) that holds it, when the .tsproj names one instead of holding it. */
  xtiPath?: string;
}

export interface TsProject {
  path: string;
  name: string;
  /** Its PLC projects, in the order of the .tsproj. */
  plcProjects: PlcProjectRef[];
}

export interface LibraryRef {
  /** Include attribute (placeholder name or library spec). */
  include: string;
  /** Library name without version/vendor. */
  name: string;
  namespace: string;
  resolution?: string;
  system: boolean;
}

export interface PlcProject {
  path: string;
  dir: string;
  name: string;
  title?: string;
  /** Relative paths (backslash separated, as in the .plcproj) of source files. */
  compile: string[];
  /** Relative folder paths declared by <Folder Include>. */
  folders: string[];
  libraries: LibraryRef[];
}

/** A PLC project's <Project> element, its PrjFilePath taken from `dir`. */
function refOf(project: XmlElement, prj: string, dir: string): PlcProjectRef {
  return { name: project.attrs.get('Name') ?? path.basename(prj, path.extname(prj)), plcprojPath: path.resolve(dir, prj.replace(/\\/g, path.sep)) };
}

/**
 * Where the Independent Project File of a PLC project is when the .tsproj names it (`<Project File="Plc.xti"/>`):
 * in the folder _Config\PLC next to the .tsproj, where TwinCAT XAE 3.1.4026 saves it.
 */
export function xtiPathOf(tsprojPath: string, file: string): string {
  return path.resolve(path.dirname(tsprojPath), '_Config', 'PLC', file.replace(/\\/g, path.sep));
}

/**
 * The PLC projects of a .tsproj, in its order: those it holds (`<Project Name="Plc" PrjFilePath="Plc\Plc.plcproj">`
 * in <Plc>), and those saved as Independent Project Files (`<Project File="Plc.xti"/>`), with the .xti still to read
 * (see parseXtiProject).
 */
export function parseTsProject(filePath: string, text: string): TsProject {
  const doc = parseXml(text);
  const plcProjects: PlcProjectRef[] = [];
  for (const plc of findAll(doc, 'Plc')) {
    for (const proj of plc.children.filter(c => c.name === 'Project')) {
      const prj = proj.attrs.get('PrjFilePath');
      const file = proj.attrs.get('File');
      if (prj) plcProjects.push(refOf(proj, prj, path.dirname(filePath)));
      else if (file) plcProjects.push({ name: path.basename(file, path.extname(file)), plcprojPath: '', xtiPath: xtiPathOf(filePath, file) });
    }
  }
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)), plcProjects };
}

/**
 * The PLC project an Independent Project File (.xti) holds: its <Project>, as the .tsproj would hold it, but with
 * the PrjFilePath taken from the folder of the .xti (`..\..\Plc\Plc.plcproj` from _Config\PLC).
 */
export function parseXtiProject(xtiPath: string, text: string): PlcProjectRef {
  for (const proj of findAll(parseXml(text), 'Project')) {
    const prj = proj.attrs.get('PrjFilePath');
    if (prj) return { ...refOf(proj, prj, path.dirname(xtiPath)), xtiPath };
  }
  throw new Error('The file holds no PLC project (no <Project> with a PrjFilePath)');
}

export function libraryName(include: string): string {
  // "Tc2_Standard, * (Beckhoff Automation GmbH)" -> "Tc2_Standard"
  return include.split(',')[0].trim();
}

/** The elements of library references: placeholders, and libraries named with their version (older projects). */
const REFERENCE_KINDS = ['PlaceholderReference', 'LibraryReference'];

/** The reference of a `<PlaceholderReference>` or `<LibraryReference>` element, or undefined without an Include. */
function libraryRefOf(text: string, r: XmlElement): LibraryRef | undefined {
  const include = r.attrs.get('Include');
  if (!include) return undefined;
  const name = libraryName(include);
  return {
    include,
    name,
    namespace: elementText(text, child(r, 'Namespace')) || name,
    resolution: elementText(text, child(r, 'DefaultResolution')),
    system: (elementText(text, child(r, 'SystemLibrary')) ?? '').toLowerCase() === 'true',
  };
}

export function parsePlcProject(filePath: string, text: string): PlcProject {
  const doc = parseXml(text);
  const project: PlcProject = {
    path: filePath,
    dir: path.dirname(filePath),
    name: path.basename(filePath, path.extname(filePath)),
    compile: [],
    folders: [],
    libraries: [],
  };
  for (const pg of findAll(doc, 'PropertyGroup')) {
    const name = elementText(text, child(pg, 'Name'));
    if (name) project.name = name;
    const title = elementText(text, child(pg, 'Title'));
    if (title) project.title = title;
  }
  for (const c of findAll(doc, 'Compile')) {
    const inc = c.attrs.get('Include');
    if (inc) project.compile.push(inc);
  }
  for (const f of findAll(doc, 'Folder')) {
    const inc = f.attrs.get('Include');
    if (inc) project.folders.push(inc.replace(/[\\/]+$/, ''));
  }
  for (const tag of REFERENCE_KINDS) {
    for (const r of findAll(doc, tag)) {
      const lib = libraryRefOf(text, r);
      if (lib) project.libraries.push(lib);
    }
  }
  return project;
}

const upperChar = (c: string) => {
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
};

/**
 * The order of the items of a .plcproj as XAE 3.1.4026 writes them: case aside, character by character by code
 * (`POUs\FB2.TcPOU`, `POUs\FBB.TcPOU`, `POUs\FB_A.TcPOU`; `POUs\Sub\FB_C.TcPOU` before `POUs\Sub_X.TcPOU`).
 */
export function itemOrder(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = upperChar(a[i]);
    const y = upperChar(b[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Whether two names are the same, as XAE compares them: case aside (see itemOrder). */
export function sameName(a: string, b: string): boolean {
  return itemOrder(a, b) === 0;
}

export class PlcProjectEditError extends Error {}

/** Makes an element for the indentation of its line and the step of one level, its first line without the indentation. */
type ElementText = (indent: string, step: string) => string;

/**
 * The text with an element in an ItemGroup, with the indentation of the items there: before `before`, else after
 * `last`.
 */
function withItem(text: string, eol: string, group: XmlElement, element: ElementText, before: XmlElement | undefined, last: XmlElement): string {
  const anchor = before ?? last;
  const groupIndent = indentBefore(text, group.start) ?? '  ';
  const indent = indentBefore(text, anchor.start) ?? `${groupIndent}  `;
  const step = indent.length > groupIndent.length && indent.startsWith(groupIndent) ? indent.slice(groupIndent.length) : '  ';
  const el = element(indent, step);
  return before
    ? text.slice(0, before.start) + el + eol + indent + text.slice(before.start)
    : text.slice(0, last.end) + eol + indent + el + text.slice(last.end);
}

/**
 * The text with a new ItemGroup that holds an element: after the group `after`, else before the group `before`,
 * else after the last PropertyGroup, else first in the project.
 */
function withNewGroup(text: string, eol: string, project: XmlElement, element: ElementText, place: { after?: XmlElement; before?: XmlElement }): string {
  const lastPropertyGroup = children(project, 'PropertyGroup').pop();
  const sibling = place.after ?? place.before ?? lastPropertyGroup ?? project.children[0];
  const groupIndent = (sibling && indentBefore(text, sibling.start)) ?? '  ';
  const newGroup = `<ItemGroup>${eol}${groupIndent}  ${element(`${groupIndent}  `, '  ')}${eol}${groupIndent}</ItemGroup>`;
  if (place.before) return text.slice(0, place.before.start) + newGroup + eol + groupIndent + text.slice(place.before.start);
  const after = place.after ?? lastPropertyGroup;
  if (after) return text.slice(0, after.end) + eol + groupIndent + newGroup + text.slice(after.end);
  return text.slice(0, project.contentStart) + eol + groupIndent + newGroup + text.slice(project.contentStart);
}

/**
 * The .plcproj with one more `<Compile Include>` (a source file) or `<Folder Include>` item, where XAE puts it:
 * before the first item of its kind that comes after it in itemOrder, else after the last one. XAE keeps the
 * `<Folder>` items it got from its project template unsorted (`DUTs`, `GVLs`, `VISUs`, `POUs`) and inserts new
 * ones the same way. Without an item of the kind, a new ItemGroup holds it: Compile items come first, then the
 * folders. The rest of the file stays byte-identical.
 */
function addItem(text: string, kind: 'Compile' | 'Folder', include: string): string {
  const project = projectElement(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const groups = children(project, 'ItemGroup');
  const group = groups.find(g => g.children.some(c => c.name === kind));
  const element: ElementText = (indent, step) => (kind === 'Compile'
    ? [`<Compile Include="${escapeAttr(include)}">`, `${indent}${step}<SubType>Code</SubType>`, `${indent}</Compile>`].join(eol)
    : `<Folder Include="${escapeAttr(include)}" />`);
  if (group) {
    const items = group.children.filter(c => c.name === kind);
    const clash = items.find(i => sameName(i.attrs.get('Include') ?? '', include));
    if (clash) throw new PlcProjectEditError(`The project already has ${clash.attrs.get('Include')}`);
    const before = items.find(i => itemOrder(i.attrs.get('Include') ?? '', include) > 0);
    return withItem(text, eol, group, element, before, items[items.length - 1]);
  }
  // A new ItemGroup: the Compile items before every other group, the folders right after them.
  const compileGroup = groups.find(g => g.children.some(c => c.name === 'Compile'));
  return withNewGroup(text, eol, project, element, kind === 'Folder' && compileGroup ? { after: compileGroup } : { before: groups[0] });
}

/** The .plcproj with the `<Compile>` item of a new source file (`POUs\FB_X.TcPOU`), see addItem. */
export function addCompileItem(text: string, include: string): string {
  return addItem(text, 'Compile', include);
}

/** The .plcproj with the `<Folder>` item of a new folder (`POUs\Valves`), see addItem. */
export function addFolderItem(text: string, include: string): string {
  return addItem(text, 'Folder', include);
}

/** A library as a .plcproj names it: `Tc2_Standard, * (Beckhoff Automation GmbH)`, `*` for the newest installed. */
export interface LibrarySpec {
  title: string;
  version: string;
  company: string;
}

/** The library a resolution or the Include of a `<LibraryReference>` names, or undefined when it names none. */
export function parseLibrarySpec(spec: string): LibrarySpec | undefined {
  const m = /^\s*([^,]*?)\s*,\s*(\S+?)\s*\((.*)\)\s*$/.exec(spec);
  return m && m[1] ? { title: m[1], version: m[2], company: m[3].trim() } : undefined;
}

/** `Tc2_Utilities, 3.4.5.0 (Beckhoff Automation GmbH)`. */
export function formatLibrarySpec(lib: LibrarySpec): string {
  return `${lib.title}, ${lib.version} (${lib.company})`;
}

/**
 * The reference of a PLC project to a library, of either kind: the one with the Include given (a placeholder,
 * case aside), else one that resolves to the library of that title and company (case aside).
 */
export function referenceTo(references: LibraryRef[], include: string, title: string, company: string): LibraryRef | undefined {
  return references.find(r => sameName(r.include, include)) ?? references.find(r => {
    const lib = parseLibrarySpec(r.resolution ?? r.include);
    return !!lib && sameName(lib.title, title) && sameName(lib.company, company);
  });
}

/** A placeholder reference to a library, as XAE 3.1.4026's Library Manager > Add library writes one. */
export interface PlaceholderReferenceSpec {
  /** The placeholder: `Tc2_Utilities`. */
  include: string;
  /** The library it resolves to by default: `Tc2_Utilities, * (Beckhoff Automation GmbH)`. */
  resolution: string;
  namespace: string;
}

/**
 * The .plcproj with a `<PlaceholderReference>` more, where XAE 3.1.4026 puts it: among the references, before the
 * first one whose Include comes after it in itemOrder, as XAE keeps them; after the last one when they are not in
 * that order. Without references, a new ItemGroup holds it, after those of the files and folders, before the others
 * (`<None>`). The rest of the file stays byte-identical. A library the project references already (see
 * referenceTo) is refused.
 */
export function addPlaceholderReference(text: string, ref: PlaceholderReferenceSpec): string {
  const lib = parseLibrarySpec(ref.resolution);
  if (!lib) throw new PlcProjectEditError(`${ref.resolution} names no library (Title, version (Company))`);
  const project = projectElement(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const references = REFERENCE_KINDS.flatMap(k => findAll(project, k)).flatMap(r => libraryRefOf(text, r) ?? []);
  const clash = referenceTo(references, ref.include, lib.title, lib.company);
  if (clash) throw new PlcProjectEditError(`The project references ${clash.include} already`);
  const element: ElementText = (indent, step) => [
    `<PlaceholderReference Include="${escapeAttr(ref.include)}">`,
    `${indent}${step}<DefaultResolution>${escapeText(ref.resolution)}</DefaultResolution>`,
    `${indent}${step}<Namespace>${escapeText(ref.namespace)}</Namespace>`,
    `${indent}</PlaceholderReference>`,
  ].join(eol);
  const groups = children(project, 'ItemGroup');
  const holding = (kind: string) => groups.find(g => g.children.some(c => c.name === kind));
  const group = holding('PlaceholderReference') ?? holding('LibraryReference');
  if (group) {
    const items = group.children.filter(c => REFERENCE_KINDS.includes(c.name));
    const names = items.map(i => i.attrs.get('Include') ?? '');
    const sorted = names.every((n, i) => i === 0 || itemOrder(names[i - 1], n) <= 0);
    const before = sorted ? items.find((_, i) => itemOrder(names[i], ref.include) > 0) : undefined;
    return withItem(text, eol, group, element, before, items[items.length - 1]);
  }
  const fileGroups = groups.filter(g => g.children.some(c => c.name === 'Compile' || c.name === 'Folder'));
  return withNewGroup(text, eol, project, element, fileGroups.length ? { after: fileGroups[fileGroups.length - 1] } : { before: groups[0] });
}

function projectElement(text: string): XmlElement {
  const project = child(parseXml(text), 'Project');
  if (!project || project.selfClosing) throw new PlcProjectEditError('The file has no <Project> element');
  return project;
}

/** The items of a .plcproj that are paths: source files, folders and the other files it lists. */
const PATH_ITEMS = ['Compile', 'Folder', 'None', 'Content'];

/** Whether two paths of items are the same, as XAE compares them: case aside, a backslash at the end aside. */
function samePath(a: string, b: string): boolean {
  return itemOrder(a.replace(/[\\/]+$/, ''), b.replace(/[\\/]+$/, '')) === 0;
}

/** The items of these kinds with this Include. */
function itemsOf(project: XmlElement, kinds: string[], include: string): XmlElement[] {
  return kinds.flatMap(k => findAll(project, k)).filter(c => samePath(c.attrs.get('Include') ?? '', include));
}

function theItem(project: XmlElement, kind: 'Compile' | 'Folder', include: string): XmlElement {
  const items = itemsOf(project, [kind], include);
  if (items.length === 0) throw new PlcProjectEditError(`The project has no item ${include}`);
  if (items.length > 1) throw new PlcProjectEditError(`The project lists ${include} ${items.length} times`);
  return items[0];
}

/** The text with the Include of each item replaced. */
function withIncludes(text: string, changes: { item: XmlElement; include: string }[]): string {
  const edits = changes.map(({ item, include }) => {
    const range = attributeRange(text, item, 'Include');
    if (!range) throw new PlcProjectEditError(`The item of ${item.attrs.get('Include')} has no Include attribute`);
    return { ...range, value: escapeAttr(include) };
  });
  return edits.sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.value + t.slice(e.end), text);
}

/**
 * The .plcproj with the `<Compile>` item of a renamed or moved source file (`POUs\FB_A.TcPOU` to
 * `POUs\FB_B.TcPOU` or `POUs\Valves\FB_A.TcPOU`), in place: XAE 3.1.4026 leaves the items where they are when their
 * path changes (a renamed object, a renamed folder). The rest of the file stays byte-identical.
 */
export function renameCompileItem(text: string, include: string, newInclude: string): string {
  const project = projectElement(text);
  const item = theItem(project, 'Compile', include);
  const clash = itemsOf(project, PATH_ITEMS, newInclude).find(c => c !== item);
  if (clash) throw new PlcProjectEditError(`The project already has ${clash.attrs.get('Include')}`);
  return withIncludes(text, [{ item, include: newInclude }]);
}

/**
 * The .plcproj with a folder renamed or moved (`POUs\Valves` to `POUs\Pumps` or `Area\Valves`): its `<Folder>`
 * item and the items of everything under it take the new path, in place, as XAE 3.1.4026 renames a folder. A
 * folder known only by the paths of its files has no `<Folder>` item. The rest stays byte-identical.
 */
export function renameFolderItems(text: string, folder: string, newFolder: string): string {
  const from = folder.replace(/[\\/]+$/, '');
  const to = newFolder.replace(/[\\/]+$/, '');
  const under = (p: string) => samePath(p, from) || samePath(p.slice(0, from.length + 1), `${from}\\`);
  if (!from || !to) throw new PlcProjectEditError('A folder of the project has a name');
  if (under(to) && !samePath(to, from)) throw new PlcProjectEditError(`${from} cannot go into itself`);
  const project = projectElement(text);
  const all = PATH_ITEMS.flatMap(k => findAll(project, k));
  const moved = all.filter(i => under(i.attrs.get('Include') ?? ''));
  if (moved.length === 0) throw new PlcProjectEditError(`The project has no folder ${from}`);
  const changes = moved.map(item => ({ item, include: to + item.attrs.get('Include')!.slice(from.length) }));
  for (const { include } of changes) {
    const clash = all.find(i => !moved.includes(i) && samePath(i.attrs.get('Include') ?? '', include));
    if (clash) throw new PlcProjectEditError(`The project already has ${clash.attrs.get('Include')}`);
  }
  return withIncludes(text, changes);
}

/** The .plcproj without the `<Compile>` item of a source file, as when XAE deletes the object, or the `<Folder>` item of a folder. */
export function removeItem(text: string, kind: 'Compile' | 'Folder', include: string): string {
  const lines = elementLines(text, theItem(projectElement(text), kind, include));
  return text.slice(0, lines.start) + text.slice(lines.end);
}

/** The `<Name>` elements of the calls of a task (`.TcTTO`): `<PouCall><Name>MAIN</Name></PouCall>`. */
function callNames(text: string): XmlElement[] {
  return findAll(parseXml(text), 'PouCall').map(call => child(call, 'Name')).filter((n): n is XmlElement => !!n && !n.selfClosing);
}

/** The programs a task (`.TcTTO`) calls. */
export function taskCalls(text: string): string[] {
  return callNames(text).map(n => elementText(text, n) ?? '').filter(n => n);
}

/**
 * The text of a task (`.TcTTO`) with its calls of a program renamed (`<PouCall><Name>MAIN</Name>`), as XAE renames
 * them with the program; the text as it was when it does not call it. The rest stays byte-identical.
 */
export function renameTaskCalls(text: string, program: string, newName: string): string {
  const upper = program.toUpperCase();
  const names = callNames(text).filter(n => elementText(text, n)?.toUpperCase() === upper);
  return names.sort((a, b) => b.contentStart - a.contentStart).reduce((t, n) => {
    const content = t.slice(n.contentStart, n.contentEnd);
    const lead = /^\s*/.exec(content)![0];
    const trail = /\s*$/.exec(content)![0];
    return t.slice(0, n.contentStart) + lead + escapeAttr(newName) + trail + t.slice(n.contentEnd);
  }, text);
}

/** Library name of a placeholder resolution such as "[Components], * (Acme)" or "Tc2_Standard, * (...)". */
export function resolutionLibraryName(lib: LibraryRef): string {
  const res = lib.resolution ?? lib.include;
  const m = /^\s*\[?([^\],]+)\]?/.exec(res);
  return (m ? m[1] : lib.name).trim();
}

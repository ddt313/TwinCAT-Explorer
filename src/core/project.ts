// Parsing of TwinCAT project files: .tsproj (system project) and .plcproj (PLC project); the items of the
// .plcproj for new, renamed, moved and deleted source files and folders; the calls of a task (.TcTTO).

import * as path from 'path';
import { XmlElement, attributeRange, child, children, elementLines, elementText, escapeAttr, indentBefore, parseXml } from './xml';

export interface PlcProjectRef {
  name: string;
  plcprojPath: string;
}

export interface TsProject {
  path: string;
  name: string;
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

function findAll(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function parseTsProject(filePath: string, text: string): TsProject {
  const doc = parseXml(text);
  const plcProjects: PlcProjectRef[] = [];
  for (const plc of findAll(doc, 'Plc')) {
    for (const proj of plc.children.filter(c => c.name === 'Project')) {
      const prj = proj.attrs.get('PrjFilePath');
      if (!prj) continue;
      plcProjects.push({
        name: proj.attrs.get('Name') ?? path.basename(prj, path.extname(prj)),
        plcprojPath: path.resolve(path.dirname(filePath), prj.replace(/\\/g, path.sep)),
      });
    }
  }
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)), plcProjects };
}

function libraryName(include: string): string {
  // "Tc2_Standard, * (Beckhoff Automation GmbH)" -> "Tc2_Standard"
  return include.split(',')[0].trim();
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
  for (const tag of ['PlaceholderReference', 'LibraryReference']) {
    for (const r of findAll(doc, tag)) {
      const inc = r.attrs.get('Include');
      if (!inc) continue;
      const name = libraryName(inc);
      project.libraries.push({
        include: inc,
        name,
        namespace: elementText(text, child(r, 'Namespace')) || name,
        resolution: elementText(text, child(r, 'DefaultResolution')),
        system: (elementText(text, child(r, 'SystemLibrary')) ?? '').toLowerCase() === 'true',
      });
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

export class PlcProjectEditError extends Error {}

/**
 * The .plcproj with one more `<Compile Include>` (a source file) or `<Folder Include>` item, where XAE puts it:
 * before the first item of its kind that comes after it in itemOrder, else after the last one. XAE keeps the
 * `<Folder>` items it got from its project template unsorted (`DUTs`, `GVLs`, `VISUs`, `POUs`) and inserts new
 * ones the same way. Without an item of the kind, a new ItemGroup holds it: Compile items come first, then the
 * folders. The rest of the file stays byte-identical.
 */
function addItem(text: string, kind: 'Compile' | 'Folder', include: string, given?: string): string {
  const project = projectElement(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const groups = children(project, 'ItemGroup');
  const group = groups.find(g => g.children.some(c => c.name === kind));
  const element = (indent: string, step: string) => given ?? (kind === 'Compile'
    ? [`<Compile Include="${escapeAttr(include)}">`, `${indent}${step}<SubType>Code</SubType>`, `${indent}</Compile>`].join(eol)
    : `<Folder Include="${escapeAttr(include)}" />`);
  if (group) {
    const items = group.children.filter(c => c.name === kind);
    const clash = items.find(i => itemOrder(i.attrs.get('Include') ?? '', include) === 0);
    if (clash) throw new PlcProjectEditError(`The project already has ${clash.attrs.get('Include')}`);
    const before = items.find(i => itemOrder(i.attrs.get('Include') ?? '', include) > 0);
    const anchor = before ?? items[items.length - 1];
    const groupIndent = indentBefore(text, group.start) ?? '  ';
    const indent = indentBefore(text, anchor.start) ?? `${groupIndent}  `;
    const step = indent.length > groupIndent.length && indent.startsWith(groupIndent) ? indent.slice(groupIndent.length) : '  ';
    const el = element(indent, step);
    return before
      ? text.slice(0, before.start) + el + eol + indent + text.slice(before.start)
      : text.slice(0, anchor.end) + eol + indent + el + text.slice(anchor.end);
  }
  // A new ItemGroup: the Compile items before every other group, the folders right after them.
  const compileGroup = groups.find(g => g.children.some(c => c.name === 'Compile'));
  const afterGroup = kind === 'Folder' ? compileGroup : undefined;
  const beforeGroup = afterGroup ? undefined : groups[0];
  const lastPropertyGroup = children(project, 'PropertyGroup').pop();
  const sibling = afterGroup ?? beforeGroup ?? lastPropertyGroup ?? project.children[0];
  const groupIndent = (sibling && indentBefore(text, sibling.start)) ?? '  ';
  const newGroup = `<ItemGroup>${eol}${groupIndent}  ${element(`${groupIndent}  `, '  ')}${eol}${groupIndent}</ItemGroup>`;
  if (beforeGroup) return text.slice(0, beforeGroup.start) + newGroup + eol + groupIndent + text.slice(beforeGroup.start);
  const after = afterGroup ?? lastPropertyGroup;
  if (after) return text.slice(0, after.end) + eol + groupIndent + newGroup + text.slice(after.end);
  return text.slice(0, project.contentStart) + eol + groupIndent + newGroup + text.slice(project.contentStart);
}

/** The .plcproj with the `<Compile>` item of a new source file (`POUs\FB_X.TcPOU`), see addItem. */
export function addCompileItem(text: string, include: string): string {
  return addItem(text, 'Compile', include);
}

/** The .plcproj with the `<Folder>` item of a new folder (`POUs\Valves`), see addItem. */
export function addFolderItem(text: string, include: string): string {
  return addItem(text, 'Folder', include);
}

function projectElement(text: string): XmlElement {
  const project = child(parseXml(text), 'Project');
  if (!project || project.selfClosing) throw new PlcProjectEditError('The file has no <Project> element');
  return project;
}

/** The items of a kind with this Include, case aside, as XAE compares them. */
function itemsOf(project: XmlElement, kind: 'Compile' | 'Folder', include: string): XmlElement[] {
  const wanted = include.replace(/[\\/]+$/, '');
  return findAll(project, kind).filter(c => itemOrder((c.attrs.get('Include') ?? '').replace(/[\\/]+$/, ''), wanted) === 0);
}

function theItem(project: XmlElement, kind: 'Compile' | 'Folder', include: string): XmlElement {
  const items = itemsOf(project, kind, include);
  if (items.length === 0) throw new PlcProjectEditError(`The project has no item ${include}`);
  if (items.length > 1) throw new PlcProjectEditError(`The project lists ${include} ${items.length} times`);
  return items[0];
}

/** The item with its Include changed, refused when another item has the new one. */
function renamedItem(text: string, project: XmlElement, item: XmlElement, newInclude: string): { start: number; end: number; element: string } {
  const clash = itemsOf(project, 'Compile', newInclude).find(c => c !== item);
  if (clash) throw new PlcProjectEditError(`The project already has ${clash.attrs.get('Include')}`);
  const range = attributeRange(text, item, 'Include');
  if (!range) throw new PlcProjectEditError(`The item of ${item.attrs.get('Include')} has no Include attribute`);
  const element = text.slice(item.start, range.start) + escapeAttr(newInclude) + text.slice(range.end, item.end);
  return { start: item.start, end: item.end, element };
}

/**
 * The .plcproj with the `<Compile>` item of a renamed source file (`POUs\FB_A.TcPOU` to `POUs\FB_B.TcPOU`), in
 * place: XAE 3.1.4026 leaves it where it was when it renames an object. The rest of the file stays byte-identical.
 */
export function renameCompileItem(text: string, include: string, newInclude: string): string {
  const project = projectElement(text);
  const r = renamedItem(text, project, theItem(project, 'Compile', include), newInclude);
  return text.slice(0, r.start) + r.element + text.slice(r.end);
}

/**
 * The .plcproj with the `<Compile>` item of a source file moved to another folder (`POUs\FB_A.TcPOU` to
 * `POUs\Valves\FB_A.TcPOU`): the item, as it was but for its Include, goes where XAE puts a new item (see addItem).
 */
export function moveCompileItem(text: string, include: string, newInclude: string): string {
  const project = projectElement(text);
  const item = theItem(project, 'Compile', include);
  const { element } = renamedItem(text, project, item, newInclude);
  const lines = elementLines(text, item);
  return addItem(text.slice(0, lines.start) + text.slice(lines.end), 'Compile', newInclude, element);
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

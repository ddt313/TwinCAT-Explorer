// Changes of TwinCAT files on disk that the VS Code commands and the MCP server share: a source file read, changed
// and written back with its BOM; members added and removed; a new object's file and its items in the .plcproj. They
// throw an Error with the message to show; asking the user and handling editors stay with the caller. Independent of
// the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import { TcSourceFile, decodeBytes, encodeText, fileKindFromPath, parseTcFile, parseTcText } from './tcfile';
import { MemberSpec, addMember, removeMember } from './splice';
import { FileStyle, NewObjectKind, NewObjectSpec, XAE_FILE_STYLE, fileStyleOf, newObjectText, objectExtension } from './newObjects';
import { PlcProject, addCompileItem, addFolderItem, parsePlcProject, projectFolderList } from './project';
import { TcWorkspace } from './workspace';

/** Changes a source file as it is on disk and writes it back with its BOM; returns the file as written. */
export function rewriteSourceFile(fsPath: string, change: (file: TcSourceFile) => string): TcSourceFile {
  const read = parseTcFile(fsPath, fs.readFileSync(fsPath));
  const file = parseTcText(fsPath, change(read), read.bom);
  fs.writeFileSync(fsPath, encodeText(file.text, read.bom));
  return file;
}

/** Adds members (methods, properties, actions) to a POU or interface of a file on disk. */
export function addMembersToFile(fsPath: string, ownerId: string, specs: MemberSpec[]): TcSourceFile {
  return rewriteSourceFile(fsPath, file => {
    let f = file;
    for (const spec of specs) f = parseTcText(fsPath, addMember(f, ownerId, spec), file.bom);
    return f.text;
  });
}

/** Removes a member, or an accessor of a property, from a file on disk. */
export function removeMemberFromFile(fsPath: string, objectId: string, accessor?: 'Get' | 'Set'): TcSourceFile {
  return rewriteSourceFile(fsPath, file => removeMember(file, objectId, accessor));
}

/** The file of a new object in a folder of a PLC project (`POUs\Valves`, empty for the project's top), and its <Compile> include. */
export function newObjectFile(project: PlcProject, folder: string, name: string, kind: NewObjectKind): { fsPath: string; include: string } {
  const file = `${name}${objectExtension(kind)}`;
  const include = folder ? `${folder}\\${file}` : file;
  return { fsPath: path.join(project.dir, ...include.split('\\')), include };
}

/** The XML header, line breaks and BOM of the first readable source file of the project, else XAE 4026's. */
export function projectFileStyle(ws: TcWorkspace, project: PlcProject): FileStyle {
  for (const e of ws.sourceEntries) {
    if (e.project !== project || !['pou', 'dut', 'gvl', 'itf'].includes(fileKindFromPath(e.path))) continue;
    const file = ws.getFile(e.path);
    const style = file && fileStyleOf(file);
    if (style) return style;
  }
  return XAE_FILE_STYLE;
}

/**
 * The text of a new object's file, with the given members added to its root (the methods and properties of the
 * interfaces a function block implements).
 */
export function newObjectFileText(spec: NewObjectSpec, style: FileStyle, fsPath: string, members: MemberSpec[] = []): string {
  let text = newObjectText(spec, style);
  if (members.length) {
    let file = parseTcText(fsPath, text, style.bom);
    for (const m of members) file = parseTcText(fsPath, addMember(file, file.root!.id, m), style.bom);
    text = file.text;
  }
  return text;
}

/**
 * The .plcproj with a <Folder> item for each folder on the way to a file (`POUs`, `POUs\Valves`) that the project has
 * neither as an item nor as the folder of a file: XAE writes one for every folder it makes.
 */
function withFolderItems(text: string, plcprojPath: string, include: string): string {
  const known = new Set(projectFolderList(parsePlcProject(plcprojPath, text)).map(f => f.toUpperCase()));
  const parts = include.split('\\').slice(0, -1);
  let out = text;
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join('\\');
    if (!known.has(folder.toUpperCase())) out = addFolderItem(out, folder);
  }
  return out;
}

/**
 * Writes the file of a new object, its <Compile> item in the .plcproj and the <Folder> items of the folders it makes.
 * The new .plcproj text is made first, so nothing is written when it cannot be; a file already on disk is refused.
 */
export function writeNewObject(project: PlcProject, fsPath: string, include: string, text: string, bom: boolean): void {
  changePlcProject(project, plcproj => addCompileItem(withFolderItems(plcproj, project.path, include), include), () => {
    if (fs.existsSync(fsPath)) throw new Error(`${path.basename(fsPath)} is already on disk in ${path.dirname(fsPath)}`);
    fs.mkdirSync(path.dirname(fsPath), { recursive: true });
    fs.writeFileSync(fsPath, encodeText(text, bom));
  });
}

/**
 * Changes the .plcproj as it is on disk (with its BOM) after `before` wrote what goes with it: the new .plcproj
 * text is made first, so nothing is written when it cannot be.
 */
export function changePlcProject(project: PlcProject, edit: (plcproj: string) => string, before: () => void): void {
  const { text, bom } = decodeBytes(fs.readFileSync(project.path));
  const changed = edit(text);
  before();
  fs.writeFileSync(project.path, encodeText(changed, bom));
}

// What adding objects (POUs, DUTs, GVLs, interfaces) and folders to a PLC project needs from the language: the
// checks of the names typed in, and the methods and properties a new function block gets from its interfaces.

import * as path from 'path';
import { LanguageIndex } from './index';
import { InterfaceStubs, nameProblem, stubsFor } from './members';
import { parseDeclaration } from './parser';
import { PouSym } from './symbols';
import { NewObjectSpec, objectDeclaration } from '../core/newObjects';
import { PlcProject, itemOrder } from '../core/project';
import { TcFileKind, fileKindFromPath } from '../core/tcfile';
import { TcWorkspace } from '../core/workspace';

const KIND_WORDS: Partial<Record<TcFileKind, string>> = { pou: 'a POU', dut: 'a DUT', gvl: 'a GVL', itf: 'an interface' };

/** The POUs, DUTs, GVLs and interfaces of a PLC project by upper case name: what each is and its name. */
export function projectObjectNames(ws: TcWorkspace, project: PlcProject): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of ws.sourceEntries) {
    const word = KIND_WORDS[fileKindFromPath(e.path)];
    if (e.project !== project || !word) continue;
    // The object's name, else the file's (the same, unless the file could not be read).
    const name = ws.getFile(e.path)?.root?.name ?? path.basename(e.path, path.extname(e.path));
    names.set(name.toUpperCase(), `${word} named ${name}`);
  }
  return names;
}

/**
 * Why a new POU, DUT, GVL or interface of the PLC project cannot have this name (not an identifier, a keyword,
 * the name of another of them: they share one namespace, case aside); undefined when it can.
 */
export function objectNameProblem(ws: TcWorkspace, project: PlcProject, name: string,
  names: Map<string, string> = projectObjectNames(ws, project)): string | undefined {
  const taken = names.get(name.toUpperCase());
  return nameProblem(name) ?? (taken ? `${project.name} already has ${taken}` : undefined);
}

/**
 * The folders of the PLC project (`POUs`, `POUs\Valves`): those of its <Folder> items and the folders of its files,
 * once each (case aside), in XAE's order of items.
 */
export function projectFolderList(project: PlcProject): string[] {
  const out = new Map<string, string>();
  const add = (folder: string) => {
    if (folder && !out.has(folder.toLowerCase())) out.set(folder.toLowerCase(), folder);
  };
  project.folders.forEach(add);
  for (const include of project.compile) {
    const parts = include.split('\\').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) add(parts.slice(0, i).join('\\'));
  }
  return [...out.values()].sort(itemOrder);
}

/** The folders of the PLC project, lower case (see projectFolderList). */
function projectFolders(project: PlcProject): Set<string> {
  return new Set(projectFolderList(project).map(f => f.toLowerCase()));
}

/** Why a new folder in `parent` (`POUs\Sub`, empty for the project itself) cannot have this name; undefined when it can. */
export function folderNameProblem(project: PlcProject, parent: string, name: string): string | undefined {
  if (!name) return 'Enter a name';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return 'A folder name has none of \\ / : * ? " < > |';
  if (/[. ]$/.test(name) || /^\.+$/.test(name)) return 'A folder name does not end with a dot or a space';
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..*)?$/i.test(name)) return `${name} is a name Windows keeps for itself`;
  const include = parent ? `${parent}\\${name}` : name;
  if (projectFolders(project).has(include.toLowerCase())) return `${project.name} already has the folder ${include}`;
  return undefined;
}

/**
 * The methods and properties a new function block gets from the interfaces it implements (and those they extend),
 * less those it gets from the function block it extends: resolved in the scope of its PLC project.
 */
export function newObjectStubs(index: LanguageIndex, project: PlcProject, spec: NewObjectSpec): InterfaceStubs {
  const scope = index.projectScope(project);
  if (!scope) throw new Error(`${project.name} is not a PLC project of the workspace`);
  const header = parseDeclaration(objectDeclaration(spec)).units[0]?.header;
  if (spec.kind !== 'fb' || !header) return { stubs: [], interfaces: [], missing: [] };
  const bases = header.extends
    .map(q => index.resolveGlobal(q.parts, scope))
    .filter((g): g is PouSym => g?.kind === 'pou' && g.pouKind === 'FB');
  return stubsFor(index, scope, header.implements, bases, []);
}

export interface BaseProblem {
  message: string;
  /** Not a name at all, rather than a name the project does not know (which a library without a stub may have). */
  blocking: boolean;
}

/**
 * What is wrong with the names typed after EXTENDS or IMPLEMENTS (one, or a list with commas): not names, or
 * not a function block, interface or structure the project knows. Undefined when nothing is.
 */
export function baseProblem(index: LanguageIndex, project: PlcProject, text: string, kind: 'FB' | 'ITF' | 'struct', list: boolean): BaseProblem | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const parsed = kind === 'struct' ? parseDeclaration(`TYPE X EXTENDS ${t} : STRUCT END_STRUCT END_TYPE`) : parseDeclaration(`INTERFACE X EXTENDS ${t}`);
  const names = (kind === 'struct' ? [parsed.units.flatMap(u => u.typeDecls)[0]?.extends] : parsed.units[0]?.header?.extends ?? [])
    .filter((q): q is NonNullable<typeof q> => !!q);
  if (parsed.errors.length || names.length === 0 || (!list && names.length > 1)) {
    return { message: `'${t}' is not ${list ? 'a list of names' : 'a name'}${parsed.errors[0] ? `: ${parsed.errors[0].message}` : ''}`, blocking: true };
  }
  const scope = index.projectScope(project);
  if (!scope) return undefined;
  const unknown = names.filter(q => {
    const g = index.resolveGlobal(q.parts, scope);
    return kind === 'struct' ? g?.kind !== 'type' || g.dutKind !== 'struct' : g?.kind !== 'pou' || g.pouKind !== kind;
  }).map(q => q.parts.map(p => p.name).join('.'));
  const what = kind === 'struct' ? 'structure' : kind === 'FB' ? 'function block' : 'interface';
  return unknown.length ? { message: `No ${what} ${unknown.join(', ')} in ${project.name} or its library stubs`, blocking: false } : undefined;
}

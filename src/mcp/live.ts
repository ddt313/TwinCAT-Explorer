// The MCP server's way into a TwinCAT XAE that has the project open: the tree item of a view, the sub-types
// CreateChild takes, and an item's code kept to make it again (undo of a delete). When XAE has the project open,
// the write tools go through it (tools.ts): XAE then shows the change at once and never asks to reload, and XAE
// saves what changed itself. Independent of the VS Code API.

import * as path from 'path';
import { PlcProject } from '../core/project';
import { fileKey } from '../core/workspace';
import { Session, ToolError, View } from './session';
import { Xae, XaeError, XaeItem } from '../core/xae';

export interface Live {
  xae: Xae;
  /** The XAE item of the view (or, from `itemOf`, of any path). */
  item: XaeItem;
  /** XAE's process id, for the answers. */
  pid: number;
}

/**
 * The .tsproj files that hold a PLC project, each with the PLC project's name there (XAE's tree names it so): a
 * simulation's .tsproj can list the machine's .plcproj too.
 */
export function plcsOf(s: Session, project: PlcProject): { tsproj: string; plc: string }[] {
  const key = fileKey(project.path);
  const out: { tsproj: string; plc: string }[] = [];
  for (const ts of s.ws.tsProjects) {
    const ref = ts.plcProjects.find(r => fileKey(r.plcprojPath) === key);
    if (ref) out.push({ tsproj: ts.path, plc: ref.name });
  }
  return out;
}

/** The folders of a file in its PLC project (`POUs`, `Valves`), from its <Compile> include. */
export function folderOf(include: string): string[] {
  const dir = path.dirname(include.replace(/\\/g, '/'));
  return dir === '.' ? [] : dir.split('/');
}

/** The path below the nested PLC project of a view's tree item: folders, POU, folders in the POU, member, accessor. */
export function viewPath(v: View): string[] {
  const out = [...folderOf(v.entry.include)];
  const root = v.obj.parent ?? v.obj;
  out.push(root.name);
  if (v.obj.parent) out.push(...v.obj.folderPath, v.obj.name);
  if (v.accessor) out.push(v.accessor);
  return out;
}

/**
 * The XAE that has a PLC project open, through any .tsproj that holds it, with an item of it; undefined when none
 * has (the files are written then).
 */
export function liveProject(s: Session, xae: Xae | undefined, project: PlcProject, itemPath: string[], file?: string): Live | undefined {
  if (!xae) return undefined;
  for (const at of plcsOf(s, project)) {
    const inst = inXae(() => xae.instanceFor(at.tsproj));
    if (inst) return { xae, pid: inst.pid, item: { pid: inst.pid, tsproj: at.tsproj, plc: at.plc, path: itemPath, file } };
  }
  return undefined;
}

export function liveView(s: Session, xae: Xae | undefined, v: View): Live | undefined {
  return liveProject(s, xae, v.entry.project, viewPath(v), v.entry.path);
}

/** Runs XAE calls, an XaeError coming back as the tool's error. */
export function inXae<R>(fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    if (e instanceof XaeError) throw new ToolError(e.message);
    throw e;
  }
}

/** CreateChild's sub-types (Beckhoff's Automation Interface: TREEITEMTYPE_PLC...). */
export const SUBTYPE = {
  folder: 601, prg: 602, fun: 603, fb: 604, enum: 605, struct: 606, union: 607, action: 608, method: 609,
  itfMethod: 610, property: 611, itfProperty: 612, get: 613, set: 614, gvl: 615, transition: 616, itf: 618, alias: 623,
  itfGet: 654, itfSet: 655,
} as const;

/** ST, as CreateChild's vInfo names the language. */
export const ST = 1;

/** An item as it was, to make it again: its name, sub-type, vInfo and code, and its children. */
export interface ItemCopy {
  name: string;
  subType: number;
  info?: (string | number)[];
  decl?: string;
  impl?: string;
  children: ItemCopy[];
}

/** The type in a property's declaration (`PROPERTY PUBLIC P_Speed : LREAL`), which CreateChild needs. */
export function propertyType(decl: string): string {
  return /:\s*([^\s;(]+(?:\s*\([^)]*\))?)\s*$/m.exec(decl.split('\n')[0])?.[1] ?? 'BOOL';
}

/** Makes a copy again under a parent item, then saves the file. */
export function recreate(live: Live, parent: XaeItem, copy: ItemCopy): void {
  live.xae.create(parent, copy.name, copy.subType, copy.info, copy.decl);
  const item = { ...parent, path: [...parent.path, copy.name] };
  if (copy.impl) {
    const now = live.xae.get(item, 'impl');
    live.xae.set(item, 'impl', copy.impl, now.hash);
  }
  for (const c of copy.children) recreate(live, item, c);
}

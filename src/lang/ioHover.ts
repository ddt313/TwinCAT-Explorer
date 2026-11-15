// What a variable declared `AT %I*` / `AT %Q*` is linked to, for its hover: the channel of a terminal (or the NC
// axis, TcCOM object, other PLC) of each link in the TwinCAT project, as XAE last saved the .tsproj. A variable of a
// GVL or a program is one variable of the process image; one of a function block is one per instance
// (`MAIN.fbSensorLeft.bSignal`), each with its own links. Independent of the VS Code API.

import * as path from 'path';
import * as A from './ast';
import { IoLinksIn, TcWorkspace } from '../core/workspace';
import { PlcProject } from '../core/project';
import { IoLink, IoLinkIndex, describeTarget } from '../core/ioLinks';
import { LanguageIndex } from './index';
import { ancestors } from './hierarchy';
import { GlobalSym, PouSym, Scope, Sym, VarSym } from './symbols';

/** Backticks a name, as Markdown code. */
function code(s: string): string {
  return `\`${s.replace(/`/g, '\'')}\``;
}

/**
 * The I/O links of a variable with an address `AT %I*` / `AT %Q*` (not a fixed one, `AT %IX0.0`) of a GVL, a
 * program or a function block, as Markdown; undefined for any other symbol, and for a PLC project that no TwinCAT
 * project links anything of.
 */
export function ioLinkHover(ws: TcWorkspace, index: LanguageIndex, s: Sym): string | undefined {
  const io = ioOf(ws, s);
  if (!io) return undefined;
  const blocks = io.links.map(({ tsProject, plc, index: links }) => {
    const title = `**I/O** · ${path.basename(tsProject.path)}`;
    const lines = io.fb
      ? instanceLines(index, io.project, links, plc, io.fb, io.v)
      : variableLines(links, plc, io.variable);
    return `${title}\n\n${lines.join('\n')}`;
  });
  return blocks.join('\n\n');
}

/**
 * What a variable `AT %I*` / `AT %Q*` that no TwinCAT project links to any I/O is told, for an information at its
 * declaration: one of a GVL or program linked to nothing, not even in part (a member, an element); one of a
 * function block that some instance of the last build has linked to nothing. Undefined when it is linked, and when
 * that is not known (a project without links, a function block with no instance in the last build).
 */
export function unlinkedIoMessage(ws: TcWorkspace, index: LanguageIndex, s: Sym): string | undefined {
  const io = ioOf(ws, s);
  if (!io) return undefined;
  const where: string[] = [];
  let instancesOff = '';
  for (const { tsProject, plc, index: links } of io.links) {
    const file = path.basename(tsProject.path);
    if (!io.fb) {
      const { own, parts } = links.linksOf(plc, io.variable);
      if (!own.length && !parts.length) where.push(file);
      continue;
    }
    const scope = index.projectScope(io.project);
    const instances = scope ? instancesOf(index, scope, io.fb, io.v.name, links.variables(plc)) : [];
    const off = instances.filter(inst => {
      const { own, parts } = links.linksOf(plc, `${inst}.${io.v.name}`);
      return !own.length && !parts.length;
    });
    if (!off.length) continue;
    where.push(file);
    const shown = off.slice(0, 3).join(', ') + (off.length > 3 ? ` and ${off.length - 3} more` : '');
    instancesOff = off.length === instances.length
      ? `in ${instances.length === 1 ? 'its instance' : `any of its ${instances.length} instances`} (${shown})`
      : `in ${off.length} of its ${instances.length} instances: ${shown}`;
  }
  if (!where.length) return undefined;
  const name = io.fb ? `${io.fb.name}.${io.v.name}` : io.variable;
  return `${name} is not linked to any I/O${io.fb ? ` ${instancesOff}` : ''} (${where.join(', ')}).`;
}

/** A variable `AT %I*` / `AT %Q*` of a GVL, program or function block, and the links of its PLC project. */
interface VarIo {
  v: VarSym;
  project: PlcProject;
  links: IoLinksIn[];
  /** Of a GVL or program: the variable of the process image (`GVL_IO.bStartButton`). */
  variable: string;
  /** Of a function block: the function block, one variable per instance. */
  fb?: PouSym;
}

function ioOf(ws: TcWorkspace, s: Sym): VarIo | undefined {
  if (s.kind !== 'var' || !s.at?.includes('*') || !s.loc) return undefined;
  const owner = s.owner;
  const global = owner.kind === 'gvl' || (owner.kind === 'pou' && owner.pouKind === 'PRG');
  const fb = owner.kind === 'pou' && owner.pouKind === 'FB' ? owner : undefined;
  if (!global && !fb) return undefined;
  const project = ws.entry(s.loc.fileKey)?.project;
  if (!project) return undefined;
  const links = ws.ioLinks(project.path).filter(l => l.index.hasLinks(l.plc));
  if (!links.length) return undefined;
  return { v: s, project, links, variable: `${owner.name}.${s.name}`, fb };
}

/** The links of one variable of the process image, and of its members and elements. */
function variableLines(links: IoLinkIndex, plc: string, variable: string): string[] {
  const { own, parts } = links.linksOf(plc, variable);
  const lines: string[] = [];
  for (const l of own) lines.push(`- ${code(describeTarget(l))}`);
  for (const l of parts) lines.push(`- ${code(partOf(l, variable))} → ${code(describeTarget(l))}`);
  if (!lines.length) {
    lines.push(links.imageVar(plc, variable)
      ? 'Not linked.'
      : 'Not linked. The last build in TwinCAT XAE did not have this variable: build and save the project in XAE to link it.');
  }
  return lines;
}

/** The links of the variable in each instance of the function block, by the instance's path. */
function instanceLines(index: LanguageIndex, project: PlcProject, links: IoLinkIndex, plc: string, fb: PouSym, v: VarSym): string[] {
  const scope = index.projectScope(project);
  const instances = scope ? instancesOf(index, scope, fb, v.name, links.variables(plc)) : [];
  if (!instances.length) {
    return [`No instance of ${code(fb.name)} with this variable in the last build in TwinCAT XAE: build and save the project in XAE to link it.`];
  }
  const lines: string[] = [];
  for (const inst of instances) {
    const variable = `${inst}.${v.name}`;
    const { own, parts } = links.linksOf(plc, variable);
    for (const l of own) lines.push(`- ${code(variable)} → ${code(describeTarget(l))}`);
    for (const l of parts) lines.push(`- ${code(variable + partOf(l, variable))} → ${code(describeTarget(l))}`);
    if (!own.length && !parts.length) lines.push(`- ${code(variable)}: not linked`);
  }
  return lines;
}

/** The part of a variable a link is of, as written after it: `.bReady`, `[1]`. */
function partOf(l: IoLink, variable: string): string {
  return l.variable.slice(variable.length);
}

/** `MAIN.aFb[1].st.b` → `MAIN`, `aFb[1]`, `st`, `b`: split at the dots outside brackets. */
function segments(variable: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < variable.length; i++) {
    const c = variable[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '.' && depth === 0) {
      out.push(variable.slice(start, i));
      start = i + 1;
    }
  }
  out.push(variable.slice(start));
  return out;
}

/** `aFb[1][2]` → name `AFB` and 2 indexes. */
function nameAndIndexes(segment: string): { upper: string; indexes: number } {
  const i = segment.indexOf('[');
  const name = (i < 0 ? segment : segment.slice(0, i)).trim();
  let indexes = 0;
  let depth = 0;
  for (const c of segment) {
    if (c === '[' && depth++ === 0) indexes++;
    else if (c === ']') depth--;
  }
  return { upper: name.toUpperCase(), indexes };
}

/**
 * The paths of the instances of a function block (or of one that extends it) that have a variable, as the process
 * image and the links of the PLC project name it: `MAIN.fbSensorLeft` of `MAIN.fbSensorLeft.bSignal`. Each path is
 * checked against the declarations: from a program or a GVL, through variables, struct members and array elements,
 * to an instance of the function block.
 */
export function instancesOf(index: LanguageIndex, scope: Scope, fb: PouSym, name: string, variables: string[]): string[] {
  const upper = name.toUpperCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const variable of variables) {
    const segs = segments(variable);
    for (let i = 2; i < segs.length; i++) {
      if (nameAndIndexes(segs[i]).upper !== upper) continue;
      const prefix = segs.slice(0, i);
      const k = prefix.join('.').replace(/\s+/g, '').toUpperCase();
      if (seen.has(k)) continue;
      const g = walk(index, scope, prefix);
      if (g?.kind === 'pou' && g.pouKind === 'FB' && (g === fb || ancestors(index, g).has(fb))) {
        seen.add(k);
        out.push(prefix.join('.'));
      }
    }
  }
  return out;
}

/** The type a path of the process image ends at (`MAIN`, `fbSensorLeft`): a program or GVL first, then its variables. */
function walk(index: LanguageIndex, scope: Scope, segs: string[]): GlobalSym | undefined {
  const first = nameAndIndexes(segs[0]);
  if (first.indexes) return undefined;
  let cur = index.lookupGlobal(scope, first.upper);
  if (!cur || (cur.kind === 'pou' && cur.pouKind !== 'PRG') || cur.kind === 'type') return undefined;
  for (const seg of segs.slice(1)) {
    if (!cur) return undefined;
    const { upper, indexes } = nameAndIndexes(seg);
    const v = membersOf(index, cur).find(m => m.name.toUpperCase() === upper);
    if (!v) return undefined;
    cur = typeOf(index, v.typeSpec, v.scope, indexes);
  }
  return cur;
}

/** The variables of a GVL, program, function block (with those it inherits) or struct (with those it extends). */
function membersOf(index: LanguageIndex, g: GlobalSym): VarSym[] {
  if (g.kind === 'gvl') return g.vars;
  if (g.kind === 'pou') return [g, ...[...ancestors(index, g)].filter(a => a.pouKind === 'FB')].flatMap(p => p.vars);
  const out: VarSym[] = [];
  let t: GlobalSym | undefined = g;
  for (let depth = 0; t?.kind === 'type' && t.dutKind === 'struct' && depth < 20; depth++) {
    out.push(...t.fields);
    t = t.extendsName ? index.resolveGlobal(t.extendsName.parts, t.scope) : undefined;
  }
  return out;
}

/** The type of a variable with `indexes` array indexes taken, through aliases; undefined for anything else. */
function typeOf(index: LanguageIndex, spec: A.TypeSpec | undefined, scope: Scope, indexes: number): GlobalSym | undefined {
  for (let depth = 0; spec && depth < 20; depth++) {
    if (spec.kind === 'ArrayType') {
      if (indexes === 0) return undefined;
      indexes--;
      spec = spec.of;
      continue;
    }
    if (spec.kind !== 'NamedType') return undefined;
    const g = index.resolveGlobal(spec.name.parts, scope);
    if (g?.kind === 'type' && g.dutKind === 'alias') {
      spec = g.aliasSpec;
      scope = g.scope;
      continue;
    }
    return indexes === 0 ? g : undefined;
  }
  return undefined;
}

// The I/O links of a TwinCAT project: which channel of which terminal (or NC axis, TcCOM object, other PLC) a PLC
// variable declared `AT %I*` / `AT %Q*` is linked to, from the <Mappings> of the .tsproj, and the variables of the
// process image of each PLC instance (<Vars> of its <Instance>, in the .tsproj or in the Independent Project File
// of the PLC project), for those that are linked to nothing.
//
// The format, as TwinCAT XAE 3.1.4026 saves it (samples/Demo/Demo/Demo.tsproj):
//
//   <Mappings>
//     <OwnerA Name="TIPC^Machine^Machine Instance">
//       <OwnerB Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)">
//         <Link VarA="PlcTask Inputs^GVL_IO.bStartButton" VarB="Channel 1^Input"/>
//
// Either owner can be the PLC: the other end is read from whichever side is not, and a link between two PLC
// instances counts for both.

import { XmlElement, child, children, elementText, findAll, parseXml } from './xml';

/** What the other end of a link is, by the root of its tree path. */
export type IoTargetKind = 'io' | 'nc' | 'plc' | 'tccom' | 'other';

/** A link of a variable of a PLC instance. */
export interface IoLink {
  /** The PLC project: `Machine` of `TIPC^Machine^Machine Instance`. */
  plc: string;
  /** Its instance: `Machine Instance`. */
  instance: string;
  /** The group of the process image the variable is in: `PlcTask Inputs`. */
  group: string;
  /** The variable as the PLC names it: `GVL_IO.bStartButton`, `MAIN.fbSensor.bSignal`, `GVL_IO.aLamps[1]`. */
  variable: string;
  /** The tree path of the other end's owner: `TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)`. */
  target: string;
  /** The variable of the other end, below its owner: `Channel 1^Input`. */
  targetVar: string;
  targetKind: IoTargetKind;
  /** For a link of part of a variable (bits): its size, and its offset on the PLC's side and on the other. */
  size?: number;
  offset?: number;
  targetOffset?: number;
}

export type IoDirection = 'input' | 'output';

/** A variable of the process image of a PLC instance: one declared `AT %I*` or `AT %Q*`, as the last build had it. */
export interface IoVar {
  plc: string;
  instance: string;
  group: string;
  direction?: IoDirection;
  variable: string;
  type?: string;
}

const KINDS: Record<string, IoTargetKind> = { TIID: 'io', TINC: 'nc', TIPC: 'plc', TIRC: 'tccom' };

function targetKind(owner: string): IoTargetKind {
  return KINDS[owner.split('^')[0].toUpperCase()] ?? 'other';
}

/** `TIPC^Machine^Machine Instance` → PLC project and instance; undefined for an owner that is not a PLC instance. */
function plcOwner(owner: string): { plc: string; instance: string } | undefined {
  const parts = owner.split('^');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'TIPC') return undefined;
  return { plc: parts[1], instance: parts.slice(2).join('^') };
}

/**
 * `PlcTask Inputs^GVL_IO.stDrive.bReady` → group and variable. A member or an element that XAE names as a child
 * (`PlcTask Inputs^GVL_IO.stDrive^bReady`) is joined with a dot, as the PLC names it.
 */
function splitPlcVar(v: string): { group: string; variable: string } | undefined {
  const i = v.indexOf('^');
  if (i <= 0) return undefined;
  const rest = v.slice(i + 1).split('^');
  const variable = rest.reduce((a, b) => (!a ? b : b.startsWith('[') ? a + b : b.startsWith(a + '.') || b.startsWith(a + '[') ? b : `${a}.${b}`), '');
  return { group: v.slice(0, i), variable };
}

function num(el: XmlElement, name: string): number | undefined {
  const v = el.attrs.get(name);
  if (v === undefined) return undefined;
  const n = /^#x/i.test(v) ? parseInt(v.slice(2), 16) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function linkOf(plcSide: string, plcVar: string, other: string, otherVar: string, l: XmlElement, plcIsA: boolean): IoLink | undefined {
  const owner = plcOwner(plcSide);
  const v = splitPlcVar(plcVar);
  if (!owner || !v) return undefined;
  const link: IoLink = { ...owner, ...v, target: other, targetVar: otherVar, targetKind: targetKind(other) };
  const size = num(l, 'Size');
  const offA = num(l, 'OffsA');
  const offB = num(l, 'OffsB');
  if (size !== undefined) link.size = size;
  if (offA !== undefined || offB !== undefined) {
    link.offset = plcIsA ? offA : offB;
    link.targetOffset = plcIsA ? offB : offA;
  }
  return link;
}

/** The links of the PLC variables in the <Mappings> of a .tsproj, in its order. */
export function parseIoLinks(text: string): IoLink[] {
  const out: IoLink[] = [];
  for (const mappings of findAll(parseXml(text), 'Mappings')) {
    for (const a of children(mappings, 'OwnerA')) {
      const ownerA = a.attrs.get('Name') ?? '';
      for (const b of children(a, 'OwnerB')) {
        const ownerB = b.attrs.get('Name') ?? '';
        for (const l of children(b, 'Link')) {
          const varA = l.attrs.get('VarA') ?? '';
          const varB = l.attrs.get('VarB') ?? '';
          const fromA = linkOf(ownerA, varA, ownerB, varB, l, true);
          const fromB = linkOf(ownerB, varB, ownerA, varA, l, false);
          if (fromA) out.push(fromA);
          if (fromB) out.push(fromB);
        }
      }
    }
  }
  return out;
}

/** VarGrpType of a <Vars> of a PLC instance: 1 its inputs, 2 its outputs. */
const DIRECTIONS: Record<string, IoDirection> = { '1': 'input', '2': 'output' };

/**
 * The process image of the PLC instances in a .tsproj, or in the Independent Project File (.xti) of a PLC project:
 * the <Var>s of the <Vars> of each <Instance>, with the PLC project of the <Project> that holds it.
 */
export function parseProcessImage(text: string): IoVar[] {
  const out: IoVar[] = [];
  for (const project of findAll(parseXml(text), 'Project')) {
    const plc = project.attrs.get('Name');
    if (!plc) continue;
    for (const inst of children(project, 'Instance')) {
      const instance = elementText(text, child(inst, 'Name')) ?? `${plc} Instance`;
      for (const vars of children(inst, 'Vars')) {
        const group = elementText(text, child(vars, 'Name')) ?? '';
        const direction = DIRECTIONS[vars.attrs.get('VarGrpType') ?? ''];
        for (const v of children(vars, 'Var')) {
          const variable = elementText(text, child(v, 'Name'));
          if (!variable) continue;
          const type = elementText(text, child(v, 'Type'));
          out.push({ plc, instance, group, ...(direction ? { direction } : {}), variable, ...(type ? { type } : {}) });
        }
      }
    }
  }
  return out;
}

/** A variable name as the PLC compares it: case aside, no blanks (`aLamps[ 1 ]` is `aLamps[1]`). */
function key(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase();
}

/** Whether `part` is a member or an element of `whole` (`GVL_IO.stDrive.bReady`, `GVL_IO.aLamps[1]` of `GVL_IO.stDrive`, `GVL_IO.aLamps`). */
function isPartOf(part: string, whole: string): boolean {
  return part.length > whole.length && part.startsWith(whole) && (part[whole.length] === '.' || part[whole.length] === '[');
}

export interface IoLinksOf {
  /** The links of the variable itself. */
  own: IoLink[];
  /** The links of its members, elements, or (for an FB instance) its variables. */
  parts: IoLink[];
}

/** The links and the process image of a TwinCAT project, looked up by PLC project and variable, case aside. */
export class IoLinkIndex {
  private readonly byPlc = new Map<string, IoLink[]>();
  private readonly imageByPlc = new Map<string, IoVar[]>();

  constructor(links: IoLink[], image: IoVar[] = []) {
    for (const l of links) push(this.byPlc, key(l.plc), l);
    for (const v of image) push(this.imageByPlc, key(v.plc), v);
  }

  /**
   * Whether the project links any variable of the PLC project. Without any, its I/O configuration is not part of
   * the project (a library, I/O not committed): no variable of it is reported as not linked.
   */
  hasLinks(plc: string): boolean {
    return (this.byPlc.get(key(plc))?.length ?? 0) > 0;
  }

  linksOf(plc: string, variable: string): IoLinksOf {
    const k = key(variable);
    const own: IoLink[] = [];
    const parts: IoLink[] = [];
    for (const l of this.byPlc.get(key(plc)) ?? []) {
      const lk = key(l.variable);
      if (lk === k) own.push(l);
      else if (isPartOf(lk, k)) parts.push(l);
    }
    return { own, parts };
  }

  /** The variable in the process image of the PLC project, as its last build had it. */
  imageVar(plc: string, variable: string): IoVar | undefined {
    const k = key(variable);
    return this.imageByPlc.get(key(plc))?.find(v => key(v.variable) === k);
  }

  /**
   * The variables of the process image of the PLC project linked to nothing, neither themselves nor any of their
   * parts; none when the project links no variable of it (see hasLinks).
   */
  unlinked(plc: string): IoVar[] {
    if (!this.hasLinks(plc)) return [];
    return (this.imageByPlc.get(key(plc)) ?? []).filter(v => {
      const { own, parts } = this.linksOf(plc, v.variable);
      return own.length === 0 && parts.length === 0;
    });
  }

  /**
   * The links of variables that the process image of the PLC project does not have, nor any variable they are part
   * of: left from a variable renamed or deleted since. None without a process image to compare with.
   */
  stale(plc: string): IoLink[] {
    const image = this.imageByPlc.get(key(plc));
    if (!image?.length) return [];
    const names = image.map(v => key(v.variable));
    return (this.byPlc.get(key(plc)) ?? []).filter(l => {
      const lk = key(l.variable);
      return !names.some(n => n === lk || isPartOf(lk, n));
    });
  }
}

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

/**
 * The other end of a link, for people: `Device 1 (EtherCAT) › Term 1 (EK1100) › Term 2 (EL1008) › Channel 1 › Input`,
 * without the root of the tree (`TIID`). With the bits of a link of part of a variable.
 */
export function describeTarget(link: IoLink): string {
  const owner = link.target.split('^').slice(1);
  const parts = [...owner, ...link.targetVar.split('^')].filter(p => p);
  const bits = link.size !== undefined
    ? ` (${link.size} bit${link.size === 1 ? '' : 's'}${link.offset ? ` at bit ${link.offset}` : ''})`
    : '';
  return parts.join(' › ') + bits;
}

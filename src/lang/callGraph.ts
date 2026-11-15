// Who calls what, for the call hierarchy and the MCP server's calls: made from the uses the analysis marks as calls
// (Occurrence.access) in every implementation of the workspace, and from the tasks (.TcTTO), which call programs.
// A function block instance called (`fbValve()`, `aValves[i]()`, `SUPER^()`) calls the body of its function block;
// a method or action called calls it. Built-ins are left out. One graph per version of the index.

import { taskCalls } from '../core/project';
import { fileKindFromPath } from '../core/tcfile';
import { Occurrence, throughIndexesOnly } from './analyzer';
import * as A from './ast';
import { SectionFeatures } from './features';
import { ancestors } from './hierarchy';
import { LanguageIndex, SectionContext } from './index';
import { symbolLabel } from './rename';
import { Loc, MemberSym, PouSym, Sym, VarSym, isLibrarySym } from './symbols';

/** What can be called: a function, program or function block (its body), a method or action, a property (its accessors). */
export type Callable = PouSym | MemberSym;

/** What calls: the body of a POU, a method, action or property accessor, or a task. */
export type Caller =
  | { kind: 'code'; sym: Callable; accessor?: 'Get' | 'Set' }
  | { kind: 'task'; name: string; fsPath: string };

export interface CallSite {
  caller: Caller;
  callee: Callable;
  /** Where the call is; none for a task's. */
  loc?: Loc;
  /** The section's text, for the line of the call. */
  text?: string;
  /** Through SUPER^ (`SUPER^.Open()`): the base's own, which no override replaces. */
  super?: true;
}

/** A call that reaches a method through what it implements or overrides: `itfValve.Open()` for FB_Valve.Open. */
export interface IncomingCall extends CallSite {
  /** The method called there, when it is not the target: I_Valve.Open, FB_ValveBase.Open. */
  via?: Callable;
}

export function isCallable(s: Sym): s is Callable {
  return (s.kind === 'pou' && s.pouKind !== 'ITF') || s.kind === 'method' || s.kind === 'action' || s.kind === 'property';
}

/** `FB_Valve.Open`, `FB_Valve.Pos.Set`, `PlcTask (task)`. */
export function callerLabel(c: Caller): string {
  return c.kind === 'task' ? `${c.name} (task)` : `${symbolLabel(c.sym)}${c.accessor ? `.${c.accessor}` : ''}`;
}

export function callerKey(c: Caller): string {
  return c.kind === 'task' ? `task:${c.fsPath}` : `${c.sym.id}${c.accessor ? `.${c.accessor}` : ''}`;
}

/** The function block of a variable's type, through arrays, pointers and references (`ARRAY[1..3] OF FB_Valve`). */
function functionBlockOf(index: LanguageIndex, v: VarSym): PouSym | undefined {
  let spec: A.TypeSpec | undefined = v.typeSpec;
  for (let depth = 0; spec && depth < 10; depth++) {
    if (spec.kind === 'ArrayType') spec = spec.of;
    else if (spec.kind === 'PointerType' || spec.kind === 'ReferenceType') spec = spec.to;
    else break;
  }
  const g = spec?.kind === 'NamedType' ? index.resolveGlobal(spec.name.parts, v.scope) : undefined;
  return g?.kind === 'pou' && g.pouKind === 'FB' ? g : undefined;
}

/** What a use calls: none for a use that is no call, a built-in, or what the index does not know. */
export function calleeOf(index: LanguageIndex, o: Occurrence): Callable | undefined {
  if (o.access !== 'call') return undefined;
  const s = o.sym;
  if (s.kind === 'var') return throughIndexesOnly(o.path) ? functionBlockOf(index, s) : undefined;
  if (o.path) return undefined;
  if (s.kind === 'pou' || s.kind === 'method' || s.kind === 'action') return s;
  return undefined;
}

/** What calls in a section: its method, action or property accessor, else its POU's body (none for a GVL, DUT or interface). */
export function callerOf(ctx: SectionContext): Caller | undefined {
  if (ctx.member) return { kind: 'code', sym: ctx.member, ...(ctx.accessor ? { accessor: ctx.accessor } : {}) };
  if (ctx.pou && ctx.pou.pouKind !== 'ITF') return { kind: 'code', sym: ctx.pou };
  return undefined;
}

/** The callable at an offset of a section: the one named there (a function block instance: its function block), else the section's. */
export function callableAt(index: LanguageIndex, occurrences: Occurrence[], ctx: SectionContext, offset: number): Callable | undefined {
  const o = occurrences.find(x => x.start <= offset && offset <= x.end);
  if (o) {
    if (o.sym.kind === 'var') {
      const fb = functionBlockOf(index, o.sym);
      if (fb) return fb;
    } else if (isCallable(o.sym)) {
      return o.sym;
    }
  }
  const own = callerOf(ctx);
  return own?.kind === 'code' ? own.sym : undefined;
}

export class CallGraph {
  readonly sites: CallSite[] = [];

  constructor(private readonly index: LanguageIndex, features: SectionFeatures) {
    for (const ctx of index.allContexts()) {
      if (ctx.role !== 'impl' || ctx.excluded) continue;
      const caller = callerOf(ctx);
      const text = index.sectionText(ctx.fileKey, ctx.sectionKey);
      if (!caller || text === undefined) continue;
      for (const o of features.analysisOf(ctx, text).occurrences) {
        const callee = calleeOf(index, o);
        if (!callee) continue;
        const site: CallSite = { caller, callee, loc: { fileKey: ctx.fileKey, sectionKey: ctx.sectionKey, start: o.start, end: o.end }, text };
        if (/\bSUPER\s*\^\s*\.\s*$/i.test(text.slice(Math.max(0, o.start - 40), o.start))) site.super = true;
        this.sites.push(site);
      }
    }
    // The tasks of each PLC project, and the programs they call.
    for (const e of index.ws.sourceEntries) {
      if (fileKindFromPath(e.path) !== 'task') continue;
      const file = index.ws.getFile(e.path);
      const scope = index.projectScope(e.project);
      if (!file || !scope) continue;
      const name = e.include.slice(e.include.lastIndexOf('\\') + 1).replace(/\.TcTTO$/i, '');
      for (const call of taskCalls(file.text)) {
        const g = index.lookupGlobal(scope, call.toUpperCase());
        if (g?.kind === 'pou' && g.pouKind === 'PRG') this.sites.push({ caller: { kind: 'task', name, fsPath: e.path }, callee: g });
      }
    }
  }

  /**
   * The calls of a callable: those of it, and for a method of a function block, those of the methods of the same
   * name that it implements or overrides (in its interfaces and the function blocks it extends), which may reach it;
   * not those through SUPER^, which call the base's own.
   */
  incoming(target: Callable): IncomingCall[] {
    const out: IncomingCall[] = this.sites.filter(s => s.callee.id === target.id);
    if (target.kind === 'method' || target.kind === 'property') {
      const upper = target.name.toUpperCase();
      for (const a of ancestors(this.index, target.owner)) {
        const m = a.members.find(x => x.kind === target.kind && x.name.toUpperCase() === upper);
        if (m) out.push(...this.sites.filter(s => s.callee.id === m.id && !s.super).map(s => ({ ...s, via: m })));
      }
    }
    return out;
  }

  /** The calls a callable makes: in its body, or in its accessors for a property. */
  outgoing(caller: Callable): CallSite[] {
    return this.sites.filter(s => s.caller.kind === 'code' && s.caller.sym.id === caller.id);
  }
}

/** The calls of a callable grouped by the other end: by caller (and the method called, `via`), or by callee. */
export interface CallGroup {
  /** `MAIN`, `FB_FillSequence (via I_Valve.Open)`, `PlcTask (task)`, `TON (Tc2_Standard)`. */
  label: string;
  /** The caller or callee, to go on with; none for a task. */
  next?: Callable;
  /** The task, for a task's group. */
  task?: { name: string; fsPath: string };
  via?: Callable;
  sites: CallSite[];
}

export function callGroups(graph: CallGraph, c: Callable, direction: 'incoming' | 'outgoing'): CallGroup[] {
  const incoming = direction === 'incoming';
  const groups = new Map<string, CallGroup>();
  for (const site of incoming ? graph.incoming(c) : graph.outgoing(c)) {
    const via = (site as IncomingCall).via;
    const key = incoming ? `${callerKey(site.caller)}|${via?.id ?? ''}` : site.callee.id;
    let g = groups.get(key);
    if (!g) {
      const caller = site.caller;
      g = incoming
        ? {
          label: `${callerLabel(caller)}${via ? ` (via ${symbolLabel(via)})` : ''}`, via, sites: [],
          ...(caller.kind === 'code' ? { next: caller.sym } : { task: { name: caller.name, fsPath: caller.fsPath } }),
        }
        : { label: `${symbolLabel(site.callee)}${isLibrarySym(site.callee) ? ` (${site.callee.scope.name})` : ''}`, next: site.callee, sites: [] };
      groups.set(key, g);
    }
    g.sites.push(site);
  }
  return [...groups.values()];
}

const graphs = new WeakMap<SectionFeatures, { version: number; graph: CallGraph }>();

/** The call graph of the index as it is now, made once per version. */
export function callGraphOf(index: LanguageIndex, features: SectionFeatures): CallGraph {
  const cached = graphs.get(features);
  if (cached && cached.version === index.version) return cached.graph;
  const graph = new CallGraph(index, features);
  // After it is made: making it brings the index up to date.
  graphs.set(features, { version: index.version, graph });
  return graph;
}

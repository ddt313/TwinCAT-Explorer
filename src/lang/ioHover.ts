// What a variable of a GVL declared `AT %I*` / `AT %Q*` is linked to, for its hover: the channel of a terminal (or
// the NC axis, TcCOM object, other PLC) of each link in the TwinCAT project, as XAE last saved the .tsproj.
// Independent of the VS Code API.

import * as path from 'path';
import { TcWorkspace } from '../core/workspace';
import { IoLink, describeTarget } from '../core/ioLinks';
import { Sym } from './symbols';

/** Backticks a name, as Markdown code. */
function code(s: string): string {
  return `\`${s.replace(/`/g, '\'')}\``;
}

/**
 * The I/O links of a variable of a GVL with an address `AT %I*` / `AT %Q*` (not a fixed one, `AT %IX0.0`), as Markdown;
 * undefined for any other symbol, and for a PLC project that no TwinCAT project links anything of.
 */
export function ioLinkHover(ws: TcWorkspace, s: Sym): string | undefined {
  if (s.kind !== 'var' || s.owner.kind !== 'gvl' || !s.at?.includes('*') || !s.loc) return undefined;
  const project = ws.entry(s.loc.fileKey)?.project;
  if (!project) return undefined;
  const variable = `${s.owner.name}.${s.name}`;
  const all = ws.ioLinks(project.path).filter(l => l.index.hasLinks(l.plc));
  if (!all.length) return undefined;
  const blocks = all.map(({ tsProject, plc, index }) => {
    const { own, parts } = index.linksOf(plc, variable);
    const title = `**I/O** · ${path.basename(tsProject.path)}`;
    const lines: string[] = [];
    for (const l of own) lines.push(`- ${code(describeTarget(l))}`);
    for (const l of parts) lines.push(`- ${code(partOf(l, variable))} → ${code(describeTarget(l))}`);
    if (!lines.length) {
      lines.push(index.imageVar(plc, variable)
        ? 'Not linked.'
        : 'Not linked. The last build in TwinCAT XAE did not have this variable: build and save the project in XAE to link it.');
    }
    return `${title}\n\n${lines.join('\n')}`;
  });
  return blocks.join('\n\n');
}

/** The part of a variable a link is of, as written after it: `.bReady`, `[1]`. */
function partOf(l: IoLink, variable: string): string {
  return l.variable.slice(variable.length);
}

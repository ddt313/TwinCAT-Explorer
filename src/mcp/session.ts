// The TwinCAT projects under one folder as the MCP server sees them: the workspace and language index the VS Code
// extension uses, loaded from disk on the first call and checked again before every call, and the names the tools
// take (`FB_Valve`, `FB_Valve.Open`, `FB_Valve.Speed.Get`, `Machine:FB_Valve`) resolved to files and sections.
// Independent of the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import { Accessor, positionIn, textHash, viewLabel, viewSections } from '../core/objectText';
import { parseJsonc } from '../core/jsonc';
import { findTsProjects } from '../core/paths';
import { PlcProject } from '../core/project';
import { Section, TcObject, TcSourceFile } from '../core/tcfile';
import { SourceEntry, TcWorkspace, fileKey } from '../core/workspace';
import { SectionFeatures } from '../lang/features';
import { LanguageIndex, SectionContext, StubSource } from '../lang/index';
import { BUNDLED_STUBS } from '../lang/stubs';
import { Loc } from '../lang/symbols';

/** What a tool name stands for: an object (POU, member, DUT, GVL, interface) or one accessor of a property. */
export interface View {
  entry: SourceEntry;
  file: TcSourceFile;
  obj: TcObject;
  accessor?: Accessor;
  /** `FB_Valve.Open`, `FB_Valve.Speed.Get`. */
  label: string;
}

export class ToolError extends Error {}

/** How long the list of .tsproj files is trusted before the folder is searched again. */
const RESCAN_MS = 10_000;

export class Session {
  readonly ws = new TcWorkspace();
  readonly index = new LanguageIndex(this.ws);
  readonly features: SectionFeatures;
  private ignore = new Set<string>();
  private loaded = false;
  private tsprojs: string[] = [];
  private scannedAt = 0;
  /** Modification time and size of the project files (.tsproj, .plcproj, .xti) when the projects were loaded. */
  private projectStamp = '';

  constructor(readonly root: string) {
    this.features = new SectionFeatures(this.index, () => this.ignore);
  }

  /** Loads the projects the first time; later, loads them again when a project file changed, and has the index re-check the source files. */
  refresh(): void {
    const now = Date.now();
    if (!this.loaded || now - this.scannedAt > RESCAN_MS) {
      this.tsprojs = findTsProjects(this.root);
      this.scannedAt = now;
    }
    const stamp = this.stampOf();
    if (!this.loaded || stamp !== this.projectStamp) {
      this.readSettings();
      this.ws.load(this.tsprojs);
      this.projectStamp = this.stampOf();
      this.loaded = true;
    } else {
      // Source files changed outside (XAE, git, an editor): getFile reads them again by modification time and size.
      this.ws.version++;
    }
    this.index.ensure();
  }

  private stampOf(): string {
    const files = [...this.tsprojs];
    for (const t of this.ws.tsProjects) for (const r of t.plcProjects) if (r.xtiPath) files.push(r.xtiPath);
    for (const p of this.ws.plcProjects) files.push(p.path);
    return files.map(f => {
      try {
        const s = fs.statSync(f);
        return `${f}|${s.mtimeMs}|${s.size}`;
      } catch {
        return `${f}|-`;
      }
    }).join('\n');
  }

  /** Library stubs and identifiers to ignore from the folder's .vscode/settings.json, as the extension takes them. */
  private readSettings(): void {
    let settings: Record<string, unknown> = {};
    try {
      settings = parseJsonc<Record<string, unknown>>(fs.readFileSync(path.join(this.root, '.vscode', 'settings.json'), 'utf8')) ?? {};
    } catch {
      // no settings
    }
    const list = (key: string) => (Array.isArray(settings[key]) ? (settings[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
    this.ignore = new Set(list('twincatExplorer.diagnostics.ignore').map(s => s.toUpperCase()));
    const stubs: StubSource[] = [...BUNDLED_STUBS];
    for (const p of list('twincatExplorer.stubFiles')) {
      const full = path.resolve(this.root, p);
      try {
        stubs.push({ path: full, text: fs.readFileSync(full, 'utf8') });
      } catch {
        // a stub file that is not there is left out, as in the extension
      }
    }
    this.index.setStubs(stubs);
  }

  get projects(): PlcProject[] {
    return this.ws.plcProjects;
  }

  /** Every object view of the workspace, in the order of the projects and their files. */
  views(): View[] {
    const out: View[] = [];
    for (const entry of this.ws.sourceEntries) {
      const file = this.ws.getFile(entry.path);
      if (!file || file.error) continue;
      for (const obj of file.ordered) {
        out.push({ entry, file, obj, label: viewLabel(obj) });
        for (const a of obj.accessors) out.push({ entry, file, obj, accessor: a.kind, label: viewLabel(obj, a.kind) });
      }
    }
    return out;
  }

  /** The view a name stands for: `FB_Valve.Open`, `FB_Valve.Speed.Get`, `Machine:FB_Valve` (case aside). */
  resolve(name: string): View {
    const m = /^\s*(?:([^:]+):)?\s*(.+?)\s*$/.exec(name);
    if (!m) throw new ToolError(`'${name}' is not an object name`);
    const project = m[1]?.trim().toUpperCase();
    const label = m[2].toUpperCase();
    const found = this.views().filter(v => v.label.toUpperCase() === label && (!project || v.entry.project.name.toUpperCase() === project));
    if (found.length === 1) return found[0];
    if (found.length === 0) {
      const near = this.views().filter(v => v.label.toUpperCase().includes(label.split('.').pop()!)).slice(0, 8).map(v => this.qualified(v));
      throw new ToolError(`No TwinCAT object '${name}'.${near.length ? ` Similar: ${near.join(', ')}` : ''}`);
    }
    throw new ToolError(`'${name}' is in several PLC projects: ${found.map(v => this.qualified(v)).join(', ')}. Use one of these names.`);
  }

  /** `Machine:FB_Valve` when several PLC projects are loaded, else `FB_Valve`. */
  qualified(v: View): string {
    return this.ws.plcProjects.length > 1 ? `${v.entry.project.name}:${v.label}` : v.label;
  }

  /** The declaration or implementation shown by a view. */
  section(v: View, part: 'decl' | 'impl'): Section {
    const s = viewSections(v.obj, v.accessor).find(x => x.role === part);
    if (!s) throw new ToolError(`${v.label} has no ${part === 'decl' ? 'declaration' : 'implementation'}`);
    return s;
  }

  context(v: View, s: Section): SectionContext | undefined {
    return this.index.context(fileKey(v.entry.path), s.key);
  }

  /** Where a location is, for tool output: `FB_Valve.Open impl:12  nCount := nCount + 1;`. */
  describeLoc(loc: Loc): string {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    const text = this.index.sectionText(loc.fileKey, loc.sectionKey);
    if (!ctx || text === undefined) return '(unknown place)';
    const { line } = positionIn(text, loc.start);
    const lineText = text.split('\n')[line]?.trim() ?? '';
    const label = ctx.accessor ? `${ctx.object.qualifiedName}.${ctx.accessor}` : ctx.object.qualifiedName;
    return `${label} ${ctx.role}:${line + 1}  ${lineText}`;
  }
}

/** The short hash the tools show and take back: the first 12 hex digits of textHash. */
export function shortHash(text: string): string {
  return textHash(text).slice(0, 12);
}

/** A text with line numbers, as `cat -n` shows it; `from`/`to` are 1-based and inclusive. */
export function numbered(text: string, from = 1, to = Number.MAX_SAFE_INTEGER): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const width = String(lines.length).length;
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(`${String(i).padStart(width)}  ${lines[i - 1]}`);
  return out.join('\n');
}

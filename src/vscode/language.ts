// Language features for Structured Text cells of TwinCAT notebooks:
// go to definition, hover, completion, references, workspace symbols and
// diagnostics. Locations are cells of object notebooks, opened on demand.

import * as vscode from 'vscode';
import { LanguageIndex, SectionContext } from '../lang/index';
import { Analysis, Analyzer, Occurrence, analyze } from '../lang/analyzer';
import { Loc, Sym, Ty, tyToString } from '../lang/symbols';
import { expressionBeforeDot } from '../lang/completion';
import { TcWorkspace, fileKey } from '../core/workspace';
import { sectionOffsetToFileOffset } from '../core/tcfile';
import { cellMeta } from './serializers';
import {
  DIFF_NOTEBOOK, FILE_NOTEBOOK, OBJECT_NOTEBOOK, ST_LANGUAGE, objectUri, parseDiffUri, parseObjectUri,
} from './uris';

export interface CellInfo {
  notebook: vscode.NotebookDocument;
  cell: vscode.NotebookCell;
  fsPath: string;
  fileKey: string;
  sectionKey: string;
  /** False for the history side of a comparison. */
  live: boolean;
}

const NOTEBOOK_TYPES = new Set([OBJECT_NOTEBOOK, DIFF_NOTEBOOK, FILE_NOTEBOOK]);

export function cellInfo(doc: vscode.TextDocument): CellInfo | undefined {
  if (doc.uri.scheme !== 'vscode-notebook-cell') return undefined;
  for (const nb of vscode.workspace.notebookDocuments) {
    if (!NOTEBOOK_TYPES.has(nb.notebookType)) continue;
    const cell = nb.getCells().find(c => c.document === doc);
    if (!cell) continue;
    const meta = cellMeta(cell);
    if (!meta || meta.header) return undefined;
    let fsPath: string | undefined;
    let live = true;
    if (nb.notebookType === OBJECT_NOTEBOOK) fsPath = parseObjectUri(nb.uri)?.fsPath;
    else if (nb.notebookType === DIFF_NOTEBOOK) {
      const d = parseDiffUri(nb.uri);
      fsPath = d?.fsPath;
      live = false;
    } else fsPath = nb.uri.fsPath;
    if (!fsPath) return undefined;
    return { notebook: nb, cell, fsPath, fileKey: fileKey(fsPath), sectionKey: meta.key, live };
  }
  return undefined;
}

const KEYWORDS = [
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE',
  'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'RETURN', 'EXIT', 'CONTINUE', 'AND', 'AND_THEN', 'OR', 'OR_ELSE',
  'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE', 'THIS', 'SUPER', 'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP',
  'VAR_STAT', 'VAR_INST', 'END_VAR', 'CONSTANT', 'POINTER TO', 'REFERENCE TO', 'ARRAY', 'STRING', 'WSTRING',
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT', 'REAL',
  'LREAL', 'TIME', 'LTIME', 'DATE', 'TOD', 'DT',
];

function completionKind(s: Sym): vscode.CompletionItemKind {
  switch (s.kind) {
    case 'var': return s.owner.kind === 'type' ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Variable;
    case 'method': return vscode.CompletionItemKind.Method;
    case 'property': return vscode.CompletionItemKind.Property;
    case 'action':
    case 'transition':
      return vscode.CompletionItemKind.Event;
    case 'pou':
      if (s.pouKind === 'ITF') return vscode.CompletionItemKind.Interface;
      if (s.pouKind === 'FUN') return vscode.CompletionItemKind.Function;
      if (s.pouKind === 'PRG') return vscode.CompletionItemKind.Module;
      return vscode.CompletionItemKind.Class;
    case 'type': return s.dutKind === 'enum' ? vscode.CompletionItemKind.Enum : vscode.CompletionItemKind.Struct;
    case 'enumValue': return vscode.CompletionItemKind.EnumMember;
    case 'gvl': return vscode.CompletionItemKind.Module;
    case 'namespace': return vscode.CompletionItemKind.Module;
    case 'builtin': return vscode.CompletionItemKind.Function;
  }
}

function symbolKind(s: Sym): vscode.SymbolKind {
  switch (s.kind) {
    case 'pou':
      if (s.pouKind === 'ITF') return vscode.SymbolKind.Interface;
      if (s.pouKind === 'FUN') return vscode.SymbolKind.Function;
      if (s.pouKind === 'PRG') return vscode.SymbolKind.Module;
      return vscode.SymbolKind.Class;
    case 'method': return vscode.SymbolKind.Method;
    case 'property': return vscode.SymbolKind.Property;
    case 'action':
    case 'transition':
      return vscode.SymbolKind.Event;
    case 'type': return s.dutKind === 'enum' ? vscode.SymbolKind.Enum : vscode.SymbolKind.Struct;
    case 'enumValue': return vscode.SymbolKind.EnumMember;
    case 'gvl': return vscode.SymbolKind.Namespace;
    case 'var': return s.constant ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable;
    default: return vscode.SymbolKind.Object;
  }
}

/** Where a symbol is declared, for hovers. */
export function describeOwner(s: Sym): string {
  if (s.scope.isLibrary) return s.kind === 'builtin' ? 'Built-in' : `Library ${s.scope.name}`;
  switch (s.kind) {
    case 'var': {
      const owner = s.owner.kind === 'method' || s.owner.kind === 'property' || s.owner.kind === 'action' || s.owner.kind === 'transition'
        ? `${s.owner.owner.name}.${s.owner.name}${s.accessor ? '.' + s.accessor : ''}` : s.owner.name;
      return `${s.section} of ${owner}`;
    }
    case 'method': return `Method of ${s.owner.name}`;
    case 'property': return `Property of ${s.owner.name}`;
    case 'action': return `Action of ${s.owner.name}`;
    case 'transition': return `Transition of ${s.owner.name}`;
    case 'pou': return `${{ FB: 'Function block', PRG: 'Program', FUN: 'Function', ITF: 'Interface' }[s.pouKind]} in ${s.scope.name}`;
    case 'type': return `${s.dutKind === 'enum' ? 'Enumeration' : s.dutKind === 'alias' ? 'Alias' : s.dutKind === 'union' ? 'Union' : 'Structure'} in ${s.scope.name}`;
    case 'enumValue': return `Value of ${s.owner.name}`;
    case 'gvl': return `Global variable list in ${s.scope.name}`;
    case 'namespace': return 'Library namespace';
    case 'builtin': return 'Built-in';
  }
}

interface CachedAnalysis {
  version: number;
  text: string;
  analysis: Analysis;
}

export class LanguageFeatures implements
  vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.ReferenceProvider,
  vscode.WorkspaceSymbolProvider<vscode.SymbolInformation>, vscode.DocumentSymbolProvider {
  private readonly cache = new Map<string, CachedAnalysis>();
  private readonly symbolLocs = new WeakMap<vscode.SymbolInformation, Loc>();

  constructor(private readonly index: LanguageIndex, private readonly ws: TcWorkspace) {}

  private ignoreSet(): Set<string> {
    const list = vscode.workspace.getConfiguration('twincatExplorer').get<string[]>('diagnostics.ignore', []);
    return new Set(list.map(s => s.toUpperCase()));
  }

  analysisOf(ctx: SectionContext, text: string): Analysis {
    const key = `${ctx.fileKey}|${ctx.sectionKey}`;
    const cached = this.cache.get(key);
    if (cached && cached.version === this.index.version && cached.text === text) return cached.analysis;
    const analysis = analyze(this.index, ctx, text, { ignore: this.ignoreSet() });
    this.cache.set(key, { version: this.index.version, text, analysis });
    return analysis;
  }

  analysisForDocument(doc: vscode.TextDocument): { info: CellInfo; ctx: SectionContext; analysis: Analysis } | undefined {
    const info = cellInfo(doc);
    if (!info) return undefined;
    const ctx = this.index.context(info.fileKey, info.sectionKey);
    if (!ctx) return undefined;
    return { info, ctx, analysis: this.analysisOf(ctx, doc.getText()) };
  }

  private occurrenceAt(analysis: Analysis, offset: number): Occurrence | undefined {
    return analysis.occurrences.find(o => o.start <= offset && offset <= o.end);
  }

  /** Location of a symbol in its object notebook (opened in the background if needed). */
  async toLocation(loc: Loc): Promise<vscode.Location | undefined> {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    if (!ctx) return undefined;
    const uri = objectUri(ctx.filePath, ctx.object);
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const cell = nb.getCells().find(c => cellMeta(c)?.key === loc.sectionKey);
    if (!cell) return new vscode.Location(uri, new vscode.Position(0, 0));
    const d = cell.document;
    return new vscode.Location(d.uri, new vscode.Range(d.positionAt(loc.start), d.positionAt(loc.end)));
  }

  // ------------------------------------------------------------------ definition

  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
    const r = this.analysisForDocument(doc);
    if (!r) return undefined;
    const o = this.occurrenceAt(r.analysis, doc.offsetAt(pos));
    if (!o?.sym.loc) return undefined;
    if (o.decl && r.info.live) {
      return new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end)));
    }
    return this.toLocation(o.sym.loc);
  }

  // ------------------------------------------------------------------ hover

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const r = this.analysisForDocument(doc);
    if (!r) return undefined;
    const o = this.occurrenceAt(r.analysis, doc.offsetAt(pos));
    if (!o) return undefined;
    const s = o.sym;
    const md = new vscode.MarkdownString();
    md.appendCodeblock(s.signature || s.name, ST_LANGUAGE);
    if (s.doc) md.appendMarkdown('\n\n' + s.doc.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1').replace(/\n/g, '  \n'));
    md.appendMarkdown(`\n\n*${describeOwner(s)}*`);
    return new vscode.Hover(md, new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end)));
  }

  // ------------------------------------------------------------------ completion

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const info = cellInfo(doc);
    if (!info) return undefined;
    const ctx = this.index.context(info.fileKey, info.sectionKey);
    if (!ctx) return undefined;
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const analyzer = new Analyzer(this.index, ctx, text);
    const exprText = expressionBeforeDot(text, offset);
    const items: vscode.CompletionItem[] = [];
    const add = (s: Sym, ty: Ty) => {
      const item = new vscode.CompletionItem(s.name, completionKind(s));
      const firstLine = (s.signature || '').split('\n')[0];
      item.detail = firstLine || tyToString(ty);
      const md = new vscode.MarkdownString();
      if (s.signature) md.appendCodeblock(s.signature, ST_LANGUAGE);
      if (s.doc) md.appendText('\n' + s.doc);
      md.appendMarkdown(`\n\n*${describeOwner(s)}*`);
      item.documentation = md;
      items.push(item);
    };
    if (exprText !== undefined) {
      let t = analyzer.typeOfText(exprText);
      for (let i = 0; i < 4 && (t.k === 'ref' || t.k === 'ptr'); i++) t = t.to;
      for (const r of analyzer.listMembers(t)) add(r.sym, r.ty);
      return items;
    }
    for (const r of analyzer.listScope()) add(r.sym, r.ty);
    for (const kw of KEYWORDS) items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
    return items;
  }

  // ------------------------------------------------------------------ references

  async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[]> {
    const r = this.analysisForDocument(doc);
    if (!r) return [];
    const o = this.occurrenceAt(r.analysis, doc.offsetAt(pos));
    if (!o) return [];
    return this.findReferences(o.sym, context.includeDeclaration);
  }

  async findReferences(target: Sym, includeDeclaration: boolean): Promise<vscode.Location[]> {
    const hits: { ctx: SectionContext; occ: Occurrence }[] = [];
    for (const ctx of this.index.allContexts()) {
      const text = this.index.sectionText(ctx.fileKey, ctx.sectionKey);
      if (text === undefined) continue;
      const a = this.analysisOf(ctx, text);
      for (const occ of a.occurrences) {
        if (occ.sym.id === target.id && (includeDeclaration || !occ.decl)) hits.push({ ctx, occ });
      }
    }
    const out: vscode.Location[] = [];
    for (const h of hits) {
      const loc = await this.toLocation({ fileKey: h.ctx.fileKey, sectionKey: h.ctx.sectionKey, start: h.occ.start, end: h.occ.end });
      if (loc) out.push(loc);
    }
    return out;
  }

  // ------------------------------------------------------------------ document symbols (Outline)

  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const r = this.analysisForDocument(doc);
    if (!r) return [];
    return r.analysis.occurrences.filter(o => o.decl).map(o => {
      const range = new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end));
      const detail = o.sym.kind === 'var' ? o.sym.signature.slice(o.sym.name.length).replace(/^\s*:\s*/, '') : '';
      return new vscode.DocumentSymbol(o.sym.name, detail, symbolKind(o.sym), range, range);
    });
  }

  // ------------------------------------------------------------------ workspace symbols

  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    const q = query.toLowerCase();
    const matches = (name: string) => {
      if (!q) return true;
      const n = name.toLowerCase();
      let i = 0;
      for (const ch of n) if (ch === q[i]) i++;
      return i === q.length;
    };
    const out: vscode.SymbolInformation[] = [];
    const add = (s: Sym, container: string) => {
      if (!s.loc || !matches(s.name)) return;
      const ctx = this.index.context(s.loc.fileKey, s.loc.sectionKey);
      if (!ctx) return;
      const uri = objectUri(ctx.filePath, ctx.object);
      // Location without a range: VS Code calls resolveWorkspaceSymbol when the symbol is picked.
      const info = new vscode.SymbolInformation(s.name, symbolKind(s), container, new vscode.Location(uri, undefined as unknown as vscode.Range));
      this.symbolLocs.set(info, s.loc);
      out.push(info);
    };
    for (const g of this.index.allGlobals()) {
      if (g.scope.isLibrary) continue;
      add(g, g.scope.name);
      if (g.kind === 'pou') for (const m of g.members) add(m, g.name);
      if (g.kind === 'gvl') for (const v of g.vars) add(v, g.name);
    }
    return out;
  }

  async resolveWorkspaceSymbol(symbol: vscode.SymbolInformation): Promise<vscode.SymbolInformation> {
    const loc = this.symbolLocs.get(symbol);
    if (loc) {
      const location = await this.toLocation(loc);
      if (location) symbol.location = location;
    }
    return symbol;
  }

  // ------------------------------------------------------------------ whole workspace check

  checkWorkspace(collection: vscode.DiagnosticCollection): { files: number; problems: number } {
    collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let problems = 0;
    const ignore = this.ignoreSet();
    for (const ctx of this.index.allContexts()) {
      const file = this.ws.getFile(ctx.filePath);
      const section = file?.sections.get(ctx.sectionKey);
      if (!file || !section) continue;
      const a = analyze(this.index, ctx, section.text, { ignore });
      if (a.problems.length === 0) continue;
      const diags = byFile.get(ctx.filePath) ?? [];
      for (const p of a.problems) {
        const start = positionInText(file.text, sectionOffsetToFileOffset(file, section, p.start));
        const end = positionInText(file.text, sectionOffsetToFileOffset(file, section, p.end));
        const d = new vscode.Diagnostic(new vscode.Range(start, end), `${ctx.object.qualifiedName} (${ctx.label}): ${p.message}`,
          p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        d.source = 'TwinCAT';
        diags.push(d);
        problems++;
      }
      byFile.set(ctx.filePath, diags);
    }
    for (const [p, diags] of byFile) collection.set(vscode.Uri.file(p), diags);
    return { files: byFile.size, problems };
  }
}

function positionInText(text: string, offset: number): vscode.Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return new vscode.Position(line, offset - lineStart);
}

/** Live diagnostics for the Structured Text cells of open TwinCAT notebooks. */
export class CellDiagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('twincat');
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private allTimer: NodeJS.Timeout | undefined;

  constructor(private readonly features: LanguageFeatures) {}

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('diagnostics.enabled', true);
  }

  refresh(doc: vscode.TextDocument): void {
    if (doc.languageId !== ST_LANGUAGE) return;
    if (!this.enabled()) {
      this.collection.delete(doc.uri);
      return;
    }
    const r = this.features.analysisForDocument(doc);
    if (!r || !r.info.live) {
      this.collection.delete(doc.uri);
      return;
    }
    const diags = r.analysis.problems.map(p => {
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)), p.message,
        p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'TwinCAT';
      return d;
    });
    this.collection.set(doc.uri, diags);
  }

  schedule(doc: vscode.TextDocument, delay = 250): void {
    const key = doc.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.refresh(doc);
    }, delay));
  }

  scheduleAll(delay = 400): void {
    if (this.allTimer) clearTimeout(this.allTimer);
    this.allTimer = setTimeout(() => {
      this.allTimer = undefined;
      this.refreshAll();
    }, delay);
  }

  refreshAll(): void {
    for (const nb of vscode.workspace.notebookDocuments) {
      if (!NOTEBOOK_TYPES.has(nb.notebookType)) continue;
      for (const cell of nb.getCells()) this.refresh(cell.document);
    }
  }

  clearNotebook(nb: vscode.NotebookDocument): void {
    for (const cell of nb.getCells()) this.collection.delete(cell.document.uri);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.allTimer) clearTimeout(this.allTimer);
    this.collection.dispose();
  }
}

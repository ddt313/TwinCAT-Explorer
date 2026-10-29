// Language features for Structured Text: go to definition, hover, completion,
// signature help, references, implementations, document highlights, folding,
// workspace symbols and diagnostics. The *At methods work on a section and an offset and serve the
// split editor (objectEditor.ts); the VS Code providers serve notebook cells.
// Locations are in the split editor (through twincat-loc renderings) or in
// object notebooks, by setting.

import * as vscode from 'vscode';
import { LanguageIndex, SectionContext } from '../lang/index';
import { Analysis, Analyzer, Occurrence, analyze } from '../lang/analyzer';
import { SectionFeatures, describeOwner } from '../lang/features';
import { Loc, Sym, Ty, tyToString } from '../lang/symbols';
import { completionContext, expressionBeforeDot } from '../lang/completion';
import { CallParam, Callable, callArguments, callSnippet, callableOfSymbol, returnsValue, signatureAt } from '../lang/calls';
import { snippetsAt } from '../lang/snippets';
import { foldingRanges } from '../lang/folding';
import { OutlineSymbol, symbolKindOf } from '../lang/outline';
import { TcWorkspace, fileKey } from '../core/workspace';
import { positionIn } from '../core/objectText';
import { TcSourceFile, sectionOffsetToFileOffset } from '../core/tcfile';
import { escapeMarkdown } from '../shared/markdown';
import { CompletionResult, HoverResult, SignatureResult } from '../shared/protocol';
import { cellMeta } from './serializers';
import { openObjectDocument } from './openDocs';
import {
  DIFF_NOTEBOOK, FILE_NOTEBOOK, OBJECT_NOTEBOOK, ST_LANGUAGE, fileUri, isFileUri, objectUri, parseDiffUri, parseObjectUri,
} from './uris';

/** Editor that TwinCAT objects open in: the XAE-like split editor or a notebook. */
export function editorMode(): 'split' | 'notebook' {
  return vscode.workspace.getConfiguration('twincatExplorer').get<string>('editor', 'split') === 'notebook' ? 'notebook' : 'split';
}

/** Problems are shown (twincatExplorer.diagnostics.enabled). */
export function diagnosticsEnabled(): boolean {
  return vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('diagnostics.enabled', true);
}

/** A problem found by the Structured Text analysis, as a VS Code diagnostic. */
export function toDiagnostic(range: vscode.Range, message: string, severity: 'error' | 'warning'): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
  d.source = 'TwinCAT';
  return d;
}

/** Location of a section range in the split editor, through a twincat-loc rendering. */
export type SplitLocator = (ctx: SectionContext, loc: Loc) => vscode.Location | undefined;

function codeblock(code: string): string {
  return '\n```' + ST_LANGUAGE + '\n' + code + '\n```\n';
}

/** A doc comment as Markdown, its line breaks kept. */
function docText(doc: string | undefined): string {
  return doc ? `\n\n${escapeMarkdown(doc).replace(/\n/g, '  \n')}` : '';
}

/** A symbol's doc comment and where it is declared, as Markdown after its signature. */
function symbolDoc(s: Sym): string {
  return docText(s.doc) + `\n\n*${describeOwner(s)}*`;
}

/** What a call calls: its declaration (without the parameters the label shows), comment and where it is declared. */
function callableDoc(c: Callable): string {
  if (c.kind === 'builtin') return symbolDoc(c.sym).trimStart();
  return codeblock(c.sym.signature.split('\n')[0]) + symbolDoc(c.sym);
}

/** A parameter of a call: its declaration, section included, and its comment. */
function paramDoc(p: CallParam): string | undefined {
  return p.sym ? codeblock(`${p.section} ${p.sym.signature}`) + docText(p.sym.doc) : undefined;
}

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
    } else {
      fsPath = nb.uri.fsPath;
      live = isFileUri(nb.uri);
    }
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

type CompletionKindName = keyof typeof vscode.CompletionItemKind;

function completionKind(s: Sym): CompletionKindName {
  switch (s.kind) {
    case 'var': return s.owner.kind === 'type' ? 'Field' : 'Variable';
    case 'method': return 'Method';
    case 'property': return 'Property';
    case 'action':
    case 'transition':
      return 'Event';
    case 'pou':
      if (s.pouKind === 'ITF') return 'Interface';
      if (s.pouKind === 'FUN') return 'Function';
      if (s.pouKind === 'PRG') return 'Module';
      return 'Class';
    case 'type': return s.dutKind === 'enum' ? 'Enum' : 'Struct';
    case 'enumValue': return 'EnumMember';
    case 'gvl': return 'Module';
    case 'namespace': return 'Module';
    case 'builtin': return 'Function';
  }
}

function symbolKind(s: Sym): vscode.SymbolKind {
  return vscode.SymbolKind[symbolKindOf(s)];
}

export { describeOwner };

export class LanguageFeatures implements
  vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.SignatureHelpProvider, vscode.ReferenceProvider,
  vscode.ImplementationProvider, vscode.WorkspaceSymbolProvider<vscode.SymbolInformation>, vscode.DocumentSymbolProvider,
  vscode.DocumentHighlightProvider, vscode.FoldingRangeProvider {
  /** The section-level features this class adapts to VS Code. */
  readonly sections: SectionFeatures;
  private readonly symbolLocs = new WeakMap<vscode.SymbolInformation, Loc>();
  /** Set by the extension: where locations point when TwinCAT objects open in the split editor. */
  splitLocator?: SplitLocator;

  constructor(private readonly index: LanguageIndex, private readonly ws: TcWorkspace) {
    this.sections = new SectionFeatures(index, () => this.ignoreSet());
  }

  private ignoreSet(): Set<string> {
    const list = vscode.workspace.getConfiguration('twincatExplorer').get<string[]>('diagnostics.ignore', []);
    return new Set(list.map(s => s.toUpperCase()));
  }

  /** Drops cached analyses, e.g. after the diagnostics settings changed. */
  clearAnalysisCache(): void {
    this.sections.clear();
  }

  analysisOf(ctx: SectionContext, text: string): Analysis {
    return this.sections.analysisOf(ctx, text);
  }

  analysisForDocument(doc: vscode.TextDocument): { info: CellInfo; ctx: SectionContext; analysis: Analysis } | undefined {
    const info = cellInfo(doc);
    if (!info) return undefined;
    const ctx = this.index.context(info.fileKey, info.sectionKey);
    if (!ctx) return undefined;
    return { info, ctx, analysis: this.analysisOf(ctx, doc.getText()) };
  }

  private occurrenceAt(analysis: Analysis, offset: number): Occurrence | undefined {
    return this.sections.occurrenceAt(analysis, offset);
  }

  /** Location of a symbol: in the split editor, or in its object notebook (opened in the background if needed). */
  async toLocation(loc: Loc): Promise<vscode.Location | undefined> {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    if (!ctx) return undefined;
    if (editorMode() === 'split' && this.splitLocator) return this.splitLocator(ctx, loc);
    const diskObject = this.ws.getFile(ctx.filePath)?.objects.get(ctx.object.id);
    const sections = diskObject?.sections.filter(s => s.accessor === ctx.accessor) ?? [];
    const nb = await openObjectDocument(ctx.filePath, { ...(diskObject ?? ctx.object), sections }, ctx.accessor);
    const uri = nb.uri;
    const cell = nb.getCells().find(c => cellMeta(c)?.key === loc.sectionKey);
    if (!cell) return new vscode.Location(uri, new vscode.Position(0, 0));
    const d = cell.document;
    return new vscode.Location(d.uri, new vscode.Range(d.positionAt(loc.start), d.positionAt(loc.end)));
  }

  // ------------------------------------------------------------------ section-level features (split editor and cells)

  /** Where the symbol at an offset is declared (itself when the offset is on a declaration). */
  definitionAt(ctx: SectionContext, text: string, offset: number): Loc | undefined {
    return this.sections.definitionAt(ctx, text, offset);
  }

  hoverAt(ctx: SectionContext, text: string, offset: number): HoverResult | undefined {
    const o = this.occurrenceAt(this.analysisOf(ctx, text), offset);
    if (!o) return undefined;
    const s = o.sym;
    return { markdown: codeblock(s.signature || s.name) + symbolDoc(s), start: o.start, end: o.end };
  }

  completionsAt(ctx: SectionContext, text: string, offset: number): CompletionResult[] {
    const analyzer = new Analyzer(this.index, ctx, text);
    const exprText = expressionBeforeDot(text, offset);
    const cc = completionContext(text, offset);
    // Calls with their arguments (XAE's "Insert with arguments"), in implementations, where none is written yet
    // and a call can go (not as the variable an output goes to).
    const calls = ctx.role === 'impl' && !cc.inComment && !cc.callFollows && !cc.outputTarget;
    const hints = vscode.workspace.getConfiguration('editor', { languageId: ST_LANGUAGE }).get<boolean>('parameterHints.enabled', true);
    const items: CompletionResult[] = [];
    const add = (s: Sym, ty: Ty) => {
      const firstLine = (s.signature || '').split('\n')[0];
      const doc = (s.signature ? codeblock(s.signature) : '') + symbolDoc(s);
      const item: CompletionResult = { label: s.name, kind: completionKind(s), detail: firstLine || tyToString(ty), documentation: doc };
      items.push(item);
      const c = calls ? callableOfSymbol(analyzer, s, ty) : undefined;
      // A call without a value (of a function block instance, an action) is a statement of its own.
      if (c && (cc.statement || returnsValue(c))) {
        items.push({
          ...item, labelDetail: callArguments(c), snippet: callSnippet(c, s.name, cc.statement && !cc.semicolonFollows),
          signatureHelp: hints && c.params.length > 0,
        });
      }
    };
    if (exprText !== undefined) {
      let t = analyzer.typeOfText(exprText);
      for (let i = 0; i < 4 && (t.k === 'ref' || t.k === 'ptr'); i++) t = t.to;
      for (const r of analyzer.listMembers(t)) add(r.sym, r.ty);
      return items;
    }
    for (const r of analyzer.listScope()) add(r.sym, r.ty);
    for (const kw of KEYWORDS) items.push({ label: kw, kind: 'Keyword' });
    for (const s of snippetsAt(ctx.role, cc)) {
      items.push({
        label: s.label, kind: 'Snippet', detail: s.detail, documentation: codeblock(s.preview), snippet: s.body, filterText: s.filterText,
        range: s.range,
      });
    }
    return items;
  }

  /** The signature of the call the cursor is in, and the parameter the cursor is at. */
  signatureHelpAt(ctx: SectionContext, text: string, offset: number): SignatureResult | undefined {
    const s = signatureAt(this.index, ctx, text, offset);
    if (!s) return undefined;
    return {
      label: s.label,
      documentation: callableDoc(s.callable),
      parameters: s.callable.params.map((p, i) => ({ label: s.params[i], documentation: paramDoc(p) })),
      activeParameter: s.active,
    };
  }

  /** References of the symbol at an offset, across all sections (unsaved edits included). */
  referencesAt(ctx: SectionContext, text: string, offset: number, includeDeclaration: boolean): Loc[] {
    return this.sections.referencesAt(ctx, text, offset, includeDeclaration);
  }

  referenceLocs(target: Sym, includeDeclaration: boolean): Loc[] {
    return this.sections.referenceLocs(target, includeDeclaration);
  }

  /** Where the implementations of the symbol at an offset are declared (see SectionFeatures.implementationsAt). */
  implementationsAt(ctx: SectionContext, text: string, offset: number): Loc[] {
    return this.sections.implementationsAt(ctx, text, offset);
  }

  /** Problems of a section with the given text. */
  problemsOf(ctx: SectionContext, text: string) {
    return this.analysisOf(ctx, text).problems;
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
    const h = this.hoverAt(r.ctx, doc.getText(), doc.offsetAt(pos));
    if (!h) return undefined;
    return new vscode.Hover(new vscode.MarkdownString(h.markdown), new vscode.Range(doc.positionAt(h.start), doc.positionAt(h.end)));
  }

  // ------------------------------------------------------------------ completion

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const info = cellInfo(doc);
    if (!info) return undefined;
    const ctx = this.index.context(info.fileKey, info.sectionKey);
    if (!ctx) return undefined;
    return this.completionsAt(ctx, doc.getText(), doc.offsetAt(pos)).map(e => {
      const label = e.labelDetail ? { label: e.label, detail: e.labelDetail } : e.label;
      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind[e.kind as CompletionKindName]);
      item.detail = e.detail;
      if (e.documentation) item.documentation = new vscode.MarkdownString(e.documentation);
      if (e.snippet) item.insertText = new vscode.SnippetString(e.snippet);
      if (e.filterText) item.filterText = e.filterText;
      if (e.range) item.range = new vscode.Range(doc.positionAt(e.range.start), doc.positionAt(e.range.end));
      if (e.signatureHelp) item.command = { command: 'editor.action.triggerParameterHints', title: 'Show the parameters' };
      return item;
    });
  }

  // ------------------------------------------------------------------ signature help

  provideSignatureHelp(doc: vscode.TextDocument, pos: vscode.Position): vscode.SignatureHelp | undefined {
    const info = cellInfo(doc);
    const ctx = info && this.index.context(info.fileKey, info.sectionKey);
    const s = ctx && this.signatureHelpAt(ctx, doc.getText(), doc.offsetAt(pos));
    if (!s) return undefined;
    const markdown = (text: string | undefined) => (text ? new vscode.MarkdownString(text) : undefined);
    const signature = new vscode.SignatureInformation(s.label, markdown(s.documentation));
    signature.parameters = s.parameters.map(p => new vscode.ParameterInformation(p.label, markdown(p.documentation)));
    signature.activeParameter = s.activeParameter;
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = s.activeParameter;
    return help;
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
    const out: vscode.Location[] = [];
    for (const loc of this.referenceLocs(target, includeDeclaration)) {
      const l = await this.toLocation(loc);
      if (l) out.push(l);
    }
    return out;
  }

  // ------------------------------------------------------------------ document highlights

  /** The keywords of the block at the cursor (IF ... END_IF), or the occurrences of the symbol there, written or read. */
  provideDocumentHighlights(doc: vscode.TextDocument, pos: vscode.Position): vscode.DocumentHighlight[] {
    const info = cellInfo(doc);
    const ctx = info && this.index.context(info.fileKey, info.sectionKey);
    const kinds = { text: vscode.DocumentHighlightKind.Text, read: vscode.DocumentHighlightKind.Read, write: vscode.DocumentHighlightKind.Write };
    return this.sections.highlightsAt(ctx, doc.getText(), doc.offsetAt(pos))
      .map(h => new vscode.DocumentHighlight(new vscode.Range(doc.positionAt(h.start), doc.positionAt(h.end)), kinds[h.kind]));
  }

  // ------------------------------------------------------------------ folding

  /** Folding by the blocks of the code, not by indentation (see foldingRanges). */
  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    const kinds = { comment: vscode.FoldingRangeKind.Comment, region: vscode.FoldingRangeKind.Region };
    return foldingRanges(doc.getText()).map(f => new vscode.FoldingRange(f.startLine, f.endLine, f.kind && kinds[f.kind]));
  }

  // ------------------------------------------------------------------ implementations

  async provideImplementation(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location[]> {
    const r = this.analysisForDocument(doc);
    if (!r) return [];
    const out: vscode.Location[] = [];
    for (const loc of this.implementationsAt(r.ctx, doc.getText(), doc.offsetAt(pos))) {
      const l = await this.toLocation(loc);
      if (l) out.push(l);
    }
    return out;
  }

  // ------------------------------------------------------------------ document symbols (Outline)

  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const info = cellInfo(doc);
    const ctx = info && this.index.context(info.fileKey, info.sectionKey);
    const range = (start: number, end: number) => new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    const toSymbol = (s: OutlineSymbol): vscode.DocumentSymbol => {
      const d = new vscode.DocumentSymbol(s.name, s.detail, vscode.SymbolKind[s.kind], range(s.start, s.end), range(s.nameStart, s.nameEnd));
      d.children = s.children.map(toSymbol);
      return d;
    };
    return this.sections.outlineOf(ctx, doc.getText()).map(toSymbol);
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
    const split = editorMode() === 'split' && this.splitLocator;
    const add = (s: Sym, container: string) => {
      if (!s.loc || !matches(s.name)) return;
      const ctx = this.index.context(s.loc.fileKey, s.loc.sectionKey);
      if (!ctx) return;
      if (split) {
        const location = this.splitLocator!(ctx, s.loc);
        if (location) out.push(new vscode.SymbolInformation(s.name, symbolKind(s), container, location));
        return;
      }
      const uri = objectUri(ctx.filePath, ctx.object, undefined, ctx.accessor);
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
    // Each file once (getFile checks the disk), not once per section.
    const files = new Map<string, TcSourceFile | undefined>();
    for (const ctx of this.index.allContexts()) {
      if (!files.has(ctx.fileKey)) files.set(ctx.fileKey, this.ws.getFile(ctx.filePath));
      const file = files.get(ctx.fileKey);
      const section = file?.sections.get(ctx.sectionKey);
      if (!file || !section) continue;
      // A section with unsaved edits is reported live in its editor; its offsets no longer match the XML.
      if (this.index.sectionText(ctx.fileKey, ctx.sectionKey) !== section.text) continue;
      const a = analyze(this.index, ctx, section.text, { ignore });
      if (a.problems.length === 0) continue;
      const diags = byFile.get(ctx.filePath) ?? [];
      for (const p of a.problems) {
        const start = positionIn(file.text, sectionOffsetToFileOffset(file, section, p.start));
        const end = positionIn(file.text, sectionOffsetToFileOffset(file, section, p.end));
        diags.push(toDiagnostic(new vscode.Range(start.line, start.character, end.line, end.character),
          `${ctx.object.qualifiedName} (${ctx.label}): ${p.message}`, p.severity));
        problems++;
      }
      byFile.set(ctx.filePath, diags);
    }
    for (const [p, diags] of byFile) collection.set(fileUri(p), diags);
    return { files: byFile.size, problems };
  }
}

/** Live diagnostics for the Structured Text cells of open TwinCAT notebooks. */
export class CellDiagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('twincat');
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private allTimer: NodeJS.Timeout | undefined;

  constructor(private readonly features: LanguageFeatures) {}

  refresh(doc: vscode.TextDocument): void {
    if (doc.languageId !== ST_LANGUAGE) return;
    if (!diagnosticsEnabled()) {
      this.collection.delete(doc.uri);
      return;
    }
    const r = this.features.analysisForDocument(doc);
    if (!r || !r.info.live) {
      this.collection.delete(doc.uri);
      return;
    }
    this.collection.set(doc.uri, r.analysis.problems.map(p =>
      toDiagnostic(new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)), p.message, p.severity)));
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

// Webview of the XAE-like split editor: one Monaco editor per section of the
// object view (Declaration above Implementation), each with its own scroll bar,
// and a splitter between them. Edits go to the extension host, which owns the
// document; language features are answered by the host.

// The entry with all editor contributions (find, hover, suggest, peek, folding, ...) and no languages.
// @ts-ignore: this entry point has no type declarations of its own
import * as monacoAll from 'monaco-editor/esm/vs/editor/edcore.main.js';
import type * as Monaco from 'monaco-editor';
import {
  BlameCommitInfo, BlameProbe, CompletionResult, EditorConfig, HighlightResult, HostMessage, HoverResult, OutlineResult, LanguageConfig, PaneSection, PaneState, ProbeAction,
  ProbeState, RenameInfo, RequestKind, SectionBlame, SectionRef, SignatureResult, TargetRange, TokenRule, WORKBENCH_CHORDS, WebviewMessage,
} from '../shared/protocol';
import { escapeMarkdown } from '../shared/markdown';
import { registerQuickFixes } from './quickFixes';
import { relativeTime } from '../shared/time';
import { TextMateHighlighter, parseColor, toHex } from './textmate';
import { foldingRanges } from '../lang/folding';
// Internal Monaco services: the public registerEditorOpener can only answer with the source editor, which
// makes Monaco highlight, reveal and move peek views in the wrong pane.
// @ts-ignore: no type declarations for internal modules
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
// @ts-ignore: no type declarations for internal modules
import { ICodeEditorService } from 'monaco-editor/esm/vs/editor/browser/services/codeEditorService.js';
// The line diff of Monaco's diff editor, for the change markers of the panes (Monaco has no public API for it).
// @ts-ignore: no type declarations for internal modules
import { linesDiffComputers } from 'monaco-editor/esm/vs/editor/common/diff/linesDiffComputers.js';

const monaco = monacoAll as typeof Monaco;

interface LineRange {
  startLineNumber: number;
  endLineNumberExclusive: number;
}

const diffComputer = (linesDiffComputers as {
  getDefault(): {
    computeDiff(original: string[], modified: string[], options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }):
      { changes: { original: LineRange; modified: LineRange }[] };
  };
}).getDefault();

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
declare global {
  interface Window {
    TWINCAT_WORKER_URL: string;
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker | Promise<Worker> };
  }
}

const vscodeApi = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscodeApi.postMessage(m);
const errors: string[] = [];
const reportError = (message: string) => {
  errors.push(message);
  post({ type: 'error', message });
};
window.addEventListener('error', e => reportError(String(e.message)));
window.addEventListener('unhandledrejection', e => reportError(String((e.reason as Error)?.stack ?? e.reason)));

// The worker runs from a blob made of the script's text: a blob worker that imports the script from the
// webview's resource URL never answers (its request does not go through the webview), and the diff editor
// computes its diffs in this worker.
let workerSource: Promise<string> | undefined;
window.MonacoEnvironment = {
  getWorker() {
    workerSource ??= fetch(window.TWINCAT_WORKER_URL).then(r => {
      if (!r.ok) throw new Error(`editor worker: ${r.status}`);
      return r.text();
    });
    return workerSource.then(source => new Worker(URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))));
  },
};

const LANG = 'twincat-st';
const THEME = 'twincat-vscode';
const SASH = 4;
const MIN_PANE = 40;
monaco.languages.register({ id: LANG });

/** A changed block against HEAD: lines of the HEAD text replaced by lines of the pane (1-based, end exclusive). */
interface Change {
  original: LineRange;
  modified: LineRange;
}

interface Pane {
  section: PaneSection;
  model: Monaco.editor.ITextModel;
  /** The pane's own editor. */
  standalone: Monaco.editor.IStandaloneCodeEditor;
  /** The editor the pane shows: its own one, or the modified side of the inline diff against HEAD. */
  editor: Monaco.editor.ICodeEditor;
  element: HTMLElement;
  /** Holds the pane's own editor (hidden while the diff is shown). */
  host: HTMLElement;
  /** HEAD text of the section (empty for a section that is not in HEAD). */
  base?: Monaco.editor.ITextModel;
  /** The section is not in HEAD: every line is new. */
  baseNew: boolean;
  changes: Change[];
  changeMarks: Monaco.editor.IEditorDecorationsCollection;
  changeTimer?: number;
  diff?: { editor: Monaco.editor.IStandaloneDiffEditor; host: HTMLElement; collapsed: boolean };
  /** "2 changes vs HEAD", shown over the pane while the changes are shown. */
  label: HTMLElement;
  /** Line blame of the section as it is on disk: the text it was computed on, and the commit of each line. */
  blame?: SectionBlame;
  /** Line changes from the blamed text to the pane's text, for the model version they were computed on. */
  blameDiff?: { version: number; changes: Change[] };
  /** The blame annotation of the current line, on the editor it was put on. */
  blameMarks?: Monaco.editor.IEditorDecorationsCollection;
  blameEditor?: Monaco.editor.ICodeEditor;
  blameShown?: { line: number; commit: BlameCommitInfo };
  blameTimer?: number;
  /** Time of the last change of the text: the annotation comes back once typing pauses. */
  typedAt: number;
}

interface ModelInfo {
  /** Section of another object view (read-only, shown in peek views). */
  ref?: SectionRef;
}

let fileKey = '';
let panes: Pane[] = [];
let sash: HTMLElement | undefined;
const root = document.getElementById('root')!;
const models = new Map<string, ModelInfo>();
let ratio = 0.5;
let seq = 0;
/** Seq of the last edit sent per section: a sync older than it is not applied to that section. */
const lastSeqOf = new Map<string, number>();
let resyncTimer: number | undefined;
let applyingRemote = false;
/** The TextMate colors are applied (until then the panes use a theme with VS Code's colors only). */
let highlighted = false;
let lastFocused: string | undefined;
let config: EditorConfig | undefined;
let themeRules: TokenRule[] | undefined;
const highlighter = new TextMateHighlighter(monaco, LANG);
let highlighterReady: Promise<void> | undefined;
let requestId = 0;
let providersRegistered = false;
const pending = new Map<number, (result: unknown) => void>();
/** Base texts: not received yet, received, or none (not in a git repository). */
let baseState: 'pending' | 'available' | 'unavailable' = 'pending';
/** Name of what the panes compare with (HEAD, or a branch chosen in the TwinCAT Changes view). */
let baseLabel = 'HEAD';
/** The panes show their changes as inline diffs. */
let changesMode = false;
/** The changes were asked for (they show once the base texts are there). */
let wantChanges = false;
/** Go to the first change once the diffs show. */
let wantFirst = false;
/** The blame annotation of the current line is turned on (and the blame came). */
let blameOn = false;
/** Commits of the line blame, which SectionBlame.lines index. */
let blameCommits: BlameCommitInfo[] = [];
/** The pointer is over a blame annotation: the language hover keeps away from it. */
let pointerOnBlame = false;
/** A line changed since the file was blamed (not saved yet, or saved and about to be blamed again). */
const NOT_COMMITTED: BlameCommitInfo = { sha: '', author: '', you: true, time: 0, summary: 'Uncommitted changes', uncommitted: true };
/** Wait after the last keystroke before the annotation shows again. */
const TYPING_PAUSE = 800;

function request<T>(kind: RequestKind, key: string, model: Monaco.editor.ITextModel, offset: number, includeDeclaration?: boolean,
  newName?: string, others?: { key: string; text: string }[]): Promise<T | null> {
  const id = ++requestId;
  return new Promise(resolve => {
    pending.set(id, r => resolve(r as T | null));
    post({ type: 'request', id, kind, key, text: model.getValue(), offset, includeDeclaration, newName, others });
  });
}

// ------------------------------------------------------------------ state kept by VS Code for this tab

interface SavedState {
  ratio?: number;
  changes?: boolean;
}

function saveState(): void {
  vscodeApi.setState({ ratio, changes: wantChanges } satisfies SavedState);
  // Also kept by the host: a webview that is rebuilt (its tab replaced, moved) gets it back.
  post({ type: 'ratio', ratio });
}

const saved = (vscodeApi.getState() ?? {}) as SavedState;
if (typeof saved.ratio === 'number') ratio = saved.ratio;

// ------------------------------------------------------------------ theme

function themeBase(): Monaco.editor.BuiltinTheme {
  const c = document.body.classList;
  if (c.contains('vscode-high-contrast-light')) return 'hc-light';
  if (c.contains('vscode-high-contrast')) return 'hc-black';
  if (c.contains('vscode-light')) return 'vs';
  return 'vs-dark';
}

/** VS Code's theme colors, from the CSS variables it sets on the webview (`--vscode-editor-background` is `editor.background`). */
function themeColors(): Record<string, string> {
  const colors: Record<string, string> = {};
  const style = document.documentElement.style;
  for (let i = 0; i < style.length; i++) {
    const name = style[i];
    if (!name.startsWith('--vscode-')) continue;
    const id = name.slice('--vscode-'.length).replace('-', '.');
    if (!id.includes('.')) continue;
    const c = parseColor(style.getPropertyValue(name));
    if (c) colors[id] = toHex(c, true);
  }
  return colors;
}

async function applyTheme(): Promise<void> {
  const base = themeBase();
  const colors = themeColors();
  if (!highlighted) {
    // VS Code's colors right away (Monaco would otherwise paint its light theme until TextMate is ready).
    monaco.editor.defineTheme(THEME, { base, inherit: false, rules: [], colors });
    monaco.editor.setTheme(THEME);
  }
  if (!themeRules || !highlighterReady) return;
  await highlighterReady;
  await highlighter.apply(themeRules, THEME, base, colors);
  highlighted = true;
}

// VS Code updates the CSS variables and body classes when the color theme changes.
new MutationObserver(() => void applyTheme().catch(e => reportError(String(e)))).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
new MutationObserver(() => void applyTheme().catch(e => reportError(String(e)))).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ------------------------------------------------------------------ language

function applyLanguage(l: LanguageConfig): void {
  const conf: Monaco.languages.LanguageConfiguration = {
    comments: { lineComment: l.lineComment, blockComment: l.blockComment },
    brackets: l.brackets,
    autoClosingPairs: l.autoClosingPairs,
    surroundingPairs: l.surroundingPairs?.map(([open, close]) => ({ open, close })),
  };
  try {
    if (l.wordPattern) conf.wordPattern = new RegExp(l.wordPattern);
    if (l.increaseIndentPattern && l.decreaseIndentPattern) {
      conf.indentationRules = { increaseIndentPattern: new RegExp(l.increaseIndentPattern), decreaseIndentPattern: new RegExp(l.decreaseIndentPattern) };
    }
    if (l.foldingStart && l.foldingEnd) conf.folding = { markers: { start: new RegExp(l.foldingStart), end: new RegExp(l.foldingEnd) } };
  } catch (e) {
    reportError(`language configuration: ${e}`);
  }
  monaco.languages.setLanguageConfiguration(LANG, conf);
}

function ownPane(model: Monaco.editor.ITextModel): Pane | undefined {
  return panes.find(p => p.model === model);
}

function modelUri(ref: { fileKey: string; sectionKey: string; role: 'decl' | 'impl'; title: string }): Monaco.Uri {
  return monaco.Uri.from({
    scheme: 'twincat-section',
    path: `/${ref.role === 'decl' ? 'Declaration' : 'Implementation'}/${ref.title}`,
    query: `f=${encodeURIComponent(ref.fileKey)}&s=${encodeURIComponent(ref.sectionKey)}`,
  });
}

/** Model showing a target: one of this tab's sections, or a read-only copy of another object's section. */
function targetModel(t: TargetRange): Monaco.editor.ITextModel {
  if (t.ref.fileKey === fileKey) {
    const own = panes.find(p => p.section.key === t.ref.sectionKey);
    if (own) return own.model;
  }
  const uri = modelUri({ fileKey: t.ref.fileKey, sectionKey: t.ref.sectionKey, role: t.ref.role, title: t.ref.view.label });
  // Registered first, so the peek editor showing it is made read-only (see onDidCreateEditor).
  models.set(uri.toString(), { ref: t.ref });
  foreignOrder.delete(uri.toString());
  foreignOrder.add(uri.toString());
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(t.ref.text, LANG, uri);
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
  } else if (model.getValue() !== t.ref.text) {
    applyingRemote = true;
    try {
      model.setValue(t.ref.text);
    } finally {
      applyingRemote = false;
    }
  }
  return model;
}

/** Copies of other objects' sections, oldest first; pruned before each new result (see pruneForeign). */
const foreignOrder = new Set<string>();
const MAX_FOREIGN = 60;

function pruneForeign(): void {
  if (foreignOrder.size <= MAX_FOREIGN) return;
  const shown = new Set(monaco.editor.getEditors().map(e => e.getModel()?.uri.toString()));
  for (const key of [...foreignOrder]) {
    if (foreignOrder.size <= MAX_FOREIGN) break;
    if (shown.has(key)) continue;
    foreignOrder.delete(key);
    models.delete(key);
    monaco.editor.getModel(monaco.Uri.parse(key))?.dispose();
  }
}

function rangeOf(model: Monaco.editor.ITextModel, start: number, end: number): Monaco.Range {
  const a = model.getPositionAt(start);
  const b = model.getPositionAt(end);
  return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
}

function locationOf(t: TargetRange): Monaco.languages.Location {
  const model = targetModel(t);
  return { uri: model.uri, range: rangeOf(model, t.start, t.end) };
}

/**
 * F2 (Rename Symbol): the host finds what the name stands for, asks its questions and writes the files, which the
 * panes then show; Monaco applies no edit of its own.
 */
function registerRename(): void {
  monaco.languages.registerRenameProvider(LANG, {
    async resolveRenameLocation(model, position) {
      const pane = ownPane(model);
      const here = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
      const r = pane && await request<RenameInfo>('prepareRename', pane.section.key, model, model.getOffsetAt(position));
      if (!r || 'problem' in r) return { range: here, text: '', rejectReason: r ? r.problem : 'Nothing to rename here.' };
      return { range: rangeOf(model, r.start, r.end), text: r.text };
    },
    async provideRenameEdits(model, position, newName) {
      const pane = ownPane(model);
      if (pane) await request<null>('rename', pane.section.key, model, model.getOffsetAt(position), undefined, newName);
      return { edits: [] };
    },
  });
}

/** Auto Declare... in the pane edited last (see quickFixes.ts). */
let autoDeclare = () => {};

function registerProviders(): void {
  registerRename();
  autoDeclare = registerQuickFixes(monaco, LANG, {
    keyOf: model => {
      const pane = ownPane(model);
      return pane?.section.editable ? pane.section.key : undefined;
    },
    request,
    post,
    lastEditor: () => panes.find(p => p.section.key === lastFocused)?.editor,
  });
  monaco.languages.registerDefinitionProvider(LANG, {
    async provideDefinition(model, position) {
      const pane = ownPane(model);
      if (!pane) return null;
      pruneForeign();
      const t = await request<TargetRange>('definition', pane.section.key, model, model.getOffsetAt(position));
      return t ? locationOf(t) : null;
    },
  });
  monaco.languages.registerReferenceProvider(LANG, {
    async provideReferences(model, position, context) {
      const pane = ownPane(model);
      if (!pane) return null;
      pruneForeign();
      const ts = await request<TargetRange[]>('references', pane.section.key, model, model.getOffsetAt(position), context.includeDeclaration);
      return (ts ?? []).map(locationOf);
    },
  });
  // Go to Symbol (Ctrl+Shift+O): the declarations of the pane in their VAR blocks, its regions and CASE branches.
  monaco.languages.registerDocumentSymbolProvider(LANG, {
    displayName: 'TwinCAT',
    async provideDocumentSymbols(model) {
      const pane = ownPane(model);
      if (!pane) return null;
      const symbols = await request<OutlineResult[]>('symbols', pane.section.key, model, 0);
      const kinds = monaco.languages.SymbolKind as unknown as Record<string, Monaco.languages.SymbolKind>;
      // Monaco's Go to Symbol shows no detail: it goes in the name, where it can be searched for too (the comment of
      // a CASE branch, `20 — Wait for the axis`; the type of a variable, `bEnable : BOOL`).
      const label = (s: OutlineResult) => !s.detail ? s.name
        : s.kind === 'Variable' || s.kind === 'Constant' ? `${s.name} : ${s.detail}` : `${s.name} — ${s.detail}`;
      const toSymbol = (s: OutlineResult): Monaco.languages.DocumentSymbol => ({
        name: label(s), detail: s.detail, kind: kinds[s.kind] ?? monaco.languages.SymbolKind.Object, tags: [],
        range: rangeOf(model, s.start, s.end), selectionRange: rangeOf(model, s.nameStart, s.nameEnd), children: s.children.map(toSymbol),
      });
      return (symbols ?? []).map(toSymbol);
    },
  });
  // Folding by the blocks of the code (IF ... END_IF and each of its branches, VAR ... END_VAR, comments, regions),
  // not by indentation. Computed here: it needs the text alone, and comes with every change.
  monaco.languages.registerFoldingRangeProvider(LANG, {
    provideFoldingRanges(model) {
      const kinds = { comment: monaco.languages.FoldingRangeKind.Comment, region: monaco.languages.FoldingRangeKind.Region };
      return foldingRanges(model.getValue()).map(f => ({ start: f.startLine + 1, end: f.endLine + 1, kind: f.kind && kinds[f.kind] }));
    },
  });
  // The keywords of the block at the cursor (IF, ELSIF, ELSE, END_IF), or the occurrences of the symbol there, written
  // or read: in this pane, and in the other panes (the declaration of a variable used in the implementation).
  monaco.languages.registerDocumentHighlightProvider(LANG, {
    async provideDocumentHighlights(model, position, token) {
      const pane = ownPane(model);
      if (!pane) return null;
      const others = panes.filter(p => p !== pane).map(p => ({ key: p.section.key, text: p.model.getValue() }));
      const hs = await request<HighlightResult[]>('highlights', pane.section.key, model, model.getOffsetAt(position), undefined, undefined,
        others);
      if (token.isCancellationRequested) return null;
      const own = (hs ?? []).filter(h => h.key === undefined);
      showCrossHighlights(pane, own.map(h => rangeOf(model, h.start, h.end)), (hs ?? []).filter(h => h.key !== undefined));
      const kinds = { text: monaco.languages.DocumentHighlightKind.Text, read: monaco.languages.DocumentHighlightKind.Read,
        write: monaco.languages.DocumentHighlightKind.Write };
      return own.map(h => ({ range: rangeOf(model, h.start, h.end), kind: kinds[h.kind] }));
    },
  });
  // Go to Implementations (Ctrl+F12) and Peek Implementations: the function blocks that implement an interface or
  // extend a function block, the methods and properties that implement or override one.
  monaco.languages.registerImplementationProvider(LANG, {
    async provideImplementation(model, position) {
      const pane = ownPane(model);
      if (!pane) return null;
      pruneForeign();
      const ts = await request<TargetRange[]>('implementation', pane.section.key, model, model.getOffsetAt(position));
      return (ts ?? []).map(locationOf);
    },
  });
  // VS Code's type hierarchy does not reach the panes: the host shows the one of the type at the cursor.
  monaco.editor.addEditorAction({
    id: 'twincat.showTypeHierarchy',
    label: 'Show Type Hierarchy',
    // Not in peek views.
    precondition: '!inReferenceSearchEditor',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    run(editor) {
      const model = editor.getModel();
      const position = editor.getPosition();
      const pane = model ? ownPane(model) : undefined;
      if (!model || !pane || !position) return;
      post({ type: 'typeHierarchy', key: pane.section.key, text: model.getValue(), offset: model.getOffsetAt(position) });
    },
  });
  monaco.languages.registerHoverProvider(LANG, {
    async provideHover(model, position) {
      const pane = ownPane(model);
      // Over the blame annotation the hover is the commit's (its decoration's), not the word's at the line end.
      if (!pane || pointerOnBlame) return null;
      const h = await request<HoverResult>('hover', pane.section.key, model, model.getOffsetAt(position));
      if (!h) return null;
      return { contents: [{ value: h.markdown }], range: rangeOf(model, h.start, h.end) };
    },
  });
  monaco.languages.registerCompletionItemProvider(LANG, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const pane = ownPane(model);
      if (!pane) return { suggestions: [] };
      const items = await request<CompletionResult[]>('completion', pane.section.key, model, model.getOffsetAt(position));
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const kinds = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
      return {
        suggestions: (items ?? []).map((i): Monaco.languages.CompletionItem => ({
          label: i.labelDetail ? { label: i.label, detail: i.labelDetail } : i.label,
          kind: kinds[i.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: i.detail,
          documentation: i.documentation ? { value: i.documentation } : undefined,
          insertText: i.snippet ?? i.label,
          insertTextRules: i.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          filterText: i.filterText,
          range: i.range ? rangeOf(model, i.range.start, i.range.end) : range,
          command: i.signatureHelp ? { id: 'editor.action.triggerParameterHints', title: 'Show the parameters' } : undefined,
        })),
      };
    },
  });
  monaco.languages.registerSignatureHelpProvider(LANG, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const pane = ownPane(model);
      if (!pane) return null;
      const s = await request<SignatureResult>('signature', pane.section.key, model, model.getOffsetAt(position));
      if (!s) return null;
      const markdown = (value: string | undefined) => (value ? { value } : undefined);
      return {
        value: {
          signatures: [{
            label: s.label,
            documentation: markdown(s.documentation),
            parameters: s.parameters.map(p => ({ label: p.label, documentation: markdown(p.documentation) })),
          }],
          activeSignature: 0,
          activeParameter: s.activeParameter,
        },
        dispose() {},
      };
    },
  });
  // Navigation to another model (go to definition, references, peek): the other pane of this tab, or another
  // object, which the host opens in its own tab.
  const codeEditors = StandaloneServices.get(ICodeEditorService) as {
    registerCodeEditorOpenHandler(handler: (input: { resource: Monaco.Uri; options?: { selection?: Monaco.IRange } },
      source: Monaco.editor.ICodeEditor | null, sideBySide?: boolean) => Promise<Monaco.editor.ICodeEditor | null>): Monaco.IDisposable;
  };
  codeEditors.registerCodeEditorOpenHandler(async (input, source, sideBySide) => {
    const resource = input.resource;
    const info = models.get(resource.toString());
    // The same model: Monaco's own handling.
    if (!info || source?.getModel()?.uri.toString() === resource.toString()) return null;
    const sel = input.options?.selection;
    const range = sel ? new monaco.Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber ?? sel.startLineNumber, sel.endColumn ?? sel.startColumn) : undefined;
    const pane = panes.find(p => p.model.uri.toString() === resource.toString());
    if (pane) {
      if (range) {
        pane.editor.setSelection(range);
        pane.editor.revealRangeInCenterIfOutsideViewport(range);
      }
      // After the peek view (if any) has closed and given the focus back to where it came from, unless the
      // peek moved into the target pane and has the focus there.
      setTimeout(() => {
        if (!pane.editor.hasWidgetFocus()) pane.editor.focus();
      }, 0);
      return pane.editor;
    }
    const model = monaco.editor.getModel(resource);
    if (info.ref && model) {
      const start = range ? model.getOffsetAt(range.getStartPosition()) : 0;
      const end = range ? model.getOffsetAt(range.getEndPosition()) : start;
      post({ type: 'open', target: { ref: info.ref, start, end }, side: !!sideBySide });
    }
    return null;
  });
}

// ------------------------------------------------------------------ layout

/**
 * Editors were created while the page was hidden (the commit diff panel behind another tab, built again when the
 * index changes): Monaco measured the font as nothing there, so clicks land columns away from the pointer and the
 * line numbers are cut. Measured again once the page shows.
 */
let measuredHidden = false;

function noteIfHidden(): void {
  if (document.hidden || root.clientWidth === 0) measuredHidden = true;
}

function layout(): void {
  if (measuredHidden && !document.hidden && root.clientWidth > 0) {
    measuredHidden = false;
    monaco.editor.remeasureFonts();
  }
  const height = root.clientHeight;
  if (panes.length === 1) {
    panes[0].element.style.top = '0px';
    panes[0].element.style.height = `${height}px`;
  } else if (panes.length >= 2) {
    const usable = Math.max(0, height - SASH);
    const minRatio = Math.min(0.5, MIN_PANE / Math.max(1, usable));
    // Clamped for this size only: the chosen ratio comes back when the editor grows again.
    const r = Math.max(minRatio, Math.min(1 - minRatio, ratio));
    const top = Math.round(usable * r);
    panes[0].element.style.top = '0px';
    panes[0].element.style.height = `${top}px`;
    sash!.style.top = `${top}px`;
    panes[1].element.style.top = `${top + SASH}px`;
    panes[1].element.style.height = `${usable - top}px`;
  }
  for (const p of panes) {
    if (p.diff) layoutDiff(p.diff);
    else p.standalone.layout();
  }
  if (revealWhenShown && height > 0 && !document.hidden) revealFirstChange();
}

/**
 * Without automatic layout a diff editor measures its own root, which it gives a fixed height: it would never grow
 * back. It gets the size of the host it fills instead.
 */
function layoutDiff(diff: NonNullable<Pane['diff']>): void {
  diff.editor.layout({ width: diff.host.clientWidth, height: diff.host.clientHeight });
}

function setRatio(r: number): void {
  ratio = r;
  layout();
  saveState();
}

function createSash(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sash';
  let dragging = false;
  let hoverTimer: number | undefined;
  el.addEventListener('pointerenter', () => {
    hoverTimer = window.setTimeout(() => el.classList.add('hover'), 300);
  });
  el.addEventListener('pointerleave', () => {
    window.clearTimeout(hoverTimer);
    if (!dragging) el.classList.remove('hover');
  });
  el.addEventListener('pointerdown', e => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = root.getBoundingClientRect();
    const usable = Math.max(1, rect.height - SASH);
    const minRatio = Math.min(0.5, MIN_PANE / usable);
    ratio = Math.max(minRatio, Math.min(1 - minRatio, (e.clientY - rect.top - SASH / 2) / usable));
    layout();
  });
  const stop = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.releasePointerCapture?.(e.pointerId);
    el.classList.remove('active', 'hover');
    saveState();
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  // Double click: back to two equal halves.
  el.addEventListener('dblclick', () => setRatio(0.5));
  return el;
}

function editorOptions(section: PaneSection): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    ...(config?.options ?? {}),
    language: LANG,
    theme: THEME,
    readOnly: !section.editable,
    automaticLayout: false,
    // VS Code pastes and cuts in a webview with document.execCommand, which does nothing with
    // Monaco's EditContext input: the text area takes the clipboard.
    editContext: false,
    // Hovers and suggestions may extend beyond the pane they belong to.
    fixedOverflowWidgets: true,
    ariaLabel: section.label,
  } as Monaco.editor.IStandaloneEditorConstructionOptions;
}

/** Options of the inline diff a pane shows against HEAD: the pane's text editable, HEAD's read-only. */
function diffOptions(section: PaneSection, collapsed: boolean): Monaco.editor.IStandaloneDiffEditorConstructionOptions {
  return {
    ...(config?.options ?? {}),
    theme: THEME,
    readOnly: !section.editable,
    originalEditable: false,
    renderSideBySide: false,
    useInlineViewWhenSpaceIsLimited: true,
    automaticLayout: false,
    editContext: false,
    fixedOverflowWidgets: true,
    ignoreTrimWhitespace: false,
    renderOverviewRuler: true,
    renderIndicators: true,
    // The Revert Block button in the gutter of each change.
    renderGutterMenu: true,
    diffAlgorithm: 'advanced',
    // Without changes nothing would be left to show.
    hideUnchangedRegions: { enabled: collapsed, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
    ariaLabel: `${section.label}, changes vs ${baseLabel}`,
  } as Monaco.editor.IStandaloneDiffEditorConstructionOptions;
}

function applyIndentation(model: Monaco.editor.ITextModel): void {
  if (!config) return;
  if (config.detectIndentation) model.detectIndentation(config.insertSpaces, config.tabSize);
  else model.updateOptions({ tabSize: config.tabSize, insertSpaces: config.insertSpaces });
}

function createPane(section: PaneSection): Pane {
  const element = document.createElement('div');
  element.className = `pane ${section.role}`;
  root.appendChild(element);
  const host = document.createElement('div');
  host.className = 'editor-host';
  element.appendChild(host);
  const label = document.createElement('div');
  label.className = 'changes-label';
  label.style.display = 'none';
  element.appendChild(label);
  const uri = modelUri({ fileKey, sectionKey: section.key, role: section.role, title: document.title || section.label });
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(section.text, LANG, uri);
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  applyIndentation(model);
  models.set(uri.toString(), {});
  noteIfHidden();
  const editor = monaco.editor.create(host, { ...editorOptions(section), model });
  const pane: Pane = {
    section, model, standalone: editor, editor, element, host, baseNew: false, changes: [],
    changeMarks: editor.createDecorationsCollection(), label, typedAt: 0,
  };
  model.onDidChangeContent(e => {
    scheduleChanges(pane);
    // Monaco's highlights go while typing; so do those of the other panes.
    clearCrossHighlights();
    // The annotation does not ride along while the line is typed in.
    pane.typedAt = Date.now();
    pane.blameMarks?.clear();
    pane.blameShown = undefined;
    scheduleBlame(pane);
    if (applyingRemote) return;
    seq++;
    lastSeqOf.set(section.key, seq);
    post({
      type: 'edit', seq, key: section.key,
      changes: e.changes.map(c => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
      text: model.getValue(),
    });
  });
  wireEditor(pane, editor);
  // A left click on a change marker shows the changes, at that change. The folding arrows share the column,
  // so only a click on the bar itself counts (like VS Code's change markers).
  editor.onMouseDown(e => {
    const line = e.target.position?.lineNumber;
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !line || !e.event.leftButton) return;
    const bar = e.target.element;
    if (!bar?.classList.contains('tc-change')) return;
    const offset = (e.target.detail as { offsetX?: number }).offsetX;
    if (offset !== undefined && (offset < bar.offsetLeft - 3 || offset > bar.offsetLeft + 6)) return;
    if (!changeAt(pane, line)) return;
    setChangesMode(true, { pane, line });
  });
  return pane;
}

// ------------------------------------------------------------------ highlights in the other panes

/**
 * The uses of the symbol at the cursor of `source` highlighted in the other panes (Monaco's highlights stay in the
 * editor that asked), with the ranges Monaco highlights in `source`: the cursor moving within them keeps them.
 */
let crossHighlights: { source: Pane; own: Monaco.Range[]; marks: Map<Pane, string[]> } | undefined;

/** As Monaco's own highlights: their colors, and a mark in the overview ruler. */
function crossOptions(kind: HighlightResult['kind']): Monaco.editor.IModelDecorationOptions {
  const [className, ruler] = kind === 'write' ? ['wordHighlightStrong', 'wordHighlightStrongForeground']
    : kind === 'read' ? ['wordHighlight', 'wordHighlightForeground'] : ['wordHighlightText', 'wordHighlightTextForeground'];
  return {
    className,
    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    overviewRuler: { color: { id: `editorOverviewRuler.${ruler}` }, position: monaco.editor.OverviewRulerLane.Center },
  };
}

function clearCrossHighlights(): void {
  for (const [p, ids] of crossHighlights?.marks ?? []) if (!p.model.isDisposed()) p.model.deltaDecorations(ids, []);
  crossHighlights = undefined;
}

function showCrossHighlights(source: Pane, own: Monaco.Range[], hs: HighlightResult[]): void {
  clearCrossHighlights();
  if (hs.length === 0) return;
  const marks = new Map<Pane, string[]>();
  for (const p of panes) {
    const mine = hs.filter(h => h.key === p.section.key);
    if (mine.length > 0) {
      marks.set(p, p.model.deltaDecorations([], mine.map(h => ({ range: rangeOf(p.model, h.start, h.end), options: crossOptions(h.kind) }))));
    }
  }
  crossHighlights = { source, own, marks };
}

/** The cursor moved: the highlights of the other panes go, unless it stays on a use Monaco highlights. */
function cursorMoved(pane: Pane, position: Monaco.Position): void {
  if (crossHighlights && !(crossHighlights.source === pane && crossHighlights.own.some(r => r.containsPosition(position)))) {
    clearCrossHighlights();
  }
}

/** Focus, cursor and mouse handling of an editor a pane shows (its own one, or the modified side of its diff). */
function wireEditor(pane: Pane, editor: Monaco.editor.ICodeEditor): void {
  editor.onDidFocusEditorText(() => focused(pane));
  editor.onDidChangeCursorPosition(e => {
    scheduleBlame(pane);
    cursorMoved(pane, e.position);
  });
  editor.onMouseMove(e => {
    pointerOnBlame = isBlameElement(e.event.browserEvent.target);
  });
  editor.onMouseLeave(() => {
    pointerOnBlame = false;
  });
}

function focused(pane: Pane): void {
  const before = lastFocused;
  lastFocused = pane.section.key;
  // The annotation moves to the pane edited now.
  if (before !== lastFocused) for (const p of panes) scheduleBlame(p, p === pane ? 0 : undefined);
}

// ------------------------------------------------------------------ line blame

function isBlameElement(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.tc-blame');
}

/** The commit that last changed a line (1-based) of a pane as the pane shows it now; undefined when unknown. */
function blameAt(pane: Pane, line: number): BlameCommitInfo | undefined {
  const b = pane.blame;
  if (!b) return undefined;
  let blamedLine = line;
  if (pane.model.getValue() !== b.text) {
    // Edited since the file was blamed: lines in changed blocks are not committed, the others moved with them.
    const version = pane.model.getVersionId();
    if (pane.blameDiff?.version !== version) {
      const changes = diffComputer.computeDiff(b.text.split('\n'), pane.model.getLinesContent(),
        { ignoreTrimWhitespace: false, maxComputationTimeMs: 200, computeMoves: false }).changes;
      pane.blameDiff = { version, changes };
    }
    let delta = 0;
    for (const c of pane.blameDiff!.changes) {
      if (line < c.modified.startLineNumber) break;
      if (line < c.modified.endLineNumberExclusive) return NOT_COMMITTED;
      delta = c.original.endLineNumberExclusive - c.modified.endLineNumberExclusive;
    }
    blamedLine = line + delta;
  }
  const index = b.lines[blamedLine - 1];
  return index === undefined || index < 0 ? undefined : blameCommits[index];
}

/** `You, 2 days ago • Fix the purge timer`, like GitLens' current line blame. */
function blameText(c: BlameCommitInfo): string {
  if (c.uncommitted) return 'You • Uncommitted changes';
  const summary = c.summary.length > 60 ? `${c.summary.slice(0, 59)}…` : c.summary;
  return `${c.you ? 'You' : c.author}, ${relativeTime(c.time)} • ${summary}`;
}

/** The commands the links of the blame hover may run (commit messages are escaped, and only these run anyway). */
const BLAME_LINKS = { enabledCommands: ['twincat.blame.open', 'twincat.blame.history', 'twincat.blame.showChanges'] };

function blameHover(c: BlameCommitInfo): Monaco.IMarkdownString {
  if (c.uncommitted) {
    const show = baseState === 'available' ? `\n\n[Show Changes](command:twincat.blame.showChanges "Show the changes vs ${escapeMarkdown(baseLabel)}")` : '';
    return { value: `**Uncommitted changes**\n\nThis line is not committed yet.${show}`, isTrusted: BLAME_LINKS };
  }
  const date = new Date(c.time * 1000).toLocaleString();
  const args = encodeURIComponent(JSON.stringify([c.sha]));
  return {
    value: `**${escapeMarkdown(c.author)}**${c.you ? ' (you)' : ''}, ${relativeTime(c.time)} (${escapeMarkdown(date)})\n\n`
      + `${escapeMarkdown(c.summary)}\n\n`
      + `\`${c.sha.slice(0, 7)}\` · [Open Changes](command:twincat.blame.open?${args} "Show what this commit changed in this object")`
      + ` · [Show History](command:twincat.blame.history "Show the commits that changed this object")`,
    isTrusted: BLAME_LINKS,
  };
}

function scheduleBlame(pane: Pane, delay = 120): void {
  window.clearTimeout(pane.blameTimer);
  const wait = Math.max(delay, pane.typedAt + TYPING_PAUSE - Date.now());
  pane.blameTimer = window.setTimeout(() => updateBlame(pane), wait);
}

/** Shows the blame of the cursor's line at the end of that line, in the pane edited last only. */
function updateBlame(pane: Pane): void {
  window.clearTimeout(pane.blameTimer);
  pane.blameTimer = undefined;
  if (pane.blameEditor !== pane.editor) {
    // The pane switched between its own editor and its diff: the annotation goes to the one shown.
    pane.blameMarks?.clear();
    pane.blameMarks = pane.editor.createDecorationsCollection();
    pane.blameEditor = pane.editor;
  }
  const position = pane.editor.getPosition();
  const commit = blameOn && position && pane.section.key === lastFocused ? blameAt(pane, position.lineNumber) : undefined;
  if (!commit || !position) {
    pane.blameMarks!.clear();
    pane.blameShown = undefined;
    return;
  }
  const line = position.lineNumber;
  const column = pane.model.getLineMaxColumn(line);
  pane.blameMarks!.set([{
    range: new monaco.Range(line, column, line, column),
    options: {
      showIfCollapsed: true,
      hoverMessage: blameHover(commit),
      after: { content: blameText(commit), inlineClassName: 'tc-blame', cursorStops: monaco.editor.InjectedTextCursorStops.None },
    },
  }]);
  pane.blameShown = { line, commit };
}

/** Line blame from the host (when the split editor opens, after the file changed on disk, after a commit). */
function applyBlame(m: Extract<HostMessage, { type: 'blame' }>): void {
  blameOn = m.enabled;
  blameCommits = m.commits;
  const byKey = new Map(m.sections.map(s => [s.key, s]));
  for (const p of panes) {
    p.blame = byKey.get(p.section.key);
    p.blameDiff = undefined;
    updateBlame(p);
  }
}

// ------------------------------------------------------------------ changes vs HEAD

function baseUri(pane: Pane): Monaco.Uri {
  return pane.model.uri.with({ scheme: 'twincat-head' });
}

/** Line a change is marked at: its first line, or for removed lines the line above them. */
function markLine(c: Change): number {
  return c.modified.endLineNumberExclusive > c.modified.startLineNumber ? c.modified.startLineNumber : Math.max(1, c.modified.startLineNumber - 1);
}

function changeAt(pane: Pane, line: number): Change | undefined {
  return pane.changes.find(c => markLine(c) === line
    || (line >= c.modified.startLineNumber && line < c.modified.endLineNumberExclusive));
}

function scheduleChanges(pane: Pane): void {
  window.clearTimeout(pane.changeTimer);
  pane.changeTimer = window.setTimeout(() => computeChanges(pane), 150);
}

/** Compares a pane with its HEAD text and marks the changed lines in the gutter, like VS Code's change markers. */
function computeChanges(pane: Pane): void {
  window.clearTimeout(pane.changeTimer);
  pane.changeTimer = undefined;
  const lines = pane.model.getLineCount();
  if (!pane.base) pane.changes = [];
  else if (pane.baseNew) {
    // Not in HEAD: all of it is new (an empty section has nothing to mark).
    pane.changes = pane.model.getValueLength() > 0
      ? [{ original: { startLineNumber: 1, endLineNumberExclusive: 1 }, modified: { startLineNumber: 1, endLineNumberExclusive: lines + 1 } }]
      : [];
  } else {
    pane.changes = diffComputer.computeDiff(pane.base.getLinesContent(), pane.model.getLinesContent(),
      { ignoreTrimWhitespace: false, maxComputationTimeMs: 200, computeMoves: false }).changes;
  }
  pane.changeMarks.set(pane.changes.map(c => {
    const added = c.original.endLineNumberExclusive === c.original.startLineNumber;
    const removed = c.modified.endLineNumberExclusive === c.modified.startLineNumber;
    const kind = added ? 'added' : removed ? 'deleted' : 'modified';
    const start = markLine(c);
    const end = removed ? start : c.modified.endLineNumberExclusive - 1;
    // Lines removed above the first line are marked at the top of line 1.
    const top = removed && c.modified.startLineNumber === 1;
    // VS Code's colors of the change markers in the overview ruler (part of the theme the panes use).
    const color: Monaco.editor.ThemeColor = { id: `editorOverviewRuler.${kind}Foreground` };
    return {
      range: new monaco.Range(start, 1, end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `tc-change tc-change-${kind}${top ? ' tc-change-top' : ''}`,
        overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Left },
        minimap: { color, position: monaco.editor.MinimapPosition.Gutter },
      },
    };
  }));
  if (pane.diff) {
    // Collapsing unchanged lines of a pane without changes would leave nothing to see.
    const collapse = pane.changes.length > 0;
    if (collapse !== pane.diff.collapsed) {
      pane.diff.collapsed = collapse;
      pane.diff.editor.updateOptions({ hideUnchangedRegions: { enabled: collapse } });
    }
  }
  updateLabel(pane);
}

function updateLabel(pane: Pane): void {
  const n = pane.changes.length;
  pane.label.textContent = !pane.base ? ''
    : pane.baseNew ? `New, not in ${baseLabel}`
      : n === 0 ? `No changes vs ${baseLabel}` : `${n} change${n === 1 ? '' : 's'} vs ${baseLabel}`;
  pane.label.style.display = changesMode && pane.base ? '' : 'none';
}

/** Each pane goes to its first change; the focus goes to the first pane with changes. */
/** The first change is to be revealed once the page shows: hidden, the panes have no height to center it in. */
let revealWhenShown = false;

function revealFirstChange(): void {
  if (document.hidden || root.clientHeight === 0) {
    revealWhenShown = true;
    return;
  }
  revealWhenShown = false;
  let target: Pane | undefined;
  for (const p of panes) {
    if (p.changes.length === 0) continue;
    const line = markLine(p.changes[0]);
    const reveal = (editor: Monaco.editor.ICodeEditor) => {
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.revealLineInCenter(line);
    };
    const diff = p.diff?.editor;
    // A diff still computing has not hidden its unchanged lines yet: centered now, the line would end up far below.
    if (diff && diff.getLineChanges() === null) {
      const once = diff.onDidUpdateDiff(() => {
        once.dispose();
        if (p.diff?.editor === diff) reveal(diff.getModifiedEditor());
      });
    } else {
      reveal(p.editor);
    }
    target ??= p;
  }
  target?.editor.focus();
}

/** Base texts from the host (again after a commit or checkout, or for another base). */
function applyBase(m: Extract<HostMessage, { type: 'base' }>): void {
  baseState = m.available ? 'available' : 'unavailable';
  baseLabel = m.label;
  const texts = new Map(m.sections.map(s => [s.key, s.text]));
  for (const p of panes) {
    if (!m.available) {
      leaveDiff(p);
      p.base?.dispose();
      p.base = undefined;
      computeChanges(p);
      continue;
    }
    const text = texts.get(p.section.key) ?? null;
    p.baseNew = text === null;
    if (!p.base) {
      monaco.editor.getModel(baseUri(p))?.dispose();
      p.base = monaco.editor.createModel(text ?? '', LANG, baseUri(p));
      p.base.setEOL(monaco.editor.EndOfLineSequence.LF);
    } else if (p.base.getValue() !== (text ?? '')) {
      p.base.setValue(text ?? '');
    }
    computeChanges(p);
    // A section that is (no longer) in HEAD has no diff to show, only its marks.
    if (changesMode) {
      if (p.baseNew) leaveDiff(p);
      else enterDiff(p);
    }
  }
  if (!m.available) {
    if (changesMode || wantChanges) setChangesMode(false);
  } else if (wantChanges && !changesMode) {
    setChangesMode(true, undefined, wantFirst);
  } else {
    for (const p of panes) updateLabel(p);
  }
  layout();
}

/** Shows the pane as an inline diff against HEAD, on the same model (edits go on as before). */
function enterDiff(pane: Pane): void {
  if (pane.diff || !pane.base || pane.baseNew) return;
  const host = document.createElement('div');
  host.className = 'editor-host';
  pane.element.insertBefore(host, pane.label);
  const state = pane.standalone.saveViewState();
  const hadFocus = pane.standalone.hasTextFocus();
  pane.host.style.display = 'none';
  const collapsed = pane.changes.length > 0;
  noteIfHidden();
  const editor = monaco.editor.createDiffEditor(host, diffOptions(pane.section, collapsed));
  editor.setModel({ original: pane.base, modified: pane.model });
  pane.diff = { editor, host, collapsed };
  const modified = editor.getModifiedEditor();
  wireEditor(pane, modified);
  pane.editor = modified;
  layoutDiff(pane.diff);
  if (state) modified.restoreViewState(state);
  if (hadFocus) modified.focus();
  updateBlame(pane);
}

/** Back to the pane's own editor, where the diff left the cursor and scroll position. */
function leaveDiff(pane: Pane): void {
  if (!pane.diff) return;
  const state = pane.editor.saveViewState();
  const hadFocus = pane.editor.hasTextFocus();
  pane.diff.editor.dispose();
  pane.diff.host.remove();
  pane.diff = undefined;
  pane.editor = pane.standalone;
  pane.host.style.display = '';
  pane.standalone.layout();
  if (state) pane.standalone.restoreViewState(state);
  if (hadFocus) pane.standalone.focus();
  updateBlame(pane);
}

/** Shows or hides the changes in every pane, optionally at a change of one pane or at the first changes. */
function setChangesMode(on: boolean, at?: { pane: Pane; line: number }, first = false): void {
  wantChanges = on;
  wantFirst = on && first;
  saveState();
  if (on && baseState !== 'available') {
    // Shown once the base texts arrive; never outside a repository.
    if (baseState === 'unavailable') {
      wantChanges = false;
      wantFirst = false;
      saveState();
      post({ type: 'changesMode', on: false });
    }
    return;
  }
  wantFirst = false;
  if (on !== changesMode) {
    changesMode = on;
    for (const p of panes) {
      if (on) enterDiff(p);
      else leaveDiff(p);
      updateLabel(p);
    }
    layout();
  }
  post({ type: 'changesMode', on: changesMode });
  if (at) {
    const editor = at.pane.editor;
    editor.setPosition({ lineNumber: at.line, column: 1 });
    editor.revealLineInCenter(at.line);
    editor.focus();
  } else if (on && first) {
    revealFirstChange();
  }
}

/** Alt+F5 / Shift+Alt+F5: the next or previous change of the focused pane, as in VS Code's editors. */
function goToChange(forward: boolean): void {
  const pane = panes.find(p => p.editor.hasTextFocus()) ?? panes.find(p => p.section.key === lastFocused);
  if (!pane || pane.changes.length === 0) return;
  const current = pane.editor.getPosition()?.lineNumber ?? 1;
  const lines = [...new Set(pane.changes.map(markLine))].sort((a, b) => a - b);
  const target = forward
    ? lines.find(l => l > current) ?? lines[0]
    : [...lines].reverse().find(l => l < current) ?? lines[lines.length - 1];
  pane.editor.setPosition({ lineNumber: target, column: 1 });
  pane.editor.revealLineInCenter(target);
}

/** Key bindings shared by all panes: VS Code's command palette and the workbench Ctrl+K chords. */
function registerKeybindings(): void {
  monaco.editor.registerCommand('twincat.showCommands', () => post({ type: 'command', command: 'workbench.action.showCommands' }));
  // Monaco's own palette (context menu entry) is replaced by VS Code's.
  monaco.editor.registerCommand('editor.action.quickCommand', () => post({ type: 'command', command: 'workbench.action.showCommands' }));
  monaco.editor.registerCommand('twincat.nextChange', () => goToChange(true));
  monaco.editor.registerCommand('twincat.previousChange', () => goToChange(false));
  // Links of the blame hover.
  monaco.editor.registerCommand('twincat.blame.open', (_accessor: unknown, sha: unknown) => {
    if (typeof sha === 'string') post({ type: 'blameOpen', sha });
  });
  monaco.editor.registerCommand('twincat.blame.history', () => post({ type: 'showHistory' }));
  monaco.editor.registerCommand('twincat.blame.showChanges', () => {
    const pane = panes.find(p => p.section.key === lastFocused);
    setChangesMode(true, pane?.blameShown ? { pane, line: pane.blameShown.line } : undefined);
  });
  const rules: Monaco.editor.IKeybindingRule[] = [
    { keybinding: monaco.KeyCode.F1, command: 'twincat.showCommands' },
    { keybinding: monaco.KeyMod.Alt | monaco.KeyCode.F5, command: 'twincat.nextChange' },
    { keybinding: monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.F5, command: 'twincat.previousChange' },
  ];
  const keys = monaco.KeyCode as unknown as Record<string, number>;
  for (const chord of WORKBENCH_CHORDS) {
    const parts = chord.second.split('+');
    let second = keys[parts.pop()!];
    if (second === undefined) continue;
    if (parts.includes('Ctrl')) second |= monaco.KeyMod.CtrlCmd;
    if (parts.includes('Shift')) second |= monaco.KeyMod.Shift;
    if (parts.includes('Alt')) second |= monaco.KeyMod.Alt;
    const id = `twincat.workbench.${chord.command}`;
    monaco.editor.registerCommand(id, () => post({ type: 'command', command: chord.command }));
    rules.push({ keybinding: monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, second), command: id });
  }
  monaco.editor.addKeybindingRules(rules);
}

// Peek views show sections of other objects as copies: their embedded editor is made read-only.
monaco.editor.onDidCreateEditor(ed => {
  const update = () => {
    const model = ed.getModel();
    if (!model) return;
    const info = models.get(model.uri.toString());
    if (info?.ref) ed.updateOptions({ readOnly: true });
    else {
      const own = panes.find(p => p.model === model);
      if (own) ed.updateOptions({ readOnly: !own.section.editable });
    }
  };
  ed.onDidChangeModel(update);
  update();
});

function init(m: Extract<HostMessage, { type: 'init' }>): void {
  fileKey = m.fileKey;
  config = m.config;
  if (typeof m.ratio === 'number' && typeof saved.ratio !== 'number') ratio = m.ratio;
  document.title = m.title;
  applyLanguage(m.language);
  themeRules = m.theme;
  highlighterReady = highlighter.load(m.onigUri, m.grammarUri);
  void applyTheme().catch(e => reportError(`highlighting: ${(e as Error).stack ?? e}`));
  if (!providersRegistered) {
    registerProviders();
    registerKeybindings();
  }
  providersRegistered = true;
  for (const p of panes) {
    window.clearTimeout(p.changeTimer);
    window.clearTimeout(p.blameTimer);
    p.diff?.editor.dispose();
    p.standalone.dispose();
    p.base?.dispose();
    // A reused page (the commit diff panel) shows other sections next: their models go too.
    models.delete(p.model.uri.toString());
    p.model.dispose();
  }
  root.textContent = '';
  crossHighlights = undefined;
  revealWhenShown = false;
  // The HEAD texts follow this message; the changes shown before come back with them.
  baseState = 'pending';
  changesMode = false;
  // So does the line blame (the split editor's; the commit diff panel has none).
  blameOn = false;
  blameCommits = [];
  pointerOnBlame = false;
  // The host's request (TwinCAT Changes view, a rebuilt webview) before what this webview saved.
  wantChanges = m.changes ?? saved.changes ?? wantChanges;
  wantFirst = wantChanges && !!m.first;
  panes = m.sections.map(createPane);
  if (panes.length >= 2) {
    sash = createSash();
    root.appendChild(sash);
  }
  layout();
  const focusTarget = panes.find(p => p.section.role === 'impl' && p.section.editable) ?? panes[0];
  lastFocused = focusTarget?.section.key;
  if (document.hasFocus()) focusTarget?.editor.focus();
  seq = 0;
  lastSeqOf.clear();
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Replaces the text of a pane with a minimal edit, so cursors and scroll positions stay where they are. */
function applyRemote(pane: Pane, text: string): void {
  const model = pane.model;
  const old = model.getValue();
  if (old === text) return;
  let start = 0;
  while (start < old.length && start < text.length && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  // Never split a surrogate pair: Monaco would widen the range and drop half of the character.
  if (start > 0 && isHigh(old.charCodeAt(start - 1))) start--;
  let endOld = old.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  if (endOld < old.length && isLow(old.charCodeAt(endOld)) && endOld > start) {
    endOld++;
    endNew++;
  }
  applyingRemote = true;
  // Monaco would trim the auto-indentation the user left on some line, and the text would not match.
  const trim = model.getOptions().trimAutoWhitespace;
  model.updateOptions({ trimAutoWhitespace: false });
  try {
    model.pushStackElement();
    model.pushEditOperations(pane.editor.getSelections() ?? [], [{ range: rangeOf(model, start, endOld), text: text.slice(start, endNew) }], () => null);
    model.pushStackElement();
    if (model.getValue() !== text) model.setValue(text);
  } finally {
    model.updateOptions({ trimAutoWhitespace: trim });
    applyingRemote = false;
  }
}

function reveal(m: Extract<HostMessage, { type: 'reveal' }>): void {
  const pane = panes.find(p => p.section.key === m.key);
  if (!pane) return;
  const r = rangeOf(pane.model, m.start, m.end);
  pane.editor.setSelection(r);
  pane.editor.revealRangeInCenter(r);
  if (m.focus) pane.editor.focus();
}

// ------------------------------------------------------------------ test hooks

function selectionOffsets(p: Pane): [number, number] {
  const s = p.editor.getSelection();
  if (!s) return [0, 0];
  return [p.model.getOffsetAt(s.getStartPosition()), p.model.getOffsetAt(s.getEndPosition())];
}

/**
 * Puts the focus in a pane for a test action. A test window may not have the OS focus, so the browser does
 * not fire focus events and Monaco would still run commands in the pane focused before.
 */
function focusForTest(pane: Pane): void {
  pane.editor.focus();
  for (const p of panes) {
    if (p !== pane && p.editor.hasTextFocus()) inputOf(p)?.dispatchEvent(new FocusEvent('blur'));
  }
  if (!pane.editor.hasTextFocus()) inputOf(pane)?.dispatchEvent(new FocusEvent('focus'));
}

/** The element that takes the keyboard input of the editor a pane shows. */
function inputOf(pane: Pane): HTMLElement | null {
  return pane.editor.getDomNode()?.querySelector('.native-edit-context, textarea') ?? null;
}

function probe(action: ProbeAction): unknown {
  switch (action.kind) {
    case 'state': {
      const rootTop = root.getBoundingClientRect().top;
      const state: ProbeState = {
        ratio,
        bodyHeight: root.clientHeight,
        sashTop: sash ? sash.getBoundingClientRect().top - rootTop : undefined,
        panes: panes.map((p): PaneState => ({
          key: p.section.key,
          text: p.model.getValue(),
          top: p.element.getBoundingClientRect().top - rootTop,
          height: p.element.getBoundingClientRect().height,
          contentHeight: p.editor.getContentHeight(),
          scrollTop: p.editor.getScrollTop(),
          readOnly: p.editor.getOption(monaco.editor.EditorOption.readOnly),
          markers: monaco.editor.getModelMarkers({ resource: p.model.uri }).length,
          tokenClasses: new Set([...p.element.querySelectorAll('.view-line span[class*="mtk"]')].map(s => s.className)).size,
          focused: p.editor.hasTextFocus(),
          selection: selectionOffsets(p),
          changes: p.changes.length,
          diff: !!p.diff,
          diffChanges: p.diff?.editor.getLineChanges()?.length ?? -1,
          label: p.label.style.display === 'none' ? undefined : p.label.textContent ?? undefined,
          blame: p.blameShown ? blameText(p.blameShown.commit) : undefined,
        })),
        foreignModels: [...models.values()].filter(i => i.ref).map(i => i.ref!.view.label),
        errors,
      };
      return state;
    }
    case 'type': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane) return false;
      const pos = pane.model.getPositionAt(action.offset);
      pane.editor.setPosition(pos);
      focusForTest(pane);
      pane.editor.trigger('keyboard', 'type', { text: action.text });
      return true;
    }
    case 'setRatio':
      setRatio(action.ratio);
      return ratio;
    case 'drag': {
      if (!sash) return false;
      const rect = sash.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const opts = (y: number) => ({ clientX: x, clientY: y, pointerId: 1, bubbles: true });
      sash.dispatchEvent(new PointerEvent('pointerdown', opts(action.fromY)));
      sash.dispatchEvent(new PointerEvent('pointermove', opts(action.toY)));
      sash.dispatchEvent(new PointerEvent('pointerup', opts(action.toY)));
      return ratio;
    }
    case 'run': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane) return false;
      pane.editor.setPosition(pane.model.getPositionAt(action.offset));
      focusForTest(pane);
      // Editor actions, or commands such as editor.action.revealDefinition (registered with registerAction2).
      const editorAction = pane.editor.getAction(action.action);
      if (editorAction) return Promise.resolve(editorAction.run()).then(() => true);
      pane.editor.trigger('probe', action.action, null);
      return true;
    }
    case 'keys': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane) return false;
      focusForTest(pane);
      const target = inputOf(pane) ?? pane.element;
      for (const k of action.strokes) {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: k.key, code: k.code, keyCode: k.keyCode, ctrlKey: !!k.ctrl, shiftKey: !!k.shift, altKey: !!k.alt, bubbles: true, cancelable: true,
        } as KeyboardEventInit));
      }
      return true;
    }
    case 'undo': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane) return false;
      focusForTest(pane);
      pane.editor.trigger('keyboard', 'undo', null);
      return true;
    }
    case 'markerClick': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane) return false;
      computeChanges(pane);
      if (!changeAt(pane, action.line)) return false;
      setChangesMode(true, { pane, line: action.line });
      return true;
    }
    case 'revertChange': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane?.diff) return false;
      pane.editor.setPosition({ lineNumber: action.line, column: 1 });
      focusForTest(pane);
      // What the Revert Block button and the diffEditor.revert command run for the change at the cursor.
      (pane.diff.editor as unknown as { revertFocusedRangeMappings(): void }).revertFocusedRangeMappings();
      return true;
    }
    case 'blame': {
      const pane = panes.find(p => p.section.key === action.key);
      if (!pane) return null;
      pane.editor.setPosition({ lineNumber: action.line, column: 1 });
      focusForTest(pane);
      // The browser may not report the focus to a window without the OS focus.
      lastFocused = pane.section.key;
      for (const p of panes) updateBlame(p);
      const shown = pane.blameShown;
      const result: BlameProbe = {
        text: shown ? blameText(shown.commit) : null,
        sha: shown?.commit.sha || null,
        hover: shown ? blameHover(shown.commit).value : null,
      };
      return result;
    }
  }
}

// ------------------------------------------------------------------ messages

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  try {
    switch (m.type) {
      case 'init':
        init(m);
        break;
      case 'sync': {
        const applied: string[] = [];
        let skipped = false;
        for (const s of m.sections) {
          const pane = panes.find(p => p.section.key === s.key);
          if (!pane) continue;
          // This section has edits the host has not applied yet: they would be lost. Ask again later.
          if ((lastSeqOf.get(s.key) ?? 0) > m.ack) {
            if (pane.model.getValue() !== s.text) skipped = true;
            continue;
          }
          applyRemote(pane, s.text);
          applied.push(s.key);
        }
        post({ type: 'synced', id: m.id, keys: applied });
        if (skipped) {
          window.clearTimeout(resyncTimer);
          resyncTimer = window.setTimeout(() => post({ type: 'resync' }), 150);
        }
        break;
      }
      case 'markers':
        for (const entry of m.markers) {
          const pane = panes.find(p => p.section.key === entry.key);
          if (!pane) continue;
          monaco.editor.setModelMarkers(pane.model, 'twincat', entry.markers.map(mk => {
            const r = rangeOf(pane.model, mk.start, Math.max(mk.end, mk.start));
            return {
              startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn,
              message: mk.message, severity: mk.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
              source: 'TwinCAT',
            };
          }));
        }
        break;
      case 'autoDeclare':
        autoDeclare();
        break;
      case 'reveal':
        reveal(m);
        break;
      case 'theme':
        themeRules = m.theme;
        void applyTheme().catch(e => reportError(String(e)));
        break;
      case 'config':
        config = m.config;
        for (const p of panes) {
          p.standalone.updateOptions(editorOptions(p.section));
          p.diff?.editor.updateOptions(diffOptions(p.section, p.diff.collapsed));
          applyIndentation(p.model);
        }
        layout();
        break;
      case 'base':
        applyBase(m);
        break;
      case 'blame':
        applyBlame(m);
        break;
      case 'setChanges':
        setChangesMode(m.on, undefined, m.first);
        break;
      case 'response': {
        const resolve = pending.get(m.id);
        pending.delete(m.id);
        resolve?.(m.result);
        break;
      }
      case 'flush':
        // Edits are posted as they happen, so every edit typed before this message is already on its way.
        post({ type: 'flushed', id: m.id });
        break;
      case 'probe':
        Promise.resolve(probe(m.action)).then(
          result => post({ type: 'probeResult', id: m.id, result }),
          e => post({ type: 'probeResult', id: m.id, result: { error: String(e) } }));
        break;
    }
  } catch (e) {
    reportError(`${m.type}: ${(e as Error).stack ?? e}`);
  }
});

window.addEventListener('resize', () => layout());
document.addEventListener('visibilitychange', () => layout());
// Focus returns to the section edited last when the tab is activated, unless something in the page
// (the Find box, a peek view, the rename box, a pane) keeps it.
window.addEventListener('focus', () => setTimeout(() => {
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return;
  const pane = panes.find(p => p.section.key === lastFocused) ?? panes[0];
  pane?.editor.focus();
}, 0));

const style = document.createElement('style');
style.textContent = `
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
#root { position: relative; height: 100vh; overflow: hidden; }
.pane { position: absolute; left: 0; right: 0; overflow: hidden; }
.sash { position: absolute; left: 0; right: 0; height: ${SASH}px; cursor: row-resize; z-index: 10; }
.sash::before { content: ''; position: absolute; left: 0; right: 0; top: ${Math.floor(SASH / 2)}px; height: 1px;
  background: var(--vscode-editorGroup-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35))); }
.sash.hover, .sash.active { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
.sash.hover::before, .sash.active::before { display: none; }
.editor-host { position: absolute; inset: 0; }
/* Change markers against HEAD, drawn like VS Code's (bar for added and changed lines, wedge for removed ones). */
.monaco-editor .tc-change { margin-left: 3px; z-index: 5; cursor: pointer; box-sizing: border-box; width: 3px !important; }
.monaco-editor .tc-change-added { border-left: 3px solid var(--vscode-editorGutter-addedBackground, #2ea043); }
.monaco-editor .tc-change-modified { border-left: 3px solid var(--vscode-editorGutter-modifiedBackground, #0078d4); }
.monaco-editor .tc-change-deleted::after { content: ''; position: absolute; left: 0; bottom: -4px; box-sizing: border-box; width: 4px; height: 0;
  z-index: 9; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 4px solid var(--vscode-editorGutter-deletedBackground, #f85149); }
.monaco-editor .tc-change-deleted.tc-change-top::after { bottom: auto; top: -4px; }
.changes-label { position: absolute; top: 3px; right: 24px; z-index: 20; pointer-events: none; padding: 1px 6px; border-radius: 2px;
  font: 11px var(--vscode-font-family); color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); opacity: 0.9; }
/* Blame of the current line, after its end (like GitLens' current line blame). */
.monaco-editor .view-line .tc-blame { color: var(--vscode-editorCodeLens-foreground, #999999) !important; opacity: 0.8; font-style: italic;
  margin-left: 3em; }
/* Monaco renders a long annotation as several spans of 50 characters: the gap goes before the first only. */
.monaco-editor .view-line .tc-blame + .tc-blame { margin-left: 0; }
`;
document.head.appendChild(style);

post({ type: 'ready' });

// Webview of the XAE-like split editor: one Monaco editor per section of the
// object view (Declaration above Implementation), each with its own scroll bar,
// and a splitter between them. Edits go to the extension host, which owns the
// document; language features are answered by the host.

// The entry with all editor contributions (find, hover, suggest, peek, folding, ...) and no languages.
// @ts-ignore: this entry point has no type declarations of its own
import * as monacoAll from 'monaco-editor/esm/vs/editor/edcore.main.js';
import type * as Monaco from 'monaco-editor';
import {
  CompletionResult, EditorConfig, HostMessage, HoverResult, LanguageConfig, PaneSection, PaneState, ProbeAction, ProbeState,
  RequestKind, SectionRef, TargetRange, TokenRule, WORKBENCH_CHORDS, WebviewMessage,
} from '../shared/protocol';
import { TextMateHighlighter, parseColor, toHex } from './textmate';
// Internal Monaco services: the public registerEditorOpener can only answer with the source editor, which
// makes Monaco highlight, reveal and move peek views in the wrong pane.
// @ts-ignore: no type declarations for internal modules
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
// @ts-ignore: no type declarations for internal modules
import { ICodeEditorService } from 'monaco-editor/esm/vs/editor/browser/services/codeEditorService.js';

const monaco = monacoAll as typeof Monaco;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
declare global {
  interface Window {
    TWINCAT_WORKER_URL: string;
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
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

window.MonacoEnvironment = {
  getWorker() {
    const blob = new Blob([`importScripts(${JSON.stringify(window.TWINCAT_WORKER_URL)});`], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  },
};

const LANG = 'twincat-st';
const THEME = 'twincat-vscode';
const SASH = 4;
const MIN_PANE = 40;
monaco.languages.register({ id: LANG });

interface Pane {
  section: PaneSection;
  model: Monaco.editor.ITextModel;
  editor: Monaco.editor.IStandaloneCodeEditor;
  element: HTMLElement;
  markers: number;
}

interface ModelInfo {
  fileKey: string;
  sectionKey: string;
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

function request<T>(kind: RequestKind, key: string, model: Monaco.editor.ITextModel, offset: number, includeDeclaration?: boolean): Promise<T | null> {
  const id = ++requestId;
  return new Promise(resolve => {
    pending.set(id, r => resolve(r as T | null));
    post({ type: 'request', id, kind, key, text: model.getValue(), offset, includeDeclaration });
  });
}

// ------------------------------------------------------------------ state kept by VS Code for this tab

interface SavedState {
  ratio?: number;
}

function saveState(): void {
  vscodeApi.setState({ ratio } satisfies SavedState);
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

function infoOf(model: Monaco.editor.ITextModel): ModelInfo | undefined {
  return models.get(model.uri.toString());
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
  models.set(uri.toString(), { fileKey: t.ref.fileKey, sectionKey: t.ref.sectionKey, ref: t.ref });
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

function registerProviders(): void {
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
  monaco.languages.registerHoverProvider(LANG, {
    async provideHover(model, position) {
      const pane = ownPane(model);
      if (!pane) return null;
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
        suggestions: (items ?? []).map(i => ({
          label: i.label,
          kind: kinds[i.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: i.detail,
          documentation: i.documentation ? { value: i.documentation } : undefined,
          insertText: i.label,
          range,
        })),
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

function layout(): void {
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
  for (const p of panes) p.editor.layout();
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
    // Hovers and suggestions may extend beyond the pane they belong to.
    fixedOverflowWidgets: true,
    ariaLabel: section.label,
  } as Monaco.editor.IStandaloneEditorConstructionOptions;
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
  const uri = modelUri({ fileKey, sectionKey: section.key, role: section.role, title: document.title || section.label });
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(section.text, LANG, uri);
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  applyIndentation(model);
  models.set(uri.toString(), { fileKey, sectionKey: section.key });
  const editor = monaco.editor.create(element, { ...editorOptions(section), model });
  const pane: Pane = { section, model, editor, element, markers: 0 };
  model.onDidChangeContent(e => {
    if (applyingRemote) return;
    seq++;
    lastSeqOf.set(section.key, seq);
    post({
      type: 'edit', seq, key: section.key,
      changes: e.changes.map(c => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
      text: model.getValue(),
    });
  });
  editor.onDidFocusEditorText(() => {
    lastFocused = section.key;
    post({ type: 'focus', key: section.key });
  });
  return pane;
}

/** Key bindings shared by all panes: VS Code's command palette and the workbench Ctrl+K chords. */
function registerKeybindings(): void {
  monaco.editor.registerCommand('twincat.showCommands', () => post({ type: 'command', command: 'workbench.action.showCommands' }));
  // Monaco's own palette (context menu entry) is replaced by VS Code's.
  monaco.editor.registerCommand('editor.action.quickCommand', () => post({ type: 'command', command: 'workbench.action.showCommands' }));
  const rules: Monaco.editor.IKeybindingRule[] = [{ keybinding: monaco.KeyCode.F1, command: 'twincat.showCommands' }];
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
  for (const p of panes) p.editor.dispose();
  root.textContent = '';
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
    if (p !== pane && p.editor.hasTextFocus()) p.element.querySelector('.native-edit-context, textarea')?.dispatchEvent(new FocusEvent('blur'));
  }
  if (!pane.editor.hasTextFocus()) pane.element.querySelector('.native-edit-context, textarea')?.dispatchEvent(new FocusEvent('focus'));
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
      const target = (pane.element.querySelector('.native-edit-context, textarea') as HTMLElement | null) ?? pane.element;
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
          pane.markers = entry.markers.length;
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
          p.editor.updateOptions(editorOptions(p.section));
          applyIndentation(p.model);
        }
        layout();
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
`;
document.head.appendChild(style);

post({ type: 'ready' });

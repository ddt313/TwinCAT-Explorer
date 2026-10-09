// The XAE-like split editor: a custom editor over the `twincat:` text document
// of an object view, drawn by a webview with one Monaco editor per section
// (Declaration above Implementation, each with its own scroll bar, a splitter
// between them). VS Code keeps the document (dirty state, save, revert, hot
// exit); the webview edits it through workspace edits and is synced back when
// it changes otherwise. Language features run here and answer the webview.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ParsedObjectText, SectionMeta, applyChanges, mapOffset, parseObjectText, viewLabel } from '../core/objectText';
import { TcWorkspace, fileKey } from '../core/workspace';
import { parseJsonc } from '../core/jsonc';
import { LanguageIndex } from '../lang/index';
import { Loc } from '../lang/symbols';
import { LanguageFeatures } from './language';
import { LocationService, rangeIn } from './locations';
import { activeThemeTokens } from './theme';
import { debugLog } from '../core/debugLog';
import { ObjectRef, locUriOf, parseObjectUri } from './uris';
import {
  EditorConfig, HostMessage, LanguageConfig, Marker, PaneSection, ProbeAction, SectionRef, TargetRange, WEBVIEW_COMMANDS, WebviewMessage,
} from '../shared/protocol';

export interface RevealTarget {
  key: string;
  start: number;
  end?: number;
  focus?: boolean;
  /** The section text the offsets were computed on, when it may differ from the document. */
  text?: string;
}

export interface OpenViewRequest {
  ref: ObjectRef;
  reveal?: RevealTarget;
  viewColumn?: vscode.ViewColumn;
}

/** Monaco options taken from the VS Code editor settings of the Structured Text language. */
const EDITOR_OPTIONS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontLigatures', 'lineHeight', 'letterSpacing', 'lineNumbers', 'renderWhitespace',
  'wordWrap', 'wordWrapColumn', 'cursorStyle', 'cursorBlinking', 'cursorSmoothCaretAnimation', 'cursorWidth', 'smoothScrolling',
  'mouseWheelZoom', 'folding', 'foldingHighlight', 'showFoldingControls', 'renderLineHighlight', 'rulers', 'bracketPairColorization',
  'guides', 'minimap', 'scrollBeyondLastLine', 'stickyScroll', 'roundedSelection', 'renderControlCharacters', 'multiCursorModifier',
  'quickSuggestions', 'quickSuggestionsDelay', 'suggestOnTriggerCharacters', 'acceptSuggestionOnEnter', 'tabCompletion',
  'wordBasedSuggestions', 'suggestSelection', 'suggest', 'parameterHints', 'hover', 'autoClosingBrackets', 'autoClosingQuotes',
  'autoClosingDelete', 'autoClosingOvertype', 'autoSurround', 'autoIndent', 'matchBrackets', 'occurrencesHighlight', 'selectionHighlight',
  'links', 'emptySelectionClipboard', 'copyWithSyntaxHighlighting', 'dragAndDrop', 'find', 'unicodeHighlight', 'padding',
  'scrollbar', 'mouseWheelScrollSensitivity', 'fastScrollSensitivity', 'linkedEditing', 'renderFinalNewline', 'glyphMargin',
  'trimAutoWhitespace', 'wordSeparators', 'lineDecorationsWidth', 'lineNumbersMinChars', 'overviewRulerBorder', 'hideCursorInOverviewRuler',
  'columnSelection', 'definitionLinkOpensInPeek', 'gotoLocation', 'inlayHints', 'experimentalWhitespaceRendering',
];

function editorConfig(): EditorConfig {
  const cfg = vscode.workspace.getConfiguration('editor', { languageId: 'twincat-st' });
  const options: Record<string, unknown> = {};
  for (const key of EDITOR_OPTIONS) {
    const v = cfg.get(key);
    if (v !== undefined && v !== null) options[key] = v;
  }
  // VS Code: 'on' | 'off' | 'onKeyboardModifier'; Monaco: a boolean (any string counts as true) and no
  // modifier mode, so only 'on' shows hovers on mouse rest.
  const hover = options.hover as { enabled?: unknown } | undefined;
  if (hover && typeof hover.enabled === 'string') options.hover = { ...hover, enabled: hover.enabled === 'on' };
  return {
    options,
    tabSize: cfg.get<number>('tabSize', 4),
    insertSpaces: cfg.get<boolean>('insertSpaces', false),
    detectIndentation: cfg.get<boolean>('detectIndentation', true),
  };
}

function languageConfig(extensionPath: string): LanguageConfig {
  try {
    const raw = parseJsonc<{
      comments?: { lineComment?: string; blockComment?: [string, string] };
      brackets?: [string, string][];
      autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
      surroundingPairs?: [string, string][];
      wordPattern?: string;
      indentationRules?: { increaseIndentPattern?: string; decreaseIndentPattern?: string };
      folding?: { markers?: { start?: string; end?: string } };
    }>(fs.readFileSync(path.join(extensionPath, 'language-configuration.json'), 'utf8'));
    return {
      lineComment: raw.comments?.lineComment,
      blockComment: raw.comments?.blockComment,
      brackets: raw.brackets,
      autoClosingPairs: raw.autoClosingPairs,
      surroundingPairs: raw.surroundingPairs,
      wordPattern: raw.wordPattern,
      increaseIndentPattern: raw.indentationRules?.increaseIndentPattern,
      decreaseIndentPattern: raw.indentationRules?.decreaseIndentPattern,
      foldingStart: raw.folding?.markers?.start,
      foldingEnd: raw.folding?.markers?.end,
    };
  } catch {
    return {};
  }
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class EditorSession implements vscode.Disposable {
  ready = false;
  /** Last webview edit applied to the document (or refused); syncs acknowledge it. */
  private seq = 0;
  private flushId = 0;
  private readonly flushes = new Map<number, () => void>();
  /** Section texts the webview is known to show: its first text, its own edits and the syncs it confirmed. */
  private readonly shown = new Map<string, string>();
  /** Syncs posted and not confirmed yet, by id, with the texts they carry. */
  private readonly syncs = new Map<number, Map<string, string>>();
  private syncId = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly probes = new Map<number, (v: unknown) => void>();
  private probeId = 0;
  private pendingReveal: RevealTarget | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  /** Messages posted to the webview, kept for the integration tests. */
  readonly posted: HostMessage[] = [];
  readonly ref: ObjectRef;
  readonly fileKey: string;

  constructor(private readonly provider: ObjectEditorProvider, readonly document: vscode.TextDocument, readonly panel: vscode.WebviewPanel) {
    this.ref = parseObjectUri(document.uri)!;
    this.fileKey = fileKey(this.ref.fsPath);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.receive(m)),
      panel.onDidChangeViewState(() => {
        if (panel.active) provider.onDidActivate?.(document.uri);
      }),
    );
  }

  parse(): ParsedObjectText | undefined {
    try {
      return parseObjectText(this.document.getText());
    } catch {
      return undefined;
    }
  }

  post(message: HostMessage): void {
    // Edits queued before the tab closed can still answer.
    if (this.disposed) return;
    if (this.provider.recordMessages) {
      this.posted.push(message);
      if (this.posted.length > 200) this.posted.shift();
    }
    void this.panel.webview.postMessage(message);
  }

  private enqueue(work: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(work).catch(e => this.provider.log?.(`Split editor: ${(e as Error).stack ?? e}`));
    this.queue = next;
    return next;
  }

  /** Handles a message from the webview (also used by the tests to simulate one). */
  receive(m: WebviewMessage): Promise<void> {
    if (m.type !== 'edit' && m.type !== 'probeResult') debugLog(`webview -> host ${m.type} ${JSON.stringify(m).slice(0, 300)}`);
    switch (m.type) {
      case 'ready': return this.enqueue(() => this.init());
      case 'edit': return this.enqueue(() => this.applyEdit(m));
      case 'request': return this.enqueue(() => this.answer(m));
      case 'open': return this.enqueue(() => this.provider.navigate(m.target, this, m.side));
      case 'command':
        if (!WEBVIEW_COMMANDS.has(m.command)) return Promise.resolve();
        // After the edits typed before it (a save command must include them).
        return this.enqueue(() => {
          void vscode.commands.executeCommand(m.command);
        });
      case 'focus': return Promise.resolve();
      case 'synced': return this.enqueue(() => this.confirmed(m));
      case 'resync': return this.enqueue(() => this.resync());
      case 'flushed': {
        const done = this.flushes.get(m.id);
        this.flushes.delete(m.id);
        done?.();
        return Promise.resolve();
      }
      case 'ratio':
        this.provider.ratios.set(this.document.uri.toString(), m.ratio);
        return Promise.resolve();
      case 'probeResult': {
        const resolve = this.probes.get(m.id);
        this.probes.delete(m.id);
        resolve?.(m.result);
        return Promise.resolve();
      }
      case 'error':
        this.provider.log?.(`Split editor webview: ${m.message}`);
        return Promise.resolve();
    }
  }

  private init(): void {
    const parsed = this.parse();
    if (!parsed) {
      this.provider.log?.(`Split editor: ${this.document.uri.toString()} is not a TwinCAT object document`);
      return;
    }
    const meta = new Map(parsed.header.sections.map(s => [s.key, s]));
    const sections: PaneSection[] = parsed.sections.map(s => {
      const m: SectionMeta | undefined = meta.get(s.key);
      return { key: s.key, role: m?.role ?? 'impl', label: m?.label ?? s.key, editable: m?.editable ?? true, text: s.text };
    });
    // A (re)loaded webview starts from these texts and counts its edits from 1 again.
    this.seq = 0;
    this.syncs.clear();
    this.shown.clear();
    for (const s of sections) this.shown.set(s.key, s.text);
    const webview = this.panel.webview;
    this.post({
      type: 'init',
      fileKey: this.fileKey,
      title: parsed.header.label,
      sections,
      config: editorConfig(),
      language: languageConfig(this.provider.extensionUri.fsPath),
      theme: activeThemeTokens().rules,
      grammarUri: webview.asWebviewUri(vscode.Uri.joinPath(this.provider.extensionUri, 'syntaxes', 'twincat-st.tmLanguage.json')).toString(),
      onigUri: webview.asWebviewUri(vscode.Uri.joinPath(this.provider.extensionUri, 'out', 'webview', 'onig.wasm')).toString(),
      ratio: this.provider.ratios.get(this.document.uri.toString()),
    });
    this.ready = true;
    if (this.pendingReveal) {
      const r = this.pendingReveal;
      this.pendingReveal = undefined;
      this.reveal(r);
    }
    this.provider.scheduleDiagnostics(this.document, 50);
  }

  private async applyEdit(m: Extract<WebviewMessage, { type: 'edit' }>): Promise<void> {
    const wanted = m.text.replace(/\r\n?/g, '\n');
    // Acknowledged (this.seq) only once applied or refused: a sync posted while this edit is retried must
    // not make the webview drop it.
    const done = () => {
      this.seq = Math.max(this.seq, m.seq);
    };
    // What the webview had before this edit.
    const before = this.shown.get(m.key);
    // The document can change between reading it and applying the edit (a reload from disk), and VS Code
    // then refuses the edit: read it again and retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      const parsed = this.parse();
      const section = parsed?.sections.find(s => s.key === m.key);
      const meta = parsed?.header.sections.find(s => s.key === m.key);
      if (!parsed || !section || meta?.editable === false) {
        done();
        this.resync();
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      const doc = this.document;
      if (applyChanges(section.text, m.changes) === wanted) {
        for (const c of m.changes) {
          const range = new vscode.Range(doc.positionAt(section.start + c.offset), doc.positionAt(section.start + c.offset + c.length));
          edit.replace(doc.uri, range, c.text.replace(/\r\n?/g, '\n'));
        }
      } else if (section.text !== before) {
        // The section changed (XAE, git, another editor) after the webview last had it, so this edit was made
        // on older text. Showing the document's text again loses a keystroke; overwriting would lose that change.
        debugLog(`edit ${m.seq} of ${m.key} made on older text: resync`);
        done();
        this.resync(parsed);
        return;
      } else {
        // The change list does not reproduce the webview's text although both started from the same text.
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(section.start), doc.positionAt(section.end)), wanted);
      }
      if (edit.size === 0) {
        done();
        return;
      }
      // Known before the change event arrives, so the document change is not echoed back.
      this.shown.set(m.key, wanted);
      for (const texts of this.syncs.values()) texts.delete(m.key);
      const version = doc.version;
      if (await vscode.workspace.applyEdit(edit)) {
        done();
        // applyEdit can resolve before the extension host has the new text; the next edit needs it.
        await this.untilVersion(version + 1);
        // Not awaited here: that save runs the save participant (flush), which waits for this queue.
        setTimeout(() => void this.provider.afterWebviewEdit(this.document), 0);
        return;
      }
      if (before === undefined) this.shown.delete(m.key);
      else this.shown.set(m.key, before);
      debugLog(`edit ${m.seq} of ${m.key} refused at version ${version} (attempt ${attempt + 1})`);
      await this.untilVersion(version + 1, 300);
    }
    this.provider.log?.(`Split editor: an edit of ${this.document.uri.path.split('/').pop()} could not be applied`);
    done();
    this.resync();
  }

  /**
   * Resolves once every edit the webview made so far is in the document (before a save). Bounded well
   * below VS Code's 1.5 s limit for save participants, which disables a listener that is too slow.
   */
  flush(timeout = 600): Promise<void> {
    if (!this.ready || this.disposed) return Promise.resolve();
    const id = ++this.flushId;
    const answered = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.flushes.delete(id);
        resolve();
      }, timeout);
      this.flushes.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.post({ type: 'flush', id });
    // The edits arrive before the answer and are queued: wait for the queue after the answer.
    const drained = answered.then(() => this.enqueue(() => undefined));
    return Promise.race([drained, new Promise<void>(resolve => setTimeout(resolve, timeout + 400))]);
  }

  private untilVersion(version: number, timeout = 2000): Promise<void> {
    if (this.document.version >= version) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      };
      const timer = setTimeout(done, timeout);
      const sub = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document === this.document && this.document.version >= version) done();
      });
    });
  }

  /** The text the webview has or is about to get (a sync not confirmed yet) for a section. */
  private expected(key: string): string | undefined {
    let text = this.shown.get(key);
    for (const texts of this.syncs.values()) if (texts.has(key)) text = texts.get(key);
    return text;
  }

  /** Sends the document's section texts when the webview may show something else. */
  documentChanged(): void {
    if (!this.ready) return;
    const parsed = this.parse();
    if (!parsed) return;
    if (parsed.sections.every(s => this.expected(s.key) === s.text)) return;
    this.resync(parsed);
  }

  private resync(parsed = this.parse()): void {
    if (!parsed || !this.ready) return;
    const id = ++this.syncId;
    this.syncs.set(id, new Map(parsed.sections.map(s => [s.key, s.text])));
    this.post({ type: 'sync', id, sections: parsed.sections.map(s => ({ key: s.key, text: s.text })), ack: this.seq });
  }

  /** The webview applied (some sections of) a sync; older syncs are superseded by it. */
  private confirmed(m: Extract<WebviewMessage, { type: 'synced' }>): void {
    const texts = this.syncs.get(m.id);
    if (!texts) return;
    for (const k of m.keys) {
      const t = texts.get(k);
      if (t !== undefined) this.shown.set(k, t);
    }
    for (const id of [...this.syncs.keys()]) if (id <= m.id) this.syncs.delete(id);
  }

  reveal(target: RevealTarget): void {
    debugLog(`reveal ${target.key}@${target.start} ready=${this.ready}`);
    if (!this.ready) {
      this.pendingReveal = target;
      return;
    }
    let { start, end = target.start } = target;
    // Offsets computed on another version of the section (the language index): map them to this document.
    const shown = this.parse()?.sections.find(s => s.key === target.key)?.text;
    if (target.text !== undefined && shown !== undefined && shown !== target.text) {
      start = mapOffset(target.text, shown, start);
      end = Math.max(start, mapOffset(target.text, shown, end));
    }
    this.post({ type: 'reveal', key: target.key, start, end, focus: target.focus ?? true });
  }

  private async answer(m: Extract<WebviewMessage, { type: 'request' }>): Promise<void> {
    const features = this.provider.features;
    const ctx = this.provider.index.context(this.fileKey, m.key);
    let result: unknown;
    if (ctx) {
      switch (m.kind) {
        case 'definition': {
          const loc = features.definitionAt(ctx, m.text, m.offset);
          result = loc ? this.provider.target(loc, this, m.key, m.text) : undefined;
          break;
        }
        case 'hover':
          result = features.hoverAt(ctx, m.text, m.offset);
          break;
        case 'completion':
          result = features.completionsAt(ctx, m.text, m.offset);
          break;
        case 'references':
          result = features.referencesAt(ctx, m.text, m.offset, m.includeDeclaration ?? true)
            .map(loc => this.provider.target(loc, this, m.key, m.text)).filter(t => t !== undefined);
          break;
      }
    }
    this.post({ type: 'response', id: m.id, result: result ?? null });
  }

  /** Runs a test action in the webview and returns its result. */
  probe(action: ProbeAction, timeout = 10000): Promise<unknown> {
    const id = ++this.probeId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probes.delete(id);
        reject(new Error(`webview did not answer the probe ${action.kind}`));
      }, timeout);
      this.probes.set(id, v => {
        clearTimeout(timer);
        resolve(v);
      });
      this.post({ type: 'probe', id, action });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
  }
}

export class ObjectEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly sessions = new Set<EditorSession>();
  private readonly pendingReveal = new Map<string, RevealTarget>();
  private readonly diagTimers = new Map<string, NodeJS.Timeout>();
  private allTimer: NodeJS.Timeout | undefined;
  /** Problems of the open split editors, on twincat-loc copies of their sections (the Problems panel opens them at the right place). */
  readonly diagnostics = vscode.languages.createDiagnosticCollection('twincat-split');
  /** twincat-loc URIs that got problems, by document URI. */
  private readonly diagnosed = new Map<string, vscode.Uri[]>();
  recordMessages = false;
  /** Splitter position per document, so a rebuilt webview (tab replaced, moved) gets it back. */
  readonly ratios = new Map<string, number>();
  onDidActivate?: (uri: vscode.Uri) => void;
  openView?: (request: OpenViewRequest) => Promise<void>;
  log?: (message: string) => void;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly extensionUri: vscode.Uri,
    readonly index: LanguageIndex,
    readonly features: LanguageFeatures,
    private readonly ws: TcWorkspace,
    private readonly locations: LocationService,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
      // Ctrl+S right after typing: the last keystrokes may still be on their way from the webview.
      vscode.workspace.onWillSaveTextDocument(e => {
        const sessions = this.sessionsOf(e.document.uri);
        if (sessions.length) e.waitUntil(Promise.all(sessions.map(s => s.flush())));
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.colorTheme')) this.postTheme();
        if (e.affectsConfiguration('editor')) {
          const config = editorConfig();
          for (const s of this.sessions) if (s.ready) s.post({ type: 'config', config });
        }
      }),
    );
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    if (!parseObjectUri(document.uri)) {
      // Not an object document (another scheme with a .tcobj name): say so instead of failing to load.
      panel.webview.html = `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground);
        padding: 16px">This TwinCAT view only shows objects opened from the TwinCAT tree. Use Reopen Editor With to open it as text.</body></html>`;
      return;
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot, vscode.Uri.joinPath(this.extensionUri, 'syntaxes')],
    };
    const session = new EditorSession(this, document, panel);
    this.sessions.add(session);
    // A new editor that opens active never gets a view state change (reveal in the tree).
    if (panel.active) this.onDidActivate?.(document.uri);
    const pending = this.pendingReveal.get(document.uri.toString());
    if (pending) {
      this.pendingReveal.delete(document.uri.toString());
      session.reveal(pending);
    }
    panel.onDidDispose(() => {
      session.dispose();
      this.sessions.delete(session);
      if (!this.sessionsOf(document.uri).length) this.clearDiagnostics(document.uri);
    });
    const csp = panel.webview.cspSource;
    const n = nonce();
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, name)).toString();
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp} 'unsafe-inline'; font-src ${csp} data:; script-src 'nonce-${n}' ${csp} 'wasm-unsafe-eval'; worker-src blob: ${csp}; connect-src ${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('editor.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${n}">window.TWINCAT_WORKER_URL = ${JSON.stringify(asset('editor.worker.js'))};</script>
<script nonce="${n}" src="${asset('editor.js')}"></script>
</body>
</html>`;
  }

  sessionsOf(uri: vscode.Uri): EditorSession[] {
    const key = uri.toString();
    return [...this.sessions].filter(s => s.document.uri.toString() === key);
  }

  allSessions(): EditorSession[] {
    return [...this.sessions];
  }

  /** Shows a place in the split editor of a document, now or once its webview is ready. */
  reveal(uri: vscode.Uri, target: RevealTarget): void {
    const sessions = this.sessionsOf(uri);
    if (sessions.length === 0) {
      this.pendingReveal.set(uri.toString(), target);
      return;
    }
    // The active editor when there are several, else the one opened last.
    const active = sessions.find(s => s.panel.active) ?? sessions.find(s => s.panel.visible) ?? sessions[sessions.length - 1];
    active.reveal(target);
  }

  /** Called by the extension when an object document changed. */
  documentChanged(doc: vscode.TextDocument): void {
    for (const s of this.sessionsOf(doc.uri)) s.documentChanged();
    if (this.sessionsOf(doc.uri).length) this.scheduleDiagnostics(doc);
    // Like a text editor: a preview tab is kept once it is edited (VS Code would replace it, and its webview,
    // with the next preview, for example a click in the Problems panel).
    if (doc.isDirty) {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (tab?.isPreview && tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === doc.uri.toString()) {
        void vscode.commands.executeCommand('workbench.action.keepEditor');
      }
    }
  }

  /**
   * After an edit from the webview: when every section equals the disk again (typed and undone),
   * saving writes nothing and makes the tab clean, like undoing back to the saved state in VS Code.
   */
  async afterWebviewEdit(doc: vscode.TextDocument): Promise<void> {
    if (!doc.isDirty) return;
    const ref = parseObjectUri(doc.uri);
    const obj = ref ? this.ws.getFile(ref.fsPath)?.objects.get(ref.objectId) : undefined;
    if (!ref || !obj) return;
    let parsed: ParsedObjectText;
    try {
      parsed = parseObjectText(doc.getText());
    } catch {
      return;
    }
    const disk = new Map(obj.sections.map(s => [s.key, s.text]));
    if (parsed.sections.every(s => disk.get(s.key) === s.text)) await doc.save();
  }

  /**
   * The section range of a location, with what the webview needs to show and open it. Offsets in the
   * requesting section (`requestKey`) refer to the text sent with the request.
   */
  target(loc: Loc, from?: EditorSession, requestKey?: string, requestText?: string): TargetRange | undefined {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    if (!ctx) return undefined;
    const indexText = this.index.sectionText(loc.fileKey, loc.sectionKey) ?? '';
    const ref: SectionRef = {
      fileKey: loc.fileKey,
      sectionKey: loc.sectionKey,
      view: { fsPath: ctx.filePath, objectId: ctx.object.id, accessor: ctx.accessor, label: viewLabel(ctx.object, ctx.accessor) },
      role: ctx.role,
      text: indexText,
    };
    let { start, end } = loc;
    // A section of the requesting tab: its pane may show another text than the index (an untouched section
    // that changed on disk while the tab had unsaved edits). The webview applies the offsets to its pane.
    const own = from && loc.fileKey === from.fileKey ? from.parse()?.sections.find(s => s.key === loc.sectionKey) : undefined;
    const sourceText = own && loc.sectionKey === requestKey && requestText !== undefined ? requestText : indexText;
    if (own && own.text !== sourceText) {
      start = mapOffset(sourceText, own.text, start);
      end = Math.max(start, mapOffset(sourceText, own.text, end));
    }
    if (own) ref.text = own.text;
    return { ref, start, end };
  }

  /** Opens the object view of a target (go to definition into another object). */
  async navigate(target: TargetRange, from?: EditorSession, side = false): Promise<void> {
    const v = target.ref.view;
    const column = side ? vscode.ViewColumn.Beside : from?.panel.viewColumn;
    await this.openView?.({
      ref: { fsPath: v.fsPath, objectId: v.objectId, accessor: v.accessor },
      reveal: { key: target.ref.sectionKey, start: target.start, end: target.end, focus: true, text: target.ref.text },
      viewColumn: column,
    });
  }

  // ------------------------------------------------------------------ diagnostics

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('diagnostics.enabled', true);
  }

  scheduleDiagnostics(doc: vscode.TextDocument, delay = 250): void {
    const key = doc.uri.toString();
    const t = this.diagTimers.get(key);
    if (t) clearTimeout(t);
    this.diagTimers.set(key, setTimeout(() => {
      this.diagTimers.delete(key);
      this.refreshDiagnostics(doc);
    }, delay));
  }

  scheduleAll(delay = 400): void {
    if (this.allTimer) clearTimeout(this.allTimer);
    this.allTimer = setTimeout(() => {
      this.allTimer = undefined;
      const docs = new Map<string, vscode.TextDocument>();
      for (const s of this.sessions) docs.set(s.document.uri.toString(), s.document);
      for (const d of docs.values()) this.refreshDiagnostics(d);
    }, delay);
  }

  /** Removes the Problems panel entries of a document. */
  clearDiagnostics(docUri: vscode.Uri): void {
    for (const u of this.diagnosed.get(docUri.toString()) ?? []) this.diagnostics.delete(u);
    this.diagnosed.delete(docUri.toString());
  }

  refreshDiagnostics(doc: vscode.TextDocument): void {
    const sessions = this.sessionsOf(doc.uri);
    if (sessions.length === 0 || doc.isClosed) {
      this.clearDiagnostics(doc.uri);
      return;
    }
    let parsed: ParsedObjectText;
    try {
      parsed = parseObjectText(doc.getText());
    } catch {
      return;
    }
    const fk = sessions[0].fileKey;
    const meta = new Map(parsed.header.sections.map(m => [m.key, m]));
    const all: { key: string; markers: Marker[] }[] = [];
    this.clearDiagnostics(doc.uri);
    const uris: vscode.Uri[] = [];
    for (const s of parsed.sections) {
      const ctx = this.enabled() ? this.index.context(fk, s.key) : undefined;
      const problems = ctx ? this.features.problemsOf(ctx, s.text) : [];
      all.push({ key: s.key, markers: problems.map(p => ({ start: p.start, end: p.end, message: p.message, severity: p.severity })) });
      if (problems.length === 0) continue;
      // One copy per section, so the Problems panel shows the line numbers of the pane.
      const uri = locUriOf(doc.uri, s.key, meta.get(s.key)?.label ?? s.key);
      this.diagnostics.set(uri, problems.map(p => {
        const d = new vscode.Diagnostic(rangeIn(s.text, p.start, p.end), p.message,
          p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        d.source = 'TwinCAT';
        return d;
      }));
      uris.push(uri);
    }
    if (uris.length) this.diagnosed.set(doc.uri.toString(), uris);
    for (const s of sessions) if (s.ready) s.post({ type: 'markers', markers: all });
    this.locations.changed(doc.uri);
  }

  private postTheme(): void {
    const theme = activeThemeTokens().rules;
    for (const s of this.sessions) if (s.ready) s.post({ type: 'theme', theme });
  }

  dispose(): void {
    for (const t of this.diagTimers.values()) clearTimeout(t);
    if (this.allTimer) clearTimeout(this.allTimer);
    for (const s of this.sessions) s.dispose();
    for (const d of this.disposables) d.dispose();
    this.diagnostics.dispose();
  }
}


// Quick fixes and Auto Declare... in the panes of the split editor. Monaco's light bulb, Ctrl+. and the hover of
// a problem offer what the host finds for the TwinCAT problems there ('codeActions' requests); a fix picked goes
// back to the host ('runFix'), which edits the document: the declaration reaches the pane like any change of the
// document, and Ctrl+Z there takes it back. Auto Declare... (Shift+F2, as in XAE, and the context menu of the
// panes) tells the host where the cursor is, and the host asks for the rest.

import type * as Monaco from 'monaco-editor';
import type { QuickFixResult, RequestKind, WebviewMessage } from '../shared/protocol';

export interface QuickFixPanes {
  /** The section of the pane a model is the text of; undefined for other models and read-only panes. */
  keyOf(model: Monaco.editor.ITextModel): string | undefined;
  request<T>(kind: RequestKind, key: string, model: Monaco.editor.ITextModel, offset: number): Promise<T | null>;
  post(message: WebviewMessage): void;
  /** The editor of the pane edited last. */
  lastEditor(): Monaco.editor.ICodeEditor | undefined;
}

/** Registers the quick fixes and Auto Declare...; returns the Auto Declare... of the pane edited last. */
export function registerQuickFixes(monaco: typeof Monaco, language: string, panes: QuickFixPanes): () => void {
  monaco.editor.registerCommand('twincat.runFix', (_accessor: unknown, id: unknown) => {
    if (typeof id === 'number') panes.post({ type: 'runFix', id });
  });
  monaco.languages.registerCodeActionProvider(language, {
    async provideCodeActions(model, _range, context) {
      const key = panes.keyOf(model);
      const markers = context.markers.filter(m => m.source === 'TwinCAT');
      if (!key || markers.length === 0) return { actions: [], dispose() {} };
      const startOf = (m: Monaco.editor.IMarkerData) => model.getOffsetAt({ lineNumber: m.startLineNumber, column: m.startColumn });
      const starts = [...new Set(markers.map(startOf))];
      const answers = await Promise.all(starts.map(offset => panes.request<QuickFixResult[]>('codeActions', key, model, offset)));
      const actions = answers.flatMap(a => a ?? []).map((f): Monaco.languages.CodeAction => ({
        title: f.title,
        kind: 'quickfix',
        isPreferred: f.preferred,
        diagnostics: markers.filter(m => startOf(m) === f.start),
        command: { id: 'twincat.runFix', title: f.title, arguments: [f.id] },
      }));
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });
  const autoDeclare = (editor: Monaco.editor.ICodeEditor) => {
    const model = editor.getModel();
    const key = model ? panes.keyOf(model) : undefined;
    const position = editor.getPosition();
    if (!model || !key || !position) return;
    panes.post({ type: 'autoDeclare', key, text: model.getValue(), offset: model.getOffsetAt(position) });
  };
  monaco.editor.addEditorAction({
    id: 'twincat.autoDeclare',
    label: 'Auto Declare...',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F2],
    precondition: '!editorReadonly',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 0,
    run: editor => autoDeclare(editor),
  });
  return () => {
    const editor = panes.lastEditor();
    if (editor) autoDeclare(editor);
  };
}

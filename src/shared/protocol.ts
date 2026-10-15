// Messages between the split editor's webview and the extension host.
// Offsets are character offsets in a section's text (LF line breaks).

export interface PaneSection {
  key: string;
  role: 'decl' | 'impl';
  label: string;
  editable: boolean;
  text: string;
}

/** A section of another object (or of this one), for go to definition and references. */
export interface SectionRef {
  fileKey: string;
  sectionKey: string;
  /** Object view the section belongs to (opened by the host when navigating there). */
  view: { fsPath: string; objectId: string; accessor?: 'Get' | 'Set'; label: string };
  role: 'decl' | 'impl';
  /** Text of the section, so the webview can show it in peek views. */
  text: string;
}

export interface TargetRange {
  ref: SectionRef;
  start: number;
  end: number;
}

export interface TokenRule {
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface EditorConfig {
  /** Monaco editor options taken from the VS Code settings (font, tab size, ...). */
  options: Record<string, unknown>;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
}

export interface LanguageConfig {
  lineComment?: string;
  blockComment?: [string, string];
  brackets?: [string, string][];
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs?: [string, string][];
  wordPattern?: string;
  increaseIndentPattern?: string;
  decreaseIndentPattern?: string;
  foldingStart?: string;
  foldingEnd?: string;
}

export interface Marker {
  start: number;
  end: number;
  message: string;
  severity: 'error' | 'warning';
}

export type HostMessage =
  | {
    type: 'init';
    fileKey: string;
    title: string;
    sections: PaneSection[];
    config: EditorConfig;
    language: LanguageConfig;
    theme: TokenRule[];
    grammarUri: string;
    onigUri: string;
    /** Splitter position kept by the host for this document (a rebuilt webview gets it back). */
    ratio?: number;
    /** Changes vs HEAD shown (a rebuilt webview gets it back). */
    changes?: boolean;
  }
  /**
   * HEAD texts of the sections (null: not in HEAD, a new object), which the panes mark their changes
   * against. `available` is false outside a git repository.
   */
  | { type: 'base'; available: boolean; sections: { key: string; text: string | null }[] }
  /** Shows or hides the changes vs HEAD (inline diff in every pane). */
  | { type: 'setChanges'; on: boolean }
  | { type: 'flush'; id: number }
  /** The document's section texts; `ack` is the last webview edit applied. Answered with 'synced'. */
  | { type: 'sync'; id: number; sections: { key: string; text: string }[]; ack: number }
  | { type: 'markers'; markers: { key: string; markers: Marker[] }[] }
  | { type: 'reveal'; key: string; start: number; end: number; focus: boolean }
  | { type: 'theme'; theme: TokenRule[] }
  | { type: 'config'; config: EditorConfig }
  | { type: 'response'; id: number; result: unknown }
  | { type: 'probe'; id: number; action: ProbeAction };

export type RequestKind = 'definition' | 'hover' | 'completion' | 'references';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; seq: number; key: string; changes: { offset: number; length: number; text: string }[]; text: string }
  | { type: 'request'; id: number; kind: RequestKind; key: string; text: string; offset: number; includeDeclaration?: boolean }
  | { type: 'open'; target: TargetRange; side?: boolean }
  /** A VS Code command the panes cannot run themselves (see WORKBENCH_CHORDS). */
  | { type: 'command'; command: string }
  | { type: 'focus'; key: string }
  /** The sections of a sync that the webview applied (it keeps sections it has unacknowledged edits in). */
  | { type: 'synced'; id: number; keys: string[] }
  /** Asks for the document's texts again, after a sync was skipped for sections with edits in flight. */
  | { type: 'resync' }
  /** Every edit made before the 'flush' with this id has been posted. */
  | { type: 'flushed'; id: number }
  | { type: 'ratio'; ratio: number }
  /** The panes now show (or no longer show) the changes vs HEAD. */
  | { type: 'changesMode'; on: boolean }
  | { type: 'probeResult'; id: number; result: unknown }
  | { type: 'error'; message: string };

/**
 * VS Code commands bound to Ctrl+K chords. Monaco owns the Ctrl+K prefix inside the panes (comment,
 * folding, ...), so it would swallow these; the webview binds them and asks VS Code to run them.
 * `second` is the second key in Monaco notation: modifiers + key name.
 */
export const WORKBENCH_CHORDS: { second: string; command: string }[] = [
  { second: 'KeyS', command: 'workbench.action.files.saveAll' },
  { second: 'Ctrl+Shift+KeyS', command: 'workbench.action.files.saveWithoutFormatting' },
  { second: 'KeyW', command: 'workbench.action.closeEditorsInGroup' },
  { second: 'Ctrl+KeyW', command: 'workbench.action.closeAllEditors' },
  { second: 'Ctrl+Shift+KeyW', command: 'workbench.action.closeAllGroups' },
  { second: 'KeyU', command: 'workbench.action.closeUnmodifiedEditors' },
  { second: 'Enter', command: 'workbench.action.keepEditor' },
  { second: 'Shift+Enter', command: 'workbench.action.pinEditor' },
  { second: 'Ctrl+LeftArrow', command: 'workbench.action.focusLeftGroup' },
  { second: 'Ctrl+RightArrow', command: 'workbench.action.focusRightGroup' },
  { second: 'Ctrl+UpArrow', command: 'workbench.action.focusAboveGroup' },
  { second: 'Ctrl+DownArrow', command: 'workbench.action.focusBelowGroup' },
  { second: 'LeftArrow', command: 'workbench.action.moveActiveEditorGroupLeft' },
  { second: 'RightArrow', command: 'workbench.action.moveActiveEditorGroupRight' },
  { second: 'Ctrl+KeyP', command: 'workbench.action.showAllEditors' },
  { second: 'Ctrl+KeyT', command: 'workbench.action.selectTheme' },
  { second: 'Ctrl+KeyS', command: 'workbench.action.openGlobalKeybindings' },
  { second: 'Ctrl+KeyR', command: 'workbench.action.keybindingsReference' },
  { second: 'Ctrl+KeyO', command: 'workbench.action.files.openFolder' },
  { second: 'KeyF', command: 'workbench.action.closeFolder' },
  { second: 'KeyP', command: 'workbench.action.files.copyPathOfActiveFile' },
  { second: 'KeyR', command: 'workbench.action.files.revealActiveFileInWindows' },
  { second: 'KeyO', command: 'workbench.action.files.showOpenedFileInNewWindow' },
  { second: 'KeyZ', command: 'workbench.action.toggleZenMode' },
  { second: 'Ctrl+KeyQ', command: 'workbench.action.navigateToLastEditLocation' },
  { second: 'Ctrl+KeyH', command: 'workbench.action.output.toggleOutput' },
  { second: 'Ctrl+PageDown', command: 'workbench.action.nextEditorInGroup' },
  { second: 'Ctrl+PageUp', command: 'workbench.action.previousEditorInGroup' },
  { second: 'Ctrl+Backslash', command: 'workbench.action.splitEditorOrthogonal' },
  { second: 'KeyD', command: 'workbench.files.action.compareWithSaved' },
];

/** Commands the webview may ask the host to run. */
export const WEBVIEW_COMMANDS = new Set<string>([
  'workbench.action.showCommands', 'workbench.action.quickOpen', ...WORKBENCH_CHORDS.map(c => c.command),
]);

export interface HoverResult {
  markdown: string;
  start: number;
  end: number;
}

export interface CompletionResult {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
}

/** Test hooks: the integration tests drive and inspect the webview through these. */
export type ProbeAction =
  | { kind: 'state' }
  | { kind: 'type'; key: string; offset: number; text: string }
  | { kind: 'setRatio'; ratio: number }
  | { kind: 'drag'; fromY: number; toY: number }
  | { kind: 'run'; key: string; offset: number; action: string }
  | { kind: 'undo'; key: string }
  | { kind: 'keys'; key: string; strokes: { key: string; code: string; keyCode: number; ctrl?: boolean; shift?: boolean; alt?: boolean }[] }
  /** A click on the change marker of a line (1-based). */
  | { kind: 'markerClick'; key: string; line: number }
  /** Reverts the change at a line (1-based) of a pane shown as a diff, like its Revert Block button. */
  | { kind: 'revertChange'; key: string; line: number };

export interface PaneState {
  key: string;
  text: string;
  top: number;
  height: number;
  contentHeight: number;
  scrollTop: number;
  readOnly: boolean;
  markers: number;
  /** Distinct token colors (mtk classes) rendered in the visible lines. */
  tokenClasses: number;
  focused: boolean;
  /** Selection as offsets. */
  selection: [number, number];
  /** Changed blocks against HEAD (the change markers). */
  changes: number;
  /** The pane shows the inline diff against HEAD. */
  diff: boolean;
  /** Changed blocks the diff editor shows (-1 without a diff, or while it computes). */
  diffChanges: number;
  /** Text of the label shown over a pane in diff mode. */
  label?: string;
}

export interface ProbeState {
  ratio: number;
  panes: PaneState[];
  sashTop?: number;
  bodyHeight: number;
  /** Models of other objects created for peek views. */
  foreignModels: string[];
  errors: string[];
}

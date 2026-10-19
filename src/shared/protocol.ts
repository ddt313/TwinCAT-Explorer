// Messages between the split editor's webview and the extension host.
// Offsets are character offsets in a section's text (LF line breaks).

import type { TokenRule } from '../core/tmTheme';

export type { TokenRule };

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

/** The name F2 renames at an offset and its range, or why there is none (answer to 'prepareRename'). */
export type RenameInfo = { start: number; end: number; text: string } | { problem: string };

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

/** A commit that last changed lines of the panes (line blame). */
export interface BlameCommitInfo {
  sha: string;
  author: string;
  /** Committed by the user of the repository (user.email): shown as "You". */
  you: boolean;
  /** Author date, seconds since 1970. */
  time: number;
  summary: string;
  /** The lines are not committed yet. */
  uncommitted: boolean;
}

/** Blame of one section: its text in HEAD ('' when not in HEAD), and per line the index of its commit (-1: unknown). */
export interface SectionBlame {
  key: string;
  text: string;
  lines: number[];
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
    /** Go to the first change once the diffs show (opened from the TwinCAT Changes view). */
    first?: boolean;
  }
  /**
   * Base texts of the sections (null: not in the base, a new object), which the panes mark their changes
   * against; `label` names the base (HEAD, origin/develop). `available` is false outside a git repository.
   */
  | { type: 'base'; available: boolean; label: string; sections: { key: string; text: string | null }[] }
  /** Shows or hides the changes (inline diff in every pane), at the first change when `first`. */
  | { type: 'setChanges'; on: boolean; first?: boolean }
  /**
   * Line blame of the sections as they are in HEAD (the panes map it onto their own text: lines changed since
   * are not committed); `enabled` false hides the annotation of the current line.
   */
  | { type: 'blame'; enabled: boolean; sections: SectionBlame[]; commits: BlameCommitInfo[] }
  | { type: 'flush'; id: number }
  /** The document's section texts; `ack` is the last webview edit applied. Answered with 'synced'. */
  | { type: 'sync'; id: number; sections: { key: string; text: string }[]; ack: number }
  | { type: 'markers'; markers: { key: string; markers: Marker[] }[] }
  | { type: 'reveal'; key: string; start: number; end: number; focus: boolean }
  | { type: 'theme'; theme: TokenRule[] }
  | { type: 'config'; config: EditorConfig }
  | { type: 'response'; id: number; result: unknown }
  | { type: 'probe'; id: number; action: ProbeAction };

export type RequestKind = 'definition' | 'hover' | 'completion' | 'references' | 'signature' | 'prepareRename' | 'rename';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; seq: number; key: string; changes: { offset: number; length: number; text: string }[]; text: string }
  /** `newName`: the name a 'rename' gives. */
  | { type: 'request'; id: number; kind: RequestKind; key: string; text: string; offset: number; includeDeclaration?: boolean; newName?: string }
  | { type: 'open'; target: TargetRange; side?: boolean }
  /** A VS Code command the panes cannot run themselves (see WORKBENCH_CHORDS). */
  | { type: 'command'; command: string }
  /** The sections of a sync that the webview applied (it keeps sections it has unacknowledged edits in). */
  | { type: 'synced'; id: number; keys: string[] }
  /** Asks for the document's texts again, after a sync was skipped for sections with edits in flight. */
  | { type: 'resync' }
  /** Every edit made before the 'flush' with this id has been posted. */
  | { type: 'flushed'; id: number }
  | { type: 'ratio'; ratio: number }
  /** The panes now show (or no longer show) the changes vs HEAD. */
  | { type: 'changesMode'; on: boolean }
  /** Shows what a commit (from the line blame) changed in this object. */
  | { type: 'blameOpen'; sha: string }
  /** Shows the commits that changed this object (TwinCAT History view). */
  | { type: 'showHistory' }
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
  /** Shown right after the label, less prominently: the arguments a call item inserts. */
  labelDetail?: string;
  /** Inserted instead of the label, in VS Code's snippet syntax (`fbTimer(IN := ${1}, PT := ${2});`). */
  snippet?: string;
  /** Compared with the typed text instead of the label. */
  filterText?: string;
  /** Offsets of the text the item replaces, when it is not the word before the cursor. */
  range?: { start: number; end: number };
  /** Shows the signature help once inserted (a call with its arguments). */
  signatureHelp?: boolean;
}

/** The signature of the call the cursor is in: the label shows the parameters at the offsets given for them. */
export interface SignatureResult {
  label: string;
  documentation?: string;
  parameters: { label: [number, number]; documentation?: string }[];
  /** Index of the parameter the cursor is at; -1 for none. */
  activeParameter: number;
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
  | { kind: 'revertChange'; key: string; line: number }
  /** Puts the cursor on a line (1-based) and returns the blame annotation shown there (BlameProbe). */
  | { kind: 'blame'; key: string; line: number }
  /** A click on the blame annotation of a line (1-based). */
  | { kind: 'blameClick'; key: string; line: number };

/** The blame annotation of the current line. */
export interface BlameProbe {
  text: string | null;
  sha: string | null;
  hover: string | null;
  /** blameClick: the annotation was rendered and clicked. */
  clicked?: boolean;
}

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
  /** The blame annotation shown at the end of the current line. */
  blame?: string;
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

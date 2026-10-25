// The tabs of TwinCAT objects whose object or file is renamed, moved or deleted: closed, and opened again under
// the new name or path where they were.

import * as vscode from 'vscode';
import { fileKey } from '../core/workspace';
import { Accessor } from '../core/objectText';
import { OBJECT_EDITOR, OBJECT_NOTEBOOK, isFileUri, parseObjectUri } from './uris';

/** A tab to open again: what it showed, in which editor, where. */
export interface ShownTab {
  kind: 'editor' | 'notebook' | 'text';
  objectId?: string;
  accessor?: Accessor;
  viewColumn: vscode.ViewColumn;
  preview: boolean;
  active: boolean;
}

function uriOf(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}

/**
 * The tabs of a file: the split editors and object notebooks of its objects (of one object, its accessors
 * included, when `objectId` is given; of one accessor of it with `accessor`) and, for the whole file, its text
 * editors.
 */
export function tabsOf(fsPath: string, objectId?: string, accessor?: Accessor): vscode.Tab[] {
  const key = fileKey(fsPath);
  return vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => {
    const uri = uriOf(t);
    if (!uri) return false;
    const ref = parseObjectUri(uri);
    if (ref) return fileKey(ref.fsPath) === key && (!objectId || ref.objectId === objectId) && (!accessor || ref.accessor === accessor);
    return !objectId && isFileUri(uri) && fileKey(uri.fsPath) === key;
  });
}

/** What the tabs show, to open them again (see reopen). */
export function shownTabs(tabs: vscode.Tab[]): ShownTab[] {
  return tabs.flatMap(t => {
    const uri = uriOf(t)!;
    const ref = parseObjectUri(uri);
    const kind = t.input instanceof vscode.TabInputCustom && t.input.viewType === OBJECT_EDITOR ? 'editor'
      : t.input instanceof vscode.TabInputNotebook && t.input.notebookType === OBJECT_NOTEBOOK ? 'notebook'
        : t.input instanceof vscode.TabInputText && isFileUri(uri) ? 'text' : undefined;
    if (!kind || (kind !== 'text' && !ref)) return [];
    return [{ kind, objectId: ref?.objectId, accessor: ref?.accessor, viewColumn: t.group.viewColumn, preview: t.isPreview, active: t.isActive && t.group.isActive }];
  });
}

export async function closeTabs(tabs: vscode.Tab[]): Promise<void> {
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}

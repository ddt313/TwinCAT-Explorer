// Opening object notebooks. A closed tab's notebook document can stay alive in
// the background (go to definition, references, VS Code's own caching) without
// reloading when the file changes on disk; reopening that document would show
// stale text. So a document is only reused while it is shown in a tab or has
// unsaved edits; otherwise every open gets a fresh URI and reads the disk.

import * as vscode from 'vscode';
import { fileKey } from '../core/workspace';
import { OBJECT_NOTEBOOK, ObjectInfo, objectUri, parseObjectUri } from './uris';

let revision = 0;
const session = Date.now().toString(36);

function nextRevision(): string {
  revision++;
  return `${session}.${revision}`;
}

function shownInTab(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
    (t.input instanceof vscode.TabInputNotebook && t.input.uri.toString() === key) ||
    (t.input instanceof vscode.TabInputNotebookDiff && (t.input.original.toString() === key || t.input.modified.toString() === key))));
}

/** The notebook document of an object that should be reused: dirty first, then one shown in a tab. */
export function reusableObjectDocument(fsPath: string, objectId: string): vscode.NotebookDocument | undefined {
  const k = fileKey(fsPath);
  const matches = vscode.workspace.notebookDocuments.filter(nb => {
    if (nb.notebookType !== OBJECT_NOTEBOOK) return false;
    const ref = parseObjectUri(nb.uri);
    return !!ref && ref.objectId === objectId && fileKey(ref.fsPath) === k;
  });
  return matches.find(nb => nb.isDirty) ?? matches.find(nb => shownInTab(nb.uri));
}

export async function openObjectDocument(fsPath: string, obj: ObjectInfo): Promise<vscode.NotebookDocument> {
  const existing = reusableObjectDocument(fsPath, obj.id);
  if (existing) return existing;
  return vscode.workspace.openNotebookDocument(objectUri(fsPath, obj, nextRevision()));
}

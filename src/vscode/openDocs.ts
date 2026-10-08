// Opening object notebooks. A closed tab's notebook document can stay alive in
// the background (go to definition, references, VS Code's own caching) and then
// stops reloading when the file changes on disk; reopening it would show stale
// text. So an object's document is reused while it is dirty, shown in a tab, or
// was opened since the last change of its file on disk. Otherwise the open gets
// a fresh URI (a new `rev` in the query) and reads the disk.

import * as vscode from 'vscode';
import { fileKey } from '../core/workspace';
import { OBJECT_NOTEBOOK, ObjectInfo, objectUri, parseObjectUri } from './uris';

let revision = 0;
const session = Date.now().toString(36);
/** Bumped per file whenever it changes on disk. */
const generation = new Map<string, number>();
/** Generation of its file when a document was opened, by document URI. */
const openedAt = new Map<string, number>();
/** Opens in flight, by `fileKey|objectId`, so concurrent callers share one document. */
const pending = new Map<string, { gen: number; doc: Promise<vscode.NotebookDocument> }>();

function nextRevision(): string {
  revision++;
  return `${session}.${revision}`;
}

function sameObject(uri: vscode.Uri, key: string, objectId: string): boolean {
  const ref = parseObjectUri(uri);
  return !!ref && ref.objectId === objectId && fileKey(ref.fsPath) === key;
}

function tabUris(): { uri: vscode.Uri; active: boolean }[] {
  const out: { uri: vscode.Uri; active: boolean }[] = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      if (t.input instanceof vscode.TabInputNotebook) out.push({ uri: t.input.uri, active: g.isActive });
      else if (t.input instanceof vscode.TabInputNotebookDiff) {
        out.push({ uri: t.input.original, active: g.isActive }, { uri: t.input.modified, active: g.isActive });
      }
    }
  }
  return out;
}

export function shownInTab(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return tabUris().some(t => t.uri.toString() === key);
}

/** A file changed on disk: documents opened before are no longer trusted to be current. */
export function markFileChanged(fsPath: string): void {
  const k = fileKey(fsPath);
  generation.set(k, (generation.get(k) ?? 0) + 1);
}

/** Forget a closed document. */
export function forgetDocument(uri: vscode.Uri): void {
  openedAt.delete(uri.toString());
}

/** The URI to use for an object right now, or undefined when a fresh document is needed. */
function reusableUri(fsPath: string, objectId: string): vscode.Uri | undefined {
  const k = fileKey(fsPath);
  const gen = generation.get(k) ?? 0;
  const docs = vscode.workspace.notebookDocuments.filter(nb => nb.notebookType === OBJECT_NOTEBOOK && sameObject(nb.uri, k, objectId));
  const tabs = tabUris().filter(t => sameObject(t.uri, k, objectId));
  const inTab = (nb: vscode.NotebookDocument) => tabs.some(t => t.uri.toString() === nb.uri.toString());
  const doc = docs.find(nb => nb.isDirty) ?? docs.find(inTab) ?? docs.find(nb => openedAt.get(nb.uri.toString()) === gen);
  if (doc) return doc.uri;
  // A tab restored after a reload whose document is not loaded yet: opening its URI reads the disk.
  const tab = tabs.find(t => t.active) ?? tabs[0];
  return tab?.uri;
}

export async function openObjectDocument(fsPath: string, obj: ObjectInfo): Promise<vscode.NotebookDocument> {
  const k = fileKey(fsPath);
  const key = `${k}|${obj.id}`;
  const gen = generation.get(k) ?? 0;
  const reuse = reusableUri(fsPath, obj.id);
  if (reuse) {
    const doc = await vscode.workspace.openNotebookDocument(reuse);
    if (!openedAt.has(doc.uri.toString())) openedAt.set(doc.uri.toString(), gen);
    return doc;
  }
  const inFlight = pending.get(key);
  if (inFlight && inFlight.gen === gen) return inFlight.doc;
  const doc = Promise.resolve(vscode.workspace.openNotebookDocument(objectUri(fsPath, obj, nextRevision()))).then(nb => {
    openedAt.set(nb.uri.toString(), gen);
    return nb;
  });
  pending.set(key, { gen, doc });
  try {
    return await doc;
  } finally {
    if (pending.get(key)?.doc === doc) pending.delete(key);
  }
}

// Opening object notebooks (the notebook alternative to the split editor of
// objectEditor.ts). A closed tab's notebook document can stay alive in
// the background (go to definition, references, VS Code's own caching) and then
// stops reloading when the file changes on disk; reopening it would show stale
// text. So an object's document is reused while it is dirty, shown in a tab, or
// was opened since the last change of its file on disk. Otherwise the open gets
// a fresh URI (a new `rev` in the query) and reads the disk.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { fileKey } from '../core/workspace';
import { cellMeta } from './serializers';
import { OBJECT_NOTEBOOK, ObjectInfo, objectUri, parseObjectUri, realPathOf } from './uris';

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

function sameObject(uri: vscode.Uri, key: string, objectId: string, accessor: 'Get' | 'Set' | undefined): boolean {
  const ref = parseObjectUri(uri);
  return !!ref && ref.objectId === objectId && ref.accessor === accessor && fileKey(ref.fsPath) === key;
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

/** Which kinds of tabs show a URI. */
export function tabKinds(uri: vscode.Uri): { editor: boolean; notebook: boolean } {
  const key = uri.toString();
  let editor = false;
  let notebook = false;
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const input = t.input;
      if ((input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) && input.uri.toString() === key) editor = true;
      if (input instanceof vscode.TabInputNotebook && input.uri.toString() === key) notebook = true;
    }
  }
  return { editor, notebook };
}

/** Whether any tab (split editor, text editor or notebook) shows the URI. */
export function anyTabShows(uri: vscode.Uri): boolean {
  const key = uri.toString();
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const input = t.input;
      if ((input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook)
        && input.uri.toString() === key) return true;
    }
  }
  return shownInTab(uri);
}

/** An editor holds unsaved edits of the file (a split editor, a notebook, its XML). */
export function hasUnsavedEdits(fsPath: string): boolean {
  const key = fileKey(fsPath);
  const same = (u: vscode.Uri) => {
    const p = realPathOf(u);
    return !!p && fileKey(p) === key;
  };
  return vscode.workspace.textDocuments.some(d => d.isDirty && same(d.uri))
    || vscode.workspace.notebookDocuments.some(nb => nb.isDirty && same(nb.uri));
}

/** Disk signature (mtime and size) at the last generation bump, by file. */
const diskSig = new Map<string, string>();

/** A file changed on disk: documents opened before are no longer trusted to be current. */
export function markFileChanged(fsPath: string): void {
  const k = fileKey(fsPath);
  let sig = 'missing';
  try {
    const st = fs.statSync(fsPath);
    sig = `${st.mtimeMs}|${st.size}`;
  } catch {
    // deleted
  }
  // The watcher echo of a write already counted (our own save) is not a new change.
  if (diskSig.get(k) === sig) return;
  diskSig.set(k, sig);
  generation.set(k, (generation.get(k) ?? 0) + 1);
}

/** Forget a closed document. */
export function forgetDocument(uri: vscode.Uri): void {
  openedAt.delete(uri.toString());
}

export interface DiskObject extends ObjectInfo {
  /** Sections of the view on disk (see viewSections). */
  sections: { key: string; text: string }[];
}

/** Whether every cell of a document still shows the disk text of its section. */
function matchesDisk(nb: vscode.NotebookDocument, obj: DiskObject): boolean {
  const disk = new Map(obj.sections.map(s => [s.key, s.text]));
  return nb.getCells().every(c => {
    const key = cellMeta(c)?.key;
    return !key || disk.get(key) === c.document.getText();
  });
}

/** Other notebook tabs showing the same object view (VS Code can reopen an older revision URI by itself). */
export function objectTabsOf(uri: vscode.Uri): vscode.Tab[] {
  const ref = parseObjectUri(uri);
  if (!ref) return [];
  const k = fileKey(ref.fsPath);
  return vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t =>
    t.input instanceof vscode.TabInputNotebook && t.input.uri.toString() !== uri.toString() && sameObject(t.input.uri, k, ref.objectId, ref.accessor));
}

/** The URI to use for an object view right now, or undefined when a fresh document is needed. */
function reusableUri(fsPath: string, obj: DiskObject, accessor: 'Get' | 'Set' | undefined): vscode.Uri | undefined {
  const objectId = obj.id;
  const k = fileKey(fsPath);
  const gen = generation.get(k) ?? 0;
  const docs = vscode.workspace.notebookDocuments.filter(nb =>
    nb.notebookType === OBJECT_NOTEBOOK && sameObject(nb.uri, k, objectId, accessor));
  const tabs = tabUris().filter(t => sameObject(t.uri, k, objectId, accessor));
  const inTab = (nb: vscode.NotebookDocument) => tabs.some(t => t.uri.toString() === nb.uri.toString());
  // A background document is reused only when it still equals the disk: VS Code's revert ("Don't Save")
  // can leave discarded text in a document that stays alive for minutes after its tab closed.
  const doc = docs.find(nb => nb.isDirty) ?? docs.find(inTab)
    ?? docs.find(nb => openedAt.get(nb.uri.toString()) === gen && matchesDisk(nb, obj));
  if (doc) return doc.uri;
  // A tab restored after a reload whose document is not loaded yet: opening its URI reads the disk.
  const tab = tabs.find(t => t.active) ?? tabs[0];
  return tab?.uri;
}

export async function openObjectDocument(fsPath: string, obj: DiskObject, accessor?: 'Get' | 'Set'): Promise<vscode.NotebookDocument> {
  const k = fileKey(fsPath);
  const key = `${k}|${obj.id}|${accessor ?? ''}`;
  const gen = generation.get(k) ?? 0;
  const reuse = reusableUri(fsPath, obj, accessor);
  if (reuse) {
    const doc = await vscode.workspace.openNotebookDocument(reuse);
    if (!openedAt.has(doc.uri.toString())) openedAt.set(doc.uri.toString(), gen);
    return doc;
  }
  const inFlight = pending.get(key);
  if (inFlight && inFlight.gen === gen) return inFlight.doc;
  const doc = Promise.resolve(vscode.workspace.openNotebookDocument(objectUri(fsPath, obj, nextRevision(), accessor))).then(nb => {
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

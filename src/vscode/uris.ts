// URIs of the virtual documents: one `twincat:` notebook per TwinCAT object
// and `twincat-diff:` snapshots of whole files for git comparisons.

import * as vscode from 'vscode';

export const OBJECT_SCHEME = 'twincat';
export const DIFF_SCHEME = 'twincat-diff';
export const OBJECT_NOTEBOOK = 'twincat-object';
export const DIFF_NOTEBOOK = 'twincat-diff';
export const FILE_NOTEBOOK = 'twincat-file';
export const ST_LANGUAGE = 'twincat-st';

export const SOURCE_EXTENSIONS = ['.tcpou', '.tcdut', '.tcgvl', '.tcio'];

export function isSourcePath(p: string): boolean {
  const lower = p.toLowerCase();
  return SOURCE_EXTENSIONS.some(e => lower.endsWith(e));
}

export function isTwinCatPath(p: string): boolean {
  return isSourcePath(p) || p.toLowerCase().endsWith('.tctto');
}

function safeName(label: string): string {
  return label.replace(/[\\/:*?"<>|#%]/g, '_');
}

export interface ObjectInfo {
  id: string;
  name: string;
  qualifiedName: string;
  folderPath: string[];
}

/**
 * `twincat:/c:/.../FB_X.TcPOU/Methods/States/OnEntry.tcobj?{"label":"FB_X.OnEntry","id":"<guid>"}`:
 * the path mirrors the XAE tree (shown in breadcrumbs), the query carries the tab title and the object id.
 */
export function objectUri(fsPath: string, obj: ObjectInfo, rev?: string): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  const segments = [...obj.folderPath, obj.name].map(safeName).join('/');
  // `rev` makes a fresh document when the object is opened again (see openDocs.ts); it is not part of the identity.
  const query = rev ? { label: obj.qualifiedName, id: obj.id, rev } : { label: obj.qualifiedName, id: obj.id };
  return vscode.Uri.from({
    scheme: OBJECT_SCHEME,
    path: `${filePath}/${segments}.tcobj`,
    query: JSON.stringify(query),
  });
}

export interface ObjectRef {
  fsPath: string;
  objectId: string;
}

export function parseObjectUri(uri: vscode.Uri): ObjectRef | undefined {
  if (uri.scheme !== OBJECT_SCHEME) return undefined;
  let objectId: string | undefined;
  try {
    objectId = JSON.parse(uri.query).id;
  } catch {
    return undefined;
  }
  const segments = uri.path.split('/');
  const fileIndex = segments.findIndex(s => /\.(tcpou|tcdut|tcgvl|tcio)$/i.test(s));
  if (!objectId || fileIndex < 0) return undefined;
  const filePath = segments.slice(0, fileIndex + 1).join('/');
  return { fsPath: vscode.Uri.from({ scheme: 'file', path: filePath }).fsPath, objectId };
}

/** Git ref shown on the left of a comparison, or WORKTREE for the file on disk. */
export const WORKTREE = 'WORKTREE';
export const INDEX = 'INDEX';

/**
 * `twincat-diff:/c:/.../FB_X.TcPOU.tcfile?{"ref":"HEAD","label":"...","against":"INDEX"}`.
 * `against` is the other side of the comparison (decides whether renames are looked up in the index).
 */
export function diffUri(fsPath: string, ref: string, label: string, against?: string): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  const query = against ? { ref, label, against } : { ref, label };
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `${filePath}.tcfile`, query: JSON.stringify(query) });
}

export function parseDiffUri(uri: vscode.Uri): { fsPath: string; ref: string; against?: string } | undefined {
  if (uri.scheme !== DIFF_SCHEME) return undefined;
  let ref = WORKTREE;
  let against: string | undefined;
  try {
    const q = JSON.parse(uri.query);
    ref = q.ref ?? WORKTREE;
    against = q.against;
  } catch {
    // keep defaults
  }
  const filePath = uri.path.replace(/\.tcfile$/, '');
  return { fsPath: vscode.Uri.from({ scheme: 'file', path: filePath }).fsPath, ref, against };
}

/** Real file behind any of our URIs (or a plain file URI). */
export function realPathOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') return uri.fsPath;
  return parseObjectUri(uri)?.fsPath ?? parseDiffUri(uri)?.fsPath;
}

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
export function objectUri(fsPath: string, obj: ObjectInfo): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  const segments = [...obj.folderPath, obj.name].map(safeName).join('/');
  return vscode.Uri.from({
    scheme: OBJECT_SCHEME,
    path: `${filePath}/${segments}.tcobj`,
    query: JSON.stringify({ label: obj.qualifiedName, id: obj.id }),
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

export function diffUri(fsPath: string, ref: string, label: string): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `${filePath}.tcfile`, query: JSON.stringify({ ref, label }) });
}

export function parseDiffUri(uri: vscode.Uri): { fsPath: string; ref: string } | undefined {
  if (uri.scheme !== DIFF_SCHEME) return undefined;
  let ref = WORKTREE;
  try {
    ref = JSON.parse(uri.query).ref ?? WORKTREE;
  } catch {
    // keep default
  }
  const filePath = uri.path.replace(/\.tcfile$/, '');
  return { fsPath: vscode.Uri.from({ scheme: 'file', path: filePath }).fsPath, ref };
}

/** Real file behind any of our URIs (or a plain file URI). */
export function realPathOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') return uri.fsPath;
  return parseObjectUri(uri)?.fsPath ?? parseDiffUri(uri)?.fsPath;
}

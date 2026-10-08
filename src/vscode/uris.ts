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

/** `twincat:/c:/.../FB_X.TcPOU/<object id>/FB_X.Method.tcobj?{"label":"FB_X.Method"}` */
export function objectUri(fsPath: string, objectId: string, label: string): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  return vscode.Uri.from({
    scheme: OBJECT_SCHEME,
    path: `${filePath}/${encodeURIComponent(objectId)}/${safeName(label)}.tcobj`,
    query: JSON.stringify({ label }),
  });
}

export interface ObjectRef {
  fsPath: string;
  objectId: string;
}

export function parseObjectUri(uri: vscode.Uri): ObjectRef | undefined {
  if (uri.scheme !== OBJECT_SCHEME) return undefined;
  const segments = uri.path.split('/');
  if (segments.length < 4) return undefined;
  segments.pop();
  const objectId = decodeURIComponent(segments.pop()!);
  const filePath = segments.join('/');
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

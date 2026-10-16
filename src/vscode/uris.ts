// URIs of the virtual documents: one `twincat:` document per opened TwinCAT
// object (shown in the split editor or as a notebook), `twincat-loc:`
// read-only renderings that point into them, and `twincat-diff:` snapshots of
// whole files for git comparisons.

import * as vscode from 'vscode';
import { Accessor, viewLabel } from '../core/objectText';

export const OBJECT_SCHEME = 'twincat';
export const LOC_SCHEME = 'twincat-loc';
export const DIFF_SCHEME = 'twincat-diff';
export const OBJECT_EDITOR = 'twincatExplorer.objectEditor';
/** Language of the `twincat:` text documents behind the split editor. */
export const OBJECT_LANGUAGE = 'twincat-object';
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
 * the path mirrors the XAE tree (shown in breadcrumbs), the query carries the tab title, the object id
 * and, for the Get or Set accessor of a property, `acc`.
 */
export function objectUri(fsPath: string, obj: ObjectInfo, rev?: string, accessor?: Accessor, scheme = OBJECT_SCHEME): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  const segments = [...obj.folderPath, obj.name, ...(accessor ? [accessor] : [])].map(safeName).join('/');
  // `rev` makes a fresh notebook document when the object is opened again (see openDocs.ts); it is not part of the identity.
  const query: Record<string, string> = { label: viewLabel(obj, accessor), id: obj.id };
  if (accessor) query.acc = accessor;
  if (rev) query.rev = rev;
  return vscode.Uri.from({ scheme, path: `${filePath}/${segments}.tcobj`, query: JSON.stringify(query) });
}

/**
 * Read-only copy of one section of an object view, which opens the split editor at the same place (see
 * locations.ts): `twincat-loc:` with the path of the object and `sec` (the section key) in the query.
 */
export function locUri(fsPath: string, obj: ObjectInfo, accessor: Accessor | undefined, sectionKey: string, sectionLabel: string): vscode.Uri {
  return locUriOf(objectUri(fsPath, obj, undefined, accessor), sectionKey, sectionLabel);
}

/** The twincat-loc URI of a section of the object view behind a `twincat:` URI. */
export function locUriOf(objectDocUri: vscode.Uri, sectionKey: string, sectionLabel: string): vscode.Uri {
  let q: Record<string, string> = {};
  try {
    q = JSON.parse(objectDocUri.query);
  } catch {
    // keep empty
  }
  const query: Record<string, string> = { label: `${q.label ?? ''} · ${sectionLabel}`, id: q.id ?? '' };
  if (q.acc) query.acc = q.acc;
  query.sec = sectionKey;
  return objectDocUri.with({ scheme: LOC_SCHEME, query: JSON.stringify(query) });
}

export interface ObjectRef {
  fsPath: string;
  objectId: string;
  accessor?: Accessor;
  /** Section key, for twincat-loc URIs. */
  section?: string;
}

export function parseObjectUri(uri: vscode.Uri, scheme = OBJECT_SCHEME): ObjectRef | undefined {
  if (uri.scheme !== scheme) return undefined;
  let objectId: string | undefined;
  let accessor: Accessor | undefined;
  let section: string | undefined;
  try {
    const q = JSON.parse(uri.query);
    objectId = q.id;
    if (q.acc === 'Get' || q.acc === 'Set') accessor = q.acc;
    if (typeof q.sec === 'string') section = q.sec;
  } catch {
    return undefined;
  }
  const segments = uri.path.split('/');
  const fileIndex = segments.findIndex(s => /\.(tcpou|tcdut|tcgvl|tcio)$/i.test(s));
  if (!objectId || fileIndex < 0) return undefined;
  const filePath = segments.slice(0, fileIndex + 1).join('/');
  const ref: ObjectRef = { fsPath: vscode.Uri.from({ scheme: 'file', path: filePath }).fsPath, objectId, accessor };
  if (section !== undefined) ref.section = section;
  return ref;
}

export function parseLocUri(uri: vscode.Uri): ObjectRef | undefined {
  return parseObjectUri(uri, LOC_SCHEME);
}

/** Identity of an object view: real file, object and accessor (not the revision). */
export function viewKey(ref: ObjectRef, fileKeyOf: (p: string) => string): string {
  return `${fileKeyOf(ref.fsPath)}|${ref.objectId}|${ref.accessor ?? ''}`;
}

/** Git ref shown on the left of a comparison, or WORKTREE for the file on disk. */
export const WORKTREE = 'WORKTREE';
export const INDEX = 'INDEX';

/**
 * `twincat-diff:/c:/.../FB_X.TcPOU.tcfile?{"ref":"HEAD","label":"...","against":"INDEX"}`.
 * `against` is the other side of the comparison (decides whether renames are looked up in the index);
 * `at` is the repository-relative path of the file at `ref` when it is known (a commit's file), so no
 * rename has to be looked up.
 */
export function diffUri(fsPath: string, ref: string, label: string, against?: string, at?: string): vscode.Uri {
  const filePath = vscode.Uri.file(fsPath).path;
  const query: Record<string, string> = { ref, label };
  if (against) query.against = against;
  if (at) query.at = at;
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `${filePath}.tcfile`, query: JSON.stringify(query) });
}

export function parseDiffUri(uri: vscode.Uri): { fsPath: string; ref: string; against?: string; at?: string } | undefined {
  if (uri.scheme !== DIFF_SCHEME) return undefined;
  let ref = WORKTREE;
  let against: string | undefined;
  let at: string | undefined;
  try {
    const q = JSON.parse(uri.query);
    ref = q.ref ?? WORKTREE;
    against = q.against;
    if (typeof q.at === 'string') at = q.at;
  } catch {
    // keep defaults
  }
  const filePath = uri.path.replace(/\.tcfile$/, '');
  return { fsPath: vscode.Uri.from({ scheme: 'file', path: filePath }).fsPath, ref, against, at };
}

/** Real file behind any of our URIs (or a plain file URI). */
export function realPathOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') return uri.fsPath;
  return parseObjectUri(uri)?.fsPath ?? parseLocUri(uri)?.fsPath ?? parseDiffUri(uri)?.fsPath;
}

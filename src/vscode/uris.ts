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
export const OBJECT_NOTEBOOK = 'twincat-object';
export const DIFF_NOTEBOOK = 'twincat-diff';
export const FILE_NOTEBOOK = 'twincat-file';
export const ST_LANGUAGE = 'twincat-st';

// The workspace's files are `file:` URIs on the desktop. In the browser (vscode.dev) they are those of the
// workspace folders (`vscode-vfs:` for a GitHub repository) and their paths come from the URIs' fsPath.
let fileSchemes: ReadonlySet<string> = new Set(['file']);
let uriOfPath: (fsPath: string) => vscode.Uri | undefined = () => undefined;

/**
 * The place of a source file in the TwinCAT tree, for the breadcrumbs of its objects: `['Machine', 'Plc', 'POUs',
 * 'Valves']` (TwinCAT project, PLC project, folders), or undefined for a file no project holds.
 */
let xaeFolderOf: (fsPath: string) => string[] | undefined = () => undefined;

/** Sets how object URIs find the place of their file in the TwinCAT tree (see objectUri). */
export function useXaeFolders(of: (fsPath: string) => string[] | undefined): void {
  xaeFolderOf = of;
}

/** Makes the URIs of other schemes count as the workspace's files (see web/extension.ts). */
export function useFileUris(schemes: Iterable<string>, toUri: (fsPath: string) => vscode.Uri | undefined): void {
  fileSchemes = new Set(['file', ...schemes]);
  uriOfPath = toUri;
}

/** True for the URI of a file of the workspace (not one of our virtual documents, nor a git: URI). */
export function isFileUri(uri: vscode.Uri): boolean {
  return fileSchemes.has(uri.scheme);
}

/** The URI of a file of the workspace, or of the extension, from its path. */
export function fileUri(fsPath: string): vscode.Uri {
  return uriOfPath(fsPath) ?? vscode.Uri.file(fsPath);
}

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
 * `twincat:/Machine/Plc/POUs/FB_X/Methods/States/OnEntry.tcobj?{"label":"FB_X.OnEntry","id":"<guid>","file":"/c:/.../FB_X.TcPOU"}`:
 * the path is the object's place in the TwinCAT tree, which the breadcrumbs show (TwinCAT project, PLC project,
 * folders, the POU, its folders, the object); the object at the top of its file ends the path itself
 * (`.../POUs/FB_X.tcobj`). The query carries the tab title, the object id, the path of the file (`file`) and, for
 * the Get or Set accessor of a property, `acc`. A file no project holds keeps its file path in the URI's path.
 */
export function objectUri(fsPath: string, obj: ObjectInfo, rev?: string, accessor?: Accessor): vscode.Uri {
  const file = vscode.Uri.file(fsPath);
  const top = obj.folderPath.length === 0 && obj.qualifiedName === obj.name;
  const xae = xaeFolderOf(fsPath);
  const fileStem = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  const segments = xae
    ? [...xae, ...(top ? [] : [fileStem, ...obj.folderPath]), obj.name, ...(accessor ? [accessor] : [])]
    : [...obj.folderPath, obj.name, ...(accessor ? [accessor] : [])];
  // `rev` makes a fresh notebook document when the object is opened again (see openDocs.ts); it is not part of the identity.
  const query: Record<string, string> = { label: viewLabel(obj, accessor), id: obj.id, file: file.path };
  if (accessor) query.acc = accessor;
  if (rev) query.rev = rev;
  const base = xae ? '' : file.path;
  // The authority is the server of a UNC path (\\server\share\...).
  return vscode.Uri.from({
    scheme: OBJECT_SCHEME, authority: file.authority, path: `${base}/${segments.map(safeName).join('/')}.tcobj`, query: JSON.stringify(query),
  });
}

/** The file behind one of our URIs: the path up to `filePath`, on the server of a UNC path. */
function fileUnder(uri: vscode.Uri, filePath: string): string {
  return vscode.Uri.from({ scheme: 'file', authority: uri.authority, path: filePath }).fsPath;
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
  if (q.file) query.file = q.file;
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
  let file: string | undefined;
  try {
    const q = JSON.parse(uri.query);
    objectId = q.id;
    if (typeof q.file === 'string') file = q.file;
    if (q.acc === 'Get' || q.acc === 'Set') accessor = q.acc;
    if (typeof q.sec === 'string') section = q.sec;
  } catch {
    return undefined;
  }
  if (!objectId) return undefined;
  // URIs made before the file went into the query (tabs restored from then) have it at the start of their path.
  let filePath = file;
  if (filePath === undefined) {
    const segments = uri.path.split('/');
    const fileIndex = segments.findIndex(isSourcePath);
    if (fileIndex < 0) return undefined;
    filePath = segments.slice(0, fileIndex + 1).join('/');
  }
  const ref: ObjectRef = { fsPath: fileUnder(uri, filePath), objectId, accessor };
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
/** An empty file: the missing side of a file a commit added or deleted (no ref name has a colon). */
export const EMPTY = ':empty';

/**
 * `twincat-diff:/c:/.../FB_X.TcPOU.tcfile?{"ref":"HEAD","label":"...","against":"INDEX"}`.
 * `against` is the other side of the comparison (decides whether renames are looked up in the index);
 * `at` is the repository-relative path of the file at `ref` when it is known (a commit's file), so no
 * rename has to be looked up.
 */
export function diffUri(fsPath: string, ref: string, label: string, against?: string, at?: string): vscode.Uri {
  const file = vscode.Uri.file(fsPath);
  const query: Record<string, string> = { ref, label };
  if (against) query.against = against;
  if (at) query.at = at;
  return vscode.Uri.from({ scheme: DIFF_SCHEME, authority: file.authority, path: `${file.path}.tcfile`, query: JSON.stringify(query) });
}

/**
 * `twincat-diff:` URI of a file as it is at `ref`, at its repository-relative path `at` there. Without `.tcfile`
 * it opens as read-only text, not as a notebook.
 */
export function revisionUri(fsPath: string, ref: string, label: string, at: string): vscode.Uri {
  const file = vscode.Uri.file(fsPath);
  return vscode.Uri.from({ scheme: DIFF_SCHEME, authority: file.authority, path: file.path, query: JSON.stringify({ ref, label, at }) });
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
  return { fsPath: fileUnder(uri, uri.path.replace(/\.tcfile$/, '')), ref, against, at };
}

/** Real file behind any of our URIs (or a plain file URI). */
export function realPathOf(uri: vscode.Uri): string | undefined {
  if (isFileUri(uri)) return uri.fsPath;
  return parseObjectUri(uri)?.fsPath ?? parseLocUri(uri)?.fsPath ?? parseDiffUri(uri)?.fsPath;
}

// The XAE-like tree of a pull request's TwinCAT changes: the folders of the changed files; each file as its POU,
// DUT, GVL or interface; under it the methods, properties and their Get/Set, actions and transitions that
// changed, in the folders TwinCAT keeps inside a POU. Sorted as in XAE's Solution Explorer (folders first, then by
// name), or the folders and files in the order of the host's page beside it, when it is given; files without code
// changes go to groups of their own, as in the VS Code extension's TwinCAT Changes view. The change's other files are
// there too, by their names, so that the tab lists all its files, as the host's own tree does. Platform-free.

import { Accessor } from '../../src/core/objectText';
import { accessorIconName, compareLabels, objectIconName, objectTreeLabel } from '../../src/core/treeLabels';
import { FileView, ObjectView, PROJECT_FILE } from './model';

export type NodeChange = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TreeFile {
  /** Path at the head (for a deleted file: at the base), and at the base when renamed. */
  path: string;
  oldPath?: string;
  /** A file that is not TwinCAT's, not read: its change, from the list of the change's files. */
  other?: NodeChange;
  /** Undefined while the file is being read. */
  view?: FileView;
  error?: string;
  /** The review threads on the file: under the lines of each object view (by its index), and in all. */
  comments?: { perObject: number[]; total: number };
}

export interface TreeNode {
  /** Stable across rebuilds: the tree keeps what is expanded by it. */
  id: string;
  kind: 'folder' | 'file' | 'innerFolder' | 'object' | 'accessor' | 'group';
  label: string;
  /** One of the extension's icons (media/icons), none for a group. */
  icon?: string;
  change?: NodeChange;
  description?: string;
  tooltip?: string;
  /** Where a click goes: the file (its path), and an object view in its TwinCAT view. */
  file?: string;
  objectId?: string;
  accessor?: Accessor;
  /** It did not change, what is under it did (a property whose Get changed). */
  muted?: boolean;
  /** Review threads: under the object's lines, or on the whole file. */
  comments?: number;
  children: TreeNode[];
}

const BUILD_OUTPUT = 'Build output (no code changes)';

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** `renamed from FB_Old.TcPOU` in the same folder, else `moved from POUs/Old`. */
function moved(path: string, oldPath: string): string {
  return dirName(path) === dirName(oldPath) ? `renamed from ${baseName(oldPath)}` : `moved from ${dirName(oldPath) || '/'}`;
}

function getOrAdd(parent: TreeNode, id: string, make: () => Omit<TreeNode, 'id' | 'children'>): TreeNode {
  let node = parent.children.find(c => c.id === id);
  if (!node) {
    node = { id, children: [], ...make() };
    parent.children.push(node);
  }
  return node;
}

function addMember(file: TreeNode, path: string, o: ObjectView, comments: number | undefined): void {
  let parent = file;
  o.folderPath.forEach((name, i) => {
    parent = getOrAdd(parent, `ifolder:${path}|${o.folderPath.slice(0, i + 1).join('\\')}`, () => ({
      kind: 'innerFolder', label: name, icon: 'folder',
    }));
  });
  const words = o.renamedFrom ? `renamed from ${o.renamedFrom}` : undefined;
  if (o.accessor) {
    // Under its property, which is in the tree for it when the property itself did not change.
    const property = getOrAdd(parent, `obj:${path}|${o.objectId}`, () => ({
      kind: 'object', label: o.name, icon: 'property', file: path, objectId: o.objectId, muted: true, tooltip: o.label.slice(0, -4),
    }));
    property.children.push({
      id: `acc:${path}|${o.objectId}|${o.accessor}`, kind: 'accessor', label: o.accessor, icon: accessorIconName(o.accessor),
      change: o.change === 'unchanged' ? undefined : o.change, file: path, objectId: o.objectId, accessor: o.accessor,
      tooltip: `${o.label} (${o.change})`, comments: comments || undefined, children: [],
    });
    return;
  }
  const node = getOrAdd(parent, `obj:${path}|${o.objectId}`, () => ({
    kind: 'object', label: o.name, icon: objectIconName(o), file: path, objectId: o.objectId,
  }));
  Object.assign(node, {
    muted: false, change: o.change === 'unchanged' ? undefined : o.change, description: words, tooltip: `${o.label} (${o.change})`, comments: comments || undefined,
  });
}

/** A file that is not TwinCAT's: its name and its change, as in the host's tree. */
function otherNode(f: TreeFile): TreeNode {
  return {
    id: `file:${f.path}`, kind: 'file', label: baseName(f.path), icon: 'file', file: f.path, change: f.other,
    description: f.oldPath ? moved(f.path, f.oldPath) : undefined, tooltip: f.oldPath ? `${f.path}\nRenamed from ${f.oldPath}` : f.path,
    comments: f.comments?.total || undefined, children: [],
  };
}

function fileNode(f: TreeFile): TreeNode {
  if (f.other) return otherNode(f);
  const v = f.view;
  const root = v?.root;
  const node: TreeNode = {
    id: `file:${f.path}`, kind: 'file', label: root ? objectTreeLabel(root) : baseName(f.path).replace(/\.[^.]+$/, ''),
    icon: root ? objectIconName(root) : 'file', file: f.path, objectId: root?.id,
    tooltip: f.oldPath ? `${f.path}\nRenamed from ${f.oldPath}` : f.path, comments: f.comments?.total || undefined, children: [],
  };
  if (!v) {
    node.description = f.error ?? 'reading…';
    return node;
  }
  if (v.error || v.note) {
    node.description = v.error ?? v.note;
    return node;
  }
  const own = v.objects.find(o => o.depth === 0);
  // The object's new name says the file's too; a move to another folder is told as well.
  const words: string[] = [];
  if (own?.renamedFrom) words.push(`renamed from ${own.renamedFrom}`);
  if (f.oldPath && (!own?.renamedFrom || dirName(f.path) !== dirName(f.oldPath))) words.push(moved(f.path, f.oldPath));
  node.description = words.join(' · ') || undefined;
  node.change = v.change !== 'modified' ? v.change : own && own.change !== 'unchanged' ? 'modified' : f.oldPath ? 'renamed' : undefined;
  v.objects.forEach((o, i) => {
    if (o.depth > 0 && o.change !== 'unchanged') addMember(node, f.path, o, f.comments?.perObject[i]);
  });
  return node;
}

/** One level of folders made of a chain of single folders (`TcUnit/TcUnit/POUs`), as GitHub's tree shows them. */
function compress(node: TreeNode): void {
  for (const c of node.children) {
    while (c.kind === 'folder' && c.children.length === 1 && c.children[0].kind === 'folder') {
      const only = c.children[0];
      c.label = `${c.label}/${only.label}`;
      c.id = only.id;
      c.children = only.children;
    }
    compress(c);
  }
}

/**
 * Sorts as XAE does; the folders and files, when `paths` is given, by the first path in them in that order: the
 * host's order of its files, where a folder's files come one after the other.
 */
function sort(node: TreeNode, paths?: (a: string, b: string) => number): void {
  const rank = (n: TreeNode) => (n.kind === 'folder' || n.kind === 'innerFolder' ? 0 : 1);
  const first = (n: TreeNode): string | undefined => {
    if (n.kind === 'file') return n.file;
    if (n.kind !== 'folder') return undefined;
    return n.children.map(first).filter((p): p is string => p !== undefined).sort(paths)[0];
  };
  const byPath = (a: TreeNode, b: TreeNode) => {
    const x = paths && first(a);
    const y = paths && first(b);
    return x !== undefined && y !== undefined ? paths!(x, y) : undefined;
  };
  node.children.sort((a, b) => byPath(a, b) ?? (rank(a) - rank(b) || compareLabels(a.label, b.label)));
  for (const c of node.children) sort(c, paths);
}

/** The tree of the files; `paths`, the host's order of its files, for the order of the folders and files. */
export function buildTree(files: TreeFile[], paths?: (a: string, b: string) => number): TreeNode[] {
  const top: TreeNode = { id: 'folder:', kind: 'folder', label: '', children: [] };
  const build: TreeNode[] = [];
  const projects: TreeNode[] = [];
  for (const f of files) {
    const v = f.view;
    if (v && PROJECT_FILE.test(f.path)) {
      const icon = /\.tsproj$/i.test(f.path) ? 'twincat-project' : 'plc-project';
      const node: TreeNode = {
        id: `file:${f.path}`, kind: 'file', label: baseName(f.path), icon, file: f.path, tooltip: f.path, children: [],
        description: v.metadataOnly ?? (v.change === 'modified' ? 'changed' : v.change), change: v.change, comments: f.comments?.total || undefined,
      };
      (v.metadataOnly ? build : projects).push(node);
      continue;
    }
    // No code changed and not moved: build output (a ProductVersion, the XML of a save).
    if (v?.metadataOnly && !f.oldPath) {
      build.push({ ...fileNode(f), description: v.metadataOnly, change: 'modified', children: [] });
      continue;
    }
    let parent = top;
    const dirs = dirName(f.path).split('/').filter(d => d.length > 0);
    dirs.forEach((d, i) => {
      parent = getOrAdd(parent, `folder:${dirs.slice(0, i + 1).join('/')}`, () => ({ kind: 'folder', label: d, icon: 'folder' }));
    });
    parent.children.push(fileNode(f));
  }
  compress(top);
  sort(top, paths);
  const groups = [[BUILD_OUTPUT, build], ['Project files', projects]] as const;
  const out = [...top.children];
  for (const [label, children] of groups) {
    if (children.length === 0) continue;
    const group: TreeNode = { id: `group:${label}`, kind: 'group', label, description: String(children.length), children: [...children] };
    sort(group, paths);
    out.push(group);
  }
  return out;
}

/** Counts for the panel's title: changed files (all of them) and object views, TwinCAT files still being read. */
export function treeSummary(files: TreeFile[]): { files: number; objects: number; reading: number } {
  let objects = 0;
  let reading = 0;
  for (const f of files) {
    if (!f.view && !f.error && !f.other) reading++;
    objects += f.view?.objects.filter(o => o.change !== 'unchanged').length ?? 0;
  }
  return { files: files.length, objects, reading };
}

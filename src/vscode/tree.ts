// The TwinCAT tree in the Explorer: TwinCAT projects (.tsproj) > PLC projects >
// References and the folders/objects of the .plcproj > methods, properties and
// the folders TwinCAT keeps inside a POU.

import * as path from 'path';
import * as vscode from 'vscode';
import { TcWorkspace, fileKey } from '../core/workspace';
import { Accessor } from '../core/objectText';
import { InnerFolder, ObjectKind, TcObject, TcSourceFile } from '../core/tcfile';
import { PlcProject, TsProject, resolutionLibraryName } from '../core/project';
import { isSourcePath, objectUri } from './uris';

export type NodeKind = 'tsproj' | 'plcproj' | 'references' | 'library' | 'folder' | 'file' | 'innerFolder' | 'object' | 'accessor';

export class TreeNode {
  /** The .tsproj node this node belongs to. */
  get root(): TreeNode {
    let n: TreeNode = this;
    while (n.parent) n = n.parent;
    return n;
  }

  children: TreeNode[] = [];
  description?: string;
  tooltip?: string;
  fsPath?: string;
  objectId?: string;
  accessor?: Accessor;
  icon?: vscode.ThemeIcon;
  /** URI of the object view of a member or accessor node, which carries its git decoration (see GitChanges). */
  resourceUri?: vscode.Uri;
  openable = false;
  /** Name used by "Copy Name". */
  name?: string;
  sortGroup = 1;

  constructor(readonly id: string, readonly kind: NodeKind, public label: string, readonly parent: TreeNode | undefined) {}

  get contextValue(): string {
    const parts: string[] = [this.kind];
    if (this.openable) parts.push('openable');
    if (this.fsPath) parts.push('hasFile');
    if (this.kind === 'file' && this.fsPath && isSourcePath(this.fsPath)) parts.push('stFile');
    if (this.name) parts.push('named');
    return parts.join(' ');
  }
}

function icon(id: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

export function objectIcon(obj: TcObject): vscode.ThemeIcon {
  switch (obj.kind) {
    case 'pou':
      if (obj.pouKind === 'PRG') return icon('symbol-module', 'symbolIcon.moduleForeground');
      if (obj.pouKind === 'FUN') return icon('symbol-function', 'symbolIcon.functionForeground');
      return icon('symbol-class', 'symbolIcon.classForeground');
    case 'itf': return icon('symbol-interface', 'symbolIcon.interfaceForeground');
    case 'dut':
      if (obj.dutKind === 'enum') return icon('symbol-enum', 'symbolIcon.enumeratorForeground');
      if (obj.dutKind === 'alias') return icon('symbol-type-parameter', 'symbolIcon.typeParameterForeground');
      return icon('symbol-structure', 'symbolIcon.structForeground');
    case 'gvl': return icon('symbol-variable', 'symbolIcon.variableForeground');
    case 'method': return icon('symbol-method', 'symbolIcon.methodForeground');
    case 'property': return icon('symbol-property', 'symbolIcon.propertyForeground');
    case 'action': return icon('symbol-event', 'symbolIcon.eventForeground');
    case 'transition': return icon('arrow-swap', 'symbolIcon.eventForeground');
  }
}

/** Icon of a property's Get or Set accessor. */
export function accessorIcon(accessor: Accessor): vscode.ThemeIcon {
  return icon(accessor === 'Get' ? 'arrow-small-left' : 'arrow-small-right', 'symbolIcon.methodForeground');
}

/** Icon of an object view; for an object that is not there (deleted since), the icon of its kind. */
export function viewIcon(obj: TcObject | undefined, kind: ObjectKind, accessor?: Accessor): vscode.ThemeIcon {
  if (accessor) return accessorIcon(accessor);
  return objectIcon(obj ?? ({ kind } as TcObject));
}

/** What the views call each kind of object. */
export const KIND_WORD: Record<ObjectKind, string> = {
  pou: 'POU', method: 'Method', property: 'Property', action: 'Action', transition: 'Transition',
  dut: 'DUT', gvl: 'GVL', itf: 'Interface',
};

/** Compares labels for sorting: case and accents aside, like `localeCompare` with base sensitivity. */
export const compareLabels = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

/** Label as XAE shows it: `MAIN (PRG)`, `FB_X (FB)`, `F_Y (FUN)`. */
export function objectTreeLabel(obj: TcObject): string {
  if (obj.kind === 'pou' && obj.pouKind) return `${obj.name} (${obj.pouKind})`;
  return obj.name;
}

export class TwinCatTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: TreeNode[] = [];
  /** Every node per object and per file: a PLC project shared by two .tsproj files appears twice. */
  private readonly byObject = new Map<string, TreeNode[]>();
  private readonly byFile = new Map<string, TreeNode[]>();
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ws: TcWorkspace) {}

  rebuild(): void {
    this.byObject.clear();
    this.byFile.clear();
    this.roots = this.ws.tsProjects.map(ts => this.buildTsProject(ts));
    this.emitter.fire(undefined);
  }

  scheduleRebuild(delay = 300): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.rebuild();
    }, delay);
  }

  private add(node: TreeNode): TreeNode {
    node.parent?.children.push(node);
    return node;
  }

  private buildTsProject(ts: TsProject): TreeNode {
    const tsKey = fileKey(ts.path);
    const root = this.add(new TreeNode(`ts:${tsKey}`, 'tsproj', ts.name, undefined));
    root.fsPath = ts.path;
    root.icon = icon('project');
    root.tooltip = ts.path;
    for (const ref of ts.plcProjects) {
      const plc = this.ws.plcProject(ref.plcprojPath);
      if (plc) {
        this.buildPlcProject(root, plc, tsKey);
        continue;
      }
      const error = this.ws.failedPlc.get(fileKey(ref.plcprojPath));
      const failed = this.add(new TreeNode(`plc:${tsKey}|${fileKey(ref.plcprojPath)}`, 'plcproj', ref.name, root));
      failed.fsPath = ref.plcprojPath;
      failed.icon = icon('warning', 'problemsWarningIcon.foreground');
      failed.description = error ? 'could not be loaded' : 'not found';
      failed.tooltip = `${ref.plcprojPath}
${error ?? 'The .plcproj file does not exist.'}`;
    }
    return root;
  }

  private buildPlcProject(parent: TreeNode, plc: PlcProject, tsKey: string): void {
    const prefix = `${tsKey}|${fileKey(plc.path)}`;
    const node = this.add(new TreeNode(`plc:${prefix}`, 'plcproj', plc.name, parent));
    node.fsPath = plc.path;
    node.icon = icon('circuit-board');
    node.tooltip = plc.path;
    node.description = 'PLC project';

    const refs = this.add(new TreeNode(`refs:${prefix}`, 'references', 'References', node));
    refs.icon = icon('references');
    refs.sortGroup = 0;
    for (const lib of [...plc.libraries].sort((a, b) => a.name.localeCompare(b.name))) {
      const l = this.add(new TreeNode(`lib:${prefix}|${lib.name}`, 'library', lib.name, refs));
      l.icon = icon('library');
      const resolved = resolutionLibraryName(lib);
      l.description = lib.resolution ?? '';
      l.tooltip = `${lib.include}${resolved !== lib.name ? `\nResolves to ${resolved}` : ''}\nNamespace: ${lib.namespace}`;
      l.name = lib.name;
    }

    const folders = new Map<string, TreeNode>();
    const ensureFolder = (rel: string): TreeNode => {
      if (!rel) return node;
      const key = rel.toLowerCase();
      const existing = folders.get(key);
      if (existing) return existing;
      const parentRel = rel.includes('\\') ? rel.slice(0, rel.lastIndexOf('\\')) : '';
      const parentNode = ensureFolder(parentRel);
      const f = this.add(new TreeNode(`folder:${prefix}|${key}`, 'folder', rel.slice(rel.lastIndexOf('\\') + 1), parentNode));
      f.icon = vscode.ThemeIcon.Folder;
      f.sortGroup = 1;
      f.name = f.label;
      folders.set(key, f);
      return f;
    };
    for (const folder of plc.folders) ensureFolder(folder);
    for (const include of plc.compile) {
      const dir = include.includes('\\') ? include.slice(0, include.lastIndexOf('\\')) : '';
      const parentNode = ensureFolder(dir);
      this.buildFile(parentNode, path.join(plc.dir, include.replace(/\\/g, path.sep)), prefix);
    }
    this.sortTree(node, vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('foldersFirst', true));
  }

  private buildFile(parent: TreeNode, fsPath: string, prefix: string): void {
    const fk = fileKey(fsPath);
    const file = this.ws.getFile(fsPath);
    const root = file?.root;
    const node = this.add(new TreeNode(`file:${prefix}|${fk}`, 'file', root ? objectTreeLabel(root) : path.basename(fsPath), parent));
    node.fsPath = fsPath;
    node.sortGroup = 2;
    node.tooltip = fsPath;
    this.byFile.set(fk, [...(this.byFile.get(fk) ?? []), node]);
    if (!file || !root) {
      node.icon = file?.fileKind === 'task' ? icon('watch') : icon('file');
      node.name = path.basename(fsPath, path.extname(fsPath));
      node.label = file?.error ? `${node.label}` : node.name;
      if (file?.error) node.description = 'unreadable';
      return;
    }
    node.objectId = root.id;
    node.openable = true;
    node.icon = objectIcon(root);
    node.name = root.name;
    this.indexObject(file, root, node);
    if (root.members.length === 0) return;
    const inner = new Map<string, TreeNode>();
    const ensureInner = (folderPath: string[]): TreeNode => {
      if (folderPath.length === 0) return node;
      const key = folderPath.join('\\').toLowerCase();
      const existing = inner.get(key);
      if (existing) return existing;
      const p = ensureInner(folderPath.slice(0, -1));
      const f = this.add(new TreeNode(`ifolder:${prefix}|${fk}|${key}`, 'innerFolder', folderPath[folderPath.length - 1], p));
      f.icon = vscode.ThemeIcon.Folder;
      f.sortGroup = 1;
      inner.set(key, f);
      return f;
    };
    const walk = (folders: InnerFolder[]) => {
      for (const f of folders) {
        ensureInner(f.path);
        walk(f.children);
      }
    };
    walk(root.innerFolders);
    for (const m of root.members) {
      const p = ensureInner(m.folderPath);
      const mn = this.add(new TreeNode(`obj:${prefix}|${fk}|${m.id}`, 'object', m.name, p));
      mn.fsPath = fsPath;
      mn.objectId = m.id;
      mn.openable = true;
      mn.icon = objectIcon(m);
      mn.name = m.name;
      mn.sortGroup = 2;
      mn.tooltip = `${m.qualifiedName} (${m.kind})`;
      mn.resourceUri = objectUri(fsPath, m);
      this.indexObject(file, m, mn);
      for (const acc of m.accessors) {
        const an = this.add(new TreeNode(`acc:${prefix}|${fk}|${m.id}|${acc.kind}`, 'accessor', acc.kind, mn));
        an.fsPath = fsPath;
        an.objectId = m.id;
        an.accessor = acc.kind;
        an.openable = true;
        an.icon = accessorIcon(acc.kind);
        an.sortGroup = 2;
        an.tooltip = `${m.qualifiedName}.${acc.kind}`;
        an.resourceUri = objectUri(fsPath, m, undefined, acc.kind);
      }
    }
  }

  private indexObject(file: TcSourceFile, obj: TcObject, node: TreeNode): void {
    const key = `${fileKey(file.path)}|${obj.id}`;
    this.byObject.set(key, [...(this.byObject.get(key) ?? []), node]);
  }

  private sortTree(node: TreeNode, foldersFirst: boolean): void {
    // References first, then (optionally) folders, then objects; alphabetical within a group.
    const rank = (n: TreeNode) => (n.sortGroup === 0 ? 0 : foldersFirst ? n.sortGroup : 1);
    node.children.sort((a, b) => rank(a) - rank(b) || compareLabels(a.label, b.label));
    for (const c of node.children) this.sortTree(c, foldersFirst);
  }

  // ------------------------------------------------------------------ TreeDataProvider

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible = node.children.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : node.kind === 'tsproj' || node.kind === 'plcproj'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    item.iconPath = node.icon;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    // A file keeps its file URI (the git extension colors it); members get their object URI (GitChanges marks them).
    if (node.kind === 'file' && node.fsPath) item.resourceUri = vscode.Uri.file(node.fsPath);
    else if (node.resourceUri) item.resourceUri = node.resourceUri;
    if (node.openable) {
      item.command = { command: 'twincatExplorer.open', title: 'Open', arguments: [node] };
    } else if (node.kind === 'file' && node.fsPath) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.fsPath), { preview: true }] };
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? node.children : this.roots;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.parent;
  }

  // ------------------------------------------------------------------ lookups

  nodesForObject(fsPath: string, objectId: string): TreeNode[] {
    return this.byObject.get(`${fileKey(fsPath)}|${objectId}`) ?? [];
  }

  nodesForFile(fsPath: string): TreeNode[] {
    return this.byFile.get(fileKey(fsPath)) ?? [];
  }

  get rootNodes(): TreeNode[] {
    return this.roots;
  }
}

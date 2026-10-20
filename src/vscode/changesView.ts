// The TwinCAT Changes view in the Source Control sidebar: the object views (POUs, methods, properties,
// accessors) that differ from HEAD, or from where the branch left another one (what a merge request shows),
// grouped by file, and apart from them the files that changed without code (build output). The uncommitted
// changes are in two lists, as in Source Control: Staged Changes (HEAD ↔ index) and Changes (index ↔ working
// tree). A click shows the changes in the split editor; objects and files are staged and unstaged one by one or
// all at once, and the changes not staged can be discarded per object or per file.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ViewChange, metadataChange, onlyTmcHashChanged, viewChanges } from '../core/objectChanges';
import { viewSections } from '../core/objectText';
import { SpliceError } from '../core/splice';
import { FileToStage, discardFiles, discardView, indexEntry, repoPath, stageFiles, stageView, unstageFiles, unstageView } from '../core/staging';
import { TcObject } from '../core/tcfile';
import { TcWorkspace, fileKey } from '../core/workspace';
import type { CommitObject } from './commitDiff';
import { PathChange, changesSince, headCommit, indexChanges, mergeBase, openNotebookDiff, readBlobs, revision, runGit, showAtRef } from './git';
import { CommitFile, GitChanges } from './gitChanges';
import { CompareBase, HEAD_BASE, INDEX_BASE } from './objectEditor';
import { hasUnsavedEdits } from './openDocs';
import { KIND_WORD, TreeIcon, compareLabels, objectIcon, objectTreeLabel, projectFileIcon, viewIcon } from './tree';
import { INDEX, SOURCE_EXTENSIONS, ST_LANGUAGE, isSourcePath, revisionUri } from './uris';

export type ChangesScope = { kind: 'head' } | { kind: 'branch'; ref: string };
/** The two lists of the uncommitted scope: staged (HEAD ↔ index), and not staged (index ↔ working tree). */
export type Group = 'staged' | 'changes';

/** The files the view lists: TwinCAT sources and project files. */
const EXTENSIONS = [...SOURCE_EXTENSIONS, '.tsproj', '.plcproj', '.xti'];

export const CHANGE_SCHEME = 'twincat-change';
/** Read-only text of an object view at a commit or in the index (a deleted method, ...). */
export const BASE_SCHEME = 'twincat-base';
const SCOPE_KEY = 'twincatExplorer.changesScope';

/** The status letter of a changed file or object view (A, D, M, R; U for a file with a merge conflict). */
export type Status = PathChange['status'] | 'U';

/** The URI that gives a node its status letter and color (provideFileDecoration); `name` keeps a file's icon. */
export function statusUri(id: string, status: Status, name = ''): vscode.Uri {
  return vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${encodeURIComponent(id)}${name}`, query: status });
}

/** The status letter of a changed object view. */
export function changeLetter(change: ViewChange['change']): Status {
  return change === 'added' ? 'A' : change === 'deleted' ? 'D' : 'M';
}

/**
 * A changed object view as the Changes, Commits and History views show it under its file: its name without the
 * root object's (`Run` for `FB_X.Run`), its status and icon, `Get accessor` or its kind (and a rename), a tooltip.
 */
export function viewChangeItem(v: ViewChange, obj: TcObject | undefined, rootName: string | undefined):
  { label: string; status: Status; icon: TreeIcon; description: string; tooltip: string } {
  const words = [v.accessor ? `${v.accessor} accessor` : KIND_WORD[v.kind]];
  if (v.renamedFrom) words.push(`renamed from ${v.renamedFrom}`);
  return {
    label: rootName && v.label.startsWith(`${rootName}.`) ? v.label.slice(rootName.length + 1) : v.label,
    status: changeLetter(v.change),
    icon: viewIcon(obj, v.kind, v.accessor),
    description: words.join(' · '),
    tooltip: `${v.label} (${v.change})`,
  };
}

export class ChangeNode {
  children: ChangeNode[] = [];
  description?: string;
  tooltip?: string;
  icon?: TreeIcon;
  status?: Status;
  /** The file (for a deleted file: where it was). */
  fsPath?: string;
  /** Repository of the file. */
  root?: string;
  /** The commit compared with, and the file's repository-relative path there when it was renamed. */
  base?: string;
  from?: string;
  /** The changed object view of a view node. */
  view?: ViewChange;
  /** The list of the uncommitted scope the node is in. */
  group?: Group;
  /** The status of the file of a view node. */
  fileStatus?: Status;
  /** The blob in the index the list compared with (of the file, or of where it was renamed from). */
  blob?: string;
  /** What Stage Changes stages and Unstage Changes unstages: the object view, or its whole file. */
  stage?: 'view' | 'file';
  unstage?: 'view' | 'file';
  /** What Discard Changes puts back (changes not staged only). */
  discard?: 'view' | 'file';
  /** Stage All or Unstage All, on the header of a list. */
  all?: 'stage' | 'unstage';

  constructor(readonly id: string, readonly type: 'file' | 'view' | 'group' | 'other', public label: string) {}
}

/** The nodes of one list: the files with object changes, the build output, the project files. */
interface Listing {
  files: ChangeNode[];
  build: ChangeNode[];
  projects: ChangeNode[];
}

/**
 * What one list compares: an older version of the files (the merge base, HEAD, the index) with a newer one (the
 * index, the working tree), in one repository.
 */
interface Comparison {
  root: string;
  /** The commit compared with: HEAD, or the merge base in the branch scope. */
  base: string;
  group?: Group;
  changes: PathChange[];
  /** Files with a merge conflict, by fileKey. */
  conflicts?: Set<string>;
  /** A file of a change as the older and the newer version have it, and where these are (`at 1a2b3c4`; none: the working tree). */
  before(c: PathChange): Promise<CommitFile>;
  now(c: PathChange): Promise<CommitFile>;
  beforeName: string;
  nowName?: string;
  /** The text of a project file in the older or newer version. */
  text(c: PathChange, side: 'before' | 'now'): Promise<string>;
  /** The blob of a change in the index: of its newer side when staged, of its older side when not. */
  blob(c: PathChange): string | undefined;
}

export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.FileDecorationProvider,
  vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly treeEmitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.treeEmitter.event;
  private readonly decorationsEmitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsEmitter.event;
  private roots: ChangeNode[] = [];
  private view: vscode.TreeView<ChangeNode> | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** The computation running, and the one queued behind it (shared by every request made meanwhile). */
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  /** Something changed while the view was hidden: it is computed again when it shows. */
  private stale = true;
  /** The last git action (stage, unstage, discard); the next one runs after it. */
  private actions: Promise<void> = Promise.resolve();
  private disposed = false;
  scope: ChangesScope;
  /** Asks before a discard (replaced by the tests). */
  confirm = async (message: string, detail: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Discard')) === 'Discard';
  /** Opens an object view in the split editor with its changes against a base. */
  openChanges?: (fsPath: string, objectId: string, accessor: 'Get' | 'Set' | undefined, base: CompareBase) => Promise<void>;
  /** Shows the staged changes of an object view (HEAD ↔ index) in the commit diff panel. */
  openStaged?: (item: CommitObject) => Promise<void>;
  /** After a stage, unstage or discard: what shows the index or the files refreshes. */
  onDidChangeRepository?: () => void;
  log?: (message: string) => void;

  constructor(private readonly ws: TcWorkspace, private readonly git: GitChanges, private readonly state: vscode.Memento) {
    this.scope = state.get<ChangesScope>(SCOPE_KEY) ?? { kind: 'head' };
  }

  attach(view: vscode.TreeView<ChangeNode>): vscode.Disposable {
    this.view = view;
    void vscode.commands.executeCommand('setContext', 'twincatExplorer.changesScope', this.scope.kind);
    return view.onDidChangeVisibility(e => {
      if (e.visible && this.stale) this.schedule(0);
    });
  }

  async setScope(scope: ChangesScope): Promise<void> {
    this.scope = scope;
    await this.state.update(SCOPE_KEY, scope);
    await vscode.commands.executeCommand('setContext', 'twincatExplorer.changesScope', scope.kind);
    this.roots = [];
    if (this.view) {
      this.view.description = scope.kind === 'head' ? 'vs HEAD' : `vs ${scope.ref}`;
      this.view.message = undefined;
    }
    this.treeEmitter.fire(undefined);
    this.schedule(0);
  }

  /** Something may have changed: computed again (debounced), now or once the view shows. */
  schedule(delay = 400): void {
    this.stale = true;
    if (!this.view?.visible || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  /**
   * Recomputes the view; resolves once a computation that started after the call is done. Asked during a
   * computation (what changed meanwhile may be missing from it), it runs one more after it, one for all who
   * ask meanwhile.
   */
  refresh(): Promise<void> {
    if (this.running) {
      this.queued ??= this.running.then(() => {
        this.queued = undefined;
        return this.refresh();
      });
      return this.queued;
    }
    this.stale = false;
    const running = (async () => {
      try {
        await this.compute();
      } catch (e) {
        this.log?.(`TwinCAT Changes: ${(e as Error).stack ?? e}`);
      } finally {
        this.running = undefined;
      }
    })();
    this.running = running;
    return running;
  }

  private async compute(): Promise<void> {
    const scope = this.scope;
    const lists = new Map<Group | undefined, Listing>();
    const notes: string[] = [];
    let description = scope.kind === 'head' ? 'vs HEAD' : `vs ${scope.ref}`;
    const repos = await this.git.repositories();
    if (repos.length === 0) notes.push('The TwinCAT projects are not in a git repository.');
    for (const root of repos) {
      let comparisons: Comparison[];
      try {
        if (scope.kind === 'head') {
          // Read now, not from a cache that follows HEAD a moment later.
          const head = await headCommit(root);
          if (!head) {
            notes.push('The repository has no commit yet.');
            continue;
          }
          comparisons = await this.uncommitted(root, head);
        } else {
          const base = await mergeBase(root, scope.ref);
          if (!base) {
            notes.push(`'${scope.ref}' is not a branch or commit of the repository. Pick another one with Compare Branch With.`);
            continue;
          }
          description = `vs ${scope.ref} (merge base ${base.slice(0, 7)})`;
          comparisons = [await this.sinceCommit(root, base)];
        }
      } catch (e) {
        notes.push(`git failed: ${(e as Error).message}`);
        continue;
      }
      for (const cmp of comparisons) {
        const list = lists.get(cmp.group) ?? { files: [], build: [], projects: [] };
        lists.set(cmp.group, list);
        for (const c of cmp.changes) {
          if (this.disposed || scope !== this.scope) return;
          try {
            if (isSourcePath(c.fsPath)) await this.addSource(c, cmp, list);
            else await this.addProjectFile(c, cmp, list);
          } catch (e) {
            this.log?.(`TwinCAT Changes: ${path.basename(c.fsPath)}: ${(e as Error).message}`);
          }
        }
      }
    }
    if (this.disposed || scope !== this.scope) return;
    if (this.ws.failedPlc.size) {
      notes.push(`${this.ws.failedPlc.size} PLC project(s) could not be read (merge conflict?): their changes may be incomplete.`);
    }
    const roots = scope.kind === 'head'
      ? [...this.top('staged', 'Staged Changes', lists.get('staged')), ...this.top('changes', 'Changes', lists.get('changes'))]
      : this.listNodes(lists.get(undefined));
    this.roots = uniqueIds(roots);
    if (this.view) {
      this.view.description = description;
      this.view.message = notes.length ? notes.join(' ')
        : roots.length === 0 ? `No TwinCAT changes ${description}.` : undefined;
    }
    this.treeEmitter.fire(undefined);
    this.decorationsEmitter.fire(undefined);
  }

  /** The two lists of the uncommitted scope: HEAD ↔ index (Staged Changes) and index ↔ working tree (Changes). */
  private async uncommitted(root: string, head: string): Promise<Comparison[]> {
    const index = await indexChanges(root, head, EXTENSIONS);
    const blob = (fsPath: string) => index.blobs.get(fileKey(fsPath));
    const inIndex = (fsPath: string): Promise<CommitFile> => {
      const b = blob(fsPath);
      return b ? this.git.fileAtBlob(root, fsPath, b) : Promise.resolve({});
    };
    const indexText = async (fsPath: string) => {
      const b = blob(fsPath);
      return b ? ((await readBlobs(root, [b]))[0] ?? Buffer.alloc(0)).toString('utf8') : '';
    };
    // A file not staged is in the index where it was before a rename.
    const oldPath = (c: PathChange) => (c.from ? path.join(root, c.from) : c.fsPath);
    const inHead = this.atCommit(root, head);
    const staged: Comparison = {
      ...inHead, group: 'staged', changes: index.staged,
      now: c => (c.status === 'D' ? Promise.resolve({}) : inIndex(c.fsPath)),
      nowName: 'in the index',
      text: (c, side) => (side === 'before' ? inHead.text(c, side) : indexText(c.fsPath)),
      blob: c => blob(c.fsPath),
    };
    const unstaged = (c: PathChange) => (c.status === 'A' ? Promise.resolve({}) : inIndex(oldPath(c)));
    const changes: Comparison = {
      ...this.atCommit(root, head), group: 'changes', conflicts: index.conflicts,
      changes: await this.withUnstagedRenames(root, index.unstaged, unstaged),
      before: unstaged, beforeName: 'in the index',
      text: (c, side) => (side === 'before' ? indexText(oldPath(c)) : Promise.resolve(fs.readFileSync(c.fsPath, 'utf8'))),
      blob: c => blob(oldPath(c)),
    };
    return [staged, changes];
  }

  /** The list of the branch scope: a commit (the merge base) ↔ the working tree, staged or not. */
  private async sinceCommit(root: string, base: string): Promise<Comparison> {
    const cmp = this.atCommit(root, base);
    return { ...cmp, changes: await this.withUnstagedRenames(root, await changesSince(root, base, EXTENSIONS), cmp.before) };
  }

  /** A comparison of a commit with the working tree, its changes to be filled in. */
  private atCommit(root: string, base: string): Comparison {
    return {
      root, base, changes: [],
      before: c => (c.status === 'A' ? Promise.resolve({}) : this.git.fileAtCommit(c.fsPath, base, c.from)),
      beforeName: `at ${base.slice(0, 7)}`,
      now: c => this.working(c),
      text: async (c, side) => (side === 'before' ? (await showAtRef(c.fsPath, base, c.from)).toString('utf8') : fs.readFileSync(c.fsPath, 'utf8')),
      blob: () => undefined,
    };
  }

  /** The working tree's version of a file (as the workspace read it), none for a deleted one. */
  private async working(c: PathChange): Promise<CommitFile> {
    const file = c.status === 'D' ? undefined : this.ws.getFile(c.fsPath);
    return file?.error ? { error: file.error } : { file };
  }

  /**
   * A POU renamed or moved in XAE and not staged shows as one file deleted and one untracked: when both hold
   * the same object (TwinCAT keeps the GUID), they become one renamed file.
   */
  private async withUnstagedRenames(root: string, changes: PathChange[], before: (c: PathChange) => Promise<CommitFile>): Promise<PathChange[]> {
    const added = changes.filter(c => c.status === 'A' && isSourcePath(c.fsPath));
    const deleted = changes.filter(c => c.status === 'D' && isSourcePath(c.fsPath));
    if (added.length === 0 || deleted.length === 0) return changes;
    const byObject = new Map<string, PathChange>();
    for (const d of deleted) {
      const id = (await before(d)).file?.root?.id;
      if (id) byObject.set(id, d);
    }
    const gone = new Set<PathChange>();
    for (const a of added) {
      const id = this.ws.getFile(a.fsPath)?.root?.id;
      const d = id ? byObject.get(id) : undefined;
      if (!id || !d) continue;
      byObject.delete(id);
      gone.add(d);
      a.status = 'R';
      a.from = path.relative(root, d.fsPath).split(path.sep).join('/');
    }
    return changes.filter(c => !gone.has(c));
  }

  private group(id: string, label: string, children: ChangeNode[]): ChangeNode {
    const g = new ChangeNode(`group:${id}`, 'group', label);
    g.children = children.sort((a, b) => compareLabels(a.label, b.label));
    g.description = String(children.length);
    return g;
  }

  /** The nodes of a list: its files, then the build output and the project files, each in a group. */
  private listNodes(list: Listing | undefined, group?: Group): ChangeNode[] {
    if (!list) return [];
    const prefix = group ? `${group}/` : '';
    const nodes = [...list.files].sort((a, b) => compareLabels(a.label, b.label));
    if (list.build.length) nodes.push(this.group(`${prefix}build`, 'Build output (no code changes)', list.build));
    if (list.projects.length) nodes.push(this.group(`${prefix}projects`, 'Project files', list.projects));
    return nodes;
  }

  /** Staged Changes or Changes, with the number of its files; none when its list is empty. */
  private top(group: Group, label: string, list: Listing | undefined): ChangeNode[] {
    const children = this.listNodes(list, group);
    if (!list || children.length === 0) return [];
    const g = new ChangeNode(`group:${group}`, 'group', label);
    Object.assign(g, { children, group, all: group === 'staged' ? 'unstage' : 'stage' });
    g.description = String(list.files.length + list.build.length + list.projects.length);
    return [g];
  }

  /** Folders of the workspace's PLC projects, also of those that did not load (merge conflicts). */
  private projectDirs(): string[] {
    return this.ws.tsProjects.flatMap(t => t.plcProjects.map(r => fileKey(path.dirname(r.plcprojPath))));
  }

  /** In a project: listed in a .plcproj, or inside the folder of one (deleted files, projects that did not load). */
  private inProject(fsPath: string): boolean {
    if (this.ws.entry(fsPath)) return true;
    const key = fileKey(fsPath);
    return this.projectDirs().some(dir => key.startsWith(dir + path.sep));
  }

  /** `Machine · POUs/Components/Valves`: the PLC project and the folder of a file. */
  private where(fsPath: string): string {
    const entry = this.ws.entry(fsPath);
    if (entry) {
      const dir = path.dirname(entry.include.replace(/\\/g, '/'));
      return dir === '.' ? entry.project.name : `${entry.project.name} · ${dir}`;
    }
    const plc = this.ws.plcProjects.find(p => fileKey(fsPath).startsWith(fileKey(p.dir) + path.sep));
    return plc ? `${plc.name} · ${path.relative(plc.dir, path.dirname(fsPath)).replace(/\\/g, '/')}` : '';
  }

  /** A node of a file of a list, with what it can do as a whole: stage, unstage, discard. */
  private fileNode(c: PathChange, cmp: Comparison, type: 'file' | 'other'): ChangeNode {
    const n = new ChangeNode(nodeId(cmp.group, `${type}:${fileKey(c.fsPath)}`), type, path.basename(c.fsPath));
    Object.assign(n, { fsPath: c.fsPath, root: cmp.root, base: cmp.base, from: c.from, status: c.status, tooltip: c.fsPath, group: cmp.group });
    n.blob = cmp.blob(c);
    if (cmp.conflicts?.has(fileKey(c.fsPath))) n.status = 'U';
    if (cmp.group === 'staged') n.unstage = 'file';
    if (cmp.group === 'changes') {
      n.stage = 'file';
      if (c.status === 'M' || c.status === 'D') n.discard = 'file';
    }
    return n;
  }

  private async addSource(c: PathChange, cmp: Comparison, list: Listing): Promise<void> {
    // Only the files of the projects (not templates, not copies in worktrees).
    if (!this.inProject(c.fsPath)) return;
    const node = this.fileNode(c, cmp, 'file');
    node.description = this.where(c.fsPath);
    if (c.from) node.tooltip = `${c.fsPath}\nRenamed from ${c.from}`;
    const unreadable = (why: string) => {
      // Conflict markers, a half-written file, git failing: nothing is known, nothing can be done per object.
      node.description = why;
      node.icon = new vscode.ThemeIcon('warning');
      list.files.push(node);
    };
    if (node.status === 'U') {
      // Staged once resolved, which also marks it resolved.
      delete node.discard;
      return unreadable('merge conflict');
    }
    const read = await cmp.now(c);
    if (read.error) return unreadable(`cannot be read${cmp.nowName ? ` ${cmp.nowName}` : ''}: ${read.error}`);
    const now = read.file;
    const readBefore = c.status === 'A' ? {} : await cmp.before(c);
    if (readBefore.error) return unreadable(`cannot be read ${cmp.beforeName}: ${readBefore.error}`);
    if (c.status !== 'A' && !readBefore.file) return unreadable(`not found ${cmp.beforeName}`);
    const before = readBefore.file;
    // Only the index differs (git rm --cached): the content did not change.
    if (c.status === 'M' && before && now && before.text === now.text) return;
    const views = viewChanges(before, now?.root ? now : undefined);
    if (views.length === 0) {
      if (c.status === 'R') {
        // Moved or renamed without a code change: still part of what changed.
        const fromDir = path.posix.dirname(c.from ?? '');
        const sameDir = fileKey(path.join(cmp.root, fromDir)) === fileKey(path.dirname(c.fsPath));
        node.description = `${this.where(c.fsPath)} · ${sameDir ? `renamed from ${path.posix.basename(c.from ?? '')}` : `moved from ${fromDir}`}`;
        const rootObject = now?.root ?? before?.root;
        if (rootObject) {
          node.label = objectTreeLabel(rootObject);
          node.icon = objectIcon(rootObject);
        }
        list.files.push(node);
      } else if (c.status === 'M' && before && now) {
        list.build.push(this.otherNode(c, cmp, metadataChange(before.text, now.text), new vscode.ThemeIcon('file-code')));
      }
      return;
    }
    const rootObject = now?.root ?? before?.root;
    if (rootObject) {
      node.label = objectTreeLabel(rootObject);
      node.icon = objectIcon(rootObject);
    }
    for (const v of views) {
      const obj: TcObject | undefined = (v.change === 'deleted' ? before : now)?.objects.get(v.objectId);
      const item = viewChangeItem(v, obj, rootObject?.name);
      const vn = new ChangeNode(nodeId(cmp.group, `view:${fileKey(c.fsPath)}|${v.objectId}|${v.accessor ?? ''}`), 'view', item.label);
      Object.assign(vn, item, { fsPath: c.fsPath, root: cmp.root, base: cmp.base, from: c.from, view: v, group: cmp.group });
      Object.assign(vn, { fileStatus: c.status, blob: node.blob });
      // One by one in a file both versions have, but for the POU, DUT or GVL itself when it is new or gone: the
      // objects of a new, deleted or renamed file go with it.
      const single = c.status === 'M' && (v.change === 'modified' || v.accessor !== undefined || !!obj?.parent);
      if (cmp.group === 'staged') vn.unstage = single ? 'view' : 'file';
      if (cmp.group === 'changes') {
        vn.stage = single ? 'view' : 'file';
        if (single) vn.discard = 'view';
      }
      node.children.push(vn);
    }
    list.files.push(node);
  }

  private async addProjectFile(c: PathChange, cmp: Comparison, list: Listing): Promise<void> {
    // The workspace's project files (.tsproj, .plcproj, .xti), also one that did not load (listed with what went wrong).
    const failed = this.ws.failedPlc.get(fileKey(c.fsPath));
    if (failed !== undefined) {
      list.projects.push(this.otherNode(c, cmp, `cannot be read: ${failed}`, new vscode.ThemeIcon('warning')));
      return;
    }
    if (!this.ws.isProjectFile(c.fsPath)) return;
    // A build rewrites the TmcHash of a PLC project in the .tsproj, or in the .xti of one saved on its own.
    if (c.status === 'M' && /\.(tsproj|xti)$/i.test(c.fsPath) && !cmp.conflicts?.has(fileKey(c.fsPath))) {
      if (onlyTmcHashChanged(await cmp.text(c, 'before'), await cmp.text(c, 'now'))) {
        list.build.push(this.otherNode(c, cmp, 'TmcHash, rewritten by a build', projectFileIcon(c.fsPath)));
        return;
      }
    }
    list.projects.push(this.otherNode(c, cmp, { M: 'changed', A: 'added', D: 'deleted', R: 'renamed' }[c.status], projectFileIcon(c.fsPath)));
  }

  private otherNode(c: PathChange, cmp: Comparison, note: string, icon: TreeIcon): ChangeNode {
    const n = this.fileNode(c, cmp, 'other');
    n.description = note;
    n.icon = icon;
    if (n.status === 'U') {
      n.description = 'merge conflict';
      delete n.discard;
    }
    return n;
  }

  // ------------------------------------------------------------------ TreeDataProvider

  getTreeItem(n: ChangeNode): vscode.TreeItem {
    const state = n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, state);
    item.id = n.id;
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.iconPath = n.icon;
    // The status letter and color come from provideFileDecoration.
    if (n.status) item.resourceUri = statusUri(n.id, n.status);
    const context: string[] = [n.type];
    if (n.stage) context.push(`stage-${n.stage}`);
    if (n.unstage) context.push(`unstage-${n.unstage}`);
    if (n.discard) context.push(`discard-${n.discard}`);
    if (n.all) context.push(`${n.all}All`);
    if (n.type === 'file' && n.status !== 'D' && n.status !== 'A' && n.status !== 'U') context.push('notebookDiff');
    item.contextValue = context.join(' ');
    if (n.type === 'view' || n.type === 'other') item.command = { command: 'twincatExplorer.changes.open', title: 'Open Changes', arguments: [n] };
    return item;
  }

  getChildren(n?: ChangeNode): ChangeNode[] {
    if (!n && this.stale && this.view?.visible) this.schedule(0);
    return n ? n.children : this.roots;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CHANGE_SCHEME) return undefined;
    switch (uri.query) {
      case 'M': return new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
      case 'A': return new vscode.FileDecoration('A', 'Added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
      case 'D': return new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      case 'R': return new vscode.FileDecoration('R', 'Renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
      case 'U': return new vscode.FileDecoration('!', 'Conflict', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
      default: return undefined;
    }
  }

  // ------------------------------------------------------------------ actions

  private baseLabel(): string {
    return this.scope.kind === 'head' ? 'HEAD' : this.scope.ref;
  }

  /**
   * A click: the object view's changes in the split editor (a staged one's in the commit diff panel, HEAD ↔ index),
   * a deleted one as text, other files as a text diff.
   */
  async open(n: ChangeNode): Promise<void> {
    if (!n.fsPath || !n.base) return;
    if (n.type === 'other') return this.openText(n);
    const v = n.view;
    if (!v) return;
    if (n.group === 'staged' && n.root) {
      const rel = repoPath(n.root, n.fsPath);
      await this.openStaged?.({
        root: n.root, commit: INDEX, parent: n.base, path: rel, fromPath: n.from ?? rel, objectId: v.objectId, accessor: v.accessor,
      });
      return;
    }
    if (v.change === 'deleted') {
      // The tab is named after the last path segment: no ref names (origin/develop) in it. Not staged, the object
      // is in the index.
      const at = n.group === 'changes' ? { root: n.root, blob: n.blob } : { commit: n.base, from: n.from };
      const uri = vscode.Uri.from({
        scheme: BASE_SCHEME,
        path: `/${v.label} (deleted)`,
        query: JSON.stringify({ fsPath: n.fsPath, ...at, objectId: v.objectId, accessor: v.accessor }),
      });
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, ST_LANGUAGE);
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    // Changes not staged compare with the index; the branch scope with the merge base, taken again by the split
    // editor after a rebase.
    const base: CompareBase = n.group === 'changes' ? (n.from ? { ...INDEX_BASE, path: n.from } : INDEX_BASE)
      : this.scope.kind === 'head' ? HEAD_BASE : { ref: this.scope.ref, label: this.scope.ref, mergeBase: true };
    await this.openChanges?.(n.fsPath, v.objectId, v.accessor, base);
  }

  /** Text of a deleted object view at the commit compared with, or in the index (read-only); a property with its accessors. */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as {
      fsPath: string; commit?: string; from?: string; root?: string; blob?: string; objectId: string; accessor?: 'Get' | 'Set';
    };
    const read = q.root && q.blob ? this.git.fileAtBlob(q.root, q.fsPath, q.blob) : this.git.fileAtCommit(q.fsPath, q.commit ?? 'HEAD', q.from);
    const obj = (await read).file?.objects.get(q.objectId);
    if (!obj) return '';
    const parts = viewSections(obj, q.accessor).map(s => s.text);
    if (!q.accessor) {
      for (const acc of obj.accessors) parts.push(`// ${acc.kind}\n${acc.sections.map(s => s.text).join('\n\n')}`);
    }
    return parts.join('\n\n');
  }

  /** A file without object changes (project files, build output): VS Code's text diff of the XML. */
  private async openText(n: ChangeNode): Promise<void> {
    const file = vscode.Uri.file(n.fsPath!);
    const name = path.basename(n.fsPath!);
    const open = (uri: vscode.Uri) => vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    if (!n.root || !n.base) return void (await open(file));
    const rel = repoPath(n.root, n.fsPath!);
    const inIndex = (at: string) => revisionUri(n.fsPath!, INDEX, `${path.posix.basename(at)} (Index)`, at);
    if (n.group === 'staged') {
      if (n.status === 'A') return void (await open(inIndex(rel)));
      const left = await revision(n.root, n.from ?? rel, n.base);
      if (n.status === 'D') return void (await open(left));
      await vscode.commands.executeCommand('vscode.diff', left, inIndex(rel), `${name} (HEAD ↔ Index)`, { preview: true });
      return;
    }
    if (n.status === 'A') return void (await open(file));
    const left = n.group === 'changes' ? inIndex(n.from ?? rel) : await revision(n.root, n.from ?? rel, n.base);
    if (n.status === 'D') return void (await open(left));
    const title = `${name} (${n.group === 'changes' ? 'Index' : this.baseLabel()} ↔ Working Tree)`;
    await vscode.commands.executeCommand('vscode.diff', left, file, title, { preview: true });
  }

  /** The whole file as a notebook diff: against the commit compared with, HEAD ↔ index when staged, index ↔ working tree when not. */
  async openNotebook(n: ChangeNode): Promise<void> {
    if (!n.fsPath || !n.base) return;
    if (n.group === 'staged') await openNotebookDiff(n.fsPath, 'HEAD', INDEX);
    else if (n.group === 'changes') await openNotebookDiff(n.fsPath, INDEX);
    else await openNotebookDiff(n.fsPath, n.base);
  }

  /**
   * Runs a git action of the view after those before it (each reads the index the one before wrote), with a
   * message when it fails, and shows the view again.
   */
  private act(verb: string, work: () => Promise<void>): Promise<void> {
    const done = this.actions.then(async () => {
      try {
        await work();
      } catch (e) {
        const message = (e as Error).message.trim().replace(/\.?$/, '.');
        // What an object could not (sections added or removed, a file that does not parse), its file can.
        void vscode.window.showErrorMessage(`TwinCAT: ${message}${e instanceof SpliceError ? ` ${verb} the whole file instead.` : ''}`);
      }
      this.schedule(100);
      this.onDidChangeRepository?.();
    });
    this.actions = done;
    return done;
  }

  /** True when no editor has unsaved edits of these files; else says so. */
  private saved(fsPaths: string[]): boolean {
    const dirty = fsPaths.find(hasUnsavedEdits);
    if (dirty) void vscode.window.showWarningMessage(`${path.basename(dirty)} has unsaved changes in an editor. Save or revert them first.`);
    return !dirty;
  }

  /** The files a node stages or unstages whole: its own, and the one it was renamed from. */
  private files(n: ChangeNode): FileToStage[] {
    const status = n.type === 'view' ? n.fileStatus : n.status;
    const files: FileToStage[] = [{ path: repoPath(n.root!, n.fsPath!), deleted: status === 'D' }];
    if (n.from && status === 'R') files.push({ path: n.from, deleted: true });
    return files;
  }

  /** An object of a new, deleted or renamed file goes with its file: asks whether to stage or unstage that. */
  private async wholeFile(n: ChangeNode, verb: 'Stage' | 'Unstage'): Promise<boolean> {
    const name = path.basename(n.fsPath!);
    const why = { A: `${name} is new`, D: `${name} is deleted`, R: `${name} is renamed` }[n.fileStatus as 'A' | 'D' | 'R']
      ?? `${n.view?.label} is all of ${name}`;
    const choice = await vscode.window.showInformationMessage(
      `${why}: it is ${verb.toLowerCase()}d as a whole file, not object by object.`, `${verb} File`);
    return choice === `${verb} File`;
  }

  /** Stage Changes: an object view, or a whole file, goes into the index as it is in the working tree. */
  async stage(n: ChangeNode): Promise<void> {
    if (n.group !== 'changes' || !n.fsPath || !n.root || !n.stage) return;
    if (n.stage === 'file' && n.type === 'view' && !(await this.wholeFile(n, 'Stage'))) return;
    const files = this.files(n);
    if (!this.saved(files.filter(f => !f.deleted).map(f => path.join(n.root!, f.path)))) return;
    if (n.status === 'U' && /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(n.fsPath, 'utf8'))) {
      void vscode.window.showWarningMessage(`${path.basename(n.fsPath)} still has conflict markers. Resolve the conflict, then stage it.`);
      return;
    }
    const v = n.view;
    await this.act('Stage', () => (n.stage === 'view' && v ? stageView(runGit, n.root!, n.fsPath!, v.objectId, v.accessor)
      : stageFiles(runGit, n.root!, files)));
  }

  /** Unstage Changes: an object view, or a whole file, goes back to HEAD's version in the index. */
  async unstage(n: ChangeNode): Promise<void> {
    if (n.group !== 'staged' || !n.fsPath || !n.root || !n.unstage) return;
    if (n.unstage === 'file' && n.type === 'view' && !(await this.wholeFile(n, 'Unstage'))) return;
    const v = n.view;
    await this.act('Unstage', () => (n.unstage === 'view' && v ? unstageView(runGit, n.root!, n.fsPath!, v.objectId, v.accessor)
      : unstageFiles(runGit, n.root!, this.files(n).map(f => f.path))));
  }

  /** The file nodes of a list, also those of its build output and project files. */
  private fileNodes(n: ChangeNode | undefined): ChangeNode[] {
    if (!n) return [];
    return n.type === 'group' ? n.children.flatMap(c => this.fileNodes(c)) : [n];
  }

  /** The files of nodes, by repository. */
  private byRoot(nodes: ChangeNode[]): Map<string, FileToStage[]> {
    const out = new Map<string, FileToStage[]>();
    for (const n of nodes) {
      if (!n.root || !n.fsPath) continue;
      out.set(n.root, [...(out.get(n.root) ?? []), ...this.files(n)]);
    }
    return out;
  }

  /** Stage All Changes: every file of the Changes list, whole, but those with a merge conflict. */
  async stageAll(list?: ChangeNode): Promise<void> {
    const nodes = this.fileNodes(list ?? this.roots.find(r => r.all === 'stage')).filter(n => n.stage && n.status !== 'U');
    if (nodes.length === 0 || !this.saved(nodes.filter(n => n.status !== 'D').map(n => n.fsPath!))) return;
    await this.act('Stage', async () => {
      for (const [root, files] of this.byRoot(nodes)) await stageFiles(runGit, root, files);
    });
  }

  /** Unstage All Changes: every file of the Staged Changes list back to HEAD's version in the index. */
  async unstageAll(list?: ChangeNode): Promise<void> {
    const nodes = this.fileNodes(list ?? this.roots.find(r => r.all === 'unstage')).filter(n => n.unstage);
    if (nodes.length === 0) return;
    await this.act('Unstage', async () => {
      for (const [root, files] of this.byRoot(nodes)) await unstageFiles(runGit, root, files.map(f => f.path));
    });
  }

  /** Discard Changes (not staged): an object view, or a whole file, back as the index has it, after a confirmation. */
  async discard(n: ChangeNode): Promise<void> {
    if (n.group !== 'changes' || !n.fsPath || !n.root || !n.discard) return;
    const name = path.basename(n.fsPath);
    if (!this.saved([n.fsPath])) return;
    const v = n.view;
    if (n.discard === 'file' || !v) {
      const detail = 'The file goes back to its version in the index: HEAD\'s, unless changes of it are staged. Staged changes stay.'
        + (n.status === 'D' ? ' Its entry in the .plcproj does not come back by itself: discard the .plcproj too (Project files).' : '');
      if (!(await this.confirm(`Discard all changes in ${name}?`, detail))) return;
    } else {
      const detail = v.change === 'added' ? 'It is removed from the file, as when it is deleted in TwinCAT XAE.'
        : v.change === 'deleted' ? 'It comes back as the index has it: as in HEAD, unless it is staged.'
          : `Its Structured Text${v.renamedFrom ? ' and its name go' : ' goes'} back to the version in the index: HEAD's, unless it is`
            + ' staged. The rest of the file stays as it is.';
      if (!(await this.confirm(`Discard the changes of ${v.label}?`, detail))) return;
    }
    await this.act('Discard', async () => {
      // The list was made against the index of then: what was staged or unstaged since could be lost.
      const where = n.from ? path.join(n.root!, n.from) : n.fsPath!;
      if ((await indexEntry(runGit, n.root!, where))?.blob !== n.blob) {
        void vscode.window.showWarningMessage('The index changed since the list was made. It is shown again: check the change and discard again.');
        return;
      }
      if (n.discard === 'view' && v) await discardView(runGit, n.root!, n.fsPath!, v.objectId, v.accessor);
      else await discardFiles(runGit, n.root!, [repoPath(n.root!, n.fsPath!)]);
    });
  }

  /** Nodes of the view, for the tests. */
  get rootNodes(): ChangeNode[] {
    return this.roots;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.treeEmitter.dispose();
    this.decorationsEmitter.dispose();
  }
}

/** The id of a node of a list: the list it is in (none in the branch scope), then what it is. */
function nodeId(group: Group | undefined, id: string): string {
  return group ? `${group}:${id}` : id;
}

/** Drops a node whose id was seen before: VS Code refuses a tree with two equal ids and shows nothing. */
function uniqueIds(nodes: ChangeNode[], seen = new Set<string>()): ChangeNode[] {
  const out: ChangeNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    n.children = uniqueIds(n.children, seen);
    out.push(n);
  }
  return out;
}

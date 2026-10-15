// The TwinCAT Changes view in the Source Control sidebar: the object views (POUs, methods, properties,
// accessors) that differ from HEAD, or from where the branch left another one (what a merge request shows),
// grouped by file, and apart from them the files that changed without code (build output). A click shows the
// changes in the split editor; changes since HEAD can be discarded per object or per file.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ViewChange, metadataChange, onlyTmcHashChanged, viewChanges } from '../core/objectChanges';
import { viewSections } from '../core/objectText';
import { removeMember, restoreView } from '../core/splice';
import { ObjectKind, TcObject, encodeText, parseTcFile } from '../core/tcfile';
import { TcWorkspace, fileKey } from '../core/workspace';
import { PathChange, changesSince, headCommit, mergeBase, openNotebookDiff, restoreFromHead, showAtRef } from './git';
import { GitChanges } from './gitChanges';
import { CompareBase, HEAD_BASE } from './objectEditor';
import { objectIcon, objectTreeLabel } from './tree';
import { SOURCE_EXTENSIONS, isSourcePath, realPathOf } from './uris';

export type ChangesScope = { kind: 'head' } | { kind: 'branch'; ref: string };

export const CHANGE_SCHEME = 'twincat-change';
/** Read-only text of an object view at a commit (a deleted method, ...). */
export const BASE_SCHEME = 'twincat-base';
const SCOPE_KEY = 'twincatExplorer.changesScope';

type Status = 'M' | 'A' | 'D' | 'R';

export class ChangeNode {
  children: ChangeNode[] = [];
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
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
  /** What Discard Changes puts back (changes since HEAD only). */
  discard?: 'view' | 'file';

  constructor(readonly id: string, readonly type: 'file' | 'view' | 'group' | 'other', public label: string) {}
}

const KIND_WORD: Record<ObjectKind, string> = {
  pou: 'POU', method: 'Method', property: 'Property', action: 'Action', transition: 'Transition',
  dut: 'DUT', gvl: 'GVL', itf: 'Interface',
};

export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.FileDecorationProvider,
  vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly treeEmitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.treeEmitter.event;
  private readonly decorationsEmitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsEmitter.event;
  private roots: ChangeNode[] = [];
  private view: vscode.TreeView<ChangeNode> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  /** Something changed while the view was hidden: it is computed again when it shows. */
  private stale = true;
  private disposed = false;
  scope: ChangesScope;
  /** Asks before a discard (replaced by the tests). */
  confirm = async (message: string, detail: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Discard')) === 'Discard';
  /** Opens an object view in the split editor with its changes against a base. */
  openChanges?: (fsPath: string, objectId: string, accessor: 'Get' | 'Set' | undefined, base: CompareBase) => Promise<void>;
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

  /** Recomputes the view; a request during a computation runs once it is done. */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.stale = false;
    try {
      await this.compute();
    } catch (e) {
      this.log?.(`TwinCAT Changes: ${(e as Error).stack ?? e}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    }
  }

  private async compute(): Promise<void> {
    const scope = this.scope;
    const files: ChangeNode[] = [];
    const build: ChangeNode[] = [];
    const projects: ChangeNode[] = [];
    const notes: string[] = [];
    let description = scope.kind === 'head' ? 'vs HEAD' : `vs ${scope.ref}`;
    const repos = await this.git.repositories();
    if (repos.length === 0) notes.push('The TwinCAT projects are not in a git repository.');
    for (const root of repos) {
      let base: string | undefined;
      if (scope.kind === 'head') {
        // Read now, not from a cache that follows HEAD a moment later: Discard checks against it.
        base = await headCommit(root);
        if (!base) {
          notes.push('The repository has no commit yet.');
          continue;
        }
      } else {
        base = await mergeBase(root, scope.ref);
        if (!base) {
          notes.push(`'${scope.ref}' is not a branch or commit of the repository. Pick another one with Compare Branch With.`);
          continue;
        }
        description = `vs ${scope.ref} (merge base ${base.slice(0, 7)})`;
      }
      let changes: PathChange[];
      try {
        changes = await this.withUnstagedRenames(root, base,
          await changesSince(root, base, [...SOURCE_EXTENSIONS, '.tsproj', '.plcproj']));
      } catch (e) {
        notes.push(`git failed: ${(e as Error).message}`);
        continue;
      }
      for (const c of changes) {
        if (this.disposed || scope !== this.scope) return;
        try {
          if (isSourcePath(c.fsPath)) await this.addSource(c, root, base, files, build);
          else await this.addProjectFile(c, root, base, build, projects);
        } catch (e) {
          this.log?.(`TwinCAT Changes: ${path.basename(c.fsPath)}: ${(e as Error).message}`);
        }
      }
    }
    if (this.disposed || scope !== this.scope) return;
    if (this.ws.failedPlc.size) {
      notes.push(`${this.ws.failedPlc.size} PLC project(s) could not be read (merge conflict?): their changes may be incomplete.`);
    }
    files.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    const roots = [...files];
    if (build.length) roots.push(this.group('build', 'Build output (no code changes)', build));
    if (projects.length) roots.push(this.group('projects', 'Project files', projects));
    this.roots = uniqueIds(roots);
    if (this.view) {
      this.view.description = description;
      this.view.message = notes.length ? notes.join(' ')
        : roots.length === 0 ? `No TwinCAT changes ${description}.` : undefined;
    }
    this.treeEmitter.fire(undefined);
    this.decorationsEmitter.fire(undefined);
  }

  /**
   * A POU renamed or moved in XAE and not staged shows as one file deleted and one untracked: when both hold
   * the same object (TwinCAT keeps the GUID), they become one renamed file.
   */
  private async withUnstagedRenames(root: string, base: string, changes: PathChange[]): Promise<PathChange[]> {
    const added = changes.filter(c => c.status === 'A' && isSourcePath(c.fsPath));
    const deleted = changes.filter(c => c.status === 'D' && isSourcePath(c.fsPath));
    if (added.length === 0 || deleted.length === 0) return changes;
    const byObject = new Map<string, PathChange>();
    for (const d of deleted) {
      const id = (await this.git.fileAtCommit(d.fsPath, base)).file?.root?.id;
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
    g.children = children.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    g.description = String(children.length);
    return g;
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

  private async addSource(c: PathChange, root: string, base: string, files: ChangeNode[], build: ChangeNode[]): Promise<void> {
    // Only the files of the projects (not templates, not copies in worktrees).
    if (!this.inProject(c.fsPath)) return;
    const node = new ChangeNode(`file:${fileKey(c.fsPath)}`, 'file', path.basename(c.fsPath));
    Object.assign(node, { fsPath: c.fsPath, root, base, from: c.from, status: c.status, tooltip: c.fsPath });
    node.description = this.where(c.fsPath);
    if (c.from) node.tooltip = `${c.fsPath}\nRenamed from ${c.from}`;
    const unreadable = (why: string) => {
      // Conflict markers, a half-written file, git failing: nothing is known, nothing can be discarded per object.
      node.description = why;
      node.icon = new vscode.ThemeIcon('warning');
      files.push(node);
    };
    const now = c.status === 'D' ? undefined : this.ws.getFile(c.fsPath);
    if (now?.error) return unreadable(`cannot be read: ${now.error}`);
    const read = c.status === 'A' ? undefined : await this.git.fileAtCommit(c.fsPath, base, c.from);
    if (read?.error) return unreadable(`cannot be read at ${base.slice(0, 7)}: ${read.error}`);
    if (c.status !== 'A' && !read?.file) return unreadable(`not found at ${base.slice(0, 7)}`);
    const before = read?.file;
    // Only the index differs (git rm --cached): the content did not change.
    if (c.status === 'M' && before && now && before.text === now.text) return;
    const views = viewChanges(before, now?.root ? now : undefined);
    if (views.length === 0) {
      if (c.status === 'R') {
        // Moved or renamed without a code change: still part of what changed.
        const fromDir = path.posix.dirname(c.from ?? '');
        const sameDir = fileKey(path.join(root, fromDir)) === fileKey(path.dirname(c.fsPath));
        node.description = `${this.where(c.fsPath)} · ${sameDir ? `renamed from ${path.posix.basename(c.from ?? '')}` : `moved from ${fromDir}`}`;
        const rootObject = now?.root ?? before?.root;
        if (rootObject) {
          node.label = objectTreeLabel(rootObject);
          node.icon = objectIcon(rootObject);
        }
        files.push(node);
      } else if (c.status === 'M' && before && now) {
        build.push(this.otherNode(c, root, base, metadataChange(before.text, now.text), 'file-code'));
      }
      return;
    }
    const rootObject = now?.root ?? before?.root;
    if (rootObject) {
      node.label = objectTreeLabel(rootObject);
      node.icon = objectIcon(rootObject);
    }
    if (this.scope.kind === 'head' && (c.status === 'M' || c.status === 'D')) node.discard = 'file';
    for (const v of views) {
      const obj: TcObject | undefined = (v.change === 'deleted' ? before : now)?.objects.get(v.objectId);
      const short = rootObject && v.label.startsWith(`${rootObject.name}.`) ? v.label.slice(rootObject.name.length + 1) : v.label;
      const vn = new ChangeNode(`view:${fileKey(c.fsPath)}|${v.objectId}|${v.accessor ?? ''}`, 'view', short);
      Object.assign(vn, { fsPath: c.fsPath, root, base, from: c.from, view: v });
      vn.status = v.change === 'added' ? 'A' : v.change === 'deleted' ? 'D' : 'M';
      vn.icon = v.accessor
        ? new vscode.ThemeIcon(v.accessor === 'Get' ? 'arrow-small-left' : 'arrow-small-right', new vscode.ThemeColor('symbolIcon.methodForeground'))
        : obj ? objectIcon(obj) : undefined;
      const words = [v.accessor ? `${v.accessor} accessor` : KIND_WORD[v.kind]];
      if (v.renamedFrom) words.push(`renamed from ${v.renamedFrom}`);
      vn.description = words.join(' · ');
      vn.tooltip = `${v.label} (${v.change})`;
      // Code changes go back to HEAD; an added member or accessor is removed. Not for new or deleted files.
      const removable = v.change === 'added' && (v.accessor !== undefined || !!obj?.parent);
      if (this.scope.kind === 'head' && c.status === 'M' && ((v.change === 'modified' && !v.renamedFrom) || removable)) vn.discard = 'view';
      node.children.push(vn);
    }
    files.push(node);
  }

  private async addProjectFile(c: PathChange, root: string, base: string, build: ChangeNode[], projects: ChangeNode[]): Promise<void> {
    // The workspace's project files, also a .plcproj that did not load (it is listed, with what went wrong).
    const failed = this.ws.failedPlc.get(fileKey(c.fsPath));
    if (failed !== undefined) {
      const n = this.otherNode(c, root, base, `cannot be read: ${failed}`, 'warning');
      projects.push(n);
      return;
    }
    if (!this.ws.isProjectFile(c.fsPath)) return;
    if (c.status === 'M' && c.fsPath.toLowerCase().endsWith('.tsproj')) {
      const before = (await showAtRef(c.fsPath, base, c.from)).toString('utf8');
      if (onlyTmcHashChanged(before, fs.readFileSync(c.fsPath, 'utf8'))) {
        build.push(this.otherNode(c, root, base, 'TmcHash, rewritten by a build', 'project'));
        return;
      }
    }
    projects.push(this.otherNode(c, root, base, { M: 'changed', A: 'added', D: 'deleted', R: 'renamed' }[c.status], 'project'));
  }

  private otherNode(c: PathChange, root: string, base: string, note: string, icon: string): ChangeNode {
    const n = new ChangeNode(`other:${fileKey(c.fsPath)}`, 'other', path.basename(c.fsPath));
    Object.assign(n, { fsPath: c.fsPath, root, base, from: c.from, status: c.status, description: note, tooltip: c.fsPath });
    n.icon = new vscode.ThemeIcon(icon);
    if (this.scope.kind === 'head' && (c.status === 'M' || c.status === 'D')) n.discard = 'file';
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
    if (n.status) item.resourceUri = vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${encodeURIComponent(n.id)}`, query: n.status });
    const context: string[] = [n.type];
    if (n.discard) context.push(`discard-${n.discard}`);
    if (n.type === 'file' && n.status !== 'D' && n.status !== 'A') context.push('notebookDiff');
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
      default: return undefined;
    }
  }

  // ------------------------------------------------------------------ actions

  private baseLabel(): string {
    return this.scope.kind === 'head' ? 'HEAD' : this.scope.ref;
  }

  /** A click: the object view's changes in the split editor, a deleted one as text, other files as a text diff. */
  async open(n: ChangeNode): Promise<void> {
    if (!n.fsPath || !n.base) return;
    if (n.type === 'other') return this.openText(n);
    const v = n.view;
    if (!v) return;
    if (v.change === 'deleted') {
      // The tab is named after the last path segment: no ref names (origin/develop) in it.
      const uri = vscode.Uri.from({
        scheme: BASE_SCHEME,
        path: `/${v.label} (deleted)`,
        query: JSON.stringify({ fsPath: n.fsPath, commit: n.base, from: n.from, objectId: v.objectId, accessor: v.accessor }),
      });
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, 'twincat-st');
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    // The branch scope compares with the merge base, taken again by the split editor after a rebase.
    const base: CompareBase = this.scope.kind === 'head' ? HEAD_BASE : { ref: this.scope.ref, label: this.scope.ref, mergeBase: true };
    await this.openChanges?.(n.fsPath, v.objectId, v.accessor, base);
  }

  /** Text of a deleted object view at the commit compared with (read-only); a property with its accessors. */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as { fsPath: string; commit: string; from?: string; objectId: string; accessor?: 'Get' | 'Set' };
    const obj = (await this.git.fileAtCommit(q.fsPath, q.commit, q.from)).file?.objects.get(q.objectId);
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
    const api = await gitApi();
    const at = (ref: string) => api?.toGitUri(n.from && n.root ? vscode.Uri.file(path.join(n.root, n.from)) : file, ref);
    const left = at(n.base!);
    if (!left || n.status === 'A') {
      await vscode.commands.executeCommand('vscode.open', file, { preview: true });
    } else if (n.status === 'D') {
      await vscode.commands.executeCommand('vscode.open', left, { preview: true });
    } else {
      await vscode.commands.executeCommand('vscode.diff', left, file, `${path.basename(n.fsPath!)} (${this.baseLabel()} ↔ Working Tree)`, { preview: true });
    }
  }

  /** The whole file as a notebook diff against the commit compared with. */
  async openNotebook(n: ChangeNode): Promise<void> {
    if (n.fsPath && n.base) await openNotebookDiff(n.fsPath, this.scope.kind === 'head' ? 'HEAD' : n.base);
  }

  /** An editor holds unsaved edits of the file (a split editor, a notebook, its XML). */
  private hasUnsavedEdits(fsPath: string): boolean {
    const key = fileKey(fsPath);
    const same = (u: vscode.Uri) => {
      const p = realPathOf(u);
      return !!p && fileKey(p) === key;
    };
    return vscode.workspace.textDocuments.some(d => d.isDirty && same(d.uri))
      || vscode.workspace.notebookDocuments.some(nb => nb.isDirty && same(nb.uri));
  }

  /** Discard Changes: an object view (or a whole file) back to HEAD, after a confirmation. */
  async discard(n: ChangeNode): Promise<void> {
    if (this.scope.kind !== 'head' || !n.fsPath || !n.discard) return;
    const name = path.basename(n.fsPath);
    if (this.hasUnsavedEdits(n.fsPath)) {
      void vscode.window.showWarningMessage(`${name} has unsaved changes in an editor. Save or revert them first.`);
      return;
    }
    try {
      if (n.discard === 'file') {
        const detail = 'The file goes back to its HEAD version, in the working tree and in the index.'
          + (n.status === 'D' ? ' Its entry in the .plcproj does not come back by itself: discard the .plcproj too (Project files).' : '');
        if (!(await this.confirm(`Discard all changes in ${name}?`, detail))) return;
        await restoreFromHead(n.fsPath);
      } else {
        const v = n.view!;
        if (!(await this.confirm(`Discard the changes of ${v.label}?`, v.change === 'added'
          ? 'It is removed from the file, as when it is deleted in TwinCAT XAE.'
          : 'Its Structured Text goes back to the HEAD version. The rest of the file stays as it is.'))) return;
        // The list was made against the HEAD of then: a commit since would make this put old code back.
        if (!n.root || (await headCommit(n.root)) !== n.base) {
          void vscode.window.showWarningMessage('HEAD moved since the list was made. It is shown again: check the change and discard again.');
          this.schedule(0);
          return;
        }
        const now = parseTcFile(n.fsPath, fs.readFileSync(n.fsPath));
        let text: string;
        if (v.change === 'added') {
          text = removeMember(now, v.objectId, v.accessor);
        } else {
          const head = await this.git.fileAtCommit(n.fsPath, n.base!, n.from);
          if (!head.file) throw new Error(head.error ?? `${name} is not in HEAD`);
          text = restoreView(now, head.file, v.objectId, v.accessor);
        }
        fs.writeFileSync(n.fsPath, encodeText(text, now.bom));
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
    }
    this.schedule(100);
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

interface GitApi {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

/** The git extension's API (for VS Code's own text diffs of files at a commit). */
async function gitApi(): Promise<GitApi | undefined> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
    if (!ext) return undefined;
    return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  } catch {
    return undefined;
  }
}

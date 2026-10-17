// The TwinCAT History view in the Source Control sidebar: the commits that changed one object view (a method,
// property, accessor, action, DUT, GVL), newest first, followed through renames of its file. For a POU with
// methods or properties it lists the commits that changed any of its objects, each expanding to them. It
// shows the object of the active TwinCAT editor unless pinned; a commit opens in the commit diff panel.

import * as path from 'path';
import * as vscode from 'vscode';
import { FileLogEntry, blobBefore } from '../core/gitLog';
import { ViewChange, historyStep, viewExists } from '../core/objectChanges';
import { Accessor, viewLabel } from '../core/objectText';
import { ObjectKind, TcObject, TcSourceFile, parseTcFile } from '../core/tcfile';
import { TcWorkspace, fileKey } from '../core/workspace';
import { CHANGE_SCHEME } from './changesView';
import { CommitObject } from './commitDiff';
import { KIND_WORD, describeCommit, escapeMarkdown } from './commitsView';
import { CommitInfo, fileLog, localOnlyCommits, pathAt, readBlobs, userEmail } from './git';
import { GitChanges } from './gitChanges';
import { CompareBase, HEAD_BASE } from './objectEditor';
import { objectIcon } from './tree';

const PAGE = 50;
/** File versions read by one git process while looking for the commits that changed the object. */
const CHUNK = 40;

/** An object view whose history is shown. */
export interface HistoryTarget {
  fsPath: string;
  objectId: string;
  accessor?: Accessor;
}

type Status = 'M' | 'A' | 'D' | 'R';

export class HistoryNode {
  children: HistoryNode[] = [];
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  icon?: vscode.ThemeIcon;
  status?: Status;
  commit?: CommitInfo;
  /** The object view the node opens, and the repository-relative path of its file in the commit and its parent. */
  objectId?: string;
  accessor?: Accessor;
  path?: string;
  fromPath?: string;
  /** The object view is in the working tree (it can be compared with). */
  live?: boolean;
  parent?: HistoryNode;

  constructor(readonly id: string, readonly type: 'commit' | 'view' | 'working' | 'more', public label: string) {}
}

/** A commit that changed the target, and the object views it changed (the target's, in object mode). */
interface Found {
  entry: FileLogEntry;
  views: ViewChange[];
}

/** What is known about the history of one target. */
interface History {
  target: HistoryTarget;
  root: string;
  /** `FB_X.Method` (the tab title of the view). */
  label: string;
  /** A POU with members: the commits that changed any of its objects. */
  fileMode: boolean;
  /** The commits of HEAD that changed the file. */
  entries: FileLogEntry[];
  /** The next entry to look at. */
  next: number;
  found: Found[];
  /** The commit that created the object (or the first commit of the file) was reached. */
  done: boolean;
  /** How many commits that changed the target to find before the view shows them (Load More adds a page). */
  wanted: number;
  /** The scan running: one at a time. */
  scanning: Promise<void>;
}

function targetKey(t: HistoryTarget): string {
  return `${fileKey(t.fsPath)}|${t.objectId}|${t.accessor ?? ''}`;
}

export class HistoryView implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<HistoryNode> | undefined;
  private current: HistoryTarget | undefined;
  private pinnedTo = false;
  /** Histories read, by target (dropped when HEAD moves). */
  private readonly histories = new Map<string, Promise<History>>();
  /** `git log --follow` of a file, shared by its objects (dropped when HEAD moves). */
  private readonly logs = new Map<string, Promise<FileLogEntry[]>>();
  /** Commits not pushed yet, and user.email, per repository (dropped when refs change: a push, a fetch). */
  private readonly repoInfos = new Map<string, Promise<{ local: Set<string>; me: string }>>();
  /** The view was not refreshed after a change while it was hidden. */
  private stale = true;
  /**
   * The object view this view opened last (Uncommitted changes, Compare with Working Version) and until when its
   * split editor becoming active does not change the view's object (a POU's history opening one of its
   * methods). Any other editor does at once.
   */
  private opened: { key: string; until: number } | undefined;
  private disposed = false;
  /** Shows a commit's changes of an object view (the commit diff panel). */
  openObject?: (item: CommitObject) => Promise<void>;
  /** Opens an object view in the split editor with its changes against a base. */
  openChanges?: (fsPath: string, objectId: string, accessor: Accessor | undefined, base: CompareBase) => Promise<void>;
  log?: (message: string) => void;

  constructor(private readonly ws: TcWorkspace, private readonly git: GitChanges) {}

  attach(view: vscode.TreeView<HistoryNode>): vscode.Disposable {
    this.view = view;
    this.updateTitle();
    return view.onDidChangeVisibility(e => {
      if (e.visible && this.stale) this.refresh();
    });
  }

  get target(): HistoryTarget | undefined {
    return this.current;
  }

  get pinned(): boolean {
    return this.pinnedTo;
  }

  /** The object of the active editor (ignored while pinned, and right after this view opened that object). */
  follow(target: HistoryTarget | undefined): void {
    if (!target || this.pinnedTo) return;
    if (this.opened && targetKey(target) === this.opened.key && Date.now() < this.opened.until) return;
    this.opened = undefined;
    this.setTarget(target);
  }

  /** Shows the history of an object (Show History). */
  show(target: HistoryTarget): void {
    this.setTarget(target);
  }

  private setTarget(target: HistoryTarget): void {
    if (this.isCurrent(target)) return;
    this.current = target;
    this.updateTitle();
    this.schedule();
  }

  private isCurrent(target: HistoryTarget): boolean {
    return !!this.current && targetKey(this.current) === targetKey(target);
  }

  setPinned(on: boolean): void {
    this.pinnedTo = on;
    // Unpinned, the view goes to the active editor, whoever opened it.
    this.opened = undefined;
    void vscode.commands.executeCommand('setContext', 'twincatExplorer.historyPinned', on);
    this.updateTitle();
  }

  /** `label`: the name of the target when the working tree does not have it (deleted since). */
  private updateTitle(label?: string): void {
    if (!this.view) return;
    const t = this.current;
    const obj = t ? this.ws.getFile(t.fsPath)?.objects.get(t.objectId) : undefined;
    const name = obj && t ? viewLabel(obj, t.accessor) : label ?? (t ? path.basename(t.fsPath) : '');
    this.view.description = t ? `${name}${this.pinnedTo ? ' (pinned)' : ''}` : undefined;
  }

  /** Something changed: shown again now, or once the view shows. */
  private schedule(): void {
    this.stale = true;
    if (this.view?.visible && !this.disposed) this.refresh();
  }

  /** HEAD moved (commit, checkout, rebase): the histories are read again. */
  headMoved(): void {
    this.histories.clear();
    this.logs.clear();
    this.repoInfos.clear();
    this.schedule();
  }

  /** Refs changed (a push, a fetch): which commits are not pushed yet is read again. */
  refsChanged(): void {
    this.repoInfos.clear();
    if (this.current) this.schedule();
  }

  /** The working tree changed: the "Uncommitted changes" entry is computed again. */
  workingChanged(): void {
    if (this.current) this.schedule();
  }

  refresh(): void {
    this.stale = false;
    this.emitter.fire(undefined);
  }

  /** Reads the history again (Refresh). */
  reload(): void {
    this.histories.clear();
    this.logs.clear();
    this.repoInfos.clear();
    this.refresh();
  }

  // ------------------------------------------------------------------ reading the history

  private cached<T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>, max: number): Promise<T> {
    let p = map.get(key);
    if (!p) {
      const reading = read();
      p = reading;
      map.set(key, reading);
      // A failure is tried again the next time.
      reading.catch(() => {
        if (map.get(key) === reading) map.delete(key);
      });
      if (map.size > max) map.delete(map.keys().next().value!);
    }
    return p;
  }

  private history(target: HistoryTarget): Promise<History> {
    return this.cached(this.histories, targetKey(target), () => this.load(target), 10);
  }

  private repoInfo(root: string): Promise<{ local: Set<string>; me: string }> {
    return this.cached(this.repoInfos, fileKey(root), async () => {
      const [local, me] = await Promise.all([localOnlyCommits(root), userEmail(root)]);
      return { local, me };
    }, 10);
  }

  private async load(target: HistoryTarget): Promise<History> {
    const root = await this.git.root(target.fsPath);
    if (!root) throw new HistoryMessage(`${path.basename(target.fsPath)} is not in a git repository.`);
    const file = this.ws.getFile(target.fsPath);
    const obj = file?.objects.get(target.objectId);
    const label = obj ? viewLabel(obj, target.accessor) : path.basename(target.fsPath);
    const fileMode = !target.accessor && !!obj && obj === file?.root && obj.members.length > 0;
    // The file's path in HEAD: another one when it was moved since (not committed yet); none for a new file.
    const headPath = await pathAt(root, target.fsPath, 'HEAD');
    const entries = headPath ? await this.cached(this.logs, `${fileKey(root)}|${headPath}`, () => fileLog(root, headPath), 20) : [];
    return { target, root, label, fileMode, entries, next: 0, found: [], done: entries.length === 0, wanted: PAGE, scanning: Promise.resolve() };
  }

  /** Looks at further commits until `wanted` commits that changed the target are found (one scan at a time). */
  private scan(h: History): Promise<void> {
    const next = h.scanning.then(() => this.scanNow(h));
    // A failed scan (git failed) does not block the next one.
    h.scanning = next.catch(() => undefined);
    return next;
  }

  private async scanNow(h: History): Promise<void> {
    // Versions of the file by blob; null for one that does not parse (a conflict committed by mistake).
    const files = new Map<string, TcSourceFile | null>();
    while (!h.done && h.found.length < h.wanted) {
      // Another object was picked meanwhile: this one goes on when it is shown again.
      if (!this.isCurrent(h.target)) return;
      const chunk = h.entries.slice(h.next, h.next + CHUNK);
      if (chunk.length === 0) {
        h.done = true;
        break;
      }
      const missing = [...new Set(chunk.flatMap(e => [blobBefore(e), e.newBlob]))].filter((b): b is string => !!b && !files.has(b));
      const blobs = await readBlobs(h.root, missing);
      missing.forEach((blob, i) => {
        const bytes = blobs[i];
        const file = bytes ? parseTcFile(h.target.fsPath, bytes) : undefined;
        files.set(blob, file && !file.error ? file : null);
      });
      for (const e of chunk) {
        h.next++;
        const old = blobBefore(e);
        const before = old ? files.get(old) : undefined;
        const now = e.newBlob ? files.get(e.newBlob) : undefined;
        // A version that does not parse tells nothing: the commits around it do.
        if (before === null || now === null) continue;
        const step = historyStep(before, now, h.target.objectId, h.target.accessor, h.fileMode);
        if (step.views.length) h.found.push({ entry: e, views: step.views });
        // The commit that created the object: no older commit changed it. (Commits listed after it in a
        // merged history are of branches made before it.)
        if (step.created) {
          h.done = true;
          break;
        }
        if (h.found.length >= h.wanted) break;
      }
      if (h.next >= h.entries.length) h.done = true;
      // The version the next commit starts from is kept; the others are not needed any more.
      const keep = h.entries[h.next]?.newBlob;
      for (const blob of [...files.keys()]) if (blob !== keep) files.delete(blob);
    }
  }

  // ------------------------------------------------------------------ tree

  async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
    if (node) return node.children;
    const target = this.current;
    if (!this.view) return [];
    if (!target) {
      this.view.message = 'Open a TwinCAT object to see the commits that changed it.';
      return [];
    }
    let h: History;
    let info: { local: Set<string>; me: string };
    try {
      h = await this.history(target);
      await this.scan(h);
      info = await this.repoInfo(h.root);
    } catch (e) {
      // Another object was picked meanwhile: its own refresh follows.
      if (this.current !== target) return [];
      if (!(e instanceof HistoryMessage)) this.log?.(`TwinCAT History: ${(e as Error).stack ?? e}`);
      this.view.message = e instanceof HistoryMessage ? e.message : `git failed: ${(e as Error).message}`;
      return [];
    }
    if (this.current !== target) return [];
    // An object deleted since (picked in the Changes view): named as its commits name it.
    if (!h.fileMode && !this.ws.getFile(target.fsPath)?.objects.has(target.objectId) && h.found.length) {
      h.label = h.found[0].views[0].label;
      this.updateTitle(h.label);
    }
    const nodes: HistoryNode[] = [];
    const working = await this.workingNode(h);
    if (working) nodes.push(working);
    for (const f of h.found) nodes.push(this.commitNode(h, f, info));
    if (!h.done) {
      const more = new HistoryNode(`hmore:${h.found.length}`, 'more', 'Load more...');
      more.icon = new vscode.ThemeIcon('ellipsis');
      nodes.push(more);
    }
    this.view.message = nodes.length ? undefined
      : h.entries.length === 0 ? `${h.label} is not committed yet.` : `No commit of HEAD changed ${h.label}.`;
    return nodes;
  }

  getParent(node: HistoryNode): HistoryNode | undefined {
    return node.parent;
  }

  getTreeItem(n: HistoryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.iconPath = n.icon;
    // The status letter and color come from the TwinCAT Changes view's decorations.
    if (n.status) item.resourceUri = vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${encodeURIComponent(n.id)}`, query: n.status });
    const context: string[] = [n.type];
    if (n.commit && n.live) context.push('compare');
    item.contextValue = context.join(' ');
    if (n.type === 'more') item.command = { command: 'twincatExplorer.history.loadMore', title: 'Load More' };
    else if (n.type === 'working' && n.objectId) item.command = { command: 'twincatExplorer.history.openWorking', title: 'Open Changes', arguments: [n] };
    else if (n.objectId && n.commit) item.command = { command: 'twincatExplorer.history.open', title: 'Open Changes', arguments: [n] };
    return item;
  }

  private commitNode(h: History, f: Found, info: { local: Set<string>; me: string }): HistoryNode {
    const c = f.entry.commit;
    const n = new HistoryNode(`hcommit:${c.sha}`, 'commit', c.subject || '(no message)');
    const copied = f.entry.status === 'C';
    const moved = f.entry.status === 'R' ? [`Moved from ${escapeMarkdown(f.entry.oldPath)}`]
      : copied ? [`Copied from ${escapeMarkdown(f.entry.oldPath)}`] : [];
    n.commit = c;
    n.path = f.entry.newPath;
    // A copy's parent has no version of this file (the commit diff shows it new).
    n.fromPath = copied ? f.entry.newPath : f.entry.oldPath;
    const local = info.local.has(c.sha);
    if (!h.fileMode) {
      const v = f.views[0];
      const notes = v.change === 'added' ? ['Created'] : v.change === 'deleted' ? ['Deleted']
        : v.renamedFrom ? [`Renamed from ${escapeMarkdown(v.renamedFrom)}`] : [];
      Object.assign(n, describeCommit(c, local, info.me, [...notes, ...moved]));
      if (v.renamedFrom) n.description += ` · renamed from ${v.renamedFrom}`;
      n.status = v.change === 'added' ? 'A' : v.change === 'deleted' ? 'D' : 'M';
      n.objectId = h.target.objectId;
      n.accessor = h.target.accessor;
      n.live = viewExists(this.ws.getFile(h.target.fsPath), h.target.objectId, h.target.accessor);
      return n;
    }
    // A POU: the commit expands to the objects it changed.
    const rootChange = f.views.find(v => v.objectId === h.target.objectId && !v.accessor);
    Object.assign(n, describeCommit(c, local, info.me, [
      ...(rootChange?.change === 'added' ? ['Created'] : []), ...moved, f.views.map(v => escapeMarkdown(v.label)).join(', '),
    ]));
    n.status = rootChange?.change === 'added' ? 'A' : 'M';
    const live = this.ws.getFile(h.target.fsPath);
    for (const v of f.views) {
      const short = v.label.startsWith(`${h.label}.`) ? v.label.slice(h.label.length + 1) : v.label;
      const vn = new HistoryNode(`hview:${c.sha}:${v.objectId}:${v.accessor ?? ''}`, 'view', short);
      Object.assign(vn, { commit: c, path: n.path, fromPath: n.fromPath, objectId: v.objectId, accessor: v.accessor, parent: n });
      vn.status = v.change === 'added' ? 'A' : v.change === 'deleted' ? 'D' : 'M';
      vn.live = viewExists(live, v.objectId, v.accessor);
      vn.icon = viewIcon(live?.objects.get(v.objectId), v.kind, v.accessor);
      const words = [v.accessor ? `${v.accessor} accessor` : KIND_WORD[v.kind]];
      if (v.renamedFrom) words.push(`renamed from ${v.renamedFrom}`);
      vn.description = words.join(' · ');
      vn.tooltip = `${v.label} (${v.change})`;
      n.children.push(vn);
    }
    return n;
  }

  /** "Uncommitted changes": the target (or for a POU, its objects) differs from HEAD. */
  private async workingNode(h: History): Promise<HistoryNode | undefined> {
    let views: ViewChange[] | undefined;
    try {
      views = await this.git.viewChangesOf(h.target.fsPath);
    } catch {
      return undefined;
    }
    // A deleted view cannot be opened in the split editor.
    views = views?.filter(v => v.change !== 'deleted' && (h.fileMode || (v.objectId === h.target.objectId && v.accessor === h.target.accessor)));
    if (!views?.length) return undefined;
    const n = new HistoryNode('hworking', 'working', 'Uncommitted changes');
    n.description = 'Working Tree';
    n.icon = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    n.tooltip = `Changes of ${h.label} since HEAD, saved but not committed`;
    if (!h.fileMode) {
      n.objectId = h.target.objectId;
      n.accessor = h.target.accessor;
      return n;
    }
    const live = this.ws.getFile(h.target.fsPath);
    for (const v of views) {
      const short = v.label.startsWith(`${h.label}.`) ? v.label.slice(h.label.length + 1) : v.label;
      const vn = new HistoryNode(`hworking:${v.objectId}:${v.accessor ?? ''}`, 'working', short);
      Object.assign(vn, { objectId: v.objectId, accessor: v.accessor, parent: n });
      vn.status = v.change === 'added' ? 'A' : 'M';
      vn.icon = viewIcon(live?.objects.get(v.objectId), v.kind, v.accessor);
      vn.description = v.accessor ? `${v.accessor} accessor` : KIND_WORD[v.kind];
      n.children.push(vn);
    }
    return n;
  }

  // ------------------------------------------------------------------ actions

  /** This view opens an object view in its split editor (see `opened`). */
  private opening(fsPath: string, objectId: string, accessor: Accessor | undefined): void {
    this.opened = { key: targetKey({ fsPath, objectId, accessor }), until: Date.now() + 2000 };
  }

  /** A commit's changes of an object view, in the commit diff panel. */
  async open(n: HistoryNode): Promise<void> {
    const t = this.current;
    if (!t || !n.commit || !n.objectId || !n.path) return;
    const root = await this.git.root(t.fsPath);
    if (!root) return;
    await this.openObject?.({
      root, commit: n.commit.sha, parent: n.commit.parents[0], path: n.path, fromPath: n.fromPath ?? n.path,
      objectId: n.objectId, accessor: n.accessor,
    });
  }

  /** The uncommitted changes of an object view, in its split editor. */
  async openWorking(n: HistoryNode): Promise<void> {
    const t = this.current;
    if (!t || !n.objectId) return;
    this.opening(t.fsPath, n.objectId, n.accessor);
    await this.openChanges?.(t.fsPath, n.objectId, n.accessor, HEAD_BASE);
  }

  /** The object view as it is now, with its changes since a commit, in its split editor. */
  async compareWithWorking(n: HistoryNode): Promise<void> {
    const t = this.current;
    if (!t || !n.objectId || !n.commit) return;
    this.opening(t.fsPath, n.objectId, n.accessor);
    // The file's path in that commit is known: no rename has to be looked up.
    await this.openChanges?.(t.fsPath, n.objectId, n.accessor, { ref: n.commit.sha, label: n.commit.sha.slice(0, 7), path: n.path });
  }

  async loadMore(): Promise<void> {
    const t = this.current;
    if (!t) return;
    try {
      const h = await this.history(t);
      h.wanted = h.found.length + PAGE;
    } catch (e) {
      this.log?.(`TwinCAT History: ${(e as Error).stack ?? e}`);
    }
    // The view reads the next page.
    this.refresh();
  }

  /** Nodes shown at the top level, for the tests. */
  async rootNodes(): Promise<HistoryNode[]> {
    return this.getChildren();
  }

  dispose(): void {
    this.disposed = true;
    this.emitter.dispose();
  }
}

/** A reason the view has nothing to show, said in its message. */
class HistoryMessage extends Error {}

/** Icon of an object view; for an object deleted since, the icon of its kind. */
function viewIcon(obj: TcObject | undefined, kind: ObjectKind, accessor?: Accessor): vscode.ThemeIcon {
  if (accessor) return new vscode.ThemeIcon(accessor === 'Get' ? 'arrow-small-left' : 'arrow-small-right', new vscode.ThemeColor('symbolIcon.methodForeground'));
  return objectIcon(obj ?? ({ kind } as TcObject));
}

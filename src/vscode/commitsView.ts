// The TwinCAT Commits view in the Source Control sidebar, like GitLens' commits: the commits of HEAD, newest
// first, as `git log` lists them. A commit expands to the files it changed: its POUs, each expanding to the
// objects the commit changed, which open in the commit diff panel (the split editor's layout, against the
// commit's parent), then the project files and every other file, which open in VS Code's diff editor.

import * as path from 'path';
import * as vscode from 'vscode';
import { TcSourceFile, parseTcFile } from '../core/tcfile';
import { ViewChange, metadataChange, viewChanges } from '../core/objectChanges';
import { Status, statusUri, viewChangeItem } from './changesView';
import { CommitObject } from './commitDiff';
import { CommitInfo, commitChanges, commitLog, headCommit, localOnlyCommits, openNotebookDiff, readBlobs, revision, userEmail } from './git';
import { GitChanges } from './gitChanges';
import { TreeIcon, compareLabels, objectIcon, objectTreeLabel, projectFileIcon } from './tree';
import { isSourcePath } from './uris';
import { escapeMarkdown } from '../shared/markdown';
import { relativeTime } from '../shared/time';

const PAGE = 30;
const PROJECT_FILE = /\.(tsproj|plcproj)$/i;

export class CommitNode {
  children: CommitNode[] = [];
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  icon?: TreeIcon;
  status?: Status;
  commit?: CommitInfo;
  root?: string;
  /** Repository-relative path of the file in the commit, and in its parent. */
  path?: string;
  fromPath?: string;
  view?: ViewChange;
  /** The node above (a commit for its files, a file for its objects). */
  parent?: CommitNode;

  constructor(readonly id: string, readonly type: 'commit' | 'file' | 'view' | 'other' | 'more', public label: string) {}
}

export class CommitsView implements vscode.TreeDataProvider<CommitNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CommitNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<CommitNode> | undefined;
  private root: string | undefined;
  private commits: CommitInfo[] = [];
  private count = PAGE;
  private more = false;
  private loading: Promise<void> | undefined;
  /** Commits no remote has (shown with an arrow, not pushed yet). */
  private local = new Set<string>();
  private me = '';
  /** Files and objects per commit (a commit never changes). */
  private readonly files = new Map<string, Promise<CommitNode[]>>();
  private timer: NodeJS.Timeout | undefined;
  private stale = true;
  private disposed = false;
  /** Shows an object as a commit changed it (the commit diff panel). */
  openObject?: (item: CommitObject) => Promise<void>;
  log?: (message: string) => void;

  constructor(private readonly git: GitChanges) {}

  attach(view: vscode.TreeView<CommitNode>): vscode.Disposable {
    this.view = view;
    return view.onDidChangeVisibility(e => {
      if (e.visible && this.stale) this.refresh();
    });
  }

  /** HEAD or the refs moved: the list is read again, now or once the view shows. */
  schedule(delay = 500): void {
    this.stale = true;
    if (!this.view?.visible || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, delay);
  }

  refresh(): void {
    this.stale = false;
    this.loading = undefined;
    this.emitter.fire(undefined);
  }

  loadMore(): void {
    this.count += PAGE;
    this.refresh();
  }

  private async load(): Promise<void> {
    const repos = await this.git.repositories();
    this.root = repos[0];
    if (!this.root) {
      this.commits = [];
      this.more = false;
      if (this.view) this.view.message = 'The TwinCAT projects are not in a git repository.';
      return;
    }
    if (this.view) this.view.description = repos.length > 1 ? path.basename(this.root) : undefined;
    // `git log HEAD` fails in a repository without commits.
    if (!(await headCommit(this.root))) {
      this.commits = [];
      this.more = false;
      if (this.view) this.view.message = 'The repository has no commits yet.';
      return;
    }
    const [list, local, me] = await Promise.all([
      commitLog(this.root, this.count + 1), localOnlyCommits(this.root), userEmail(this.root),
    ]);
    this.more = list.length > this.count;
    this.commits = list.slice(0, this.count);
    this.local = local;
    this.me = me;
    if (this.view) this.view.message = undefined;
  }

  async getChildren(node?: CommitNode): Promise<CommitNode[]> {
    if (!node) {
      if (!this.loading) {
        this.loading = this.load().catch(e => {
          this.log?.(`TwinCAT Commits: ${(e as Error).stack ?? e}`);
          if (this.view) this.view.message = `git failed: ${(e as Error).message}`;
        });
      }
      await this.loading;
      const nodes = this.commits.map(c => this.commitNode(c));
      if (this.more) {
        const more = new CommitNode(`more:${this.count}`, 'more', 'Load more commits...');
        more.icon = new vscode.ThemeIcon('ellipsis');
        nodes.push(more);
      }
      return nodes;
    }
    if (node.type === 'commit' && node.commit) return this.filesOf(node.commit);
    return node.children;
  }

  getParent(node: CommitNode): CommitNode | undefined {
    return node.parent;
  }

  getTreeItem(n: CommitNode): vscode.TreeItem {
    const state = n.type === 'commit' ? vscode.TreeItemCollapsibleState.Collapsed
      : n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, state);
    item.id = n.id;
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.iconPath = n.icon;
    // The status letter and color come from the Changes view's provideFileDecoration. A file's name ends the
    // path: the file icon theme picks the icon of a plain file by it.
    const name = n.type !== 'view' && n.path ? `/${path.posix.basename(n.path)}` : '';
    if (n.status) item.resourceUri = statusUri(n.id, n.status, name);
    const context: string[] = [n.type];
    // A whole-file notebook diff needs both sides: not for a file deleted, nor for the first commit.
    if (n.type === 'file' && n.status !== 'D' && n.commit?.parents.length) context.push('notebookDiff');
    item.contextValue = context.join(' ');
    if (n.type === 'view') item.command = { command: 'twincatExplorer.commits.open', title: 'Open Changes', arguments: [n] };
    if (n.type === 'other') item.command = { command: 'twincatExplorer.commits.openText', title: 'Open Changes', arguments: [n] };
    if (n.type === 'more') item.command = { command: 'twincatExplorer.commits.loadMore', title: 'Load More Commits' };
    return item;
  }

  private commitNode(c: CommitInfo): CommitNode {
    const n = new CommitNode(`commit:${c.sha}`, 'commit', c.subject || '(no message)');
    n.commit = c;
    n.root = this.root;
    // A merge shows what it brought into the branch.
    const merge = c.parents.length > 1 ? [`Merge commit: its files are compared with the first parent \`${c.parents[0].slice(0, 7)}\``] : [];
    Object.assign(n, describeCommit(c, this.local.has(c.sha), this.me, merge));
    return n;
  }

  private filesOf(c: CommitInfo): Promise<CommitNode[]> {
    let files = this.files.get(c.sha);
    if (!files) {
      const computing = this.computeFiles(c).then(({ nodes, failed }) => {
        // What could not be read is read again at the next expansion.
        if (failed && this.files.get(c.sha) === computing) this.files.delete(c.sha);
        return nodes;
      }, e => {
        if (this.files.get(c.sha) === computing) this.files.delete(c.sha);
        const n = new CommitNode(`error:${c.sha}`, 'other', `git failed: ${(e as Error).message}`);
        n.icon = new vscode.ThemeIcon('warning');
        return [n];
      });
      files = computing;
      this.files.set(c.sha, files);
    }
    return files;
  }

  private async computeFiles(c: CommitInfo): Promise<{ nodes: CommitNode[]; failed: boolean }> {
    const root = this.root!;
    const parent = c.parents[0];
    // Same id as the commit's node in the list, which is what VS Code matches (reveal).
    const commitNode = this.commitNode(c);
    const changes = (await commitChanges(root, c.sha, parent)).map(ch => {
      const rel = path.relative(root, ch.fsPath).split(path.sep).join('/');
      return { ch, rel, fromRel: ch.from ?? rel };
    });
    // Both versions of every TwinCAT source file in one git process.
    const specs: string[] = [];
    const at = (spec: string | undefined) => (spec === undefined ? -1 : specs.push(spec) - 1);
    const reads = changes.map(({ ch, rel, fromRel }) => isSourcePath(ch.fsPath)
      ? { after: at(ch.status === 'D' ? undefined : `${c.sha}:${rel}`), before: at(parent && ch.status !== 'A' ? `${parent}:${fromRel}` : undefined) }
      : undefined);
    const blobs = await readBlobs(root, specs);
    const parse = (index: number, fsPath: string, label: string): { file?: TcSourceFile; error?: string } => {
      if (index < 0) return {};
      const blob = blobs[index];
      if (!blob) return { error: `${label} is missing` };
      const file = parseTcFile(fsPath, blob);
      return file.error ? { error: `${label} does not parse: ${file.error}` } : { file };
    };
    const sources: CommitNode[] = [];
    const others: CommitNode[] = [];
    const plain: CommitNode[] = [];
    const seen = new Set<string>();
    let failed = false;
    changes.forEach(({ ch, rel, fromRel }, i) => {
      const node = new CommitNode(`cfile:${c.sha}:${rel}`, isSourcePath(ch.fsPath) ? 'file' : 'other', path.basename(ch.fsPath));
      if (seen.has(node.id)) return;
      seen.add(node.id);
      Object.assign(node, { commit: c, root, path: rel, fromPath: fromRel, status: ch.status, parent: commitNode });
      const dir = path.posix.dirname(rel);
      node.description = dir === '.' ? '' : dir;
      node.tooltip = ch.from ? `${rel}\nRenamed from ${ch.from}` : rel;
      const read = reads[i];
      if (node.type === 'other' || !read) {
        // Not a POU: TwinCAT project files with their own icon, any other file with the file icon theme's.
        if (PROJECT_FILE.test(rel)) {
          node.icon = projectFileIcon(rel);
          others.push(node);
        } else {
          node.icon = vscode.ThemeIcon.File;
          plain.push(node);
        }
        return;
      }
      // A file without object changes to show (unreadable, renamed, metadata only): its XML diff on a click.
      const leaf = (description: string, icon?: TreeIcon) => {
        const n = new CommitNode(node.id, 'other', node.label);
        Object.assign(n, { commit: c, root, path: rel, fromPath: fromRel, status: ch.status, tooltip: node.tooltip, description, icon: icon ?? node.icon, parent: commitNode });
        return n;
      };
      const after = parse(read.after, ch.fsPath, `${rel} at ${c.sha.slice(0, 7)}`);
      const before = parse(read.before, path.join(root, fromRel), `${fromRel} at ${parent?.slice(0, 7)}`);
      const error = after.error ?? before.error;
      if (error) {
        failed = true;
        others.push(leaf(`cannot be read: ${error}`, new vscode.ThemeIcon('warning')));
        return;
      }
      const rootObject = after.file?.root ?? before.file?.root;
      if (rootObject) {
        node.label = objectTreeLabel(rootObject);
        node.icon = objectIcon(rootObject);
      }
      const views = viewChanges(before.file, after.file);
      if (views.length === 0) {
        sources.push(leaf(ch.status === 'R' ? `renamed from ${ch.from}`
          : before.file && after.file ? metadataChange(before.file.text, after.file.text) : ''));
        return;
      }
      for (const v of views) {
        const item = viewChangeItem(v, (v.change === 'deleted' ? before.file : after.file)?.objects.get(v.objectId), rootObject?.name);
        const vn = new CommitNode(`cview:${c.sha}:${rel}:${v.objectId}:${v.accessor ?? ''}`, 'view', item.label);
        // Two objects with one GUID (XML copied by hand) would give two equal ids, and VS Code shows nothing.
        if (seen.has(vn.id)) continue;
        seen.add(vn.id);
        Object.assign(vn, item, { commit: c, root, path: rel, fromPath: fromRel, view: v, parent: node });
        node.children.push(vn);
      }
      sources.push(node);
    });
    const byLabel = (a: CommitNode, b: CommitNode) => compareLabels(a.label, b.label)
      || (a.path ?? '').localeCompare(b.path ?? '');
    return { nodes: [...sources.sort(byLabel), ...others.sort(byLabel), ...plain.sort(byLabel)], failed };
  }

  // ------------------------------------------------------------------ actions

  /** A changed object: the commit diff panel. */
  async open(n: CommitNode): Promise<void> {
    if (!n.commit || !n.root || !n.path || !n.view) return;
    await this.openObject?.({
      root: n.root, commit: n.commit.sha, parent: n.commit.parents[0], path: n.path, fromPath: n.fromPath ?? n.path,
      objectId: n.view.objectId, accessor: n.view.accessor,
    });
  }

  /**
   * Any file but a POU with object changes (project files, other files, renames, metadata): VS Code's diff
   * editor, the first parent against the commit; an added or deleted file against an empty one.
   */
  async openText(n: CommitNode): Promise<void> {
    if (!n.commit || !n.root || !n.path) return;
    const parent = n.commit.parents[0];
    const from = n.fromPath ?? n.path;
    const left = await revision(n.root, from, n.status === 'A' ? undefined : parent);
    const right = await revision(n.root, n.path, n.status === 'D' ? undefined : n.commit.sha);
    const renamed = from !== n.path ? `${path.posix.basename(from)} → ` : '';
    const refs = `${parent ? `${parent.slice(0, 7)} ↔ ` : ''}${n.commit.sha.slice(0, 7)}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, `${renamed}${path.posix.basename(n.path)} (${refs})`, { preview: true });
  }

  /** The whole POU file as a notebook diff, parent against commit. */
  async openNotebook(n: CommitNode): Promise<void> {
    if (!n.commit || !n.root || !n.path) return;
    const parent = n.commit.parents[0];
    if (!parent) return;
    await openNotebookDiff(path.join(n.root, n.path), parent, n.commit.sha, { left: n.fromPath ?? n.path, right: n.path });
  }

  /** Nodes shown at the top level, for the tests. */
  async rootNodes(): Promise<CommitNode[]> {
    return this.getChildren();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}


/**
 * Description (`You, 2 days ago`), icon (an arrow for a commit not pushed yet, else a commit or a merge) and
 * tooltip of a commit in a tree view; `more` adds lines to the tooltip.
 */
export function describeCommit(c: CommitInfo, local: boolean, me: string, more: string[] = []):
  { description: string; icon: vscode.ThemeIcon; tooltip: vscode.MarkdownString } {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMarkdown(c.subject)}**\n\n`);
  if (c.body) md.appendText(`${c.body}\n\n`);
  for (const line of more) md.appendMarkdown(`${line}\n\n`);
  md.appendMarkdown(`${escapeMarkdown(c.author)} · ${new Date(c.date * 1000).toLocaleString()} · \`${c.sha.slice(0, 7)}\``);
  if (local) md.appendMarkdown(' · not pushed');
  return {
    description: `${c.email && c.email === me ? 'You' : c.author}, ${relativeTime(c.date)}`,
    icon: local
      ? new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('gitDecoration.addedResourceForeground'))
      : new vscode.ThemeIcon(c.parents.length > 1 ? 'git-merge' : 'git-commit'),
    tooltip: md,
  };
}

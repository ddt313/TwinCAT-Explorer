// The TwinCAT Commits view in the Source Control sidebar, like GitLens' commits: the commits of HEAD that
// changed TwinCAT files, newest first. A commit expands to its POUs and other TwinCAT files, a POU to the
// objects the commit changed, which open in the commit diff panel (the split editor's layout, against the
// commit's parent).

import * as path from 'path';
import * as vscode from 'vscode';
import { ObjectKind, TcSourceFile, parseTcFile } from '../core/tcfile';
import { ViewChange, metadataChange, viewChanges } from '../core/objectChanges';
import { TcWorkspace } from '../core/workspace';
import { CHANGE_SCHEME, gitApi } from './changesView';
import { CommitObject } from './commitDiff';
import { CommitInfo, commitChanges, commitLog, localOnlyCommits, openNotebookDiff, readBlobs, userEmail } from './git';
import { GitChanges } from './gitChanges';
import { objectIcon, objectTreeLabel } from './tree';
import { SOURCE_EXTENSIONS, isSourcePath } from './uris';

const PAGE = 30;
const EXTENSIONS = [...SOURCE_EXTENSIONS, '.tsproj', '.plcproj'];

type Status = 'M' | 'A' | 'D' | 'R';

const KIND_WORD: Record<ObjectKind, string> = {
  pou: 'POU', method: 'Method', property: 'Property', action: 'Action', transition: 'Transition',
  dut: 'DUT', gvl: 'GVL', itf: 'Interface',
};

export class CommitNode {
  children: CommitNode[] = [];
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  icon?: vscode.ThemeIcon;
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

/** `3 days ago`, like GitLens. */
export function relativeTime(seconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - seconds);
  const steps: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, unit] of steps) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
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

  constructor(private readonly ws: TcWorkspace, private readonly git: GitChanges) {}

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
    const [list, local, me] = await Promise.all([
      commitLog(this.root, EXTENSIONS, this.count + 1), localOnlyCommits(this.root), userEmail(this.root),
    ]);
    this.more = list.length > this.count;
    this.commits = list.slice(0, this.count);
    this.local = local;
    this.me = me;
    if (this.view) {
      this.view.message = this.commits.length ? undefined : 'No commit of HEAD changed a TwinCAT file.';
      this.view.description = repos.length > 1 ? path.basename(this.root) : undefined;
    }
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
    if (n.status) item.resourceUri = vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${encodeURIComponent(n.id)}`, query: n.status });
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
    const local = this.local.has(c.sha);
    n.description = `${c.email && c.email === this.me ? 'You' : c.author}, ${relativeTime(c.date)}`;
    n.icon = local
      ? new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('gitDecoration.addedResourceForeground'))
      : new vscode.ThemeIcon('git-commit');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMarkdown(c.subject)}**\n\n`);
    if (c.body) md.appendText(`${c.body}\n\n`);
    md.appendMarkdown(`${escapeMarkdown(c.author)} · ${new Date(c.date * 1000).toLocaleString()} · \`${c.sha.slice(0, 7)}\``);
    if (local) md.appendMarkdown(' · not pushed');
    n.tooltip = md;
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
    const changes = (await commitChanges(root, c.sha, parent, EXTENSIONS)).map(ch => {
      const rel = path.relative(root, ch.fsPath).split(path.sep).join('/');
      return { ch, rel, fromRel: ch.from ?? rel };
    });
    // Both versions of every source file in one git process.
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
    const seen = new Set<string>();
    let failed = false;
    changes.forEach(({ ch, rel, fromRel }, i) => {
      const node = new CommitNode(`cfile:${c.sha}:${rel}`, isSourcePath(ch.fsPath) ? 'file' : 'other', path.basename(ch.fsPath));
      if (seen.has(node.id)) return;
      seen.add(node.id);
      Object.assign(node, { commit: c, root, path: rel, fromPath: fromRel, status: ch.status, parent: commitNode });
      node.description = path.posix.dirname(rel);
      node.tooltip = ch.from ? `${rel}\nRenamed from ${ch.from}` : rel;
      const read = reads[i];
      if (node.type === 'other' || !read) {
        node.icon = new vscode.ThemeIcon('project');
        others.push(node);
        return;
      }
      // A file without object changes to show (unreadable, renamed, metadata only): its XML diff on a click.
      const leaf = (description: string, icon?: vscode.ThemeIcon) => {
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
        const short = rootObject && v.label.startsWith(`${rootObject.name}.`) ? v.label.slice(rootObject.name.length + 1) : v.label;
        const vn = new CommitNode(`cview:${c.sha}:${rel}:${v.objectId}:${v.accessor ?? ''}`, 'view', short);
        // Two objects with one GUID (XML copied by hand) would give two equal ids, and VS Code shows nothing.
        if (seen.has(vn.id)) continue;
        seen.add(vn.id);
        Object.assign(vn, { commit: c, root, path: rel, fromPath: fromRel, view: v, parent: node });
        vn.status = v.change === 'added' ? 'A' : v.change === 'deleted' ? 'D' : 'M';
        const obj = (v.change === 'deleted' ? before.file : after.file)?.objects.get(v.objectId);
        vn.icon = v.accessor
          ? new vscode.ThemeIcon(v.accessor === 'Get' ? 'arrow-small-left' : 'arrow-small-right', new vscode.ThemeColor('symbolIcon.methodForeground'))
          : obj ? objectIcon(obj) : undefined;
        const words = [v.accessor ? `${v.accessor} accessor` : KIND_WORD[v.kind]];
        if (v.renamedFrom) words.push(`renamed from ${v.renamedFrom}`);
        vn.description = words.join(' · ');
        vn.tooltip = `${v.label} (${v.change})`;
        node.children.push(vn);
      }
      sources.push(node);
    });
    const byLabel = (a: CommitNode, b: CommitNode) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    return { nodes: [...sources.sort(byLabel), ...others.sort(byLabel)], failed };
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

  /** A file without object changes (project files, renames, metadata): VS Code's text diff of the XML. */
  async openText(n: CommitNode): Promise<void> {
    if (!n.commit || !n.root || !n.path) return;
    const api = await gitApi();
    if (!api) return;
    const parent = n.commit.parents[0];
    const right = n.status === 'D' ? undefined : api.toGitUri(vscode.Uri.file(path.join(n.root, n.path)), n.commit.sha);
    const left = !parent || n.status === 'A' ? undefined : api.toGitUri(vscode.Uri.file(path.join(n.root, n.fromPath ?? n.path)), parent);
    const short = n.commit.sha.slice(0, 7);
    if (left && right) {
      await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(n.path)} (${short})`, { preview: true });
    } else if (left ?? right) {
      await vscode.commands.executeCommand('vscode.open', left ?? right, { preview: true });
    }
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

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}

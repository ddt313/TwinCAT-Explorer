// TwinCAT: Show Call Hierarchy: what calls a function, program, function block (its body), method or action, and what it
// calls (lang/callGraph.ts), in VS Code's References view, one group each, expanded level by level; a quick pick when
// that view's extension is disabled. Callers go up to the tasks that call a program; a method's include the calls
// through what it implements or overrides (via). From the split editor, the commit diff, a notebook cell or the
// TwinCAT tree; a caller or callee opens the split editor at its call.

import * as vscode from 'vscode';
import { positionIn } from '../core/objectText';
import { fileKey } from '../core/workspace';
import { CallGroup, CallSite, Callable, callGraphOf, callGroups, callableAt, isCallable } from '../lang/callGraph';
import { LanguageIndex } from '../lang/index';
import { symbolLabel } from '../lang/rename';
import { Loc } from '../lang/symbols';
import { LanguageFeatures, describeOwner } from './language';
import { SymbolTreeInput, SymbolTreeModel, referencesView } from './referencesView';

type Direction = 'incoming' | 'outgoing';

const DIRECTIONS: Record<Direction, { label: string; icon: string }> = {
  incoming: { label: 'Incoming Calls', icon: 'call-incoming' },
  outgoing: { label: 'Outgoing Calls', icon: 'call-outgoing' },
};

/** A node of the References view: the callable, the group of its incoming or outgoing calls, or a caller or callee. */
interface Node {
  callable?: Callable;
  direction?: Direction;
  /** A caller's or callee's. */
  group?: CallGroup;
  parent?: Node;
  /** The callables above it (by id), where a caller or callee that comes again stops. */
  seen: Set<string>;
  children?: Node[];
}

class CallInput implements SymbolTreeInput<Node> {
  readonly contextValue = 'twincatExplorer.callHierarchy';
  readonly title = 'Call Hierarchy';

  constructor(private readonly owner: CallHierarchy, private readonly target: Callable, readonly location: vscode.Location) {}

  resolve(): SymbolTreeModel<Node> {
    return this.owner.model(this.target);
  }

  with(location: vscode.Location): CallInput {
    return new CallInput(this.owner, this.target, location);
  }
}

const NOT_CALLABLE = 'Show Call Hierarchy works on functions, programs, function blocks, methods, actions and properties: put the cursor on one (or in its code), or pick it in the TwinCAT tree.';

/** The line of a call, trimmed. */
function lineOf(site: CallSite): string {
  if (!site.loc || site.text === undefined) return '';
  return site.text.split('\n')[positionIn(site.text, site.loc.start).line]?.trim() ?? '';
}

export class CallHierarchy {
  constructor(private readonly index: LanguageIndex, private readonly features: LanguageFeatures) {}

  private locate(loc: Loc): vscode.Location | undefined {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    return ctx && this.features.splitLocator?.(ctx, loc);
  }

  /** At an offset of a section of the split editor or the commit diff (see callableAt). */
  async showAt(fk: string, key: string, text: string, offset: number): Promise<void> {
    const ctx = this.index.context(fk, key);
    const target = ctx && callableAt(this.index, this.features.analysisOf(ctx, text).occurrences, ctx, offset);
    if (!target) {
      void vscode.window.showInformationMessage(NOT_CALLABLE);
      return;
    }
    await this.show(target, this.locate({ fileKey: fk, sectionKey: key, start: offset, end: offset }));
  }

  /** At a position of a notebook cell. */
  async showInCell(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    const r = this.features.analysisForDocument(doc);
    const target = r && callableAt(this.index, r.analysis.occurrences, r.ctx, doc.offsetAt(pos));
    if (!target) {
      void vscode.window.showInformationMessage(NOT_CALLABLE);
      return;
    }
    await this.show(target, new vscode.Location(doc.uri, pos));
  }

  /** Of an object of the TwinCAT tree: its POU, method, action or property. */
  async showObject(target: { fsPath: string; objectId?: string } | undefined): Promise<void> {
    const file = target && this.index.ws.getFile(target.fsPath);
    const obj = target?.objectId ? file?.objects.get(target.objectId) : file?.root;
    let callable: Callable | undefined;
    for (const s of obj?.sections ?? []) {
      const ctx = target && this.index.context(fileKey(target.fsPath), s.key);
      const sym = ctx && (ctx.member ?? ctx.pou);
      if (sym && isCallable(sym)) {
        callable = sym;
        break;
      }
    }
    if (!callable) {
      void vscode.window.showInformationMessage(NOT_CALLABLE);
      return;
    }
    await this.show(callable);
  }

  async show(target: Callable, anchor?: vscode.Location): Promise<void> {
    const at = (target.loc && this.locate(target.loc)) || anchor;
    const view = at && await referencesView();
    if (view && at) view.setInput(new CallInput(this, target, at));
    else await this.pick(target);
  }

  /** The tree of the References view: its levels are made when expanded, from the call graph as it is then. */
  model(target: Callable): SymbolTreeModel<Node> {
    const root: Node = { callable: target, seen: new Set([target.id]) };
    root.children = (['incoming', 'outgoing'] as const).map(direction => ({ direction, parent: root, seen: root.seen }));
    const childrenOf = (node: Node): Node[] => {
      if (node.children) return node.children;
      // A direction's group: the target's calls; a caller or callee: its own, unless it is one above it (recursion).
      const g = node.group;
      const from = g ? g.next : target;
      if (!from || (g && node.seen.has(from.id))) return (node.children = []);
      const seen = g ? new Set([...node.seen, from.id]) : node.seen;
      const graph = callGraphOf(this.index, this.features.sections);
      return (node.children = callGroups(graph, from, node.direction!).map(group => ({ group, direction: node.direction, parent: node, seen })));
    };
    return {
      provider: {
        getTreeItem: node => this.treeItem(node, node === root),
        getChildren: node => (node ? childrenOf(node) : [root]),
        getParent: node => node.parent,
      },
      message: undefined,
      navigation: {
        nearest: () => root,
        next: from => from,
        previous: from => from,
        location: node => this.locationOf(node),
      },
    };
  }

  /** Where a node opens: a callable's name, a caller's or callee's first call. */
  private locationOf(node: Node): vscode.Location | undefined {
    if (node.callable?.loc) return this.locate(node.callable.loc);
    const site = node.group?.sites.find(s => s.loc);
    return site?.loc && this.locate(site.loc);
  }

  private treeItem(node: Node, root: boolean): vscode.TreeItem {
    if (root) {
      const c = node.callable!;
      const item = new vscode.TreeItem({ label: symbolLabel(c), highlights: [[0, symbolLabel(c).length]] }, vscode.TreeItemCollapsibleState.Expanded);
      item.description = describeOwner(c);
      item.iconPath = new vscode.ThemeIcon(c.kind === 'pou' ? (c.pouKind === 'FB' ? 'symbol-class' : 'symbol-function') : `symbol-${c.kind === 'property' ? 'property' : 'method'}`);
      this.command(item, node);
      return item;
    }
    if (!node.group) {
      const d = DIRECTIONS[node.direction!];
      const item = new vscode.TreeItem(d.label, node.direction === 'incoming' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(d.icon);
      return item;
    }
    const g = node.group;
    const recursive = !!g.next && node.seen.has(g.next.id);
    // Expandable when it has calls of its own (a library's has none in the workspace to show).
    const expandable = !!g.next && !recursive && callGroups(callGraphOf(this.index, this.features.sections), g.next, node.direction!).length > 0;
    const item = new vscode.TreeItem(g.label, expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const calls = g.sites.filter(s => s.loc);
    item.description = recursive ? '(recursive)' : calls.length > 1 ? `${calls.length} calls` : calls[0] ? lineOf(calls[0]) : '';
    item.tooltip = calls.map(lineOf).join('\n') || g.label;
    const c = g.next;
    item.iconPath = new vscode.ThemeIcon(g.task ? 'watch' : !c ? 'symbol-function' : c.kind === 'pou' ? (c.pouKind === 'FB' ? 'symbol-class' : 'symbol-function') : 'symbol-method');
    this.command(item, node);
    return item;
  }

  private command(item: vscode.TreeItem, node: Node): void {
    const at = this.locationOf(node);
    if (at) item.command = { command: 'vscode.open', title: 'Open', arguments: [at.uri, { selection: at.range } satisfies vscode.TextDocumentShowOptions] };
  }

  /** Callers and callees in a quick pick, when the References view is not there: one level each. */
  private async pick(target: Callable): Promise<void> {
    const graph = callGraphOf(this.index, this.features.sections);
    const items: (vscode.QuickPickItem & { loc?: Loc })[] = [];
    for (const direction of ['incoming', 'outgoing'] as const) {
      const groups = callGroups(graph, target, direction);
      if (!groups.length) continue;
      items.push({ label: DIRECTIONS[direction].label, kind: vscode.QuickPickItemKind.Separator });
      for (const g of groups) {
        const first = g.sites.find(s => s.loc);
        items.push({ label: `$(${DIRECTIONS[direction].icon}) ${g.label}`, description: first ? lineOf(first) : '', loc: first?.loc });
      }
    }
    if (!items.length) {
      void vscode.window.showInformationMessage(`No calls of or from ${symbolLabel(target)} in the workspace.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { title: `Call Hierarchy of ${symbolLabel(target)}`, matchOnDescription: true });
    const at = picked?.loc && this.locate(picked.loc);
    if (at) await vscode.commands.executeCommand('vscode.open', at.uri, { selection: at.range } satisfies vscode.TextDocumentShowOptions);
  }
}

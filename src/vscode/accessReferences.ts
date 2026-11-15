// TwinCAT: Show References by Access: the places a symbol is declared and used, grouped by how each uses it (written,
// passed to a VAR_IN_OUT, its address taken, called, read; see Occurrence.access), in VS Code's References view, or a
// quick pick when its extension is disabled. Find All References (Shift+F12) cannot tell them apart: VS Code's API
// gives its places no kind. From the split editor, the commit diff, a notebook cell or the TwinCAT tree; a place
// opens the split editor there.

import * as vscode from 'vscode';
import { fileKey } from '../core/workspace';
import { AccessGroup, AccessKind, PlaceView, accessGroups } from '../lang/features';
import { LanguageIndex } from '../lang/index';
import { symbolLabel } from '../lang/rename';
import { Loc, Sym } from '../lang/symbols';
import { LanguageFeatures } from './language';
import { SymbolTreeInput, SymbolTreeModel, referencesView } from './referencesView';

const GROUPS: Record<AccessKind, { label: string; icon: string }> = {
  declaration: { label: 'Declaration', icon: 'symbol-field' },
  write: { label: 'Write', icon: 'edit' },
  readwrite: { label: 'Read and write (VAR_IN_OUT)', icon: 'arrow-swap' },
  address: { label: 'Address taken', icon: 'symbol-reference' },
  call: { label: 'Call', icon: 'call-outgoing' },
  read: { label: 'Read', icon: 'eye' },
  type: { label: 'Type', icon: 'symbol-class' },
};

/** A node of the References view: a group, a section in it (`FB_Valve · Implementation`), or a place there. */
interface Node {
  group?: AccessGroup;
  section?: string;
  place?: PlaceView;
  parent?: Node;
  children: Node[];
  location?: vscode.Location;
}

class AccessInput implements SymbolTreeInput<Node> {
  readonly contextValue = 'twincatExplorer.accessReferences';
  readonly title = 'References by Access';

  constructor(private readonly owner: AccessReferences, private readonly sym: Sym, readonly location: vscode.Location) {}

  resolve(): SymbolTreeModel<Node> {
    return this.owner.model(this.sym);
  }

  with(location: vscode.Location): AccessInput {
    return new AccessInput(this.owner, this.sym, location);
  }
}

const NO_SYMBOL = 'Show References by Access works on a name: put the cursor on a variable, POU, method, property or type, or pick an object in the TwinCAT tree.';

export class AccessReferences {
  constructor(private readonly index: LanguageIndex, private readonly features: LanguageFeatures) {}

  /** Where a place is in the split editor: a twincat-loc rendering, which VS Code opens the split editor at. */
  private locate(loc: Loc): vscode.Location | undefined {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    return ctx && this.features.splitLocator?.(ctx, loc);
  }

  /** At an offset of a section (by file and section key) of the split editor or the commit diff. */
  async showAt(fk: string, key: string, text: string, offset: number): Promise<void> {
    const ctx = this.index.context(fk, key);
    const o = ctx && this.features.sections.occurrenceAt(this.features.analysisOf(ctx, text), offset);
    if (!o) {
      void vscode.window.showInformationMessage(NO_SYMBOL);
      return;
    }
    await this.show(o.sym, this.locate({ fileKey: fk, sectionKey: key, start: o.start, end: o.end }));
  }

  /** At a position of a notebook cell. */
  async showInCell(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    const r = this.features.analysisForDocument(doc);
    const o = r && this.features.sections.occurrenceAt(r.analysis, doc.offsetAt(pos));
    if (!o) {
      void vscode.window.showInformationMessage(NO_SYMBOL);
      return;
    }
    await this.show(o.sym, new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end))));
  }

  /** Of an object of the TwinCAT tree: its POU, interface, method, property, action, DUT or GVL. */
  async showObject(target: { fsPath: string; objectId?: string } | undefined): Promise<void> {
    const file = target && this.index.ws.getFile(target.fsPath);
    const obj = target?.objectId ? file?.objects.get(target.objectId) : file?.root;
    let sym: Sym | undefined;
    for (const s of obj?.sections ?? []) {
      const ctx = target && this.index.context(fileKey(target.fsPath), s.key);
      sym = ctx && (ctx.member ?? ctx.pou ?? ctx.types[0] ?? ctx.gvl);
      if (sym) break;
    }
    if (!sym) {
      void vscode.window.showInformationMessage(NO_SYMBOL);
      return;
    }
    await this.show(sym);
  }

  /** Shows the places of a symbol in the References view, anchored at its declaration (else `anchor`), else in a quick pick. */
  async show(sym: Sym, anchor?: vscode.Location): Promise<void> {
    const at = (sym.loc && this.locate(sym.loc)) || anchor;
    const view = at && await referencesView();
    if (view && at) view.setInput(new AccessInput(this, sym, at));
    else await this.pick(sym);
  }

  /** The tree the References view shows, from the index as it is now (symbols are compared by id). */
  model(sym: Sym): SymbolTreeModel<Node> {
    const groups = accessGroups(this.index, this.features.sections.references(sym, true));
    const roots: Node[] = [];
    const order: Node[] = [];
    for (const group of groups) {
      const node: Node = { group, children: [] };
      roots.push(node);
      for (const place of group.places) {
        let section = node.children.find(c => c.section === place.section);
        if (!section) node.children.push(section = { section: place.section, parent: node, children: [] });
        const leaf: Node = { place, parent: section, children: [], location: this.locate(place.ref.loc) };
        section.children.push(leaf);
      }
      // Places in the order shown, for Go to Next (F4).
      for (const section of node.children) order.push(...section.children);
    }
    const step = (from: Node, delta: number) => {
      const i = order.indexOf(from);
      return order[(((i < 0 ? (delta > 0 ? -1 : 0) : i) + delta) % order.length + order.length) % order.length] ?? from;
    };
    const total = order.length;
    return {
      provider: {
        getTreeItem: node => this.treeItem(node),
        getChildren: node => (node ? node.children : roots),
        getParent: node => node.parent,
      },
      message: total ? `${symbolLabel(sym)}: ${total} place(s), ${groups.map(g => `${g.places.length} ${g.kind}`).join(', ')}` : `No references of ${symbolLabel(sym)}.`,
      navigation: {
        nearest: () => order[0],
        next: from => step(from, 1),
        previous: from => step(from, -1),
        location: node => node.location,
      },
    };
  }

  private treeItem(node: Node): vscode.TreeItem {
    if (node.group) {
      const g = GROUPS[node.group.kind];
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.group.places.length);
      item.iconPath = new vscode.ThemeIcon(g.icon);
      return item;
    }
    if (!node.place) {
      const item = new vscode.TreeItem(node.section ?? '', vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.children.length);
      item.iconPath = new vscode.ThemeIcon('symbol-file');
      return item;
    }
    const p = node.place;
    const item = new vscode.TreeItem({ label: p.line, highlights: [p.highlight] }, vscode.TreeItemCollapsibleState.None);
    // The member or index it is used through, and the line: `.eState  4`.
    item.description = `${p.ref.occ.path ? `${p.ref.occ.path}  ` : ''}${p.lineNumber}`;
    item.tooltip = `${p.where}\n${p.line}`;
    const at = node.location;
    if (at) item.command = { command: 'vscode.open', title: 'Open', arguments: [at.uri, { selection: at.range } satisfies vscode.TextDocumentShowOptions] };
    return item;
  }

  /** The places in a quick pick, when the References view is not there. */
  private async pick(sym: Sym): Promise<void> {
    const groups = accessGroups(this.index, this.features.sections.references(sym, true));
    if (!groups.length) {
      void vscode.window.showInformationMessage(`No references of ${symbolLabel(sym)}.`);
      return;
    }
    const items: (vscode.QuickPickItem & { loc?: Loc })[] = groups.flatMap(g => [
      { label: `${GROUPS[g.kind].label} (${g.places.length})`, kind: vscode.QuickPickItemKind.Separator },
      ...g.places.map(p => ({ label: `$(${GROUPS[g.kind].icon}) ${p.line}`, description: p.where, loc: p.ref.loc })),
    ]);
    const picked = await vscode.window.showQuickPick(items, { title: `References of ${symbolLabel(sym)} by Access`, matchOnDescription: true });
    const at = picked?.loc && this.locate(picked.loc);
    if (at) await vscode.commands.executeCommand('vscode.open', at.uri, { selection: at.range } satisfies vscode.TextDocumentShowOptions);
  }
}

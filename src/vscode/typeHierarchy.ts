// The type hierarchy of function blocks and interfaces, and Go to Implementation of the TwinCAT tree (what they find
// is lang/hierarchy.ts'). Notebook cells get VS Code's own type hierarchy from the provider here. The split editor
// (a webview) and the tree are out of its reach: TwinCAT: Show Type Hierarchy shows the supertypes and the subtypes
// of one together in VS Code's References view, through the API its built-in references-view extension gives the
// call and type hierarchies, or in a quick pick when that extension is disabled. Both open the split editor.

import * as vscode from 'vscode';
import { TypeTree, hierarchyTypeAt, implementations, isHierarchyType, subtypes, supertypes, typeTree } from '../lang/hierarchy';
import { LanguageIndex } from '../lang/index';
import { symbolLabel } from '../lang/rename';
import { Loc, MemberSym, PouSym, isLibrarySym } from '../lang/symbols';
import { TcObject } from '../core/tcfile';
import { fileKey } from '../core/workspace';
import { LanguageFeatures, describeOwner } from './language';
import { ShowPlaces } from './rename';
import { objectIcon } from './tree';

/** The part of the API of the references-view extension used here (see its references-view.d.ts). */
interface SymbolTree {
  setInput(input: SymbolTreeInput<unknown>): void;
}

/** What the References view shows: anchored at a word of a document, resolved to a tree once shown. */
interface SymbolTreeInput<T> {
  /** The value of the `reference-list.source` context key. */
  readonly contextValue: string;
  readonly title: string;
  readonly location: vscode.Location;
  resolve(): vscode.ProviderResult<SymbolTreeModel<T>>;
  /** The same at another place: re-run from the view's history. */
  with(location: vscode.Location): SymbolTreeInput<T>;
}

interface SymbolTreeModel<T> {
  provider: vscode.TreeDataProvider<T>;
  /** Shown above the tree. */
  message: string | undefined;
  /** For Go to Next and Go to Previous (F4, Shift+F4) of the view. */
  navigation?: {
    nearest(uri: vscode.Uri, position: vscode.Position): T | undefined;
    next(from: T): T;
    previous(from: T): T;
    location(item: T): vscode.Location | undefined;
  };
}

/** The API of the References view; undefined when its extension is disabled. */
async function referencesView(): Promise<SymbolTree | undefined> {
  const ext = vscode.extensions.getExtension<SymbolTree>('vscode.references-view');
  try {
    const api = ext && (ext.isActive ? ext.exports : await ext.activate());
    return typeof api?.setInput === 'function' ? api : undefined;
  } catch {
    return undefined;
  }
}

type Direction = 'supertypes' | 'subtypes';

const GROUPS: Record<Direction, { label: string; icon: string }> = {
  supertypes: { label: 'Supertypes', icon: 'type-hierarchy-super' },
  subtypes: { label: 'Subtypes', icon: 'type-hierarchy-sub' },
};

/** A node of the References view: the type, the group of its supertypes or subtypes, or one of these. */
interface HierarchyNode {
  /** None for a group. */
  sym?: PouSym;
  /** A group's, and those in it. */
  direction?: Direction;
  parent?: HierarchyNode;
  children: HierarchyNode[];
  /** Its name in the split editor; none for a library's. */
  location?: vscode.Location;
}

/** The hierarchy of a function block or interface in the References view (the type is found again when re-run). */
class HierarchyInput implements SymbolTreeInput<HierarchyNode> {
  readonly contextValue = 'twincatExplorer.typeHierarchy';
  readonly title = 'Type Hierarchy';

  constructor(private readonly hierarchy: TypeHierarchy, private readonly pou: PouSym, readonly location: vscode.Location) {}

  resolve(): SymbolTreeModel<HierarchyNode> | undefined {
    return this.hierarchy.model(this.pou);
  }

  with(location: vscode.Location): HierarchyInput {
    return new HierarchyInput(this.hierarchy, this.pou, location);
  }
}

/** A POU as the index has it now (a rebuild makes new symbols), by its id; a library's stays. */
function current(index: LanguageIndex, pou: PouSym): PouSym | undefined {
  if (isLibrarySym(pou)) return pou;
  return index.allGlobals().find((g): g is PouSym => g.kind === 'pou' && g.id === pou.id);
}

/** Where a POU names one of its supertypes after EXTENDS or IMPLEMENTS. */
function namedAt(index: LanguageIndex, pou: PouSym, sup: PouSym): Loc | undefined {
  const loc = pou.loc;
  const q = loc && [...pou.extendsNames, ...pou.implementsNames].find(n => index.resolveGlobal(n.parts, pou.scope) === sup);
  const name = q?.parts[q.parts.length - 1];
  return loc && name && { fileKey: loc.fileKey, sectionKey: loc.sectionKey, start: name.start, end: name.end };
}

const NOT_A_TYPE = 'Show Type Hierarchy works on function blocks and interfaces: open one, put the cursor on its name, or pick it in the TwinCAT tree.';

export class TypeHierarchy implements vscode.TypeHierarchyProvider {
  /** The types of the items given to VS Code, which it gives back for their supertypes and subtypes. */
  private readonly items = new WeakMap<vscode.TypeHierarchyItem, PouSym>();

  constructor(private readonly index: LanguageIndex, private readonly features: LanguageFeatures, private readonly showPlaces: ShowPlaces) {}

  /** Where a place is in the split editor: a twincat-loc rendering, which VS Code opens the split editor at. */
  private locate(loc: Loc): vscode.Location | undefined {
    const ctx = this.index.context(loc.fileKey, loc.sectionKey);
    return ctx && this.features.splitLocator?.(ctx, loc);
  }

  private async open(loc: Loc, preview: boolean): Promise<void> {
    const at = this.locate(loc);
    if (at) await vscode.commands.executeCommand('vscode.open', at.uri, { selection: at.range, preview } satisfies vscode.TextDocumentShowOptions);
  }

  /** Where a POU is: the folder of its file in its PLC project, or its library. */
  private where(pou: PouSym): string | undefined {
    if (isLibrarySym(pou)) return describeOwner(pou);
    const ctx = pou.loc && this.index.context(pou.loc.fileKey, pou.loc.sectionKey);
    const include = ctx ? this.index.ws.entry(ctx.filePath)?.include : undefined;
    return include?.includes('\\') ? include.slice(0, include.lastIndexOf('\\')) : undefined;
  }

  /** The POU, interface, method or property of an object of a file (its POU or interface without `objectId`). */
  private symbolOf(fsPath: string, objectId?: string): PouSym | MemberSym | undefined {
    const file = this.index.ws.getFile(fsPath);
    const obj = objectId ? file?.objects.get(objectId) : file?.root;
    for (const s of obj?.sections ?? []) {
      const ctx = this.index.context(fileKey(fsPath), s.key);
      if (ctx) return ctx.member ?? ctx.pou;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ Go to Implementation

  /** Go to Implementation of an object (the TwinCAT tree's): one opens, more are listed to pick one. */
  async goToImplementation(target: { fsPath: string; objectId?: string } | undefined): Promise<void> {
    const sym = target && this.symbolOf(target.fsPath, target.objectId);
    if (!sym) {
      void vscode.window.showInformationMessage('Go to Implementation works on function blocks, interfaces, and their methods and properties.');
      return;
    }
    const locs = implementations(this.index, sym).flatMap(s => (s.loc ? [s.loc] : []));
    if (locs.length === 0) void vscode.window.showInformationMessage(`No implementation found for ${symbolLabel(sym)}.`);
    else if (locs.length === 1) await this.open(locs[0], false);
    else await this.showPlaces(`Implementations of ${symbolLabel(sym)}`, locs);
  }

  // ------------------------------------------------------------------ TwinCAT: Show Type Hierarchy

  /** Of an object: a function block or interface, or the one of a method or property. */
  async showObject(target: { fsPath: string; objectId?: string } | undefined): Promise<void> {
    const sym = target && this.symbolOf(target.fsPath, target.objectId);
    const pou = sym?.kind === 'pou' ? sym : sym?.owner;
    if (!pou || !isHierarchyType(pou)) {
      void vscode.window.showInformationMessage(NOT_A_TYPE);
      return;
    }
    await this.show(pou);
  }

  /** At an offset of a section (by file and section key) of the split editor (see hierarchyTypeAt). */
  async showAt(fk: string, key: string, text: string, offset: number): Promise<void> {
    const ctx = this.index.context(fk, key);
    const pou = ctx && hierarchyTypeAt(this.features.analysisOf(ctx, text), ctx, offset);
    if (!pou) {
      void vscode.window.showInformationMessage(NOT_A_TYPE);
      return;
    }
    await this.show(pou, this.locate({ fileKey: fk, sectionKey: key, start: offset, end: offset }));
  }

  /** At a position of a notebook cell. */
  async showInCell(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    const r = this.features.analysisForDocument(doc);
    const pou = r && hierarchyTypeAt(r.analysis, r.ctx, doc.offsetAt(pos));
    if (!pou) {
      void vscode.window.showInformationMessage(NOT_A_TYPE);
      return;
    }
    await this.show(pou, new vscode.Location(doc.uri, pos));
  }

  /**
   * Shows the supertypes and the subtypes of a function block or interface in the References view, anchored at its
   * name (`anchor`, where it was asked for, for a library's), else in a quick pick.
   */
  async show(pou: PouSym, anchor?: vscode.Location): Promise<void> {
    const at = (pou.loc && this.locate(pou.loc)) || anchor;
    const view = at && await referencesView();
    if (view && at) view.setInput(new HierarchyInput(this, pou, at));
    else await this.pick(pou);
  }

  /** The tree the References view shows, made from the index as it is now. */
  model(pou: PouSym): SymbolTreeModel<HierarchyNode> | undefined {
    const focus = current(this.index, pou);
    if (!focus) return undefined;
    const root: HierarchyNode = { sym: focus, children: [], location: focus.loc && this.locate(focus.loc) };
    const order: HierarchyNode[] = [root];
    const nodes = (trees: TypeTree[], direction: Direction, parent: HierarchyNode): HierarchyNode[] => trees.map(t => {
      const node: HierarchyNode = { sym: t.sym, direction, parent, children: [], location: t.sym.loc && this.locate(t.sym.loc) };
      order.push(node);
      node.children = nodes(t.children, direction, node);
      return node;
    });
    for (const direction of ['supertypes', 'subtypes'] as const) {
      const trees = typeTree(this.index, focus, direction);
      if (!trees.length) continue;
      const group: HierarchyNode = { direction, parent: root, children: [] };
      order.push(group);
      group.children = nodes(trees, direction, group);
      root.children.push(group);
    }
    // The next or previous node that opens, in the order shown.
    const step = (from: HierarchyNode, delta: number) => {
      const i = order.indexOf(from);
      for (let k = 1; k <= order.length; k++) {
        const node = order[(((i + delta * k) % order.length) + order.length) % order.length];
        if (node.location) return node;
      }
      return from;
    };
    return {
      provider: {
        getTreeItem: node => this.treeItem(node, node === root),
        getChildren: node => (node ? node.children : [root]),
        getParent: node => node.parent,
      },
      message: root.children.length ? undefined : `${focus.name} has no supertypes or subtypes.`,
      navigation: {
        nearest: () => root,
        next: from => step(from, 1),
        previous: from => step(from, -1),
        location: node => node.location,
      },
    };
  }

  private treeItem(node: HierarchyNode, root: boolean): vscode.TreeItem {
    const state = node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    const sym = node.sym;
    if (!sym) {
      const group = GROUPS[node.direction!];
      const item = new vscode.TreeItem(group.label, state);
      item.iconPath = new vscode.ThemeIcon(group.icon);
      return item;
    }
    const item = new vscode.TreeItem(root ? { label: sym.name, highlights: [[0, sym.name.length]] } : sym.name, state);
    item.description = this.where(sym);
    item.tooltip = `${sym.signature}\n${describeOwner(sym)}`;
    item.iconPath = objectIcon((sym.pouKind === 'ITF' ? { kind: 'itf' } : { kind: 'pou', pouKind: sym.pouKind }) as TcObject);
    const at = node.location;
    if (at) item.command = { command: 'vscode.open', title: 'Open', arguments: [at.uri, { selection: at.range } satisfies vscode.TextDocumentShowOptions] };
    return item;
  }

  /** The hierarchy in a quick pick, when the References view is not there: the supertypes, then the subtypes. */
  private async pick(pou: PouSym): Promise<void> {
    const items: (vscode.QuickPickItem & { loc?: Loc })[] = [];
    const add = (trees: TypeTree[], depth: number) => {
      for (const t of trees) {
        const icon = t.sym.pouKind === 'ITF' ? 'symbol-interface' : 'symbol-class';
        items.push({ label: `${' '.repeat(depth)}$(${icon}) ${t.sym.name}`, description: this.where(t.sym), loc: t.sym.loc });
        add(t.children, depth + 1);
      }
    };
    for (const direction of ['supertypes', 'subtypes'] as const) {
      const trees = typeTree(this.index, pou, direction);
      if (!trees.length) continue;
      items.push({ label: GROUPS[direction].label, kind: vscode.QuickPickItemKind.Separator });
      add(trees, 0);
    }
    if (!items.length) {
      void vscode.window.showInformationMessage(`${pou.name} has no supertypes or subtypes.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { title: `Type Hierarchy of ${pou.name}`, matchOnDescription: true });
    if (picked?.loc) await this.open(picked.loc, false);
  }

  // ------------------------------------------------------------------ VS Code's type hierarchy, in notebook cells

  async prepareTypeHierarchy(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.TypeHierarchyItem[] | undefined> {
    const r = this.features.analysisForDocument(doc);
    const pou = r && hierarchyTypeAt(r.analysis, r.ctx, doc.offsetAt(pos));
    const item = pou && await this.item(pou, new vscode.Location(doc.uri, doc.getWordRangeAtPosition(pos) ?? new vscode.Range(pos, pos)));
    return item ? [item] : undefined;
  }

  async provideTypeHierarchySupertypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
    const pou = this.typeOf(item);
    if (!pou) return [];
    const out: vscode.TypeHierarchyItem[] = [];
    for (const s of supertypes(this.index, pou)) {
      // A library's has no source: it is where the subtype names it.
      const named = namedAt(this.index, pou, s);
      const anchor = (named && await this.features.toLocation(named)) || new vscode.Location(item.uri, item.selectionRange);
      const i = await this.item(s, anchor);
      if (i) out.push(i);
    }
    return out;
  }

  async provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
    const pou = this.typeOf(item);
    if (!pou) return [];
    const out: vscode.TypeHierarchyItem[] = [];
    for (const s of subtypes(this.index, pou)) {
      const i = await this.item(s, new vscode.Location(item.uri, item.selectionRange));
      if (i) out.push(i);
    }
    return out;
  }

  /** An item of VS Code's type hierarchy: at its name (in a cell or the split editor, by setting), else at `anchor`. */
  private async item(pou: PouSym, anchor: vscode.Location): Promise<vscode.TypeHierarchyItem | undefined> {
    const at = pou.loc ? await this.features.toLocation(pou.loc) : anchor;
    if (!at) return undefined;
    const kind = pou.pouKind === 'ITF' ? vscode.SymbolKind.Interface : vscode.SymbolKind.Class;
    const item = new vscode.TypeHierarchyItem(kind, pou.name, this.where(pou) ?? '', at.uri, at.range, at.range);
    this.items.set(item, pou);
    return item;
  }

  /** The function block or interface of an item, as the index has it now. */
  private typeOf(item: vscode.TypeHierarchyItem): PouSym | undefined {
    const pou = this.items.get(item);
    return pou && current(this.index, pou);
  }
}

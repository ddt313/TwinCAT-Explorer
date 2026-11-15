// VS Code's References view, through the API its built-in references-view extension gives the call and type
// hierarchies: what TwinCAT: Show Type Hierarchy and Show References by Access show their trees in, where VS Code's
// own providers do not reach (the split editor is a webview).

import * as vscode from 'vscode';

/** The part of the API of the references-view extension used here (see its references-view.d.ts). */
interface SymbolTree {
  setInput(input: SymbolTreeInput<unknown>): void;
}

/** What the References view shows: anchored at a word of a document, resolved to a tree once shown. */
export interface SymbolTreeInput<T> {
  /** The value of the `reference-list.source` context key. */
  readonly contextValue: string;
  readonly title: string;
  readonly location: vscode.Location;
  resolve(): vscode.ProviderResult<SymbolTreeModel<T>>;
  /** The same at another place: re-run from the view's history. */
  with(location: vscode.Location): SymbolTreeInput<T>;
}

export interface SymbolTreeModel<T> {
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
export async function referencesView(): Promise<SymbolTree | undefined> {
  const ext = vscode.extensions.getExtension<SymbolTree>('vscode.references-view');
  try {
    const api = ext && (ext.isActive ? ext.exports : await ext.activate());
    return typeof api?.setInput === 'function' ? api : undefined;
  } catch {
    return undefined;
  }
}

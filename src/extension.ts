// Entry point: wires the TwinCAT workspace model, the tree, the object
// notebooks, the language features and the git comparisons together.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TcWorkspace } from './core/workspace';
import { objectAtOffset } from './core/tcfile';
import { LanguageIndex, StubSource } from './lang/index';
import { BUNDLED_STUBS } from './lang/stubs';
import { ObjectFileSystem, objectUriOf } from './vscode/objectFs';
import { CellLabels, FileSerializer, ObjectSerializer, cellMeta } from './vscode/serializers';
import { TreeNode, TwinCatTree } from './vscode/tree';
import { CellDiagnostics, LanguageFeatures, cellInfo } from './vscode/language';
import { DiffFileSystem, openNotebookDiff, verifyRef } from './vscode/git';
import {
  DIFF_NOTEBOOK, DIFF_SCHEME, FILE_NOTEBOOK, INDEX, OBJECT_NOTEBOOK, OBJECT_SCHEME, ST_LANGUAGE, isSourcePath,
  isTwinCatPath, parseDiffUri, parseObjectUri, realPathOf,
} from './vscode/uris';

export interface TwinCatExplorerApi {
  workspace: TcWorkspace;
  index: LanguageIndex;
  tree: TwinCatTree;
  treeView: vscode.TreeView<TreeNode>;
  features: LanguageFeatures;
  ready: Promise<void>;
  openObject(fsPath: string, objectId: string, options?: OpenOptions): Promise<vscode.NotebookEditor | undefined>;
}

interface OpenOptions {
  preview?: boolean;
  preserveFocus?: boolean;
  viewColumn?: vscode.ViewColumn;
  accessor?: 'Get' | 'Set';
}

function config() {
  return vscode.workspace.getConfiguration('twincatExplorer');
}

function userStubs(): StubSource[] {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const out: StubSource[] = [];
  for (const p of config().get<string[]>('stubFiles', [])) {
    const full = path.isAbsolute(p) || !folder ? p : path.join(folder, p);
    try {
      out.push({ path: full, text: fs.readFileSync(full, 'utf8') });
    } catch (e) {
      void vscode.window.showWarningMessage(`TwinCAT Explorer: cannot read stub file ${full}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function activate(context: vscode.ExtensionContext): TwinCatExplorerApi {
  const ws = new TcWorkspace();
  const index = new LanguageIndex(ws);
  index.setStubs([...BUNDLED_STUBS, ...userStubs()]);
  const objectFs = new ObjectFileSystem();
  const diffFs = new DiffFileSystem();
  const tree = new TwinCatTree(ws);
  const treeView = vscode.window.createTreeView('twincatExplorer.tree', { treeDataProvider: tree, showCollapseAll: true });
  const features = new LanguageFeatures(index, ws);
  const diagnostics = new CellDiagnostics(features);
  const checkCollection = vscode.languages.createDiagnosticCollection('twincat-check');
  const fileSerializer = new FileSerializer();
  const stSelector: vscode.DocumentSelector = { language: ST_LANGUAGE };

  context.subscriptions.push(
    treeView, diagnostics, checkCollection,
    vscode.workspace.registerFileSystemProvider(OBJECT_SCHEME, objectFs, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider(DIFF_SCHEME, diffFs, { isCaseSensitive: true, isReadonly: true }),
    vscode.workspace.registerNotebookSerializer(OBJECT_NOTEBOOK, new ObjectSerializer(), { transientOutputs: true }),
    vscode.workspace.registerNotebookSerializer(DIFF_NOTEBOOK, fileSerializer,
      { transientOutputs: true, transientDocumentMetadata: { original: true, bom: true } }),
    vscode.workspace.registerNotebookSerializer(FILE_NOTEBOOK, fileSerializer,
      { transientOutputs: true, transientDocumentMetadata: { original: true, bom: true } }),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(OBJECT_NOTEBOOK, new CellLabels()),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(DIFF_NOTEBOOK, new CellLabels()),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(FILE_NOTEBOOK, new CellLabels()),
    vscode.languages.registerDefinitionProvider(stSelector, features),
    vscode.languages.registerHoverProvider(stSelector, features),
    vscode.languages.registerCompletionItemProvider(stSelector, features, '.'),
    vscode.languages.registerReferenceProvider(stSelector, features),
    vscode.languages.registerDocumentSymbolProvider(stSelector, features),
    vscode.languages.registerWorkspaceSymbolProvider(features),
  );

  // ------------------------------------------------------------------ loading and change tracking

  let loadTimer: NodeJS.Timeout | undefined;
  const loadProjects = async () => {
    const exclude = config().get<string>('exclude') || undefined;
    const uris = await vscode.workspace.findFiles('**/*.tsproj', exclude);
    ws.load(uris.map(u => u.fsPath));
    index.invalidateAll();
    tree.rebuild();
    await vscode.commands.executeCommand('setContext', 'twincatExplorer.hasProjects', ws.tsProjects.length > 0);
    for (const err of ws.loadErrors) console.warn(`TwinCAT Explorer: ${err}`);
    diagnostics.scheduleAll(100);
  };
  const scheduleLoad = () => {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => void loadProjects(), 500);
  };

  const onSourceChanged = (fsPath: string) => {
    ws.invalidate(fsPath);
    index.invalidateFile(fsPath);
    objectFs.notifyRealFileChanged(fsPath);
    diffFs.notifyChanged(fsPath);
    tree.scheduleRebuild();
    diagnostics.scheduleAll();
  };
  objectFs.onDidWriteRealFile = fsPath => onSourceChanged(fsPath);

  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO,TcTTO,tcpou,tcdut,tcgvl,tcio,tctto}');
  const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{tsproj,plcproj}');
  context.subscriptions.push(
    sourceWatcher, projectWatcher,
    sourceWatcher.onDidChange(u => onSourceChanged(u.fsPath)),
    sourceWatcher.onDidCreate(u => onSourceChanged(u.fsPath)),
    sourceWatcher.onDidDelete(u => onSourceChanged(u.fsPath)),
    projectWatcher.onDidChange(scheduleLoad),
    projectWatcher.onDidCreate(scheduleLoad),
    projectWatcher.onDidDelete(scheduleLoad),
  );

  // Unsaved edits of open notebooks are visible to the rest of the index (completion, diagnostics).
  const clearOverlays = (nb: vscode.NotebookDocument) => {
    for (const cell of nb.getCells()) {
      const info = cellInfo(cell.document);
      if (info?.live) index.setOverlay(info.fileKey, info.sectionKey, undefined);
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId !== ST_LANGUAGE || e.contentChanges.length === 0) return;
      const info = cellInfo(e.document);
      if (!info?.live) return;
      index.setOverlay(info.fileKey, info.sectionKey, e.document.getText());
      diagnostics.schedule(e.document);
      diagnostics.scheduleAll(800);
    }),
    vscode.workspace.onDidOpenNotebookDocument(nb => {
      for (const cell of nb.getCells()) diagnostics.schedule(cell.document, 50);
    }),
    vscode.workspace.onDidSaveNotebookDocument(nb => {
      clearOverlays(nb);
      diagnostics.scheduleAll();
    }),
    vscode.workspace.onDidCloseNotebookDocument(nb => {
      clearOverlays(nb);
      diagnostics.clearNotebook(nb);
      diagnostics.scheduleAll();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('twincatExplorer.foldersFirst')) tree.rebuild();
      if (e.affectsConfiguration('twincatExplorer.stubFiles')) {
        index.setStubs([...BUNDLED_STUBS, ...userStubs()]);
        diagnostics.scheduleAll();
      }
      if (e.affectsConfiguration('twincatExplorer.diagnostics')) diagnostics.scheduleAll(50);
      if (e.affectsConfiguration('twincatExplorer.exclude')) scheduleLoad();
    }),
  );

  // ------------------------------------------------------------------ opening objects

  const openObject = async (fsPath: string, objectId: string, options: OpenOptions = {}) => {
    const file = ws.getFile(fsPath);
    const obj = file?.objects.get(objectId);
    if (!file || !obj) {
      void vscode.window.showWarningMessage(`TwinCAT object not found in ${path.basename(fsPath)}`);
      return undefined;
    }
    const nb = await vscode.workspace.openNotebookDocument(objectUriOf(file, obj));
    const editor = await vscode.window.showNotebookDocument(nb, {
      preview: options.preview ?? true, preserveFocus: options.preserveFocus ?? false, viewColumn: options.viewColumn,
    });
    if (options.accessor) {
      const idx = nb.getCells().findIndex(c => cellMeta(c)?.accessor === options.accessor);
      if (idx >= 0) {
        const range = new vscode.NotebookRange(idx, idx + 1);
        editor.selections = [range];
        editor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
      }
    }
    return editor;
  };

  let lastClick: { id: string; time: number } | undefined;
  const openNode = async (node: TreeNode | undefined, sideBySide = false) => {
    if (!node?.fsPath || !node.objectId) return;
    const now = Date.now();
    const doubleClick = !sideBySide && lastClick?.id === node.id && now - lastClick.time < 500;
    lastClick = { id: node.id, time: now };
    await openObject(node.fsPath, node.objectId, {
      preview: !(doubleClick || sideBySide),
      preserveFocus: !(doubleClick || sideBySide),
      viewColumn: sideBySide ? vscode.ViewColumn.Beside : undefined,
      accessor: node.accessor,
    });
  };

  // ------------------------------------------------------------------ revealing

  const nodeForUri = (uri: vscode.Uri, offset?: number): TreeNode | undefined => {
    const o = parseObjectUri(uri);
    if (o) return tree.nodeForObject(o.fsPath, o.objectId) ?? tree.nodeForFile(o.fsPath);
    const d = parseDiffUri(uri);
    if (d) return tree.nodeForFile(d.fsPath);
    if (uri.scheme === 'file' && isTwinCatPath(uri.fsPath)) {
      if (offset !== undefined) {
        const file = ws.getFile(uri.fsPath);
        const obj = file ? objectAtOffset(file, offset) : undefined;
        if (file && obj) {
          const n = tree.nodeForObject(file.path, obj.id);
          if (n) return n;
        }
      }
      return tree.nodeForFile(uri.fsPath);
    }
    return undefined;
  };

  const reveal = async (uri: vscode.Uri | undefined, explicit: boolean, offset?: number) => {
    if (!uri) return;
    if (!explicit && (!config().get<boolean>('autoReveal', true) || !treeView.visible)) return;
    const node = nodeForUri(uri, offset);
    if (!node) {
      if (explicit) void vscode.window.showInformationMessage('This file is not part of a TwinCAT PLC project in the workspace.');
      return;
    }
    if (!explicit && treeView.selection[0]?.id === node.id) return;
    try {
      await treeView.reveal(node, { select: true, focus: explicit, expand: false });
    } catch {
      // The node disappeared during a rebuild.
    }
  };

  const activeUri = (): vscode.Uri | undefined => {
    const nbEditor = vscode.window.activeNotebookEditor;
    if (nbEditor) return nbEditor.notebook.uri;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.uri.scheme === 'vscode-notebook-cell') return cellInfo(editor.document)?.notebook.uri;
    return editor.document.uri;
  };

  let selectionTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor(e => void reveal(e?.notebook.uri, false)),
    vscode.window.onDidChangeActiveTextEditor(e => {
      if (e && e.document.uri.scheme === 'file') void reveal(e.document.uri, false, e.document.offsetAt(e.selection.active));
    }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor.document.uri.scheme !== 'file' || !isTwinCatPath(e.textEditor.document.uri.fsPath)) return;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        void reveal(e.textEditor.document.uri, false, e.textEditor.document.offsetAt(e.selections[0].active));
      }, 300);
    }),
    treeView.onDidChangeVisibility(e => {
      if (e.visible) void reveal(activeUri(), false);
    }),
  );

  // ------------------------------------------------------------------ commands

  /** Real file, object and accessor addressed by a command argument (tree node, URI, SCM resource) or the active editor. */
  const target = (arg: unknown): { fsPath: string; objectId?: string } | undefined => {
    if (arg instanceof TreeNode) return arg.fsPath ? { fsPath: arg.fsPath, objectId: arg.objectId } : undefined;
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg && typeof arg === 'object' && (arg as { resourceUri?: unknown }).resourceUri instanceof vscode.Uri) {
      uri = (arg as { resourceUri: vscode.Uri }).resourceUri;
    } else uri = activeUri();
    if (!uri) return undefined;
    const o = parseObjectUri(uri);
    if (o) return { fsPath: o.fsPath, objectId: o.objectId };
    const p = realPathOf(uri);
    return p ? { fsPath: p } : undefined;
  };

  const openXml = async (arg: unknown) => {
    const t = target(arg);
    if (!t) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.fsPath));
    let selection: vscode.Range | undefined;
    if (t.objectId) {
      const obj = ws.getFile(t.fsPath)?.objects.get(t.objectId);
      if (obj) {
        const pos = doc.positionAt(obj.element.start + (doc.getText().charCodeAt(0) === 0xfeff ? 1 : 0));
        selection = new vscode.Range(pos, pos);
      }
    }
    await vscode.window.showTextDocument(doc, { preview: true, selection });
  };

  const lastRefKey = 'twincatExplorer.lastCompareRef';

  context.subscriptions.push(
    vscode.commands.registerCommand('twincatExplorer.refresh', () => loadProjects()),
    vscode.commands.registerCommand('twincatExplorer.open', (node?: TreeNode) => openNode(node)),
    vscode.commands.registerCommand('twincatExplorer.openToSide', (node?: TreeNode) => openNode(node, true)),
    vscode.commands.registerCommand('twincatExplorer.openXml', openXml),
    vscode.commands.registerCommand('twincatExplorer.revealInTree', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : activeUri();
      await vscode.commands.executeCommand('twincatExplorer.tree.focus');
      await reveal(uri, true);
    }),
    vscode.commands.registerCommand('twincatExplorer.revealActive', () => reveal(activeUri(), true)),
    vscode.commands.registerCommand('twincatExplorer.openChanges', async (arg?: unknown) => {
      const t = target(arg);
      if (!t || !isSourcePath(t.fsPath)) {
        void vscode.window.showInformationMessage('Open Changes works on .TcPOU, .TcDUT, .TcGVL and .TcIO files.');
        return;
      }
      // Resources of the git extension's "Staged Changes" group (ResourceGroupType.Index = 1) compare HEAD with the index.
      const groupType = arg && typeof arg === 'object' ? (arg as { resourceGroupType?: number }).resourceGroupType : undefined;
      if (groupType === 1) await openNotebookDiff(t.fsPath, 'HEAD', INDEX);
      else await openNotebookDiff(t.fsPath, 'HEAD');
    }),
    vscode.commands.registerCommand('twincatExplorer.compareWithRef', async (arg?: unknown) => {
      const t = target(arg);
      if (!t || !isSourcePath(t.fsPath)) return;
      const ref = await vscode.window.showInputBox({
        title: 'Compare with git ref',
        prompt: 'Branch, tag or commit to show on the left (working tree on the right)',
        value: context.workspaceState.get<string>(lastRefKey, 'origin/develop'),
        validateInput: async v => (v.trim() && (await verifyRef(t.fsPath, v.trim())) ? undefined : `'${v}' is not a commit in this repository`),
      });
      if (!ref) return;
      await context.workspaceState.update(lastRefKey, ref.trim());
      await openNotebookDiff(t.fsPath, ref.trim());
    }),
    vscode.commands.registerCommand('twincatExplorer.goToObject', async () => {
      const items: (vscode.QuickPickItem & { fsPath: string; objectId: string })[] = [];
      const iconOf: Record<string, string> = {
        pou: 'symbol-class', method: 'symbol-method', property: 'symbol-property', action: 'symbol-event',
        transition: 'symbol-event', dut: 'symbol-structure', gvl: 'symbol-variable', itf: 'symbol-interface',
      };
      for (const e of ws.sourceEntries) {
        const file = ws.getFile(e.path);
        if (!file) continue;
        for (const obj of file.ordered) {
          items.push({
            label: `$(${iconOf[obj.kind] ?? 'symbol-misc'}) ${obj.qualifiedName}`,
            description: obj.kind === 'pou' ? obj.pouKind : obj.kind,
            detail: `${e.project.name} · ${e.include}`,
            fsPath: file.path,
            objectId: obj.id,
          });
        }
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Go to TwinCAT Object', matchOnDescription: true, placeHolder: 'POU, method, property, DUT or GVL name',
      });
      if (pick) await openObject(pick.fsPath, pick.objectId, { preview: false });
    }),
    vscode.commands.registerCommand('twincatExplorer.checkWorkspace', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Checking TwinCAT Structured Text' },
        async () => features.checkWorkspace(checkCollection));
      void vscode.window.showInformationMessage(result.problems === 0
        ? 'TwinCAT: no problems found.'
        : `TwinCAT: ${result.problems} problem(s) in ${result.files} file(s). See the Problems panel.`);
    }),
    vscode.commands.registerCommand('twincatExplorer.hideNotebookToolbars', async () => {
      // VS Code has no per-notebook-type switch for these two toolbars, so they change for every notebook.
      const choice = await vscode.window.showInformationMessage(
        'Hide the notebook toolbar (Run All, Select Kernel, + Code, + Markdown) and the insert buttons between cells? '
        + 'This sets "notebook.globalToolbar" to false and "notebook.insertToolbarLocation" to "hidden" in your user settings, '
        + 'for all notebooks.', { modal: true }, 'Hide', 'Show Again');
      if (!choice) return;
      const nb = vscode.workspace.getConfiguration('notebook');
      const hide = choice === 'Hide';
      await nb.update('globalToolbar', hide ? false : undefined, vscode.ConfigurationTarget.Global);
      await nb.update('insertToolbarLocation', hide ? 'hidden' : undefined, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('twincatExplorer.copyName', async (node?: TreeNode) => {
      if (node?.name) await vscode.env.clipboard.writeText(node.name);
    }),
  );

  const ready = loadProjects();
  return {
    workspace: ws, index, tree, treeView, features, ready,
    openObject,
  };
}

export function deactivate(): void {
  // Disposables are released through the extension context.
}

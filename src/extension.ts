// Entry point: wires the TwinCAT workspace model, the tree, the split editor
// and object notebooks, the language features and the git comparisons together.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TcWorkspace, fileKey } from './core/workspace';
import { objectAtOffset } from './core/tcfile';
import { isInHiddenFolder } from './core/paths';
import { debugLog } from './core/debugLog';
import { LanguageIndex, StubSource } from './lang/index';
import { BUNDLED_STUBS } from './lang/stubs';
import { ObjectFileSystem } from './vscode/objectFs';
import { parseObjectText, positionIn, viewSections } from './core/objectText';
import { forgetDocument, markFileChanged, objectTabsOf, openObjectDocument } from './vscode/openDocs';
import { OverlaySync } from './vscode/overlays';
import { CellLabels, FileSerializer, ObjectSerializer } from './vscode/serializers';
import { MemberTarget, TreeNode, TwinCatTree, memberKinds } from './vscode/tree';
import { MemberCommands, NewMemberKind } from './vscode/members';
import { ObjectCommands, ObjectTarget } from './vscode/objects';
import { ShownTab } from './vscode/tabs';
import { itemOrder } from './core/project';
import { Loc } from './lang/symbols';
import { CellDiagnostics, LanguageFeatures, cellInfo, editorMode } from './vscode/language';
import { DiffFileSystem, GitDirWatcher, firstParent, openNotebookDiff, verifyRef, watchRepositories } from './vscode/git';
import { GitChanges } from './vscode/gitChanges';
import { BASE_SCHEME, ChangeNode, ChangesView } from './vscode/changesView';
import { CommitNode, CommitsView } from './vscode/commitsView';
import { CommitDiffPanel } from './vscode/commitDiff';
import { HistoryNode, HistoryTarget, HistoryView } from './vscode/historyView';
import { BlameService } from './vscode/blame';
import { CompareBase, ObjectEditorProvider, RevealTarget } from './vscode/objectEditor';
import { LocationService } from './vscode/locations';
import {
  DIFF_NOTEBOOK, DIFF_SCHEME, FILE_NOTEBOOK, INDEX, LOC_SCHEME, OBJECT_EDITOR, OBJECT_NOTEBOOK, OBJECT_SCHEME,
  ST_LANGUAGE, isSourcePath, isTwinCatPath, objectUri, parseDiffUri, parseLocUri, parseObjectUri, realPathOf, viewKey,
} from './vscode/uris';

export interface TwinCatExplorerApi {
  workspace: TcWorkspace;
  index: LanguageIndex;
  tree: TwinCatTree;
  treeView: vscode.TreeView<TreeNode>;
  /** Moves files dropped on a folder of the TwinCAT tree. */
  treeDragAndDrop: vscode.TreeDragAndDropController<TreeNode>;
  features: LanguageFeatures;
  objectEditors: ObjectEditorProvider;
  git: GitChanges;
  changes: ChangesView;
  changesView: vscode.TreeView<ChangeNode>;
  commits: CommitsView;
  commitsView: vscode.TreeView<CommitNode>;
  commitDiff: CommitDiffPanel;
  history: HistoryView;
  historyView: vscode.TreeView<HistoryNode>;
  ready: Promise<void>;
  /** Opens an object view as a notebook. */
  openObject(fsPath: string, objectId: string, options?: OpenOptions): Promise<vscode.NotebookEditor | undefined>;
  /** Opens an object view in the split editor and returns its document. */
  openSplit(fsPath: string, objectId: string, options?: OpenOptions & { reveal?: RevealTarget }): Promise<vscode.TextDocument | undefined>;
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

const warnedStubs = new Set<string>();

function userStubs(): StubSource[] {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const out: StubSource[] = [];
  for (const p of config().get<string[]>('stubFiles', [])) {
    if (!path.isAbsolute(p) && !folder) continue;
    const full = path.isAbsolute(p) || !folder ? p : path.join(folder, p);
    try {
      out.push({ path: full, text: fs.readFileSync(full, 'utf8') });
    } catch (e) {
      const message = `Explorer for TwinCAT: cannot read stub file ${full}: ${(e as Error).message}`;
      if (!warnedStubs.has(message)) void vscode.window.showWarningMessage(message);
      warnedStubs.add(message);
    }
  }
  return out;
}

export function activate(context: vscode.ExtensionContext): TwinCatExplorerApi {
  const ws = new TcWorkspace();
  const index = new LanguageIndex(ws);
  // User stubs are read once projects are found, so windows without TwinCAT never warn about them.
  index.setStubs(BUNDLED_STUBS);
  const log = vscode.window.createOutputChannel('Explorer for TwinCAT', { log: true });
  const objectFs = new ObjectFileSystem(context.workspaceState);
  const gitDirs = new GitDirWatcher();
  const diffFs = new DiffFileSystem(gitDirs);
  const gitChanges = new GitChanges(ws, gitDirs);
  const tree = new TwinCatTree(ws);
  // Dragging the file of a POU, DUT, GVL or interface onto a folder of its PLC project moves it there.
  const treeMime = 'application/vnd.code.tree.twincatexplorer.tree';
  const dragAndDropController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [treeMime],
    dropMimeTypes: [treeMime],
    handleDrag: (nodes, data) => {
      const files = nodes.filter(n => n.objectFile && n.fsPath).map(n => n.fsPath!);
      if (files.length) data.set(treeMime, new vscode.DataTransferItem(files));
    },
    handleDrop: async (target, data) => {
      const files = data.get(treeMime)?.value;
      let dest = target;
      while (dest && !dest.objectTarget) dest = dest.parent;
      const to = dest?.objectTarget;
      if (!Array.isArray(files) || !to) return;
      const entries = (files as string[]).map(f => ({ f, entry: ws.entry(f) }));
      const sameProject = entries.filter(e => e.entry && fileKey(e.entry.project.path) === fileKey(to.plcprojPath));
      if (sameProject.length < files.length) void vscode.window.showInformationMessage('A file moves to a folder of its own PLC project only.');
      // Not into the folder it is in.
      const movable = sameProject.filter(e => {
        const include = e.entry!.include;
        return itemOrder(include.slice(0, Math.max(include.lastIndexOf('\\'), 0)), to.folder) !== 0;
      }).map(e => e.f);
      if (movable.length === 0) return;
      const where = to.folder || ws.plcProject(to.plcprojPath)?.name || path.basename(to.plcprojPath);
      const choice = await vscode.window.showWarningMessage(`Move ${movable.map(f => path.basename(f)).join(', ')} to ${where}?`, {
        modal: true, detail: 'The file moves on disk, and its item in the .plcproj with it.',
      }, 'Move');
      if (choice !== 'Move') return;
      for (const f of movable) await objects.move(f, to.folder);
    },
  };
  const treeView = vscode.window.createTreeView('twincatExplorer.tree', { treeDataProvider: tree, showCollapseAll: true, dragAndDropController });
  const features = new LanguageFeatures(index, ws);
  const diagnostics = new CellDiagnostics(features);
  const locations = new LocationService(ws, index);
  features.splitLocator = (ctx, loc) => locations.locate(ctx, loc);
  const objectEditors = new ObjectEditorProvider(context.extensionUri, index, features, ws, locations);
  objectEditors.log = message => {
    debugLog(message);
    log.warn(message);
  };
  objectEditors.recordMessages = context.extensionMode === vscode.ExtensionMode.Test;
  objectEditors.git = gitChanges;
  gitChanges.log = message => log.warn(message);
  const changesView = new ChangesView(ws, gitChanges, context.workspaceState);
  changesView.log = message => log.warn(message);
  const changesTree = vscode.window.createTreeView('twincatExplorer.changes', { treeDataProvider: changesView, showCollapseAll: true });
  const commitDiff = new CommitDiffPanel(objectEditors, gitChanges);
  // TwinCAT keeps an object's GUID when its POU moves to another folder: found there.
  commitDiff.locate = (objectId, preferred) => {
    if (ws.getFile(preferred)?.objects.has(objectId)) return preferred;
    return ws.sourceEntries.find(e => ws.getFile(e.path)?.objects.has(objectId))?.path;
  };
  const commitsView = new CommitsView(gitChanges);
  commitsView.log = message => log.warn(message);
  commitsView.openObject = item => commitDiff.show(item);
  const commitsTree = vscode.window.createTreeView('twincatExplorer.commits', { treeDataProvider: commitsView, showCollapseAll: true });
  const history = new HistoryView(ws, gitChanges);
  history.log = message => log.warn(message);
  history.openObject = item => commitDiff.show(item);
  const historyTree = vscode.window.createTreeView('twincatExplorer.history', { treeDataProvider: history, showCollapseAll: true });
  objectEditors.blame = new BlameService(gitChanges);
  // A click on a line's blame: what that commit changed in the object, in the commit diff panel.
  objectEditors.openBlame = async (session, root, commit) => {
    await commitDiff.show({
      root, commit: commit.sha, parent: await firstParent(root, commit.sha), path: commit.filename,
      fromPath: commit.previous?.filename ?? commit.filename, objectId: session.ref.objectId, accessor: session.ref.accessor,
    }, false);
  };
  const showHistory = async (target: HistoryTarget) => {
    history.show(target);
    await vscode.commands.executeCommand('twincatExplorer.history.focus');
  };
  objectEditors.showHistory = ref => showHistory({ fsPath: ref.fsPath, objectId: ref.objectId, accessor: ref.accessor });
  const checkCollection = vscode.languages.createDiagnosticCollection('twincat-check');
  const fileSerializer = new FileSerializer();
  const stSelector: vscode.DocumentSelector = { language: ST_LANGUAGE };
  /** Live problems of open notebooks and split editors. */
  const scheduleAllDiagnostics = (delay?: number) => {
    diagnostics.scheduleAll(delay);
    objectEditors.scheduleAll(delay);
  };

  context.subscriptions.push(
    treeView, diagnostics, checkCollection, log, diffFs, gitChanges, gitDirs, objectEditors, locations,
    // M/A badges of changed objects in the TwinCAT tree and on object tabs.
    vscode.window.registerFileDecorationProvider(gitChanges),
    gitChanges.onDidChangeHead(() => {
      objectEditors.refreshBases();
      changesView.schedule();
      commitsView.schedule();
      history.headMoved();
    }),
    // The TwinCAT Commits view and its diff panel.
    commitsView, commitsTree, commitsView.attach(commitsTree), commitDiff,
    // The TwinCAT History view (the commits that changed one object).
    history, historyTree, history.attach(historyTree),
    historyTree.onDidChangeVisibility(e => {
      if (e.visible && !history.target) history.follow(activeObject());
    }),
    // The TwinCAT Changes view in the Source Control sidebar.
    changesView, changesTree, changesView.attach(changesTree),
    vscode.window.registerFileDecorationProvider(changesView),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, changesView),
    gitChanges.onDidChangeFileDecorations(() => {
      changesView.schedule();
      history.workingChanged();
    }),
    // A fetch can move the branch compared with; a push changes which commits are not pushed yet.
    gitDirs.onDidChange(() => {
      if (changesView.scope.kind === 'branch') changesView.schedule(1000);
      commitsView.schedule(1500);
      history.refsChanged();
    }),
    vscode.window.registerCustomEditorProvider(OBJECT_EDITOR, objectEditors, {
      // Monaco keeps its undo history and scroll positions while the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(LOC_SCHEME, locations),
    vscode.workspace.registerFileSystemProvider(OBJECT_SCHEME, objectFs, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider(DIFF_SCHEME, diffFs, { isCaseSensitive: true, isReadonly: true }),
    vscode.workspace.registerNotebookSerializer(OBJECT_NOTEBOOK, new ObjectSerializer(), { transientOutputs: true }),
    vscode.workspace.registerNotebookSerializer(DIFF_NOTEBOOK, fileSerializer,
      { transientOutputs: true, transientDocumentMetadata: { original: true, bom: true } }),
    // Not transient here: VS Code strips transient metadata before saving, and the file notebook
    // needs the original XML to splice the edited sections into.
    vscode.workspace.registerNotebookSerializer(FILE_NOTEBOOK, fileSerializer, { transientOutputs: true }),
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

  // Unsaved edits of open editors are visible to the rest of the index (completion, diagnostics).
  const overlays = new OverlaySync(index, ws, (uri, load, key, loadBase) => objectFs.effectiveBase(uri, load, key, loadBase));
  /** Load id of an object document (see ObjectTextHeader.load). */
  const loadOf = (text: string) => {
    try {
      return parseObjectText(text).header.load;
    } catch {
      return undefined;
    }
  };
  const refreshOverlays = (files?: Iterable<string>) => {
    if (overlays.refresh(files)) {
      scheduleAllDiagnostics(300);
      scheduleCheck();
    }
  };

  // Results of "Check All Structured Text" are re-run (debounced) on any change while they are shown.
  let checkTimer: NodeJS.Timeout | undefined;
  const scheduleCheck = () => {
    if (!checkHasResults) return;
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = undefined;
      checkHasResults = features.checkWorkspace(checkCollection).problems > 0;
    }, 800);
  };
  let checkHasResults = false;

  // The git hook is only started once a workspace has TwinCAT projects, so the extension stays idle
  // in the other windows of the profile (it also activates on startup).
  let projectServicesStarted = false;
  const startProjectServices = () => {
    if (projectServicesStarted) return;
    projectServicesStarted = true;
    void watchRepositories(() => {
      diffFs.notifyRefsChanged();
      gitChanges.headMayHaveChanged();
    }).then(d => context.subscriptions.push(d));
    // Tabs restored at start-up may have missed changes made before the watchers ran.
    objectFs.notifyAllWatched();
  };

  let loadTimer: NodeJS.Timeout | undefined;
  let reportedErrors = '';
  const loadProjects = async () => {
    try {
      const exclude = config().get<string>('exclude') || undefined;
      const uris = await vscode.workspace.findFiles('**/*.tsproj', exclude);
      // Copies of the repository in hidden folders (git worktrees under .claude/worktrees, ...) are not projects of this workspace.
      const visible = uris.filter(u => {
        const folder = vscode.workspace.getWorkspaceFolder(u);
        return !isInHiddenFolder(folder ? path.relative(folder.uri.fsPath, u.fsPath) : u.fsPath);
      });
      ws.load(visible.map(u => u.fsPath));
      const hasProjects = ws.tsProjects.length > 0;
      if (hasProjects) {
        startProjectServices();
        index.setStubs([...BUNDLED_STUBS, ...userStubs()]);
      }
      index.invalidateAll();
      refreshOverlays();
      tree.rebuild();
      if (hasProjects) void gitChanges.refreshAll();
      changesView.schedule(0);
      commitsView.schedule(0);
      checkCollection.clear();
      checkHasResults = false;
      await vscode.commands.executeCommand('setContext', 'twincatExplorer.hasProjects', hasProjects);
      if (hasProjects || ws.loadErrors.length) {
        log.info(`Loaded ${ws.tsProjects.length} TwinCAT project(s), ${ws.plcProjects.length} PLC project(s), `
          + `${ws.sourceEntries.length} source file(s); ignored ${uris.length - visible.length} .tsproj file(s) in hidden folders.`);
      }
      for (const err of ws.loadErrors) log.warn(err);
      const errors = ws.loadErrors.join('\n');
      if (errors && errors !== reportedErrors) {
        void vscode.window.showWarningMessage(
          `Explorer for TwinCAT: ${ws.loadErrors.length} project file(s) could not be loaded. The tree marks them with a warning.`,
          'Show Log').then(choice => { if (choice) log.show(); });
      }
      reportedErrors = errors;
      scheduleAllDiagnostics(100);
    } catch (e) {
      log.error(`Loading the TwinCAT projects failed: ${(e as Error).stack ?? e}`);
      void vscode.window.showErrorMessage(`Explorer for TwinCAT: loading the projects failed: ${(e as Error).message}`, 'Show Log')
        .then(choice => { if (choice) log.show(); });
    }
  };
  const scheduleLoad = () => {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => void loadProjects(), 500);
  };

  const onSourceChanged = (fsPath: string, except?: vscode.Uri) => {
    debugLog(`onSourceChanged ${fsPath}`);
    markFileChanged(fsPath);
    ws.invalidate(fsPath);
    index.invalidateFile(fsPath);
    objectFs.notifyRealFileChanged(fsPath, except);
    diffFs.notifyChanged(fsPath);
    gitChanges.fileChanged(fsPath);
    changesView.schedule();
    tree.scheduleRebuild();
    refreshOverlays([fsPath]);
    scheduleAllDiagnostics();
    scheduleCheck();
  };
  // A change event for the URI being saved, during its save, can leave its working copy ignoring later changes.
  objectFs.onDidWriteRealFile = (fsPath, savedUri) => onSourceChanged(fsPath, savedUri);

  // Created at once (before the first await) so no change is missed while the projects load.
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO,TcTTO,tcpou,tcdut,tcgvl,tcio,tctto}');
  const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{tsproj,plcproj}');
  context.subscriptions.push(
    sourceWatcher,
    sourceWatcher.onDidChange(u => onSourceChanged(u.fsPath)),
    sourceWatcher.onDidCreate(u => onSourceChanged(u.fsPath)),
    sourceWatcher.onDidDelete(u => onSourceChanged(u.fsPath)),
    projectWatcher,
    projectWatcher.onDidChange(scheduleLoad),
    projectWatcher.onDidCreate(scheduleLoad),
    projectWatcher.onDidDelete(scheduleLoad),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleLoad),
  );

  let tabsTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme === OBJECT_SCHEME) {
        // A split editor's document: edited in the webview, reverted, or reloaded from disk.
        if (e.contentChanges.length === 0) return;
        const ref = parseObjectUri(e.document.uri);
        overlays.touched(e.document);
        if (ref) refreshOverlays([ref.fsPath]);
        objectEditors.documentChanged(e.document);
        locations.changed(e.document.uri);
        return;
      }
      if (e.document.languageId !== ST_LANGUAGE || e.contentChanges.length === 0) return;
      const info = cellInfo(e.document);
      if (!info?.live) return;
      overlays.touched(e.document);
      refreshOverlays([info.fsPath]);
      diagnostics.schedule(e.document);
    }),
    vscode.workspace.onDidOpenNotebookDocument(nb => {
      // Notebooks restored by hot exit (window reload, extension host restart) bring unsaved text without change events.
      refreshOverlays();
      for (const cell of nb.getCells()) diagnostics.schedule(cell.document, 50);
    }),
    vscode.workspace.onDidChangeNotebookDocument(e => {
      // Revert and reload from disk replace cells without text change events.
      if (e.contentChanges.length === 0) return;
      for (const ch of e.contentChanges) {
        for (const c of ch.removedCells) {
          diagnostics.collection.delete(c.document.uri);
          overlays.forgetCell(c.document.uri);
        }
        for (const c of ch.addedCells) diagnostics.schedule(c.document, 50);
      }
      refreshOverlays();
    }),
    vscode.workspace.onDidOpenTextDocument(doc => {
      // Restored by hot exit with unsaved text, without change events.
      if (doc.uri.scheme === OBJECT_SCHEME) refreshOverlays();
      // Renderings shown in peek views and the redirect below get Structured Text colors.
      if (doc.uri.scheme === LOC_SCHEME && doc.languageId !== ST_LANGUAGE) void vscode.languages.setTextDocumentLanguage(doc, ST_LANGUAGE);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.scheme === 'vscode-notebook-cell') diagnostics.collection.delete(doc.uri);
      if (doc.uri.scheme === OBJECT_SCHEME) {
        overlays.forgetCell(doc.uri);
        // A notebook of the same object view keeps what the file system knows about the URI.
        const notebookOpen = vscode.workspace.notebookDocuments.some(nb => nb.uri.toString() === doc.uri.toString());
        objectFs.forget(doc.uri, loadOf(doc.getText()), !notebookOpen);
        objectEditors.clearDiagnostics(doc.uri);
        refreshOverlays();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme !== OBJECT_SCHEME) return;
      refreshOverlays();
      scheduleCheck();
    }),
    vscode.workspace.onDidSaveNotebookDocument(() => {
      refreshOverlays();
      scheduleCheck();
    }),
    vscode.workspace.onDidCloseNotebookDocument(nb => {
      diagnostics.clearNotebook(nb);
      for (const cell of nb.getCells()) overlays.forgetCell(cell.document.uri);
      if (nb.notebookType === OBJECT_NOTEBOOK) {
        // A split editor of the same object view keeps what the file system knows about the URI.
        const textOpen = vscode.workspace.textDocuments.some(d => d.uri.toString() === nb.uri.toString());
        objectFs.forget(nb.uri, (nb.metadata?.header as { load?: string } | undefined)?.load, !textOpen);
        forgetDocument(nb.uri);
      }
      refreshOverlays();
    }),
    vscode.window.tabGroups.onDidChangeTabs(e => {
      // One tab per object: VS Code can reopen an older revision URI by itself (Go Back, Reopen Closed
      // Editor, history). A clean duplicate is closed and the existing tab is shown instead.
      // Reopen Editor With on a tab with unsaved edits: the other editor reads the disk, and the edits stay in a
      // document no tab shows.
      for (const tab of e.opened) {
        const input = tab.input;
        const uri = input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom ? input.uri : undefined;
        if (!uri || uri.scheme !== OBJECT_SCHEME) continue;
        // A second tab of the same kind (split to another group, moved) shows the same document.
        const sameKind = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t !== tab
          && t.input instanceof (input instanceof vscode.TabInputNotebook ? vscode.TabInputNotebook : vscode.TabInputCustom)
          && (t.input as { uri: vscode.Uri }).uri.toString() === uri.toString());
        if (sameKind.length) continue;
        const hiddenDirty = input instanceof vscode.TabInputNotebook
          ? vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.toString() === uri.toString())
          : vscode.workspace.notebookDocuments.some(nb => nb.isDirty && nb.uri.toString() === uri.toString());
        if (!hiddenDirty) continue;
        const back = input instanceof vscode.TabInputNotebook ? 'Back to Split Editor' : 'Back to Notebook';
        void vscode.window.showWarningMessage(
          `${tab.label} has unsaved changes in the other editor. This tab shows the file on disk; save or revert them there.`, back)
          .then(choice => {
            if (choice) void vscode.commands.executeCommand('vscode.openWith', uri, input instanceof vscode.TabInputNotebook ? OBJECT_EDITOR : OBJECT_NOTEBOOK);
          });
      }
      for (const tab of e.opened) {
        if (!(tab.input instanceof vscode.TabInputNotebook) || tab.input.notebookType !== OBJECT_NOTEBOOK || tab.isDirty) continue;
        const existing = objectTabsOf(tab.input.uri)[0];
        if (!existing || !(existing.input instanceof vscode.TabInputNotebook)) continue;
        const target = existing.input.uri;
        void vscode.window.tabGroups.close(tab).then(() => vscode.commands.executeCommand('vscode.openWith', target, OBJECT_NOTEBOOK));
      }
      // Only documents shown in a tab (or dirty) feed the overlays.
      if (tabsTimer) clearTimeout(tabsTimer);
      tabsTimer = setTimeout(() => refreshOverlays(), 200);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('twincatExplorer.foldersFirst')) tree.rebuild();
      if (e.affectsConfiguration('twincatExplorer.stubFiles') && ws.tsProjects.length > 0) {
        index.setStubs([...BUNDLED_STUBS, ...userStubs()]);
        scheduleAllDiagnostics();
      }
      if (e.affectsConfiguration('twincatExplorer.diagnostics')) {
        features.clearAnalysisCache();
        scheduleAllDiagnostics(50);
      }
      if (e.affectsConfiguration('twincatExplorer.exclude')) scheduleLoad();
      if (e.affectsConfiguration('twincatExplorer.blame')) objectEditors.blameSettingChanged();
    }),
  );

  // ------------------------------------------------------------------ opening objects

  /** Opens an object view (an accessor of a property when options.accessor is set) as a notebook. */
  const openObject = async (fsPath: string, objectId: string, options: OpenOptions = {}) => {
    const file = ws.getFile(fsPath);
    const obj = file?.objects.get(objectId);
    if (!file || !obj) {
      void vscode.window.showWarningMessage(`TwinCAT object not found in ${path.basename(fsPath)}`);
      return undefined;
    }
    const nb = await openObjectDocument(file.path, { ...obj, sections: viewSections(obj, options.accessor) }, options.accessor);
    return vscode.window.showNotebookDocument(nb, {
      preview: options.preview ?? true, preserveFocus: options.preserveFocus ?? false, viewColumn: options.viewColumn,
    });
  };

  /**
   * URI of the split editor document already open for an object view: it can differ from the URI built
   * now (opened from a notebook with a revision, or the object was renamed or moved in XAE since).
   */
  const openViewUri = (fsPath: string, objectId: string, accessor?: 'Get' | 'Set'): vscode.Uri | undefined => {
    const key = viewKey({ fsPath, objectId, accessor }, fileKey);
    const same = (u: vscode.Uri) => {
      const r = parseObjectUri(u);
      return !!r && viewKey(r, fileKey) === key;
    };
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (t.input instanceof vscode.TabInputCustom && t.input.viewType === OBJECT_EDITOR && same(t.input.uri)) return t.input.uri;
      }
    }
    return vscode.workspace.textDocuments.find(d => d.uri.scheme === OBJECT_SCHEME && same(d.uri))?.uri;
  };

  /** Opens an object view in the split editor, optionally at a place of one of its sections. */
  const openSplit = async (fsPath: string, objectId: string, options: OpenOptions & { reveal?: RevealTarget } = {}) => {
    const file = ws.getFile(fsPath);
    const obj = file?.objects.get(objectId);
    if (!file || !obj || (options.accessor && !obj.accessors.some(a => a.kind === options.accessor))) {
      void vscode.window.showWarningMessage(`TwinCAT object not found in ${path.basename(fsPath)}`);
      return undefined;
    }
    const uri = openViewUri(file.path, obj.id, options.accessor) ?? objectUri(file.path, obj, undefined, options.accessor);
    await vscode.commands.executeCommand('vscode.openWith', uri, OBJECT_EDITOR, {
      preview: options.preview ?? true, preserveFocus: options.preserveFocus ?? false, viewColumn: options.viewColumn,
    });
    if (options.reveal) objectEditors.reveal(uri, options.reveal);
    if (!options.preserveFocus) void reveal(uri, false);
    return vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  };

  /** Opens an object view in the editor chosen by the twincatExplorer.editor setting. */
  const openDefault = async (fsPath: string, objectId: string, options: OpenOptions = {}) => {
    if (editorMode() === 'notebook') await openObject(fsPath, objectId, options);
    else await openSplit(fsPath, objectId, options);
  };

  objectEditors.openView = async ({ ref, reveal: target, viewColumn }) => {
    await openSplit(ref.fsPath, ref.objectId, { accessor: ref.accessor, reveal: target, viewColumn, preview: false });
  };

  // An object of the TwinCAT Changes or History view: its split editor (whatever twincatExplorer.editor says, the
  // diff is shown there) with the changes against the base of the view.
  const openWithChanges = async (fsPath: string, objectId: string, accessor: 'Get' | 'Set' | undefined, base: CompareBase) => {
    const doc = await openSplit(fsPath, objectId, { accessor, preview: true });
    if (doc && !(await objectEditors.showChangesAgainst(doc.uri, base))) {
      void vscode.window.showInformationMessage(`${path.basename(fsPath)} cannot be compared with ${base.label}.`);
    }
  };
  changesView.openChanges = openWithChanges;
  history.openChanges = openWithChanges;

  /** The object view of the active editor: a split editor, an object notebook, or the commit diff panel. */
  const activeObject = (): HistoryTarget | undefined => {
    const session = objectEditors.activeSession();
    if (session) return { fsPath: session.ref.fsPath, objectId: session.ref.objectId, accessor: session.ref.accessor };
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const ref = nb ? parseObjectUri(nb.uri) : undefined;
    if (ref) return { fsPath: ref.fsPath, objectId: ref.objectId, accessor: ref.accessor };
    const shown = commitDiff.active ? commitDiff.shown : undefined;
    const live = commitDiff.livePath;
    return shown && live ? { fsPath: live, objectId: shown.objectId, accessor: shown.accessor } : undefined;
  };

  /** The object a Show History command is for: a node of a view, a `twincat:` URI, or the active editor's. */
  const historyTarget = (arg: unknown): HistoryTarget | undefined => {
    if (arg instanceof TreeNode) return arg.fsPath && arg.objectId ? { fsPath: arg.fsPath, objectId: arg.objectId, accessor: arg.accessor } : undefined;
    if (arg instanceof ChangeNode) return arg.fsPath && arg.view ? { fsPath: arg.fsPath, objectId: arg.view.objectId, accessor: arg.view.accessor } : undefined;
    if (arg instanceof CommitNode) {
      if (!arg.view || !arg.root || !arg.path) return undefined;
      const fsPath = commitDiff.locate?.(arg.view.objectId, path.join(arg.root, arg.path));
      return fsPath ? { fsPath, objectId: arg.view.objectId, accessor: arg.view.accessor } : undefined;
    }
    if (arg instanceof HistoryNode) {
      const t = history.target;
      return t && arg.objectId ? { fsPath: t.fsPath, objectId: arg.objectId, accessor: arg.accessor } : undefined;
    }
    if (arg instanceof vscode.Uri) {
      const ref = parseObjectUri(arg) ?? parseLocUri(arg);
      if (ref) return { fsPath: ref.fsPath, objectId: ref.objectId, accessor: ref.accessor };
    }
    return activeObject();
  };

  // twincat-loc section copies are opened by VS Code in an editor tab at a position (Problems panel,
  // workspace symbols, locations from notebook cells): show the split editor at that place instead.
  // Peek views also show them, in embedded editors without a tab, and those are left alone.
  const redirected = new WeakSet<vscode.TextEditor>();
  const tabOf = (uri: vscode.Uri) => vscode.window.tabGroups.all.flatMap(g => g.tabs)
    .find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  const redirectLoc = async (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.uri.scheme !== LOC_SCHEME || editor.viewColumn === undefined || redirected.has(editor)) return;
    redirected.add(editor);
    const uri = editor.document.uri;
    // The selection given to the open is applied right after the editor becomes visible, and the tab
    // model follows shortly.
    let tab: vscode.Tab | undefined;
    for (let i = 0; i < 10 && !tab; i++) {
      await new Promise(r => setTimeout(r, 25));
      tab = tabOf(uri);
    }
    if (!tab) return;
    // The start of the selection: VS Code selects the whole range of a problem or symbol.
    const target = locations.targetAt(uri, editor.selection.start);
    const end = locations.targetAt(uri, editor.selection.end);
    debugLog(`redirect ${uri.path.split('/').pop()} at ${editor.selection.start.line}:${editor.selection.start.character} -> ${target?.key}@${target?.start}`);
    if (!target) {
      await vscode.window.tabGroups.close(tab, true);
      return;
    }
    const preview = tab.isPreview;
    const docUri = openViewUri(target.ref.fsPath, target.ref.objectId, target.ref.accessor);
    // The object's split editor shown in another group is used there, like revealIfVisible does for files.
    const visible = docUri && vscode.window.tabGroups.all.find(g =>
      g.activeTab?.input instanceof vscode.TabInputCustom && g.activeTab.input.uri.toString() === docUri.toString());
    const viewColumn = visible ? visible.viewColumn : tab.group.viewColumn;
    // A preview copy is replaced by the split editor opening as a preview in its place (a replaced editor
    // does not go to Reopen Closed Editor); otherwise it is closed.
    const replace = preview && !visible && !(docUri && tab.group.tabs.some(t => t.input instanceof vscode.TabInputCustom
      && t.input.uri.toString() === docUri.toString()));
    if (!replace) await vscode.window.tabGroups.close(tab, true);
    await openSplit(target.ref.fsPath, target.ref.objectId, {
      accessor: target.ref.accessor, viewColumn, preview,
      reveal: {
        key: target.key, start: target.start, end: end?.key === target.key ? end.start : target.start, focus: true, text: target.text,
      },
    });
    const left = tabOf(uri);
    if (left) await vscode.window.tabGroups.close(left, true);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(e => void redirectLoc(e)),
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const e of editors) void redirectLoc(e);
    }),
  );

  let lastClick: { id: string; time: number } | undefined;
  const openNode = async (node: TreeNode | undefined, sideBySide = false) => {
    if (!node?.fsPath || !node.objectId) return;
    const now = Date.now();
    const doubleClick = !sideBySide && lastClick?.id === node.id && now - lastClick.time < 500;
    lastClick = { id: node.id, time: now };
    await openDefault(node.fsPath, node.objectId, {
      preview: !(doubleClick || sideBySide),
      preserveFocus: !(doubleClick || sideBySide),
      viewColumn: sideBySide ? vscode.ViewColumn.Beside : undefined,
      accessor: node.accessor,
    });
  };

  // ------------------------------------------------------------------ revealing

  /** Tree nodes showing the object or file of a URI (several when a PLC project belongs to two .tsproj files). */
  const nodesForUri = (uri: vscode.Uri, offset?: number): TreeNode[] => {
    const o = parseObjectUri(uri) ?? parseLocUri(uri);
    if (o) {
      const nodes = tree.nodesForObject(o.fsPath, o.objectId);
      if (o.accessor) {
        const accessors = nodes.flatMap(n => n.children.filter(c => c.kind === 'accessor' && c.accessor === o.accessor));
        if (accessors.length) return accessors;
      }
      return nodes.length ? nodes : tree.nodesForFile(o.fsPath);
    }
    const d = parseDiffUri(uri);
    if (d) return tree.nodesForFile(d.fsPath);
    if (uri.scheme === 'file' && isTwinCatPath(uri.fsPath)) {
      if (offset !== undefined) {
        const file = ws.getFile(uri.fsPath);
        const obj = file ? objectAtOffset(file, offset) : undefined;
        if (file && obj) {
          const nodes = tree.nodesForObject(file.path, obj.id);
          if (nodes.length) return nodes;
        }
      }
      return tree.nodesForFile(uri.fsPath);
    }
    return [];
  };

  const sameTarget = (a: TreeNode, b: TreeNode) =>
    !!a.fsPath && !!b.fsPath && fileKey(a.fsPath) === fileKey(b.fsPath) && (a.objectId ?? '') === (b.objectId ?? '')
    && (a.accessor ?? '') === (b.accessor ?? '');

  const reveal = async (uri: vscode.Uri | undefined, explicit: boolean, offset?: number) => {
    if (!uri) return;
    if (!explicit && (!config().get<boolean>('autoReveal', true) || !treeView.visible)) return;
    if (!explicit) {
      // Once VS Code rendered the tree, and refreshed it at start-up (see onDidChangeVisibility).
      await tree.whenQuiet();
      if (!treeView.visible) return;
    }
    const candidates = nodesForUri(uri, offset);
    if (candidates.length === 0) {
      if (explicit) void vscode.window.showInformationMessage('This file is not part of a TwinCAT PLC project in the workspace.');
      return;
    }
    const selected = treeView.selection[0];
    // Keep the selection when it already shows this object: the other copy of a shared PLC project, or a Get/Set node.
    if (!explicit && selected && candidates.some(c => sameTarget(selected, c))) return;
    // The node just opened from the tree wins: its selection can reach this extension after the editor opens.
    const clicked = candidates.find(c => c.id === lastClick?.id);
    if (!explicit && clicked && selected?.id === clicked.id) return;
    const node = clicked ?? (selected && candidates.find(c => c.root === selected.root)) ?? candidates[0];
    try {
      await treeView.reveal(node, { select: true, focus: explicit, expand: false });
    } catch {
      // The node disappeared during a rebuild.
    }
  };

  const activeUri = (): vscode.Uri | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    const nbEditor = vscode.window.activeNotebookEditor;
    if (nbEditor) return nbEditor.notebook.uri;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.uri.scheme === 'vscode-notebook-cell') return cellInfo(editor.document)?.notebook.uri;
    return editor.document.uri;
  };

  let selectionTimer: NodeJS.Timeout | undefined;
  let treeRendered = false;
  /** The History view shows the object of the editor that became active (unless pinned). */
  const followInHistory = (uri: vscode.Uri | undefined) => {
    const ref = uri ? parseObjectUri(uri) : undefined;
    if (ref) history.follow({ fsPath: ref.fsPath, objectId: ref.objectId, accessor: ref.accessor });
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor(e => {
      void reveal(e?.notebook.uri, false);
      followInHistory(e?.notebook.uri);
    }),
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
      if (!e.visible) return;
      if (!treeRendered) {
        // VS Code 1.142, rendering the view expanded as the last session left it, shows the children of the first
        // project only, although it asked for those of every project. A refresh once it rendered the tree shows them.
        treeRendered = true;
        void tree.whenQuiet().then(() => tree.refresh());
      }
      void reveal(activeUri(), false);
    }),
  );
  objectEditors.onDidActivate = uri => {
    void reveal(uri, false);
    followInHistory(uri);
  };

  // ------------------------------------------------------------------ commands

  /** Real file and object addressed by a command argument (tree node, URI, SCM resource) or the active editor. */
  const target = (arg: unknown): { fsPath: string; objectId?: string } | undefined => {
    if (arg instanceof TreeNode) return arg.fsPath ? { fsPath: arg.fsPath, objectId: arg.objectId } : undefined;
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg && typeof arg === 'object' && (arg as { resourceUri?: unknown }).resourceUri instanceof vscode.Uri) {
      uri = (arg as { resourceUri: vscode.Uri }).resourceUri;
    } else uri = activeUri();
    if (!uri) return undefined;
    const o = parseObjectUri(uri) ?? parseLocUri(uri);
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

  /** Where the language index finds an object or member of a file used: references to it, its declaration aside. */
  const usesOf = (fsPath: string, objectId: string): Loc[] => {
    const obj = ws.getFile(fsPath)?.objects.get(objectId);
    // Any section of it: an action has only its implementation.
    const ctx = obj?.sections[0] && index.context(fileKey(fsPath), obj.sections[0].key);
    const sym = ctx && (obj!.parent ? ctx.member : ctx.pou ?? ctx.gvl ?? ctx.types[0]);
    return sym ? features.referenceLocs(sym, false) : [];
  };
  /** The places, to open one in the split editor. */
  const showUses = async (title: string, locs: Loc[]) => {
    const items = locs.map(loc => {
      const ctx = index.context(loc.fileKey, loc.sectionKey);
      const text = index.sectionText(loc.fileKey, loc.sectionKey) ?? '';
      const { line } = positionIn(text, loc.start);
      return {
        label: ctx ? `${ctx.object.qualifiedName}${ctx.accessor ? `.${ctx.accessor}` : ''}` : '?',
        description: `${ctx?.label ?? ''}, line ${line + 1}`,
        detail: text.split('\n')[line]?.trim(),
        loc, ctx, text,
      };
    });
    const pick = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
    if (!pick?.ctx) return;
    await openSplit(pick.ctx.filePath, pick.ctx.object.id, {
      accessor: pick.ctx.accessor, preview: false,
      reveal: { key: pick.loc.sectionKey, start: pick.loc.start, end: pick.loc.end, focus: true, text: pick.text },
    });
  };
  /** Tabs closed for a rename or move, open again in the file under its new name or path; the active one last. */
  const reopen = async (fsPath: string, tabs: ShownTab[]) => {
    const file = ws.getFile(fsPath);
    for (const t of [...tabs].sort((a, b) => Number(a.active) - Number(b.active))) {
      const options = { viewColumn: t.viewColumn, preview: t.preview, preserveFocus: !t.active };
      if (t.kind === 'text') {
        await vscode.window.showTextDocument(vscode.Uri.file(fsPath), options);
        continue;
      }
      const obj = t.objectId ? file?.objects.get(t.objectId) : undefined;
      if (!obj || (t.accessor && !obj.accessors.some(a => a.kind === t.accessor))) continue;
      if (t.kind === 'notebook') await openObject(fsPath, obj.id, { ...options, accessor: t.accessor });
      // Not openSplit: it would take the URI of the document under the old name, still open for a while.
      else await vscode.commands.executeCommand('vscode.openWith', objectUri(fsPath, obj, undefined, t.accessor), OBJECT_EDITOR, options);
    }
  };

  const members = new MemberCommands(ws, index, {
    written: fsPath => {
      onSourceChanged(fsPath);
      // At once, so that the new member has its node when it opens and is revealed.
      tree.rebuild();
    },
    open: (fsPath, objectId, accessor) => openDefault(fsPath, objectId, { accessor, preview: false }),
    references: usesOf,
    showReferences: showUses,
    reopen,
  });
  /** Where a new member goes: the POU, interface or folder of a tree node, or the POU or interface of the active editor. */
  const memberTarget = (arg: unknown): MemberTarget | undefined => {
    if (arg instanceof TreeNode && arg.memberTarget) return arg.memberTarget;
    const t = target(arg);
    const root = t && ws.getFile(t.fsPath)?.root;
    const kinds = root && memberKinds(root);
    return t && root && kinds?.members ? { fsPath: t.fsPath, objectId: root.id, folderPath: [], actions: kinds.actions } : undefined;
  };
  const addMember = (kind: NewMemberKind) => async (arg?: unknown) => {
    const t = memberTarget(arg);
    if (!t || (kind === 'action' && !t.actions)) {
      void vscode.window.showInformationMessage(kind === 'action'
        ? 'Actions are added to function blocks and programs: open one, or pick it in the TwinCAT tree.'
        : `Add ${kind === 'method' ? 'Method' : 'Property'} works on function blocks, programs and interfaces: open one, or pick it in the TwinCAT tree.`);
      return;
    }
    await members.add(kind, t);
  };

  const objects = new ObjectCommands(ws, index, {
    // At once, not after the .plcproj watcher's delay: the new object has its node when it opens.
    written: () => loadProjects(),
    open: (fsPath, objectId) => openDefault(fsPath, objectId, { preview: false }),
    references: usesOf,
    showReferences: showUses,
    reopen,
  });
  /**
   * Where a new object goes: the PLC project or folder of a tree node; else the folder of the active editor's
   * object, or a PLC project picked.
   */
  const objectTarget = async (arg: unknown): Promise<ObjectTarget | undefined> => {
    if (arg instanceof TreeNode && arg.objectTarget) return arg.objectTarget;
    const t = target(arg);
    const entry = t && ws.entry(t.fsPath);
    if (entry) return { plcprojPath: entry.project.path, folder: entry.include.includes('\\') ? entry.include.slice(0, entry.include.lastIndexOf('\\')) : '' };
    if (t && ws.plcProject(t.fsPath)) return { plcprojPath: t.fsPath, folder: '' };
    if (ws.plcProjects.length <= 1) return ws.plcProjects[0] && { plcprojPath: ws.plcProjects[0].path, folder: '' };
    const pick = await vscode.window.showQuickPick(ws.plcProjects.map(p => ({ label: p.name, description: p.path, p })), { placeHolder: 'PLC project' });
    return pick && { plcprojPath: pick.p.path, folder: '' };
  };
  const addObject = (run: (t: ObjectTarget) => Promise<void>) => async (arg?: unknown) => {
    const t = await objectTarget(arg);
    if (t) await run(t);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('twincatExplorer.addPou', addObject(t => objects.addPou(t))),
    vscode.commands.registerCommand('twincatExplorer.addDut', addObject(t => objects.addDut(t))),
    vscode.commands.registerCommand('twincatExplorer.addGvl', addObject(t => objects.addGvl(t))),
    vscode.commands.registerCommand('twincatExplorer.addInterface', addObject(t => objects.addInterface(t))),
    vscode.commands.registerCommand('twincatExplorer.newFolder', addObject(t => objects.newFolder(t))),
    vscode.commands.registerCommand('twincatExplorer.addMethod', addMember('method')),
    vscode.commands.registerCommand('twincatExplorer.addProperty', addMember('property')),
    vscode.commands.registerCommand('twincatExplorer.addAction', addMember('action')),
    vscode.commands.registerCommand('twincatExplorer.implementInterfaces', async (arg?: unknown) => {
      const t = target(arg);
      if (!t) {
        void vscode.window.showInformationMessage('Implement Interfaces works on function blocks: open one, or pick it in the TwinCAT tree.');
        return;
      }
      await members.implementInterfaces(t.fsPath);
    }),
    // Rename, Delete and Move to Folder of the tree, from its context menu, with F2 and Delete in it, and by drag and drop.
    vscode.commands.registerCommand('twincatExplorer.rename', async (arg?: unknown) => {
      const node = arg instanceof TreeNode ? arg : treeView.selection[0];
      if (node?.kind === 'object' && node.fsPath && node.objectId) await members.rename(node.fsPath, node.objectId);
      else if (node?.objectFile && node.fsPath) await objects.rename(node.fsPath);
    }),
    vscode.commands.registerCommand('twincatExplorer.delete', async (arg?: unknown) => {
      const node = arg instanceof TreeNode ? arg : treeView.selection[0];
      if ((node?.kind === 'object' || node?.kind === 'accessor') && node.fsPath && node.objectId) {
        await members.delete(node.fsPath, node.objectId, node.accessor);
      } else if (node?.objectFile && node.fsPath) {
        await objects.delete(node.fsPath);
      } else if (node?.kind === 'folder' && node.children.length === 0 && node.objectTarget) {
        await objects.deleteFolder(node.objectTarget);
      }
    }),
    vscode.commands.registerCommand('twincatExplorer.moveToFolder', async (arg?: unknown) => {
      const node = arg instanceof TreeNode ? arg : treeView.selection[0];
      if (node?.objectFile && node.fsPath) await objects.move(node.fsPath);
    }),
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
    vscode.commands.registerCommand('twincatExplorer.commits.open', (node?: CommitNode) => node && commitsView.open(node)),
    vscode.commands.registerCommand('twincatExplorer.commits.openText', (node?: CommitNode) => node && commitsView.openText(node)),
    vscode.commands.registerCommand('twincatExplorer.commits.openNotebook', (node?: CommitNode) => node && commitsView.openNotebook(node)),
    vscode.commands.registerCommand('twincatExplorer.commits.loadMore', () => commitsView.loadMore()),
    vscode.commands.registerCommand('twincatExplorer.commits.refresh', () => commitsView.refresh()),
    // Also for the commits of the TwinCAT History view.
    vscode.commands.registerCommand('twincatExplorer.commits.copySha', async (node?: CommitNode | HistoryNode) => {
      if (node?.commit) await vscode.env.clipboard.writeText(node.commit.sha);
    }),
    vscode.commands.registerCommand('twincatExplorer.commits.copyMessage', async (node?: CommitNode | HistoryNode) => {
      if (node?.commit) await vscode.env.clipboard.writeText(node.commit.body ? `${node.commit.subject}\n\n${node.commit.body}` : node.commit.subject);
    }),
    // The object of the commit diff panel as it is now, in the split editor.
    vscode.commands.registerCommand('twincatExplorer.commitDiff.openCurrent', async () => {
      const shown = commitDiff.shown;
      if (!shown) return;
      const fsPath = commitDiff.locate?.(shown.objectId, path.join(shown.root, shown.path));
      if (!fsPath) {
        void vscode.window.showInformationMessage('The object is not in the working tree any more.');
        return;
      }
      await openSplit(fsPath, shown.objectId, { accessor: shown.accessor, preview: false });
    }),
    vscode.commands.registerCommand('twincatExplorer.history.show', async (arg?: unknown) => {
      const t = historyTarget(arg);
      if (!t) {
        void vscode.window.showInformationMessage('Show History works on TwinCAT objects in the working tree: open one, or pick it in the TwinCAT tree.');
        return;
      }
      await showHistory(t);
    }),
    vscode.commands.registerCommand('twincatExplorer.history.open', (node?: HistoryNode) => node && history.open(node)),
    vscode.commands.registerCommand('twincatExplorer.history.openWorking', (node?: HistoryNode) => node && history.openWorking(node)),
    vscode.commands.registerCommand('twincatExplorer.history.compareWithWorking', (node?: HistoryNode) => node && history.compareWithWorking(node)),
    vscode.commands.registerCommand('twincatExplorer.history.loadMore', () => history.loadMore()),
    vscode.commands.registerCommand('twincatExplorer.history.refresh', () => history.reload()),
    vscode.commands.registerCommand('twincatExplorer.history.pin', () => history.setPinned(true)),
    vscode.commands.registerCommand('twincatExplorer.history.unpin', () => {
      history.setPinned(false);
      history.follow(activeObject());
    }),
    vscode.commands.registerCommand('twincatExplorer.toggleBlame', async () => {
      const key = 'blame.currentLine';
      const on = config().get<boolean>(key, true);
      // Written where it is set: a workspace value would win over a user one.
      const target = config().inspect<boolean>(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config().update(key, !on, target);
    }),
    vscode.commands.registerCommand('twincatExplorer.changes.open', (node?: ChangeNode) => node && changesView.open(node)),
    vscode.commands.registerCommand('twincatExplorer.changes.discard', (node?: ChangeNode) => node && changesView.discard(node)),
    vscode.commands.registerCommand('twincatExplorer.changes.openNotebook', (node?: ChangeNode) => node && changesView.openNotebook(node)),
    vscode.commands.registerCommand('twincatExplorer.changes.refresh', () => changesView.refresh()),
    vscode.commands.registerCommand('twincatExplorer.changes.showUncommitted', () => changesView.setScope({ kind: 'head' })),
    vscode.commands.registerCommand('twincatExplorer.changes.showBranch', () =>
      changesView.setScope({ kind: 'branch', ref: context.workspaceState.get<string>(lastRefKey, 'origin/develop') })),
    vscode.commands.registerCommand('twincatExplorer.changes.compareBranchWith', async () => {
      const probe = ws.plcProjects[0]?.path;
      if (!probe) return;
      const ref = await vscode.window.showInputBox({
        title: 'Compare the branch with',
        prompt: 'Branch, tag or commit: the view shows what changed since HEAD left it, uncommitted changes included',
        value: context.workspaceState.get<string>(lastRefKey, 'origin/develop'),
        validateInput: async v => (v.trim() && (await verifyRef(probe, v.trim())) ? undefined : `'${v}' is not a commit in this repository`),
      });
      if (!ref) return;
      await context.workspaceState.update(lastRefKey, ref.trim());
      await changesView.setScope({ kind: 'branch', ref: ref.trim() });
    }),
    vscode.commands.registerCommand('twincatExplorer.showChanges', (uri?: unknown) =>
      objectEditors.setChangesMode(uri instanceof vscode.Uri ? uri : undefined, true)),
    vscode.commands.registerCommand('twincatExplorer.hideChanges', (uri?: unknown) =>
      objectEditors.setChangesMode(uri instanceof vscode.Uri ? uri : undefined, false)),
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
      if (pick) await openDefault(pick.fsPath, pick.objectId, { preview: false });
    }),
    vscode.commands.registerCommand('twincatExplorer.checkWorkspace', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Checking TwinCAT Structured Text' },
        async () => features.checkWorkspace(checkCollection));
      checkHasResults = result.problems > 0;
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

  void vscode.commands.executeCommand('setContext', 'twincatExplorer.historyPinned', false);
  const ready = loadProjects();
  return {
    workspace: ws, index, tree, treeView, treeDragAndDrop: dragAndDropController, features, objectEditors, git: gitChanges,
    changes: changesView, changesView: changesTree, commits: commitsView, commitsView: commitsTree, commitDiff,
    history, historyView: historyTree, ready, openObject, openSplit,
  };
}

export function deactivate(): void {
  // Disposables are released through the extension context.
}

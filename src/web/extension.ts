// Entry point in the browser (vscode.dev, github.dev): the extension of the desktop, bundled with the modules of
// this folder in place of Node's (scripts/build-web.js). The workspace's TwinCAT files are read into memory before
// the projects load, so the synchronous reads of the rest of the extension find them (vfs.ts). No git: the
// comparisons with HEAD and with a branch, the TwinCAT Changes, Commits and History views and blame read GitHub
// (github.ts); only staging (git's index) is hidden there.
// No MCP server: it runs in Node.

import * as path from 'path';
import * as vscode from 'vscode';
import { parseJsonc } from '../core/jsonc';
import { TwinCatExplorerApi, activate as activateExtension } from '../extension';
import { disableGit, useRevisionSource } from '../vscode/git';
import { activeThemeFile } from '../vscode/theme';
import { useFileUris } from '../vscode/uris';
import { GitHubRevisions, prefetchRepository } from './github';
import * as vfs from './vfs';

/** The folder the bundle's `__dirname` points into (set by scripts/build-web.js): the extension's own. */
const BUNDLE_ROOT = '/__twincat_explorer__';

const decoder = new TextDecoder();

/** Reads a color theme's file and the files it refers to; true when one was read. */
async function loadThemeFiles(file: string, seen = new Set<string>()): Promise<boolean> {
  if (seen.has(file)) return false;
  seen.add(file);
  const bytes = await vfs.loadFile(file);
  if (!bytes) return false;
  if (/\.tmTheme$/i.test(file)) return true;
  try {
    const json = parseJsonc<{ include?: string; tokenColors?: unknown }>(decoder.decode(bytes));
    if (json.include) await loadThemeFiles(path.join(path.dirname(file), json.include), seen);
    if (typeof json.tokenColors === 'string') await vfs.loadFile(path.join(path.dirname(file), json.tokenColors));
  } catch {
    // An unreadable theme leaves the editor's default colors.
  }
  return true;
}

export function activate(context: vscode.ExtensionContext): TwinCatExplorerApi {
  disableGit('Git is not available in the browser.');
  // Open Changes and the split editor's changes compare with HEAD as GitHub has it.
  const revisions = new GitHubRevisions();
  useRevisionSource(revisions);
  vfs.mount(BUNDLE_ROOT, context.extensionUri);
  // The color themes are files of other extensions.
  for (const ext of vscode.extensions.all) vfs.mount(ext.extensionUri.fsPath, ext.extensionUri);
  vfs.onWriteError(message => void vscode.window.showErrorMessage(`Explorer for TwinCAT: ${message}`));
  const loaded = new Set<string>();
  const languageConfig = vfs.loadFile(path.join(context.extensionUri.fsPath, 'language-configuration.json'));

  const api = activateExtension(context, {
    beforeLoad: async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      useFileUris(folders.map(f => f.uri.scheme), p => vfs.uriOf(p));
      await languageConfig;
      const fresh = folders.filter(f => !loaded.has(f.uri.toString()));
      if (fresh.length) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading the TwinCAT files' }, async progress => {
          for (const f of fresh) {
            progress.report({ message: `downloading ${f.name}` });
            await prefetchRepository(f.uri);
            progress.report({ message: f.name });
            await vfs.loadFolder(f);
            loaded.add(f.uri.toString());
          }
        });
      }
      // Stub files are read as they are on the desktop: by path, relative to the first folder.
      const first = folders[0]?.uri.fsPath;
      for (const p of vscode.workspace.getConfiguration('twincatExplorer').get<string[]>('stubFiles', [])) {
        if (first || path.isAbsolute(p)) await vfs.loadFile(path.isAbsolute(p) || !first ? p : path.join(first, p));
      }
    },
    sync: uri => vfs.sync(uri),
  });

  // The TwinCAT Changes view compares with a branch only (no index in the browser): the base branch of the pull
  // request open (github.dev from a pull request), else the default branch, until another is picked.
  void api.ready.then(async () => {
    if (api.changes.scope.kind !== 'head' || !api.workspace.tsProjects.length) return;
    const ref = await revisions.defaultBase().catch(() => undefined);
    if (ref) await api.changes.setScope({ kind: 'branch', ref });
  });

  // Signed in to GitHub (blame needs it; a private repository too): the open editors read HEAD and blame again.
  context.subscriptions.push(vscode.authentication.onDidChangeSessions(e => {
    if (e.provider.id === 'github') api.objectEditors.refreshBases();
  }));

  const loadTheme = async () => {
    const file = activeThemeFile();
    if (file && (await loadThemeFiles(file))) api.objectEditors.postTheme();
  };
  void loadTheme();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => void loadTheme()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.colorTheme')) void loadTheme();
    }),
  );
  return api;
}

export function deactivate(): void {
  // Disposables are released through the extension context.
}

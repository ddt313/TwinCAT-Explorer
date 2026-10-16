// The changes one commit made to one object, in the split editor's layout (Declaration above Implementation),
// read-only: each pane is an inline diff of the commit's text against its parent's. One panel, reused for the
// next object picked in the TwinCAT Commits view, like a preview tab.

import * as path from 'path';
import * as vscode from 'vscode';
import { Accessor, viewLabel, viewSections } from '../core/objectText';
import { fileKey } from '../core/workspace';
import { HostMessage, PaneSection, ProbeAction, WEBVIEW_COMMANDS, WebviewMessage } from '../shared/protocol';
import { GitChanges } from './gitChanges';
import { ObjectEditorProvider, editorInit, editorWebviewHtml, editorWebviewOptions } from './objectEditor';
import { activeThemeTokens } from './theme';

export const COMMIT_DIFF_VIEW = 'twincatExplorer.commitDiff';

/** One object view as one commit changed it. */
export interface CommitObject {
  root: string;
  commit: string;
  /** First parent; undefined for the first commit of the repository. */
  parent?: string;
  /** Repository-relative path of the file in the commit, and in the parent (they differ for a rename). */
  path: string;
  fromPath: string;
  objectId: string;
  accessor?: Accessor;
}

interface Content {
  item: CommitObject;
  title: string;
  /** The file holding the object in the working tree now (it may have moved since the commit). */
  livePath: string | undefined;
  sections: PaneSection[];
  base: { key: string; text: string | null }[];
  baseLabel: string;
}

export class CommitDiffPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private content: Content | undefined;
  private readonly probes = new Map<number, (v: unknown) => void>();
  private probeId = 0;
  private readonly disposables: vscode.Disposable[] = [];
  /** Messages posted to the webview, kept for the integration tests. */
  readonly posted: HostMessage[] = [];
  /** The working-tree file that holds an object (by GUID), the given one first. */
  locate?: (objectId: string, preferred: string) => string | undefined;

  constructor(private readonly provider: ObjectEditorProvider, private readonly git: GitChanges) {
    const postTheme = () => this.post({ type: 'theme', theme: activeThemeTokens().rules });
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(postTheme),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.colorTheme')) postTheme();
        if (e.affectsConfiguration('editor') && this.panel) {
          this.post({ type: 'config', config: editorInit(this.panel.webview, this.provider.extensionUri).config });
        }
      }),
    );
  }

  /** The object shown now. */
  get shown(): CommitObject | undefined {
    return this.content?.item;
  }

  /** The working-tree file of the object shown, when it still exists. */
  get livePath(): string | undefined {
    return this.content?.livePath;
  }

  get visible(): boolean {
    return !!this.panel;
  }

  /** Shows an object as a commit changed it, in the panel (created on first use). */
  async show(item: CommitObject, preserveFocus = true): Promise<void> {
    const content = await this.load(item);
    if (!content) return;
    this.content = content;
    if (this.panel) {
      this.panel.title = content.title;
      this.panel.reveal(undefined, preserveFocus);
      if (this.ready) this.send();
      return;
    }
    const panel = vscode.window.createWebviewPanel(COMMIT_DIFF_VIEW, content.title, { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      { ...editorWebviewOptions(this.provider.extensionUri), retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(this.provider.extensionUri, 'media', 'twincat.svg');
    this.panel = panel;
    this.ready = false;
    panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.receive(m), undefined, this.disposables);
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.ready = false;
    }, undefined, this.disposables);
    panel.webview.html = editorWebviewHtml(panel.webview, this.provider.extensionUri);
  }

  /** The commit's and the parent's texts of the object's sections; undefined (with a message) when unreadable. */
  private async load(item: CommitObject): Promise<Content | undefined> {
    const after = await this.git.fileAtCommit(path.join(item.root, item.path), item.commit, item.path);
    const before = item.parent ? await this.git.fileAtCommit(path.join(item.root, item.fromPath), item.parent, item.fromPath) : {};
    const error = after.error ?? before.error;
    if (error) {
      void vscode.window.showErrorMessage(`TwinCAT: ${error}`);
      return undefined;
    }
    const now = after.file?.objects.get(item.objectId);
    const old = before.file?.objects.get(item.objectId);
    const obj = now ?? old;
    const nowSections = now ? viewSections(now, item.accessor) : [];
    const oldSections = old ? viewSections(old, item.accessor) : [];
    if (!obj || (nowSections.length === 0 && oldSections.length === 0)) {
      void vscode.window.showInformationMessage('The object is in neither the commit nor its parent.');
      return undefined;
    }
    // A deleted object or accessor shows its parent's sections, emptied: everything in them is removed.
    const sections: PaneSection[] = nowSections.length
      ? nowSections.map(s => ({ key: s.key, role: s.role, label: s.label, editable: false, text: s.text }))
      : oldSections.map(s => ({ key: s.key, role: s.role, label: s.label, editable: false, text: '' }));
    const base = sections.map(s => ({ key: s.key, text: before.file?.sections.get(s.key)?.text ?? null }));
    // A deleted property took its Get and Set with it: their code is shown removed below its declaration.
    if (!now && old?.kind === 'property' && !item.accessor && old.accessors.length) {
      const key = `${old.id}:accessors`;
      sections.push({ key, role: 'impl', label: 'Get / Set', editable: false, text: '' });
      base.push({ key, text: old.accessors.map(a => `// ${a.kind}\n${a.sections.map(s => s.text).join('\n\n')}`).join('\n\n') });
    }
    return {
      item,
      title: `${viewLabel(obj, item.accessor)} @ ${item.commit.slice(0, 7)}`,
      livePath: this.locate?.(item.objectId, path.join(item.root, item.path)),
      sections,
      base,
      baseLabel: item.parent ? `parent ${item.parent.slice(0, 7)}` : 'an empty repository',
    };
  }

  private send(): void {
    const c = this.content;
    if (!c || !this.panel) return;
    this.post({
      type: 'init',
      fileKey: `commit:${c.item.commit}:${c.item.path}`,
      title: c.title,
      sections: c.sections,
      ...editorInit(this.panel.webview, this.provider.extensionUri),
      changes: true,
      first: true,
    });
    this.post({ type: 'base', available: true, label: c.baseLabel, sections: c.base });
  }

  private receive(m: WebviewMessage): void {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.send();
        return;
      case 'request':
        this.answer(m);
        return;
      case 'open':
        void this.provider.navigate(m.target, undefined, m.side);
        return;
      case 'command':
        if (WEBVIEW_COMMANDS.has(m.command)) void vscode.commands.executeCommand(m.command);
        return;
      case 'probeResult': {
        const resolve = this.probes.get(m.id);
        this.probes.delete(m.id);
        resolve?.(m.result);
        return;
      }
      case 'error':
        this.provider.log?.(`Commit diff webview: ${m.message}`);
        return;
      default:
        // Read-only panes: no edits; focus, splitter and mode changes need nothing here.
        return;
    }
  }

  /** Hovers and go to definition, from what the working tree knows about the names. */
  private answer(m: Extract<WebviewMessage, { type: 'request' }>): void {
    const live = this.content?.livePath;
    const ctx = live ? this.provider.index.context(fileKey(live), m.key) : undefined;
    let result: unknown;
    if (ctx) {
      const features = this.provider.features;
      switch (m.kind) {
        case 'definition': {
          const loc = features.definitionAt(ctx, m.text, m.offset);
          result = loc ? this.provider.target(loc) : undefined;
          break;
        }
        case 'hover':
          result = features.hoverAt(ctx, m.text, m.offset);
          break;
        case 'references':
          result = features.referencesAt(ctx, m.text, m.offset, m.includeDeclaration ?? true)
            .map(loc => this.provider.target(loc)).filter(t => t !== undefined);
          break;
        case 'completion':
          result = [];
          break;
      }
    }
    this.post({ type: 'response', id: m.id, result: result ?? null });
  }

  private post(message: HostMessage): void {
    if (!this.panel) return;
    this.posted.push(message);
    if (this.posted.length > 200) this.posted.shift();
    void this.panel.webview.postMessage(message);
  }

  /** Runs a test action in the webview and returns its result. */
  probe(action: ProbeAction, timeout = 10000): Promise<unknown> {
    const id = ++this.probeId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probes.delete(id);
        reject(new Error(`commit diff webview did not answer the probe ${action.kind}`));
      }, timeout);
      this.probes.set(id, v => {
        clearTimeout(timer);
        resolve(v);
      });
      this.post({ type: 'probe', id, action });
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

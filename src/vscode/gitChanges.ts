// Changes of the TwinCAT objects against HEAD: the M/A badges of methods, properties and accessors in the
// TwinCAT tree and on the tabs of object views, and the HEAD text of an object view's sections, which the
// split editor compares its panes with (change markers, inline diff).

import * as path from 'path';
import * as vscode from 'vscode';
import { ObjectChange, changeKey, objectChanges } from '../core/objectChanges';
import { TcSourceFile, parseTcFile } from '../core/tcfile';
import { TcWorkspace, fileKey } from '../core/workspace';
import { GitDirWatcher, changedSourceFiles, headCommit, originalPath, repositoryRoot, showAtRef } from './git';
import { isSourcePath, parseObjectUri } from './uris';

/** HEAD text of each section of an object view; null for a section that is not in HEAD (a new object). */
export interface ViewBase {
  sections: { key: string; text: string | null }[];
}

interface HeadFile {
  head: string;
  /** Undefined when the file is not in HEAD (new or untracked). */
  file: TcSourceFile | undefined;
}

export class GitChanges implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly decorationsEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsEmitter.event;
  private readonly headEmitter = new vscode.EventEmitter<void>();
  /** HEAD moved (commit, checkout, rebase, reset): the HEAD texts shown by split editors may have changed. */
  readonly onDidChangeHead = this.headEmitter.event;
  /** Repository root per folder (fileKey); null outside a repository. */
  private readonly roots = new Map<string, Promise<string | null>>();
  /** HEAD commit per repository root (fileKey). */
  private readonly heads = new Map<string, { root: string; head: string }>();
  /** First HEAD lookup of a root, shared by the callers that ask meanwhile. */
  private readonly headLookups = new Map<string, Promise<string>>();
  /** HEAD version per file (fileKey), for the HEAD commit it was read at. */
  private readonly headFiles = new Map<string, Promise<HeadFile>>();
  /** Changed objects per file (fileKey), keyed by changeKey. */
  private readonly changes = new Map<string, { fsPath: string; objects: Map<string, ObjectChange> }>();
  /** Files changed on disk since the last recompute, by fileKey. */
  private readonly changedFiles = new Map<string, string>();
  private filesTimer: NodeJS.Timeout | undefined;
  private headTimer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  log?: (message: string) => void;

  constructor(private readonly ws: TcWorkspace, private readonly gitDirs: GitDirWatcher) {
    this.disposables.push(gitDirs.onDidChange(() => this.headMayHaveChanged()));
  }

  // ------------------------------------------------------------------ repositories and HEAD

  private rootOf(fsPath: string): Promise<string | null> {
    const dir = path.dirname(fsPath);
    let root = this.roots.get(fileKey(dir));
    if (!root) {
      root = repositoryRoot(dir).then(r => r ?? null);
      this.roots.set(fileKey(dir), root);
    }
    return root;
  }

  private headOf(root: string): Promise<string> {
    const key = fileKey(root);
    const known = this.heads.get(key);
    if (known) return Promise.resolve(known.head);
    let lookup = this.headLookups.get(key);
    if (!lookup) {
      lookup = headCommit(root).then(head => {
        this.headLookups.delete(key);
        if (!this.heads.has(key)) this.heads.set(key, { root, head });
        return this.heads.get(key)!.head;
      });
      this.headLookups.set(key, lookup);
    }
    return lookup;
  }

  /** The file as committed in HEAD; undefined outside a repository. */
  private async headFile(fsPath: string): Promise<HeadFile | undefined> {
    const root = await this.rootOf(fsPath);
    if (!root) return undefined;
    const head = await this.headOf(root);
    const key = fileKey(fsPath);
    const cached = this.headFiles.get(key);
    if (cached && (await cached).head === head) return cached;
    const read = (async (): Promise<HeadFile> => {
      if (!head) return { head, file: undefined };
      try {
        // A file renamed since HEAD is compared with its old path (or with the file that held the same object).
        const orig = await originalPath(fsPath, 'HEAD', false);
        const bytes = await showAtRef(fsPath, 'HEAD', orig);
        const file = bytes.length ? parseTcFile(fsPath, bytes) : undefined;
        return { head, file: file && !file.error ? file : undefined };
      } catch (e) {
        this.log?.(`Reading ${path.basename(fsPath)} at HEAD failed: ${(e as Error).message}`);
        return { head, file: undefined };
      }
    })();
    this.headFiles.set(key, read);
    return read;
  }

  /** True when the HEAD version of a file is already read for the current HEAD (comparing it needs no git). */
  private async headIsRead(fsPath: string): Promise<boolean> {
    const cached = this.headFiles.get(fileKey(fsPath));
    if (!cached) return false;
    const root = await this.rootOf(fsPath);
    if (!root) return true;
    const known = this.heads.get(fileKey(root));
    return !!known && (await cached).head === known.head;
  }

  /** Runs the refreshes one after the other, so git runs never pile up. */
  private run(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => (this.disposed ? undefined : work()))
      .catch(e => this.log?.(`Git changes: ${(e as Error).stack ?? e}`));
    this.queue = next;
    return next;
  }

  /** A repository may have moved its HEAD (the git extension or the .git watcher saw a change). */
  headMayHaveChanged(): void {
    if (this.headTimer) clearTimeout(this.headTimer);
    this.headTimer = setTimeout(() => void this.run(() => this.checkHeads()), 200);
  }

  private async checkHeads(): Promise<void> {
    let moved = false;
    for (const [key, known] of [...this.heads]) {
      const now = await headCommit(known.root);
      if (now === known.head) continue;
      this.heads.set(key, { root: known.root, head: now });
      moved = true;
    }
    if (!moved || this.disposed) return;
    // Split editors read the new HEAD texts right away; the marks of the tree follow.
    this.headEmitter.fire();
    await this.refreshAllNow();
  }

  // ------------------------------------------------------------------ object changes

  /** Looks at every repository of the workspace's PLC projects again (start, projects reloaded, HEAD moved). */
  refreshAll(): Promise<void> {
    return this.run(() => this.refreshAllNow());
  }

  private async refreshAllNow(): Promise<void> {
    const roots = new Map<string, string>();
    for (const plc of this.ws.plcProjects) {
      const root = await this.rootOf(plc.path);
      if (!root) continue;
      roots.set(fileKey(root), root);
      void this.gitDirs.watch(plc.path);
    }
    const candidates = new Map<string, string>();
    for (const root of roots.values()) {
      await this.headOf(root);
      try {
        // Only files of the projects: the tree shows nothing else (templates, copies in worktrees).
        for (const f of await changedSourceFiles(root)) if (this.ws.entry(f)) candidates.set(fileKey(f), f);
      } catch (e) {
        this.log?.(`git status in ${root} failed: ${(e as Error).message}`);
      }
    }
    // Files marked before and no longer changed (committed, reverted) lose their marks.
    for (const [key, known] of this.changes) if (!candidates.has(key)) candidates.set(key, known.fsPath);
    for (const f of candidates.values()) {
      if (this.disposed) return;
      await this.computeFile(f);
    }
    // HEAD versions are kept for the files with changes only (they are compared again at every save).
    for (const key of [...this.headFiles.keys()]) if (!this.changes.has(key)) this.headFiles.delete(key);
    this.decorationsEmitter.fire(undefined);
  }

  /** A source file changed on disk: its marks are computed again (debounced, files changed together at once). */
  fileChanged(fsPath: string): void {
    // Files outside the projects (copies in .claude/worktrees, templates) are not in the tree.
    if (!isSourcePath(fsPath) || !this.ws.entry(fsPath)) return;
    this.changedFiles.set(fileKey(fsPath), fsPath);
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => {
      this.filesTimer = undefined;
      void this.run(() => this.recomputeChangedFiles());
    }, 300);
  }

  private async recomputeChangedFiles(): Promise<void> {
    const files = [...this.changedFiles.values()];
    this.changedFiles.clear();
    let changed = false;
    let unknown = false;
    for (const f of files) {
      // A file whose HEAD version is not read yet: one git status finds out whether it differs at all (a
      // checkout or rebase touches many files at once, most of them equal to HEAD afterwards).
      if (await this.headIsRead(f)) changed = (await this.computeFile(f)) || changed;
      else unknown = true;
    }
    if (unknown) await this.refreshAllNow();
    else if (changed) this.decorationsEmitter.fire(undefined);
  }

  /** Computes the changed objects of a file; true when they differ from what was known. */
  private async computeFile(fsPath: string): Promise<boolean> {
    const key = fileKey(fsPath);
    const before = this.changes.get(key)?.objects;
    let now: Map<string, ObjectChange> | undefined;
    try {
      const work = this.ws.getFile(fsPath);
      if (work && !work.error && work.root) {
        const head = await this.headFile(fsPath);
        if (head) now = objectChanges(head.file, work);
      }
    } catch (e) {
      // The file is held by another program (XAE, a virus scanner) or went away during a checkout: its marks
      // stay as they were until it changes again.
      this.log?.(`Comparing ${path.basename(fsPath)} with HEAD failed: ${(e as Error).message}`);
      return false;
    }
    if (now && now.size) this.changes.set(key, { fsPath, objects: now });
    else this.changes.delete(key);
    return (before?.size ?? 0) !== (now?.size ?? 0) || [...(now ?? [])].some(([k, v]) => before?.get(k) !== v);
  }

  /** Change of an object view (or of an object with all its accessors) against HEAD. */
  changeOf(fsPath: string, objectId: string, accessor?: 'Get' | 'Set'): ObjectChange | undefined {
    return this.changes.get(fileKey(fsPath))?.objects.get(changeKey(objectId, accessor));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const ref = parseObjectUri(uri);
    if (!ref) return undefined;
    const change = this.changeOf(ref.fsPath, ref.objectId, ref.accessor);
    if (change === 'added') {
      return new vscode.FileDecoration('A', 'Added since HEAD', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    }
    if (change === 'modified') {
      return new vscode.FileDecoration('M', 'Modified since HEAD', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    }
    return undefined;
  }

  // ------------------------------------------------------------------ split editor

  /** HEAD texts of sections of a file; undefined when the file is not in a repository. */
  async viewBase(fsPath: string, sectionKeys: string[]): Promise<ViewBase | undefined> {
    const head = await this.headFile(fsPath);
    if (!head) return undefined;
    void this.gitDirs.watch(fsPath);
    return { sections: sectionKeys.map(key => ({ key, text: head.file?.sections.get(key)?.text ?? null })) };
  }

  dispose(): void {
    this.disposed = true;
    if (this.headTimer) clearTimeout(this.headTimer);
    if (this.filesTimer) clearTimeout(this.filesTimer);
    for (const d of this.disposables) d.dispose();
    this.decorationsEmitter.dispose();
    this.headEmitter.dispose();
  }
}

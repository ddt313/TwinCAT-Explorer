// Changes of the TwinCAT objects against HEAD: the M/A badges of methods, properties and accessors in the
// TwinCAT tree and on the tabs of object views, and the HEAD text of an object view's sections, which the
// split editor compares its panes with (change markers, inline diff).

import * as path from 'path';
import * as vscode from 'vscode';
import { cached } from '../core/cache';
import { ObjectChange, ViewChange, changeKey, objectChanges, viewChanges } from '../core/objectChanges';
import { TcSourceFile, parseTcFile } from '../core/tcfile';
import { TcWorkspace, fileKey } from '../core/workspace';
import { GitDirWatcher, changedSourceFiles, headCommit, mergeBase, originalPath, repositoryRoot, showAtRef } from './git';
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

/** A source file read at a commit. */
export interface CommitFile {
  /** The file; undefined when it is not in that commit. */
  file?: TcSourceFile;
  /** Why it could not be read (git failed, the XML does not parse): then nothing is known about it. */
  error?: string;
}

export class GitChanges implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly decorationsEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsEmitter.event;
  private readonly headEmitter = new vscode.EventEmitter<void>();
  /** HEAD moved (commit, checkout, rebase, reset): the HEAD texts shown by split editors may have changed. */
  readonly onDidChangeHead = this.headEmitter.event;
  /** Repository root per folder (fileKey); undefined outside a repository. */
  private readonly roots = new Map<string, Promise<string | undefined>>();
  /** HEAD commit per repository root (fileKey). */
  private readonly heads = new Map<string, { root: string; head: string }>();
  /** First HEAD lookup of a root, shared by the callers that ask meanwhile. */
  private readonly headLookups = new Map<string, Promise<string>>();
  /** HEAD version per file (fileKey), for the HEAD commit it was read at. */
  private readonly headFiles = new Map<string, Promise<HeadFile | undefined>>();
  /** Files at a commit (they never change), the oldest dropped first. */
  private readonly commitFiles = new Map<string, Promise<CommitFile>>();
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

  /** Root of the repository of a file (spelled like the file's path); undefined outside a repository. */
  root(fsPath: string): Promise<string | undefined> {
    const dir = path.dirname(fsPath);
    let root = this.roots.get(fileKey(dir));
    if (!root) {
      root = repositoryRoot(dir);
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

  /**
   * The file as committed in HEAD (`file` undefined: not in HEAD), with the HEAD commit; undefined outside a
   * repository, or when HEAD's version cannot be read (nothing is known then: no marks, no change markers).
   */
  async headFile(fsPath: string): Promise<HeadFile | undefined> {
    const root = await this.root(fsPath);
    if (!root) return undefined;
    const head = await this.headOf(root);
    const key = fileKey(fsPath);
    const cached = this.headFiles.get(key);
    if (cached && (await cached)?.head === head) return cached;
    const read = (async (): Promise<HeadFile | undefined> => {
      if (!head) return { head, file: undefined };
      // At the commit, not at HEAD: HEAD may have moved before checkHeads noticed, and the text must be the
      // commit's it is labelled with.
      const r = await this.readAt(fsPath, head);
      if (r.error) this.log?.(`Reading ${path.basename(fsPath)} at HEAD (${head.slice(0, 7)}) failed: ${r.error}`);
      return r.error ? undefined : { head, file: r.file };
    })();
    this.headFiles.set(key, read);
    // A failed read is tried again the next time.
    void read.then(r => {
      if (!r && this.headFiles.get(key) === read) this.headFiles.delete(key);
    });
    return read;
  }

  /** A source file at a ref (followed through renames since, or at `from`, its repository-relative path there). */
  private async readAt(fsPath: string, ref: string, from?: string): Promise<CommitFile> {
    try {
      const orig = from ?? (await originalPath(fsPath, ref, false));
      const bytes = await showAtRef(fsPath, ref, orig);
      if (!bytes.length) return {};
      const file = parseTcFile(fsPath, bytes);
      return file.error ? { error: `${path.basename(fsPath)} does not parse at ${ref.slice(0, 7)}: ${file.error}` } : { file };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /** True when the HEAD version of a file is already read for the current HEAD (comparing it needs no git). */
  private async headIsRead(fsPath: string): Promise<boolean> {
    const cached = this.headFiles.get(fileKey(fsPath));
    if (!cached) return false;
    const root = await this.root(fsPath);
    if (!root) return true;
    const known = this.heads.get(fileKey(root));
    return !!known && (await cached)?.head === known.head;
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
      const root = await this.root(plc.path);
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

  /**
   * Texts of sections of a file at HEAD, at a commit, or at the merge base of HEAD with a branch (the base of
   * a comparison); undefined when that version cannot be read (no repository, no such branch).
   */
  async viewBase(fsPath: string, sectionKeys: string[], base: { ref: string; mergeBase?: boolean; path?: string }): Promise<ViewBase | undefined> {
    let file: TcSourceFile | undefined;
    if (base.ref === 'HEAD' && !base.mergeBase) {
      const head = await this.headFile(fsPath);
      if (!head) return undefined;
      file = head.file;
    } else {
      const root = await this.root(fsPath);
      if (!root) return undefined;
      // Taken again each time: a rebase moves the merge base.
      const commit = base.mergeBase ? await mergeBase(root, base.ref) : base.ref;
      if (!commit) return undefined;
      const read = await this.fileAtCommit(fsPath, commit, base.mergeBase ? undefined : base.path);
      if (read.error) return undefined;
      file = read.file;
    }
    void this.gitDirs.watch(fsPath);
    return { sections: sectionKeys.map(key => ({ key, text: file?.sections.get(key)?.text ?? null })) };
  }

  /**
   * A source file as it is in a commit (followed through renames since, or at `from`, its repository-relative
   * path there). Failed reads are not kept, the next call tries again.
   */
  fileAtCommit(fsPath: string, commit: string, from?: string): Promise<CommitFile> {
    return cached(this.commitFiles, `${commit}|${from ?? fileKey(fsPath)}`, () => this.readAt(fsPath, commit, from), 400, r => !!r.error);
  }

  /**
   * The object views of a file that differ from HEAD, as the TwinCAT Changes view lists them (deleted ones
   * too); undefined when HEAD's version cannot be read.
   */
  async viewChangesOf(fsPath: string): Promise<ViewChange[] | undefined> {
    const work = this.ws.getFile(fsPath);
    if (!work || work.error) return undefined;
    const head = await this.headFile(fsPath);
    return head ? viewChanges(head.file, work) : undefined;
  }

  /** Repository roots of the workspace's PLC projects, also of those that did not load (merge conflicts). */
  async repositories(): Promise<string[]> {
    const roots = new Map<string, string>();
    const plcPaths = new Set(this.ws.tsProjects.flatMap(t => t.plcProjects.map(r => r.plcprojPath)));
    for (const p of plcPaths) {
      const root = await this.root(p);
      if (root) roots.set(fileKey(root), root);
    }
    return [...roots.values()];
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

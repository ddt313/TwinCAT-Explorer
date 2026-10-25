// Commits of a GitHub repository opened in the browser (vscode.dev, github.dev): HEAD from the Remote Repositories
// extension, which opened it (the commit of the branch, tag or pull request shown), and the files of a commit from
// GitHub's REST API, with the GitHub account VS Code is signed in with.

import * as vscode from 'vscode';
import { BlameCommit, CommitInfo, FileLogEntry, NameStatus } from '../core/gitLog';
import { BlameResult, RevisionSource } from '../vscode/git';
import { blobId } from './crypto';
import * as vfs from './vfs';

/** What the Remote Repositories extension exports (ms-vscode.remote-repositories, its ExtensionApi). */
interface RemoteHubApi {
  getMetadata(uri: vscode.Uri): Promise<{
    provider: { id: string; name: string };
    repo: { owner: string; name: string };
    getRevision(): Promise<{ type: number; name: string; revision: string }>;
  } | undefined>;
  /** Downloads the repository's files at once (a tarball, kept in memory); false when it did not. */
  loadWorkspaceContents(uri: vscode.Uri): Promise<boolean>;
}

const REMOTE_HUB = 'ms-vscode.remote-repositories';
const API = 'https://api.github.com';
/** Files of commits never change: the last ones read are kept. */
const KEPT = 200;
/** How long a merge base is kept: the branch compared with can move meanwhile. */
const MERGE_BASE_MS = 60_000;
/** Pages of 300 files read of a commit at most (GitHub lists 3000 at most). */
const COMMIT_FILE_PAGES = 10;
/** Pages of 100 commits read of a file's history at most: its commits since the 1000th last are not listed. */
const LOG_PAGES = 10;

const BLAME_QUERY = `query($owner: String!, $name: String!, $commit: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $commit) {
      ... on Commit {
        blame(path: $path) {
          ranges { startingLine endingLine commit { oid authoredDate messageHeadline author { name email } } }
        }
      }
    }
  }
}`;

interface RestCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; author: { name: string; email: string; date: string } | null };
  /** In the answer of `commits/<sha>`: what it changed against its first parent, 300 a page. */
  files?: { filename: string; status: string; previous_filename?: string }[];
}

function commitInfo(c: RestCommit): CommitInfo {
  const [subject, ...rest] = c.commit.message.split('\n');
  return {
    sha: c.sha, parents: c.parents.map(p => p.sha), author: c.commit.author?.name ?? '', email: c.commit.author?.email ?? '',
    date: Math.floor(Date.parse(c.commit.author?.date ?? '') / 1000) || 0, subject, body: rest.join('\n').trim(),
  };
}

/** A file of a commit as git's name-status has it: a copy is an added file, a change of type a changed one. */
function nameStatus(f: { filename: string; status: string; previous_filename?: string }): NameStatus {
  switch (f.status) {
    case 'added': case 'copied': return { status: 'A', path: f.filename };
    case 'removed': return { status: 'D', path: f.filename };
    case 'renamed': return f.previous_filename ? { status: 'R', path: f.filename, from: f.previous_filename } : { status: 'A', path: f.filename };
    default: return { status: 'M', path: f.filename };
  }
}

/** A ref in a URL path: its slashes kept (feature/x), the rest encoded. */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}


async function remoteHub(): Promise<RemoteHubApi | undefined> {
  const ext = vscode.extensions.getExtension<RemoteHubApi>(REMOTE_HUB);
  if (!ext) return undefined;
  return ext.isActive ? ext.exports : ext.activate();
}

/**
 * Has GitHub Repositories download a workspace folder's repository in one go before its TwinCAT files are read:
 * without it each file is one request to GitHub's API (a thousand POUs, a thousand requests). False when it did
 * not (not a GitHub repository, too large for its limit, offline): the files are then read one by one.
 */
export async function prefetchRepository(folder: vscode.Uri): Promise<boolean> {
  if (folder.scheme !== 'vscode-vfs' || !/^github(\+|$)/.test(folder.authority)) return false;
  try {
    return (await (await remoteHub())?.loadWorkspaceContents(folder)) ?? false;
  } catch {
    return false;
  }
}

interface Repository {
  folder: vscode.WorkspaceFolder;
  owner: string;
  name: string;
}

export class GitHubRevisions implements RevisionSource {
  private readonly repos = new Map<string, Promise<Repository | undefined>>();
  private readonly files = new Map<string, Promise<Uint8Array | undefined>>();
  /** The files of commits' trees (path → blob id), per repository root and commit. */
  private readonly trees = new Map<string, Promise<Map<string, string>>>();
  private readonly mergeBases = new Map<string, { at: number; commit: Promise<string | undefined> }>();
  private readonly commits = new Map<string, Promise<RestCommit | undefined>>();
  /** The commits of HEAD read so far, per repository root and HEAD. */
  private readonly logs = new Map<string, { commits: CommitInfo[]; done: boolean }>();
  /** Blob ids of the working tree's files, per path and modification. */
  private readonly blobIds = new Map<string, { mtimeMs: number; id: string }>();
  /** Whether a repository answers without signing in (a public one), per owner/name. */
  private readonly publicRepos = new Map<string, Promise<boolean>>();

  constructor() {
    // Signed in or out meanwhile: the repositories that did not answer are asked again.
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'github') this.publicRepos.clear();
    });
  }

  /** The folder of a workspace opened from GitHub (`vscode-vfs://github/<owner>/<repo>`) holding the file. */
  root(fsPath: string): string | undefined {
    const uri = vfs.uriOf(fsPath);
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    return folder && folder.uri.scheme === 'vscode-vfs' && /^github(\+|$)/.test(folder.uri.authority) ? folder.uri.fsPath : undefined;
  }

  private repository(root: string): Promise<Repository | undefined> {
    let repo = this.repos.get(root);
    if (!repo) {
      repo = (async () => {
        const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === root);
        const meta = folder && (await (await remoteHub())?.getMetadata(folder.uri));
        if (!folder || meta?.provider.id !== 'github') return undefined;
        return { folder, owner: meta.repo.owner, name: meta.repo.name };
      })();
      this.repos.set(root, repo);
      // Looked up again next time when it failed (the extension still starting).
      void repo.then(r => {
        if (!r) this.repos.delete(root);
      }, () => this.repos.delete(root));
    }
    return repo;
  }

  async head(root: string): Promise<string> {
    const repo = await this.repository(root);
    if (!repo) throw new Error('The repository of the workspace is not known (GitHub Repositories)');
    // Asked each time: the branch shown can be switched (the commits of a branch move).
    const meta = await (await remoteHub())?.getMetadata(repo.folder.uri);
    const revision = (await meta?.getRevision())?.revision;
    if (!revision) throw new Error(`The commit of ${repo.owner}/${repo.name} shown is not known`);
    return revision;
  }

  read(root: string, relPath: string, commit: string): Promise<Uint8Array | undefined> {
    const key = `${root}|${commit}|${relPath}`;
    let file = this.files.get(key);
    if (!file) {
      file = this.fetchFile(root, relPath, commit);
      this.files.set(key, file);
      if (this.files.size > KEPT) this.files.delete(this.files.keys().next().value!);
      void file.catch(() => this.files.delete(key));
    }
    return file;
  }

  private async fetchFile(root: string, relPath: string, commit: string): Promise<Uint8Array | undefined> {
    const response = await this.request(root, `contents/${relPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commit)}`,
      'application/vnd.github.raw+json', `Reading ${relPath} at ${commit.slice(0, 7)}`);
    return response && new Uint8Array(await response.arrayBuffer());
  }

  /**
   * A request about the repository of a workspace folder (`repos/<owner>/<name>/<what>`); undefined when GitHub
   * answers 404 (no such file or ref). Throws when the repository cannot be read: signed out of a private one, the
   * rate limit reached, offline.
   */
  private async request(root: string, what: string, accept: string, doing: string): Promise<Response | undefined> {
    const repo = await this.repository(root);
    if (!repo) throw new Error('The repository of the workspace is not known (GitHub Repositories)');
    const session = await this.session(true);
    const response = await this.get(`${API}/repos/${repo.owner}/${repo.name}${what ? `/${what}` : ''}`, session, accept);
    // A private repository answers 404 to whoever is not signed in, as for a file the commit does not have.
    if (!session && [401, 403, 404].includes(response.status) && !(await this.isPublic(repo))) {
      void this.session(false);
      throw new Error(`Sign in with GitHub (the Accounts menu) to compare with ${repo.owner}/${repo.name} as it is on GitHub`);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const why = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0' ? 'the rate limit of GitHub\'s API is reached'
        : `${response.status} ${response.statusText}`;
      throw new Error(`${doing} from GitHub failed: ${why}`);
    }
    return response;
  }

  private get(url: string, session: vscode.AuthenticationSession | undefined, accept = 'application/vnd.github+json'): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (session) headers.Authorization = `Bearer ${session.accessToken}`;
    return fetch(url, { headers });
  }

  async resolve(root: string, ref: string): Promise<string | undefined> {
    const response = await this.request(root, `commits/${refPath(ref)}`, 'application/vnd.github.sha', `Looking up ${ref}`);
    return response && (await response.text()).trim();
  }

  mergeBase(root: string, ref: string): Promise<string | undefined> {
    return (async () => {
      const head = await this.head(root);
      const key = `${root}|${ref}|${head}`;
      const known = this.mergeBases.get(key);
      if (known && Date.now() - known.at < MERGE_BASE_MS) return known.commit;
      const commit = (async () => {
        // One commit per page: only the merge base is wanted, not the list of commits.
        const response = await this.request(root, `compare/${refPath(ref)}...${head}?per_page=1`, 'application/vnd.github+json', `Comparing with ${ref}`);
        return response ? ((await response.json()) as { merge_base_commit?: { sha?: string } }).merge_base_commit?.sha : undefined;
      })();
      this.mergeBases.set(key, { at: Date.now(), commit });
      void commit.catch(() => this.mergeBases.delete(key));
      return commit;
    })();
  }

  /**
   * Compares the tree of the commit (one request, kept) with the files in memory by their blob ids, as git compares
   * a commit with the working tree: changes not committed are in, and there is no limit on the number of files (the
   * file list of GitHub's comparisons stops at 300). Renames show as a file deleted and one added.
   */
  async changesSince(root: string, base: string, extensions: string[]): Promise<NameStatus[]> {
    const lower = extensions.map(e => e.toLowerCase());
    const wanted = (p: string) => lower.some(e => p.toLowerCase().endsWith(e));
    const tree = await this.tree(root, base);
    const working = new Map<string, string>();
    for (const f of vfs.contents(root)) {
      if (!wanted(f.relPath)) continue;
      const key = `${root}|${f.relPath}`;
      let known = this.blobIds.get(key);
      if (known?.mtimeMs !== f.mtimeMs) this.blobIds.set(key, known = { mtimeMs: f.mtimeMs, id: blobId(f.bytes) });
      working.set(f.relPath, known.id);
    }
    const out: NameStatus[] = [];
    for (const [p, id] of tree) {
      if (!wanted(p)) continue;
      const now = working.get(p);
      if (now === undefined) out.push({ status: 'D', path: p });
      else if (now !== id) out.push({ status: 'M', path: p });
    }
    for (const p of working.keys()) if (!tree.has(p)) out.push({ status: 'A', path: p });
    return out;
  }

  private tree(root: string, commit: string): Promise<Map<string, string>> {
    const key = `${root}|${commit}`;
    let tree = this.trees.get(key);
    if (!tree) {
      tree = (async () => {
        const response = await this.request(root, `git/trees/${commit}?recursive=1`, 'application/vnd.github+json', `Reading the files of ${commit.slice(0, 7)}`);
        if (!response) throw new Error(`GitHub does not have the commit ${commit.slice(0, 7)}`);
        const json = (await response.json()) as { truncated?: boolean; tree: { path: string; type: string; sha: string }[] };
        if (json.truncated) throw new Error(`The repository has too many files for GitHub to list those of ${commit.slice(0, 7)}`);
        return new Map(json.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
      })();
      this.trees.set(key, tree);
      void tree.catch(() => this.trees.delete(key));
    }
    return tree;
  }

  /**
   * A file's history from GitHub's list of the commits that changed it (renames not followed). Each commit's
   * versions are `<commit>:<path>` specs, the one before it at its first parent: git.ts's readBlobs reads them, only
   * for the commits the History view looks at.
   */
  async fileLog(root: string, relPath: string): Promise<FileLogEntry[]> {
    const head = await this.head(root);
    const out: FileLogEntry[] = [];
    for (let page = 1; page <= LOG_PAGES; page++) {
      const response = await this.request(root, `commits?sha=${head}&path=${encodeURIComponent(relPath)}&per_page=100&page=${page}`,
        'application/vnd.github+json', `Reading the history of ${relPath}`);
      const commits = ((await response?.json()) as RestCommit[] | undefined) ?? [];
      for (const c of commits) {
        const parent = c.parents[0]?.sha;
        out.push({
          commit: commitInfo(c),
          status: 'M', oldBlob: parent && `${parent}:${relPath}`, newBlob: `${c.sha}:${relPath}`, oldPath: relPath, newPath: relPath,
        });
      }
      if (commits.length < 100) break;
    }
    return out;
  }

  async firstParent(root: string, sha: string): Promise<string | undefined> {
    return (await this.commit(root, sha))?.parents[0]?.sha;
  }

  /** A commit with the files it changed (all their pages), kept: a commit never changes. */
  private commit(root: string, sha: string): Promise<RestCommit | undefined> {
    const key = `${root}|${sha}`;
    let known = this.commits.get(key);
    if (!known) {
      known = (async () => {
        let first: RestCommit | undefined;
        for (let page = 1; page <= COMMIT_FILE_PAGES; page++) {
          const response = await this.request(root, `commits/${sha}?per_page=300&page=${page}`, 'application/vnd.github+json',
            `Reading the commit ${sha.slice(0, 7)}`);
          const c = (await response?.json()) as RestCommit | undefined;
          if (!c) return first;
          if (!first) first = c;
          else first.files!.push(...(c.files ?? []));
          if ((c.files?.length ?? 0) < 300) break;
        }
        return first;
      })();
      this.commits.set(key, known);
      if (this.commits.size > KEPT) this.commits.delete(this.commits.keys().next().value!);
      void known.catch(() => this.commits.delete(key));
    }
    return known;
  }

  async commitChanges(root: string, commit: string): Promise<NameStatus[]> {
    const c = await this.commit(root, commit);
    if (!c) throw new Error(`GitHub does not have the commit ${commit.slice(0, 7)}`);
    return (c.files ?? []).map(nameStatus);
  }

  /** The commits of HEAD, 100 a page: the pages read are kept while HEAD stays (Load more reads the next one). */
  async commitLog(root: string, count: number): Promise<CommitInfo[]> {
    const head = await this.head(root);
    const key = `${root}|${head}`;
    let log = this.logs.get(key);
    if (!log) this.logs.set(key, log = { commits: [], done: false });
    while (!log.done && log.commits.length < count) {
      const page = Math.floor(log.commits.length / 100) + 1;
      const response = await this.request(root, `commits?sha=${head}&per_page=100&page=${page}`, 'application/vnd.github+json', 'Reading the commits');
      const commits = ((await response?.json()) as RestCommit[] | undefined) ?? [];
      log.commits.push(...commits.map(commitInfo));
      if (commits.length < 100) log.done = true;
    }
    return log.commits.slice(0, count);
  }

  /**
   * Blame from GitHub's GraphQL API, which needs a sign-in even for a public repository: without one VS Code's
   * Accounts menu gets a sign-in request, and the lines have no blame.
   */
  async blame(root: string, commit: string, relPath: string, ranges: [number, number][]): Promise<BlameResult> {
    const repo = await this.repository(root);
    if (!repo) throw new Error('The repository of the workspace is not known (GitHub Repositories)');
    const session = await this.session(true);
    if (!session) {
      void this.session(false);
      throw new Error('Sign in with GitHub (the Accounts menu) to see who changed the lines');
    }
    const response = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: BLAME_QUERY, variables: { owner: repo.owner, name: repo.name, commit, path: relPath } }),
    });
    type Range = { startingLine: number; endingLine: number; commit: { oid: string; authoredDate: string; messageHeadline: string; author: { name: string; email: string } | null } };
    const json = (await response.json()) as { data?: { repository?: { object?: { blame?: { ranges: Range[] } } } }; errors?: { message: string }[] };
    const found = json.data?.repository?.object?.blame?.ranges;
    if (!response.ok || !found) throw new Error(`Blame of ${relPath} from GitHub failed: ${json.errors?.[0]?.message ?? `${response.status} ${response.statusText}`}`);
    const lines = new Map<number, string>();
    const commits = new Map<string, BlameCommit>();
    const wanted = (line: number) => ranges.some(([start, end]) => line >= start && line <= end);
    for (const r of found) {
      for (let line = r.startingLine; line <= r.endingLine; line++) if (wanted(line)) lines.set(line, r.commit.oid);
      if (commits.has(r.commit.oid)) continue;
      commits.set(r.commit.oid, {
        sha: r.commit.oid, author: r.commit.author?.name ?? '', email: r.commit.author?.email ?? '',
        time: Math.floor(Date.parse(r.commit.authoredDate) / 1000) || 0, summary: r.commit.messageHeadline, filename: relPath,
      });
    }
    return { lines, commits };
  }

  /**
   * The branch to compare the workspace with: the base branch of the pull request of the commit shown (github.dev
   * opened from a pull request), else the repository's default branch.
   */
  async defaultBase(): Promise<string | undefined> {
    const root = vscode.workspace.workspaceFolders?.map(f => this.root(f.uri.fsPath)).find(r => r);
    if (!root) return undefined;
    const head = await this.head(root);
    type Pull = { state: string; head: { sha: string }; base: { ref: string } };
    const pulls = await this.request(root, `commits/${head}/pulls`, 'application/vnd.github+json', 'Looking up the pull request');
    const open = ((await pulls?.json()) as Pull[] | undefined)?.filter(p => p.state === 'open') ?? [];
    const pull = open.find(p => p.head.sha === head) ?? open[0];
    if (pull) return pull.base.ref;
    const repo = await this.request(root, '', 'application/vnd.github+json', 'Reading the repository');
    return ((await repo?.json()) as { default_branch?: string } | undefined)?.default_branch;
  }

  private isPublic(repo: Repository): Promise<boolean> {
    const key = `${repo.owner}/${repo.name}`;
    let known = this.publicRepos.get(key);
    if (!known) {
      known = this.get(`${API}/repos/${repo.owner}/${repo.name}`, undefined).then(r => r.ok, () => {
        this.publicRepos.delete(key);
        return false;
      });
      this.publicRepos.set(key, known);
    }
    return known;
  }

  async canRead(fsPath: string): Promise<boolean> {
    const root = this.root(fsPath);
    const repo = root ? await this.repository(root) : undefined;
    if (!repo) {
      void vscode.window.showInformationMessage(
        `${fsPath.split(/[\\/]/).pop()} is not in a repository opened from GitHub: there is no HEAD to compare with in the browser.`);
      return false;
    }
    if ((await this.session(true)) || (await this.isPublic(repo))) return true;
    const choice = await vscode.window.showInformationMessage(
      `${repo.owner}/${repo.name} is private: sign in with GitHub to compare with HEAD.`, 'Sign In');
    if (choice !== 'Sign In') return false;
    try {
      return !!(await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }));
    } catch {
      return false;
    }
  }

  /**
   * The GitHub session to read the repository with, if VS Code has one for this extension. Not `silent`, VS Code
   * adds a sign-in request to its Accounts menu rather than asking at once: the split editor reads HEAD as soon
   * as it opens, to mark the changed lines, and a public repository needs no sign-in.
   */
  private async session(silent: boolean): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession('github', ['repo'], silent ? { silent: true } : {});
    } catch {
      return undefined;
    }
  }
}

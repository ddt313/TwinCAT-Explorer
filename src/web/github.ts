// Commits of a GitHub repository opened in the browser (vscode.dev, github.dev): HEAD from the Remote Repositories
// extension, which opened it (the commit of the branch, tag or pull request shown), and the files of a commit from
// GitHub's REST API, with the GitHub account VS Code is signed in with.

import * as vscode from 'vscode';
import { RevisionSource } from '../vscode/git';
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
    const repo = await this.repository(root);
    if (!repo) throw new Error('The repository of the workspace is not known (GitHub Repositories)');
    const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${relPath.split('/').map(encodeURIComponent).join('/')}`
      + `?ref=${encodeURIComponent(commit)}`;
    const session = await this.session(true);
    const response = await this.get(url, session);
    // A private repository answers 404 to whoever is not signed in, as for a file the commit does not have.
    if (!session && [401, 403, 404].includes(response.status) && !(await this.isPublic(repo))) {
      void this.session(false);
      throw new Error(`Sign in with GitHub (the Accounts menu) to compare with ${repo.owner}/${repo.name} as it is on GitHub`);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const why = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0' ? 'the rate limit of GitHub\'s API is reached'
        : `${response.status} ${response.statusText}`;
      throw new Error(`Reading ${relPath} at ${commit.slice(0, 7)} from GitHub failed: ${why}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private get(url: string, session: vscode.AuthenticationSession | undefined): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (session) headers.Authorization = `Bearer ${session.accessToken}`;
    return fetch(url, { headers });
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

// The command line that registers the extension's MCP server with Claude Code for one folder (scope local:
// in ~/.claude.json, never in the repository), the programs it needs, and the permission rules the folder's own
// Claude Code settings get. Independent of the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import { RunGit } from './staging';

/** The name Claude Code knows the server by; its tools are mcp__twincat__*. */
export const MCP_SERVER_NAME = 'twincat';

/** How Claude Code starts the server: a program, its arguments and environment. */
export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The server run by Node when it is on PATH (`node`, so that a Node update keeps working), else by the editor's
 * own Electron as Node (ELECTRON_RUN_AS_NODE), which needs nothing installed. Paths take forward slashes, which
 * Windows accepts: through npm's claude.cmd, a quoted argument (a path with spaces) loses its backslashes.
 */
export function serverLaunch(serverJs: string, nodeOnPath: boolean, electron: string): ServerLaunch {
  const slashes = (p: string) => p.replace(/\\/g, '/');
  return nodeOnPath
    ? { command: 'node', args: [slashes(serverJs)], env: {} }
    : { command: slashes(electron), args: [slashes(serverJs)], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** `claude` arguments that register the server for the folder Claude Code runs in. */
export function claudeAddArgs(launch: ServerLaunch): string[] {
  const env = Object.entries(launch.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'local', ...env, '--', launch.command, ...launch.args];
}

/** `claude` arguments that remove the folder's registration (before adding it again with another path). */
export function claudeRemoveArgs(): string[] {
  return ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'local'];
}

/**
 * The folder as Claude Code's sessions and terminals give it, a Windows drive letter in upper case. Claude Code files a
 * local-scope server under the exact folder that `claude mcp add` runs in, and VS Code's fsPath has the drive letter
 * in lower case (`c:\repo`): a server added from there is never found by a session.
 */
export function claudeFolder(folder: string): string {
  return folder.replace(/^[a-z](?=:)/, d => d.toUpperCase());
}

/** Runs Claude Code's `claude` with these arguments in a folder. */
export type RunClaude = (args: string[], cwd: string) => Promise<{ ok: boolean; output: string }>;

/**
 * Registers the server for a folder from Claude Code's spelling of it, in place of an earlier registration (add
 * refuses a name already there): the one in that spelling, and one made in VS Code's (a lower case drive letter),
 * where no session looks.
 */
export async function registerServer(run: RunClaude, folder: string, launch: ServerLaunch): Promise<{ ok: boolean; output: string }> {
  const cwd = claudeFolder(folder);
  const lower = folder.replace(/^[A-Z](?=:)/, d => d.toLowerCase());
  for (const f of new Set([lower, cwd])) await run(claudeRemoveArgs(), f);
  return run(claudeAddArgs(launch), cwd);
}

/** The server's tools that only read (check with compiler: true runs XAE's Check all objects, which saves nothing). */
export const MCP_READ_TOOLS = ['status', 'objects', 'read', 'locate', 'find_symbol', 'definition', 'references', 'hierarchy', 'check', 'edit_history'];

/** Extensions of the TwinCAT source files whose code the server reads and writes. */
export const TWINCAT_SOURCE_EXTENSIONS = ['TcPOU', 'TcDUT', 'TcGVL', 'TcIO'];

/** The folder's own Claude Code settings, which Claude Code keeps out of git: its permission rules go there. */
export const LOCAL_SETTINGS = '.claude/settings.local.json';

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

/**
 * Claude Code permission rules for a folder that has the server: with `reads`, its reading tools run without
 * asking; with `xml`, Claude Code's own file tools (Edit, Write) never edit the XML of TwinCAT's source files, so
 * code changes go through the server.
 */
export function permissionRules(choice: { reads: boolean; xml: boolean } = { reads: true, xml: true }): PermissionRules {
  return {
    allow: choice.reads ? MCP_READ_TOOLS.map(t => `mcp__${MCP_SERVER_NAME}__${t}`) : [],
    deny: choice.xml ? TWINCAT_SOURCE_EXTENSIONS.map(ext => `Edit(**/*.${ext})`) : [],
  };
}

/**
 * A Claude Code settings file with the rules added to its `permissions` (each once), the rest as it was, and the
 * rules it did not have yet. Throws on a file that is not a plain JSON object (comments, for one, would be lost).
 */
export function addPermissionRules(text: string | undefined, rules: PermissionRules): { text: string; added: string[] } {
  let settings: Record<string, unknown> = {};
  if (text?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('it is not plain JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it is not a JSON object');
    settings = parsed as Record<string, unknown>;
  }
  const permissions = settings.permissions ?? {};
  if (typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('its permissions are not an object');
  const perms = permissions as Record<string, unknown>;
  const added: string[] = [];
  for (const key of ['allow', 'deny'] as const) {
    const list = perms[key] ?? [];
    if (!Array.isArray(list)) throw new Error(`its permissions.${key} is not a list`);
    for (const rule of rules[key]) {
      if (list.includes(rule)) continue;
      list.push(rule);
      added.push(rule);
    }
    perms[key] = list;
  }
  settings.permissions = perms;
  return { text: added.length ? JSON.stringify(settings, null, 2) + '\n' : text ?? '', added };
}

/** git's output in a folder, or undefined when git fails there (not a repository, no git). */
async function gitOutput(git: RunGit, args: string[], cwd: string): Promise<string | undefined> {
  try {
    return (await git(args, cwd)).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Adds permission rules to a folder's .claude/settings.local.json and keeps that file out of git (in the clone's
 * .git/info/exclude when nothing ignores it yet, never in a file of the repository). A settings file that the
 * repository tracks is left alone. Returns what to tell the user.
 */
export async function addFolderPermissions(git: RunGit, folder: string, rules: PermissionRules): Promise<string> {
  if (!rules.allow.length && !rules.deny.length) return '';
  const lists = [rules.allow.length ? `allow ${rules.allow.join(', ')}` : '', rules.deny.length ? `deny ${rules.deny.join(', ')}` : ''];
  const byHand = `Add them by hand if you want them: ${lists.filter(Boolean).join('; ')}.`;
  // The folder's path in its repository ('' at the root); undefined outside a repository.
  const prefix = (await gitOutput(git, ['rev-parse', '--show-prefix'], folder))?.trim();
  if (prefix !== undefined && (await gitOutput(git, ['ls-files', '--', LOCAL_SETTINGS], folder))?.trim()) {
    return `${LOCAL_SETTINGS} is committed in the repository, so its permission rules were left as they are. ${byHand}`;
  }
  const file = path.join(folder, LOCAL_SETTINGS);
  try {
    const result = addPermissionRules(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, rules);
    if (result.added.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, result.text);
    }
  } catch (e) {
    return `${LOCAL_SETTINGS} was left as it is (${(e as Error).message}). ${byHand}`;
  }
  if (prefix !== undefined && (await gitOutput(git, ['ls-files', '--others', '--exclude-standard', '--', LOCAL_SETTINGS], folder))?.trim()) {
    const exclude = (await gitOutput(git, ['rev-parse', '--git-path', 'info/exclude'], folder))?.trim();
    if (exclude) {
      const excludeFile = path.resolve(folder, exclude);
      const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}/${prefix}${LOCAL_SETTINGS}\n`);
    }
  }
  const files = TWINCAT_SOURCE_EXTENSIONS.map(e => `.${e}`).join(', ');
  const what = [
    rules.allow.length ? 'Claude Code runs its reading tools without asking' : '',
    rules.deny.length ? `Claude Code's Edit and Write tools never change ${files} files` : '',
  ].filter(Boolean).join(', and ');
  return `${what} (rules in ${LOCAL_SETTINGS}${prefix !== undefined ? ', which git ignores' : ''}).`;
}

/** An argument for a command line typed in a shell (cmd or a POSIX shell): quoted when it has spaces or quotes. */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function commandLine(program: string, args: string[]): string {
  return [program, ...args].map(shellQuote).join(' ');
}

/**
 * Claude Code's `claude` on a PATH: `claude.exe` (native install) or `claude.cmd` (npm) on Windows, `claude`
 * elsewhere. Only full folder paths count, as in findOnPath.
 */
export function findClaude(pathValue = process.env.PATH ?? '', platform = process.platform): string | undefined {
  const windows = platform === 'win32';
  const names = windows ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const entry of pathValue.split(windows ? ';' : ':')) {
    const dir = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!(windows ? /^([a-z]:[\\/]|[\\/]{2})/i.test(dir) : dir.startsWith('/'))) continue;
    for (const name of names) {
      const candidate = windows ? path.win32.join(dir, name) : path.posix.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not there
      }
    }
  }
  return undefined;
}

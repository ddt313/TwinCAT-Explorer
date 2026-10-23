// The command line that registers the extension's MCP server with Claude Code for one folder (scope local:
// in ~/.claude.json, never in the repository), and the programs it needs. Independent of the VS Code API.

import * as fs from 'fs';
import * as path from 'path';

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

// `TwinCAT: Set Up MCP Server for Claude Code`: registers the MCP server of this version of the extension with
// Claude Code for a workspace folder (scope local, in ~/.claude.json), and, after an update of the extension,
// offers to do it again, since the path of out/mcp/server.js changes with each version.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { findOnPath } from '../core/paths';
import {
  MCP_SERVER_NAME, claudeAddArgs, claudeRemoveArgs, commandLine, findClaude, serverLaunch,
} from '../core/mcpSetup';

/** globalState: the server path each folder was set up with (fsPath -> path of server.js). */
const STATE_KEY = 'twincatExplorer.mcpSetup';

function run(program: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  // claude.cmd (npm) runs through cmd, which takes one command line: quote it ourselves.
  const viaShell = /\.cmd$/i.test(program);
  return new Promise(resolve => {
    cp.execFile(viaShell ? commandLine(program, args) : program, viaShell ? [] : args,
      { cwd, shell: viaShell, windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error?.message ?? '') });
      });
  });
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];
  const picked = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })), {
    title: 'Set Up MCP Server for Claude Code', placeHolder: 'The folder Claude Code runs in',
  });
  return picked?.folder;
}

export async function setUpMcpServer(context: vscode.ExtensionContext, folderPath?: string): Promise<void> {
  const serverJs = context.asAbsolutePath('out/mcp/server.js');
  if (!fs.existsSync(serverJs)) {
    void vscode.window.showErrorMessage(`TwinCAT: the MCP server is not in this installation (${serverJs}).`);
    return;
  }
  const folder = folderPath ?? (await pickFolder())?.uri.fsPath;
  if (!folder) {
    void vscode.window.showWarningMessage('TwinCAT: open the folder of a TwinCAT repository first.');
    return;
  }
  const launch = serverLaunch(serverJs, !!findOnPath('node'), process.execPath);
  const addArgs = claudeAddArgs(launch);
  const claude = findClaude();
  if (!claude) {
    const line = commandLine('claude', addArgs);
    await vscode.env.clipboard.writeText(line);
    void vscode.window.showWarningMessage(
      `TwinCAT: Claude Code (claude) is not on PATH. The command to run in ${folder} is on the clipboard: ${line}`);
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Registering the TwinCAT MCP server with Claude Code' },
    async () => {
      // A registration made with the path of an older version is replaced: add refuses a name already there.
      await run(claude, claudeRemoveArgs(), folder);
      return run(claude, addArgs, folder);
    });
  if (!result.ok) {
    void vscode.window.showErrorMessage(`TwinCAT: claude mcp add failed: ${result.output}`);
    return;
  }
  const state = context.globalState.get<Record<string, string>>(STATE_KEY) ?? {};
  await context.globalState.update(STATE_KEY, { ...state, [folder]: serverJs });
  void vscode.window.showInformationMessage(
    `TwinCAT: the MCP server "${MCP_SERVER_NAME}" is set up for ${folder}, for you only (Claude Code's local scope, in ~/.claude.json; `
    + 'nothing is written to the repository). Claude Code sessions started in that folder from now on have its tools.');
}

/** After an update of the extension, offers to set the server up again for the open folders that had it. */
export function checkMcpSetup(context: vscode.ExtensionContext): void {
  const state = context.globalState.get<Record<string, string>>(STATE_KEY) ?? {};
  const serverJs = context.asAbsolutePath('out/mcp/server.js');
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const old = state[f.uri.fsPath];
    if (!old || old === serverJs || fs.existsSync(old)) continue;
    void vscode.window.showInformationMessage(
      `TwinCAT: Claude Code still starts the MCP server of an older version of the extension for ${f.name}, which is gone.`,
      'Set Up Again').then(choice => {
      if (choice) void setUpMcpServer(context, f.uri.fsPath);
    });
  }
}

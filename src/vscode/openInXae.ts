// `TwinCAT: Open Solution in TwinCAT XAE`, from a TwinCAT project in the tree or the Command Palette: the TwinCAT XAE
// that has the project open comes to the front, or XAE is started on the solution of the workspace that has the
// project, shown and the user's own. XAE is never closed here, and nothing is saved in it.

import * as path from 'path';
import * as vscode from 'vscode';
import { Xae, solutionsWith, xaeWith } from '../core/xae';

/** The only item, or the one picked when there are several. */
export async function pick<T>(items: T[], label: (t: T) => vscode.QuickPickItem, title: string): Promise<T | undefined> {
  if (items.length <= 1) return items[0];
  const picked = await vscode.window.showQuickPick(items.map(t => ({ ...label(t), t })), { title });
  return picked?.t;
}

/** The solution file of the workspace that has the TwinCAT project, picked when several have it. */
export async function solutionOf(tsproj: string): Promise<string | undefined> {
  const exclude = vscode.workspace.getConfiguration('twincatExplorer').get<string>('exclude') || undefined;
  const found = solutionsWith(tsproj, (await vscode.workspace.findFiles('**/*.sln', exclude)).map(uri => uri.fsPath));
  return pick(found, f => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(f) }), 'The solution to open in TwinCAT XAE');
}

export class SolutionOpener {
  /** The project being opened: one at a time, as asking the XAEs anything waits for one that is opening a solution. */
  private opening: string | undefined;

  constructor(private readonly xae: Xae, private readonly projects: () => { name: string; path: string }[]) {}

  async open(project?: { name: string; path: string }): Promise<void> {
    if (this.opening) {
      void vscode.window.showInformationMessage(`TwinCAT: TwinCAT XAE is still opening ${this.opening}.`);
      return;
    }
    project ??= await pick(this.projects(), t => ({ label: t.name, description: vscode.workspace.asRelativePath(t.path) }),
      'The TwinCAT project to open in TwinCAT XAE');
    if (!project) {
      if (!this.projects().length) void vscode.window.showErrorMessage('TwinCAT: the workspace has no TwinCAT project.');
      return;
    }
    this.opening = project.name;
    try {
      const instances = await this.xae.instancesAsync();
      const running = xaeWith(instances, project.path);
      if (running) return await this.front(running.pid, project.name);
      const sln = await solutionOf(project.path);
      if (!sln) {
        void vscode.window.showErrorMessage(`TwinCAT: no .sln file of the workspace has ${project.name}.`);
        return;
      }
      const withSolution = xaeWith(instances, project.path, sln);
      if (withSolution) return await this.front(withSolution.pid, project.name);
      await this.start(sln);
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
    } finally {
      this.opening = undefined;
    }
  }

  private async front(pid: number, name: string): Promise<void> {
    const { shown } = await this.xae.frontAsync(pid);
    if (!shown) void vscode.window.showWarningMessage(`TwinCAT: ${name} is open in a TwinCAT XAE that a tool started hidden (process ${pid}); it is left hidden.`);
  }

  private async start(sln: string): Promise<void> {
    const name = path.basename(sln);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Opening ${name} in TwinCAT XAE` },
        () => this.xae.openSolutionAsync(sln));
      vscode.window.setStatusBarMessage(`$(check) ${name} is open in TwinCAT XAE`, 5000);
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: TwinCAT XAE has not opened ${name}: ${(e as Error).message}`);
    } finally {
      this.xae.forget();
    }
  }
}

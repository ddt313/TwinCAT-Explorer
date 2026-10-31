// `TwinCAT: Renew Trial License in TwinCAT XAE`: brings TwinCAT XAE to SYSTEM > License of a TwinCAT project of the
// workspace, targeting the runtime of this machine, and clicks "7 Days Trial License...". XAE's dialog then asks the
// user for the security code, which only the user reads and types. The XAE that has the project open is used, or one
// is started on the solution and closed again without saving once the new license is written.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LicenseFolder, lastLicenseWrite, licenseFolders, readLicenses, runtimeNetId, timeLeft } from '../core/license';
import { fileKey } from '../core/workspace';
import { TrialLicensePage, Xae, XaeError, solutionProjects } from '../core/xae';

/** How long XAE's dialog waits for the user, and how long XAE stays enabled before it counts as cancelled. */
const WAIT_MS = 10 * 60_000;
const CANCELLED_MS = 20_000;

async function pick<T>(items: T[], label: (t: T) => vscode.QuickPickItem, title: string): Promise<T | undefined> {
  if (items.length <= 1) return items[0];
  const picked = await vscode.window.showQuickPick(items.map(t => ({ ...label(t), t })), { title });
  return picked?.t;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class TrialLicenseRenewal {
  private busy = false;

  constructor(private readonly xae: Xae, private readonly projects: () => { name: string; path: string }[], private readonly refresh: () => void) {}

  async renew(runtime?: string): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage('TwinCAT: a trial license is already being renewed in TwinCAT XAE.');
      return;
    }
    const folder = await pick(licenseFolders().filter(f => !runtime || f.runtime === runtime),
      f => ({ label: f.runtime, description: f.folder }), 'The TwinCAT runtime to renew the trial license of');
    if (!folder) {
      if (!licenseFolders().length) void vscode.window.showErrorMessage('TwinCAT: no TwinCAT runtime on this machine.');
      return;
    }
    const netId = runtimeNetId(folder);
    if (!netId) {
      void vscode.window.showErrorMessage(`TwinCAT: the AMS Net ID of the runtime ${folder.runtime} was not found.`);
      return;
    }
    const tsproj = await pick(this.projects(), t => ({ label: t.name, description: vscode.workspace.asRelativePath(t.path) }),
      'The TwinCAT project to generate the trial license with');
    if (!tsproj) {
      if (!this.projects().length) void vscode.window.showErrorMessage('TwinCAT: the workspace has no TwinCAT project.');
      return;
    }
    let running;
    try {
      running = await this.xae.instanceForAsync(tsproj.path);
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    let sln: string | undefined;
    if (!running) {
      sln = await this.solutionOf(tsproj.path);
      if (!sln) {
        void vscode.window.showErrorMessage(`TwinCAT: no .sln file of the workspace has ${tsproj.name}. Open the project in TwinCAT XAE, then run this again.`);
        return;
      }
    }
    this.busy = true;
    try {
      await this.run(folder, netId, tsproj.path, running?.pid, sln);
    } finally {
      this.busy = false;
    }
  }

  /** The solution files of the workspace that have the TwinCAT project. */
  private async solutionOf(tsproj: string): Promise<string | undefined> {
    const key = fileKey(tsproj);
    const exclude = vscode.workspace.getConfiguration('twincatExplorer').get<string>('exclude') || undefined;
    const found: string[] = [];
    for (const uri of await vscode.workspace.findFiles('**/*.sln', exclude)) {
      try {
        if (solutionProjects(fs.readFileSync(uri.fsPath, 'utf8'), uri.fsPath).some(p => fileKey(p) === key)) found.push(uri.fsPath);
      } catch {
        // unreadable: not a candidate
      }
    }
    return pick(found, f => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(f) }), 'The solution to open in TwinCAT XAE');
  }

  private async run(folder: LicenseFolder, netId: string, tsproj: string, pid: number | undefined, sln: string | undefined): Promise<void> {
    const before = lastLicenseWrite(folder.folder);
    let page: TrialLicensePage | undefined;
    const outcome = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'TwinCAT trial license', cancellable: true,
    }, async (progress, token) => {
      progress.report({ message: pid ? 'opening SYSTEM > License in TwinCAT XAE...' : `starting TwinCAT XAE on ${path.basename(sln!)}...` });
      page = await this.xae.openTrialLicenseAsync({ pid, sln, tsproj, netId });
      if (page.needsTarget) {
        const choice = await vscode.window.showWarningMessage(
          `The project in TwinCAT XAE targets ${page.target}, not this machine (${netId}). Switch it to this machine for the trial license?`,
          { modal: true, detail: 'The target is set back afterwards. XAE then shows the project as changed: do not save it for this.' }, 'Switch Target');
        if (!choice) return 'cancelled';
        page = await this.xae.openTrialLicenseAsync({ pid, sln, tsproj, netId, setTarget: true });
      }
      progress.report({
        message: page.clicked
          ? 'type the security code in the dialog of TwinCAT XAE.'
          : 'click "7 Days Trial License..." on the License page of TwinCAT XAE, then type the security code.',
      });
      // The dialog disables XAE; enabled again for a while without a new license file, it was cancelled.
      let dialogSeen = !!page.dialog;
      let enabledSince: number | undefined;
      for (const end = Date.now() + WAIT_MS; Date.now() < end; await sleep(1000)) {
        if (token.isCancellationRequested) return 'cancelled';
        if (lastLicenseWrite(folder.folder) > before) return 'written';
        const window = await this.xae.windowAsync(page.hwnd);
        if (!window.running) return 'closed';
        if (!window.enabled) {
          dialogSeen = true;
          enabledSince = undefined;
        } else if (dialogSeen) {
          enabledSince ??= Date.now();
          if (Date.now() - enabledSince > CANCELLED_MS) return 'cancelled in XAE';
        }
      }
      return 'timeout';
    }).then(o => o, (e: unknown) => e as Error);
    await this.finish(outcome, folder, netId, tsproj, page);
  }

  private async finish(outcome: string | Error, folder: LicenseFolder, netId: string, tsproj: string, page: TrialLicensePage | undefined): Promise<void> {
    this.refresh();
    if (outcome instanceof Error) {
      const where = page?.started ? ' TwinCAT XAE stays open: close it without saving.' : '';
      void vscode.window.showErrorMessage(`TwinCAT: the trial license was not renewed: ${outcome instanceof XaeError ? outcome.message : String(outcome)}.${where}`);
      return;
    }
    if (outcome === 'written') {
      const trial = readLicenses([folder]).find(f => f.trial);
      void vscode.window.showInformationMessage(trial?.expires
        ? `TwinCAT: new 7-day trial license of ${folder.runtime}, valid until ${trial.expires.toLocaleString()} (${timeLeft(trial.expires, new Date())}).`
        : `TwinCAT: a new license file of ${folder.runtime} was written.`);
    } else if (outcome === 'closed') {
      void vscode.window.showWarningMessage('TwinCAT: TwinCAT XAE was closed before a new trial license was written.');
      return;
    } else if (outcome !== 'cancelled') {
      void vscode.window.showWarningMessage(outcome === 'timeout'
        ? 'TwinCAT: no new trial license after 10 minutes.'
        : 'TwinCAT: the trial license dialog was closed without a new license.');
    }
    if (!page || page.needsTarget) return;
    await this.restore(page, netId, tsproj);
  }

  /** XAE as it was: one started here closed without saving, a running one's target set back. */
  private async restore(page: TrialLicensePage, netId: string, tsproj: string): Promise<void> {
    // A message XAE shows after the license waits for the user first.
    for (let waited = 0; ; waited += 1000, await sleep(1000)) {
      const window = await this.xae.windowAsync(page.hwnd).catch(() => ({ running: false, enabled: true }));
      if (!window.running) return;
      if (window.enabled) break;
      if (waited > 120_000) {
        void vscode.window.showWarningMessage(page.started
          ? 'TwinCAT: TwinCAT XAE still shows a dialog: close XAE without saving once it is answered.'
          : `TwinCAT: TwinCAT XAE still shows a dialog: set the project's target back to ${page.target} once it is answered.`);
        return;
      }
    }
    try {
      if (page.started) await this.xae.quitAsync(page.pid);
      else if (page.targetChanged) await this.xae.targetAsync(page.pid, tsproj, page.target);
    } catch (e) {
      void vscode.window.showWarningMessage(page.started
        ? `TwinCAT: TwinCAT XAE was not closed (${(e as Error).message}): close it without saving.`
        : `TwinCAT: the target of the project in TwinCAT XAE was not set back to ${page.target} from ${netId} (${(e as Error).message}).`);
    }
  }
}

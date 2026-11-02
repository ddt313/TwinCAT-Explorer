// The TwinCAT licenses in the status bar: how long the license that ends first has left, warned about a day before
// and once it has expired, and `TwinCAT: Show Licenses` with each license of each runtime. Both offer
// `TwinCAT: Renew Trial License in TwinCAT XAE` (trialLicense.ts) for a trial license.
// The runtimes of this machine are read from their license files; with twincatExplorer.remoteLicenses, the remote
// systems this machine's AMS router has routes to (an XAR in a container, a PLC) over ADS, through the XAE bridge,
// every few minutes.
// Only shown in a workspace with TwinCAT projects, on Windows where a runtime has a license file.

import * as vscode from 'vscode';
import { LicenseFile, LicenseFolder, firstToExpire, licenseFolders, readLicenses, remoteLicenses, timeLeft } from '../core/license';
import { Xae } from '../core/xae';

/** Left before the status bar and a notification warn. */
const WARNING_TIME = 24 * 3600_000;
/** How often the remote systems' licenses are read again. */
const REMOTE_EVERY = 5 * 60_000;
const RENEW_HINT = 'TwinCAT XAE renews it: SYSTEM > License > 7 Days Trial License.';
const RENEW = 'Renew in TwinCAT XAE';

function localTime(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fileTitle(f: LicenseFile): string {
  return `${f.runtime}${f.netId ? ` (${f.netId})` : ''}: ${f.trial ? '7-day trial license' : 'license file'}`;
}

function validity(f: LicenseFile, now: Date): string {
  if (!f.expires) return 'no end date';
  const left = timeLeft(f.expires, now);
  return left === 'expired' ? `expired ${localTime(f.expires)}` : `valid until ${localTime(f.expires)}, ${left} left`;
}

function licenseLabel(l: { name: string; orderNo?: string; instances?: number }): string {
  return `${l.name}${l.orderNo ? ` (${l.orderNo})` : ''}${l.instances ? ` × ${l.instances}` : ''}`;
}

/** The system of a file, as renewing its trial license takes it: its runtime of this machine, or its remote system's AMS Net ID. */
function systemOf(f: LicenseFile): string {
  return f.netId ?? f.runtime;
}

export class LicenseStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('twincatExplorer.license', vscode.StatusBarAlignment.Left, 0);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private watchers: vscode.Disposable[] = [];
  private watched = '';
  private folders: LicenseFolder[] = [];
  private files: LicenseFile[] = [];
  private remote: LicenseFile[] = [];
  /** The remote systems whose licenses were not read, with why. */
  private unread: { name: string; netId: string; error: string }[] = [];
  private remoteAt = 0;
  private reading: Promise<void> | undefined;
  private xae: Xae | undefined;
  private shown = false;
  /** The expiry times already warned about, so that each is told once. */
  private readonly warned = new Set<string>();

  constructor() {
    this.item.name = 'TwinCAT License';
    this.item.command = 'twincatExplorer.showLicenses';
    const timer = setInterval(() => {
      if (Date.now() - this.remoteAt > REMOTE_EVERY) void this.readRemote();
      this.update();
    }, 60_000);
    this.disposables.push(
      { dispose: () => clearInterval(timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('twincatExplorer.licenseStatusBar')) this.update();
        if (e.affectsConfiguration('twincatExplorer.remoteLicenses')) void this.readRemote();
      }),
    );
  }

  /** The bridge that reads the remote systems' licenses over ADS. */
  setXae(xae: Xae): void {
    this.xae = xae;
    void this.readRemote();
  }

  /** Shows the item while the workspace has TwinCAT projects. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.refresh();
  }

  /** Reads the license files again, the remote systems' in the background. */
  refresh(): void {
    this.folders = licenseFolders();
    this.watch();
    this.files = readLicenses(this.folders);
    this.update();
    void this.readRemote();
  }

  private remoteEnabled(): boolean {
    return !!this.xae && this.shown && vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('remoteLicenses', false);
  }

  /** The licenses of the systems this machine has ADS routes to; one read at a time. */
  private readRemote(): Promise<void> {
    if (!this.remoteEnabled()) {
      this.remote = [];
      this.unread = [];
      this.update();
      return Promise.resolve();
    }
    this.reading ??= (async () => {
      const remote: LicenseFile[] = [];
      const unread: LicenseStatus['unread'] = [];
      try {
        const { local, routes } = await this.xae!.adsRoutesAsync();
        for (const r of routes.filter(r => r.netId !== local)) {
          try {
            const { found, files } = await this.xae!.adsLicensesAsync(r.netId);
            if (found) remote.push(...remoteLicenses(files, r.name, r.netId));
            else unread.push({ name: r.name, netId: r.netId, error: 'its license folder was not found over ADS' });
          } catch (e) {
            unread.push({ name: r.name, netId: r.netId, error: (e as Error).message });
          }
        }
      } catch {
        // no ADS router or no bridge here: no remote systems
      }
      this.remote = remote;
      this.unread = unread;
      this.remoteAt = Date.now();
      this.update();
    })().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private watch(): void {
    const key = this.folders.map(f => f.folder).join('|');
    if (key === this.watched) return;
    this.watched = key;
    for (const w of this.watchers) w.dispose();
    this.watchers = this.folders.map(({ folder }) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '*.tclrs'));
      const changed = () => {
        this.files = readLicenses(this.folders);
        this.update();
      };
      w.onDidCreate(changed);
      w.onDidChange(changed);
      w.onDidDelete(changed);
      return w;
    });
  }

  private all(): LicenseFile[] {
    return [...this.files, ...this.remote];
  }

  private update(): void {
    const enabled = vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('licenseStatusBar', true);
    const all = this.all();
    if (!this.shown || !enabled || !all.length) {
      this.item.hide();
      return;
    }
    const now = new Date();
    const first = firstToExpire(all);
    const left = first?.expires && first.expires.getTime() - now.getTime();
    // With several runtimes or systems, which one ends first.
    const which = first && new Set(all.map(systemOf)).size > 1 ? ` ${first.runtime}` : '';
    if (left === undefined) {
      this.item.text = '$(key) TwinCAT license';
      this.item.backgroundColor = undefined;
    } else if (left < 0) {
      this.item.text = `$(error) TwinCAT license${which} expired`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `${left < WARNING_TIME ? '$(warning)' : '$(key)'} TwinCAT license${which} ${timeLeft(first!.expires!, now)}`;
      this.item.backgroundColor = left < WARNING_TIME ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    this.item.tooltip = this.tooltip(now);
    this.item.show();
    for (const f of all) {
      const fLeft = f.expires && f.expires.getTime() - now.getTime();
      if (fLeft !== undefined && fLeft < WARNING_TIME) this.warn(f, fLeft < 0, now);
    }
  }

  private warn(f: LicenseFile, expired: boolean, now: Date): void {
    const key = `${f.netId ?? ''}|${f.file}|${f.expires!.getTime()}|${expired}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    const what = `the ${f.trial ? '7-day trial license' : 'license'} of ${f.runtime}`;
    const message = expired
      ? `TwinCAT: ${what} expired ${localTime(f.expires!)}, so TwinCAT cannot start in Run mode.`
      : `TwinCAT: ${what} expires ${localTime(f.expires!)}, in ${timeLeft(f.expires!, now)}.`;
    const actions = f.trial ? [RENEW, 'Show Licenses'] : ['Show Licenses'];
    void vscode.window.showWarningMessage(f.trial ? `${message} ${RENEW_HINT}` : message, ...actions).then(choice => {
      if (choice === RENEW) void vscode.commands.executeCommand('twincatExplorer.renewTrialLicense', systemOf(f));
      else if (choice) void vscode.commands.executeCommand('twincatExplorer.showLicenses');
    });
  }

  private tooltip(now: Date): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    for (const f of this.all()) {
      md.appendMarkdown(`**${fileTitle(f)}**  \n`);
      md.appendText(validity(f, now));
      md.appendMarkdown('  \n');
      md.appendText(f.licenses.map(licenseLabel).join(', ') || 'no licenses');
      md.appendMarkdown('\n\n');
    }
    for (const u of this.unread) {
      md.appendMarkdown(`**${u.name} (${u.netId})**  \n`);
      md.appendText(`not read: ${u.error}`);
      md.appendMarkdown('\n\n');
    }
    if (this.all().some(f => f.trial)) md.appendText(RENEW_HINT);
    return md;
  }

  /**
   * `TwinCAT: Show Licenses`: each license of each file, by runtime and remote system; picking a file's entry of this
   * machine reveals the file, and a trial license's Renew entry renews it.
   */
  async show(): Promise<void> {
    this.refresh();
    if (this.remoteEnabled()) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading the licenses of the remote TwinCAT systems' },
        () => this.readRemote());
    }
    const all = this.all();
    if (!all.length && !this.unread.length) {
      const where = this.folders.map(f => f.folder).join(', ');
      void vscode.window.showInformationMessage(where
        ? `TwinCAT: no license file in ${where}.`
        : 'TwinCAT: no TwinCAT runtime on this machine.');
      return;
    }
    type Item = vscode.QuickPickItem & { file?: string; renew?: string };
    const now = new Date();
    const items: Item[] = [];
    for (const f of all) {
      items.push({ label: fileTitle(f), kind: vscode.QuickPickItemKind.Separator });
      const issued = f.issued ? `Issued ${localTime(f.issued)}. ` : '';
      items.push({
        label: `$(${f.expires && f.expires < now ? 'error' : 'calendar'}) ${validity(f, now)}`,
        detail: f.netId ? `${issued}${f.file} on ${f.runtime}, read over ADS` : `${issued}Pick to reveal ${f.file}`,
        file: f.netId ? undefined : f.file,
      });
      if (f.trial) items.push({ label: `$(sync) ${RENEW}...`, detail: 'Opens its 7 Days Trial License dialog, where you type the security code', renew: systemOf(f) });
      for (const l of f.licenses) {
        items.push({ label: `$(key) ${l.name}`, description: [l.orderNo, l.instances && `${l.instances} instances`].filter(Boolean).join(', '), detail: l.id });
      }
    }
    for (const u of this.unread) {
      items.push({ label: `${u.name} (${u.netId})`, kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(debug-disconnect) licenses not read', detail: u.error });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'TwinCAT Licenses', placeHolder: all.some(f => f.trial) ? RENEW_HINT : undefined, matchOnDescription: true,
    });
    if (picked?.renew) await vscode.commands.executeCommand('twincatExplorer.renewTrialLicense', picked.renew);
    else if (picked?.file) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(picked.file));
  }

  dispose(): void {
    for (const d of [...this.disposables, ...this.watchers]) d.dispose();
  }
}

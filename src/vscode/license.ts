// The TwinCAT licenses of this machine in the status bar: how long the license that ends first has left, warned
// about a day before and once it has expired, and `TwinCAT: Show Licenses` with each license of each runtime.
// Only shown in a workspace with TwinCAT projects, on Windows where a runtime has a license file.

import * as vscode from 'vscode';
import { LicenseFile, LicenseFolder, firstToExpire, licenseFolders, readLicenses, timeLeft } from '../core/license';

/** Left before the status bar and a notification warn. */
const WARNING_TIME = 24 * 3600_000;
const RENEW_HINT = 'TwinCAT XAE renews it: SYSTEM > License > 7 Days Trial License.';

function localTime(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fileTitle(f: LicenseFile): string {
  return `${f.runtime}: ${f.trial ? '7-day trial license' : 'license file'}`;
}

function validity(f: LicenseFile, now: Date): string {
  if (!f.expires) return 'no end date';
  const left = timeLeft(f.expires, now);
  return left === 'expired' ? `expired ${localTime(f.expires)}` : `valid until ${localTime(f.expires)}, ${left} left`;
}

function licenseLabel(l: { name: string; orderNo?: string; instances?: number }): string {
  return `${l.name}${l.orderNo ? ` (${l.orderNo})` : ''}${l.instances ? ` × ${l.instances}` : ''}`;
}

export class LicenseStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('twincatExplorer.license', vscode.StatusBarAlignment.Left, 0);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private watchers: vscode.Disposable[] = [];
  private watched = '';
  private folders: LicenseFolder[] = [];
  private files: LicenseFile[] = [];
  private shown = false;
  /** The expiry times already warned about, so that each is told once. */
  private readonly warned = new Set<string>();

  constructor() {
    this.item.name = 'TwinCAT License';
    this.item.command = 'twincatExplorer.showLicenses';
    const timer = setInterval(() => this.update(), 60_000);
    this.disposables.push(
      { dispose: () => clearInterval(timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('twincatExplorer.licenseStatusBar')) this.update();
      }),
    );
  }

  /** Shows the item while the workspace has TwinCAT projects. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.refresh();
  }

  /** Reads the license files again. */
  refresh(): void {
    this.folders = licenseFolders();
    this.watch();
    this.files = readLicenses(this.folders);
    this.update();
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

  private update(): void {
    const enabled = vscode.workspace.getConfiguration('twincatExplorer').get<boolean>('licenseStatusBar', true);
    if (!this.shown || !enabled || !this.files.length) {
      this.item.hide();
      return;
    }
    const now = new Date();
    const first = firstToExpire(this.files);
    const left = first?.expires && first.expires.getTime() - now.getTime();
    if (left === undefined) {
      this.item.text = '$(key) TwinCAT license';
      this.item.backgroundColor = undefined;
    } else if (left < 0) {
      this.item.text = '$(error) TwinCAT license expired';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `${left < WARNING_TIME ? '$(warning)' : '$(key)'} TwinCAT license ${timeLeft(first!.expires!, now)}`;
      this.item.backgroundColor = left < WARNING_TIME ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    this.item.tooltip = this.tooltip(now);
    this.item.show();
    if (first?.expires && left !== undefined && left < WARNING_TIME) this.warn(first, left < 0, now);
  }

  private warn(f: LicenseFile, expired: boolean, now: Date): void {
    const key = `${f.file}|${f.expires!.getTime()}|${expired}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    const what = `the ${f.trial ? '7-day trial license' : 'license'} of ${f.runtime}`;
    const message = expired
      ? `TwinCAT: ${what} expired ${localTime(f.expires!)}, so TwinCAT cannot start in Run mode.`
      : `TwinCAT: ${what} expires ${localTime(f.expires!)}, in ${timeLeft(f.expires!, now)}.`;
    void vscode.window.showWarningMessage(f.trial ? `${message} ${RENEW_HINT}` : message, 'Show Licenses').then(choice => {
      if (choice) void vscode.commands.executeCommand('twincatExplorer.showLicenses');
    });
  }

  private tooltip(now: Date): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    for (const f of this.files) {
      md.appendMarkdown(`**${fileTitle(f)}**  \n`);
      md.appendText(validity(f, now));
      md.appendMarkdown('  \n');
      md.appendText(f.licenses.map(licenseLabel).join(', ') || 'no licenses');
      md.appendMarkdown('\n\n');
    }
    if (this.files.some(f => f.trial)) md.appendText(RENEW_HINT);
    return md;
  }

  /** `TwinCAT: Show Licenses`: each license of each file, by runtime; picking a file's entry reveals the file. */
  async show(): Promise<void> {
    this.refresh();
    if (!this.files.length) {
      const where = this.folders.map(f => f.folder).join(', ');
      void vscode.window.showInformationMessage(where
        ? `TwinCAT: no license file in ${where}.`
        : 'TwinCAT: no TwinCAT runtime on this machine.');
      return;
    }
    type Item = vscode.QuickPickItem & { file?: string };
    const now = new Date();
    const items: Item[] = [];
    for (const f of this.files) {
      items.push({ label: fileTitle(f), kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: `$(${f.expires && f.expires < now ? 'error' : 'calendar'}) ${validity(f, now)}`,
        detail: f.issued ? `Issued ${localTime(f.issued)}. Pick to reveal ${f.file}` : `Pick to reveal ${f.file}`,
        file: f.file,
      });
      for (const l of f.licenses) {
        items.push({ label: `$(key) ${l.name}`, description: [l.orderNo, l.instances && `${l.instances} instances`].filter(Boolean).join(', '), detail: l.id });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'TwinCAT Licenses', placeHolder: this.files.some(f => f.trial) ? RENEW_HINT : undefined, matchOnDescription: true,
    });
    if (picked?.file) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(picked.file));
  }

  dispose(): void {
    for (const d of [...this.disposables, ...this.watchers]) d.dispose();
  }
}

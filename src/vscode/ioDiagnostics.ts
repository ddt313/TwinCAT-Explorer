// The links of the .tsproj files to PLC variables that the code no longer declares (see staleIoLinks), as problems
// of the .tsproj, at the variable of each link: a variable renamed or deleted since XAE last saved the .tsproj.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { describeTarget } from '../core/ioLinks';
import { positionIn } from '../core/objectText';
import { problemLevels } from '../lang/analyzer';
import { LanguageIndex } from '../lang/index';
import { staleIoLinks } from '../lang/ioHover';
import { diagnosticsEnabled, toDiagnostic } from './language';
import { fileUri } from './uris';

export class IoLinkDiagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('twincat-io');
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly index: LanguageIndex) {}

  schedule(delay = 500): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, delay);
  }

  refresh(): void {
    this.collection.clear();
    const level = problemLevels(vscode.workspace.getConfiguration('twincatExplorer').get('diagnostics.rules'))['stale-io-link'] ?? 'warning';
    if (!diagnosticsEnabled() || level === 'off') return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const texts = new Map<string, string>();
    for (const s of staleIoLinks(this.index.ws, this.index)) {
      const file = s.tsProject.path;
      let text = texts.get(file);
      if (text === undefined) {
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          text = '';
        }
        texts.set(file, text);
      }
      const r = s.link.range ?? { start: 0, end: 0 };
      const start = positionIn(text, r.start);
      const end = positionIn(text, r.end);
      const message = `${s.link.variable}, linked to ${describeTarget(s.link)}: ${s.reason}. `
        + 'Renamed or deleted since TwinCAT XAE saved the project: link it again in XAE.';
      const list = byFile.get(file) ?? [];
      list.push(toDiagnostic(new vscode.Range(start.line, start.character, end.line, end.character), { message, severity: level, code: 'stale-io-link' }));
      byFile.set(file, list);
    }
    for (const [p, list] of byFile) this.collection.set(fileUri(p), list);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.collection.dispose();
  }
}


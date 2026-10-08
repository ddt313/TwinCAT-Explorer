// Keeps the language index in line with what the user sees: a section's text in
// the index is the text of an open notebook cell when it differs from the disk.
// Only documents that are dirty or shown in a tab count (a lingering background
// document must not override), a dirty document wins over a clean one, and the
// most recently edited one wins among equals. VS Code 1.141 does not tell the
// extension host that a notebook restored by hot exit is dirty, so the decision
// compares texts instead of trusting isDirty alone.

import * as vscode from 'vscode';
import { LanguageIndex } from '../lang/index';
import { TcWorkspace, fileKey } from '../core/workspace';
import { cellMeta } from './serializers';
import { FILE_NOTEBOOK, OBJECT_NOTEBOOK, parseObjectUri } from './uris';
import { shownInTab } from './openDocs';

interface Candidate {
  text: string;
  dirty: boolean;
  time: number;
  fsPath: string;
}

export class OverlaySync {
  /** Overlay text currently in the index, by `fileKey|sectionKey`. */
  private readonly applied = new Map<string, string>();
  private readonly lastEdit = new Map<string, number>();

  constructor(private readonly index: LanguageIndex, private readonly ws: TcWorkspace) {}

  /** Records a text edit of a cell document (most recent edit wins between two open copies). */
  touched(doc: vscode.TextDocument): void {
    this.lastEdit.set(doc.uri.toString(), Date.now());
  }

  forgetCell(uri: vscode.Uri): void {
    this.lastEdit.delete(uri.toString());
  }

  private static realPath(nb: vscode.NotebookDocument): string | undefined {
    if (nb.notebookType === OBJECT_NOTEBOOK) return parseObjectUri(nb.uri)?.fsPath;
    if (nb.notebookType === FILE_NOTEBOOK) return nb.uri.fsPath;
    return undefined;
  }

  /**
   * Recomputes the overlays of the given files (all files when omitted).
   * Returns true when the index changed.
   */
  refresh(onlyFiles?: Iterable<string>): boolean {
    const only = onlyFiles ? new Set([...onlyFiles].map(f => fileKey(f))) : undefined;
    const best = new Map<string, Candidate>();
    for (const nb of vscode.workspace.notebookDocuments) {
      const fsPath = OverlaySync.realPath(nb);
      if (!fsPath) continue;
      const fk = fileKey(fsPath);
      if (only && !only.has(fk)) continue;
      if (!nb.isDirty && !shownInTab(nb.uri)) continue;
      for (const cell of nb.getCells()) {
        const m = cellMeta(cell);
        if (!m || m.header || cell.kind !== vscode.NotebookCellKind.Code) continue;
        const key = `${fk}|${m.key}`;
        const c: Candidate = { text: cell.document.getText(), dirty: nb.isDirty, time: this.lastEdit.get(cell.document.uri.toString()) ?? 0, fsPath };
        const cur = best.get(key);
        if (!cur || (c.dirty && !cur.dirty) || (c.dirty === cur.dirty && c.time > cur.time)) best.set(key, c);
      }
    }
    let changed = false;
    const set = (key: string, text: string | undefined) => {
      if (this.applied.get(key) === text) return;
      const [fk, sectionKey] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      this.index.setOverlay(fk, sectionKey, text);
      if (text === undefined) this.applied.delete(key);
      else this.applied.set(key, text);
      changed = true;
    };
    for (const [key, c] of best) {
      const sectionKey = key.slice(key.indexOf('|') + 1);
      const disk = this.ws.getFile(c.fsPath)?.sections.get(sectionKey)?.text;
      set(key, disk !== undefined && c.text === disk ? undefined : c.text);
    }
    for (const key of [...this.applied.keys()]) {
      if (best.has(key)) continue;
      if (only && !only.has(key.slice(0, key.indexOf('|')))) continue;
      set(key, undefined);
    }
    return changed;
  }
}

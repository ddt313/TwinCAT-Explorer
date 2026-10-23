// Keeps the language index in line with what the user sees: a section's text in
// the index is the text of an open split editor or notebook cell when it differs
// from the disk.
// Only documents that are dirty or shown in a tab count (a lingering background
// document must not override), a dirty document wins over a clean one, and the
// most recently edited one wins among equals. VS Code 1.141 does not tell the
// extension host that a notebook restored by hot exit is dirty, so the decision
// compares texts instead of trusting isDirty alone.

import * as vscode from 'vscode';
import { LanguageIndex } from '../lang/index';
import { TcWorkspace, fileKey } from '../core/workspace';
import { parseObjectText } from '../core/objectText';
import { cellMeta } from './serializers';
import { FILE_NOTEBOOK, OBJECT_NOTEBOOK, OBJECT_SCHEME, parseObjectUri } from './uris';
import { anyTabShows, shownInTab, tabKinds } from './openDocs';
import { textHash } from '../core/objectText';

interface Candidate {
  text: string;
  /** Differs from the disk text. */
  changed: boolean;
  dirty: boolean;
  time: number;
}

/** Hash an object section is compared with to know whether the user edited it (see ObjectFileSystem.effectiveBase). */
export type BaseLookup = (uri: vscode.Uri, load: string | undefined, key: string, loadBase: string | undefined) => string | undefined;

export class OverlaySync {
  /** Overlay text currently in the index, by `fileKey|sectionKey`. */
  private readonly applied = new Map<string, string>();
  private readonly lastEdit = new Map<string, number>();

  constructor(private readonly index: LanguageIndex, private readonly ws: TcWorkspace, private readonly baseOf: BaseLookup) {}

  /** Records a text edit of a cell or object document (most recent edit wins between two open copies). */
  touched(doc: vscode.TextDocument): void {
    this.lastEdit.set(doc.uri.toString(), Date.now());
  }

  forgetCell(uri: vscode.Uri): void {
    this.lastEdit.delete(uri.toString());
  }

  private static realPath(nb: vscode.NotebookDocument): string | undefined {
    if (nb.notebookType === OBJECT_NOTEBOOK) return parseObjectUri(nb.uri)?.fsPath;
    // Only the working file: a twincat-file notebook on a git: URI is history.
    if (nb.notebookType === FILE_NOTEBOOK) return nb.uri.scheme === 'file' ? nb.uri.fsPath : undefined;
    return undefined;
  }

  /**
   * Recomputes the overlays of the given files (all files when omitted).
   * Returns true when the index changed.
   */
  refresh(onlyFiles?: Iterable<string>): boolean {
    const only = onlyFiles ? new Set([...onlyFiles].map(f => fileKey(f))) : undefined;
    const best = new Map<string, Candidate>();
    const offer = (key: string, c: Candidate) => {
      const cur = best.get(key);
      const better = !cur || (c.changed !== cur.changed ? c.changed : c.dirty !== cur.dirty ? c.dirty : c.time > cur.time);
      if (better) best.set(key, c);
    };
    // Documents of the split editor.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== OBJECT_SCHEME) continue;
      const ref = parseObjectUri(doc.uri);
      if (!ref) continue;
      const fk = fileKey(ref.fsPath);
      if (only && !only.has(fk)) continue;
      if (!doc.isDirty && !anyTabShows(doc.uri)) continue;
      // The tab was switched to the notebook (Reopen Editor With): the hidden unsaved text is not what the user sees.
      if (doc.isDirty) {
        const kinds = tabKinds(doc.uri);
        if (!kinds.editor && kinds.notebook) continue;
      }
      let parsed;
      try {
        parsed = parseObjectText(doc.getText());
      } catch {
        continue;
      }
      const meta = new Map(parsed.header.sections.map(m => [m.key, m]));
      const file = this.ws.getFile(ref.fsPath);
      for (const sec of parsed.sections) {
        const m = meta.get(sec.key);
        if (!m) continue;
        // An untouched section is never written back on save (see the object notebooks below).
        const base = this.baseOf(doc.uri, parsed.header.load, sec.key, m.base);
        if (base !== undefined && textHash(sec.text) === base) continue;
        const disk = file?.sections.get(sec.key)?.text;
        offer(`${fk}|${sec.key}`, {
          text: sec.text, changed: disk === undefined || sec.text !== disk, dirty: doc.isDirty,
          time: this.lastEdit.get(doc.uri.toString()) ?? 0,
        });
      }
    }
    for (const nb of vscode.workspace.notebookDocuments) {
      const fsPath = OverlaySync.realPath(nb);
      if (!fsPath) continue;
      const fk = fileKey(fsPath);
      if (only && !only.has(fk)) continue;
      if (!nb.isDirty && !shownInTab(nb.uri)) continue;
      if (nb.isDirty) {
        const kinds = tabKinds(nb.uri);
        if (!kinds.notebook && kinds.editor) continue;
      }
      const file = this.ws.getFile(fsPath);
      for (const cell of nb.getCells()) {
        const m = cellMeta(cell);
        if (!m || m.header || cell.kind !== vscode.NotebookCellKind.Code) continue;
        const text = cell.document.getText();
        if (nb.notebookType === OBJECT_NOTEBOOK) {
          // A cell the user did not edit is never written back on save, so the disk text stands even
          // when this tab is stale (outside change while it was dirty, discarded edits, older revision).
          const base = this.baseOf(nb.uri, (nb.metadata?.header as { load?: string } | undefined)?.load, m.key, m.base);
          if (base !== undefined && textHash(text) === base) continue;
        }
        const disk = file?.sections.get(m.key)?.text;
        offer(`${fk}|${m.key}`, {
          text, changed: disk === undefined || text !== disk, dirty: nb.isDirty,
          time: this.lastEdit.get(cell.document.uri.toString()) ?? 0,
        });
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
    for (const [key, c] of best) set(key, c.changed ? c.text : undefined);
    for (const key of [...this.applied.keys()]) {
      if (best.has(key)) continue;
      if (only && !only.has(key.slice(0, key.indexOf('|')))) continue;
      set(key, undefined);
    }
    return changed;
  }
}

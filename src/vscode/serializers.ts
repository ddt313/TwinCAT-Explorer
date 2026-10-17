// Notebook serializers: an object notebook shows the sections of one TwinCAT
// object view as cells (Declaration above Implementation); a file notebook
// shows every object of a .TcPOU file, used for git comparisons.

import * as vscode from 'vscode';
import { ObjectTextHeader, ParsedObjectText, SectionMeta, formatObjectText, parseObjectText } from '../core/objectText';
import { KIND_WORD } from './tree';
import { ST_LANGUAGE } from './uris';
import { decodeBytes, parseTcText, encodeText } from '../core/tcfile';
import { applySectionEdits } from '../core/splice';

export interface CellMeta extends SectionMeta {
  /** Header cell of an object in a file notebook. */
  header?: boolean;
}

export function cellMeta(cell: vscode.NotebookCell | vscode.NotebookCellData): CellMeta | undefined {
  const m = cell.metadata as CellMeta | undefined;
  return m && typeof m.key === 'string' ? m : undefined;
}

/** Object notebook documents of version 0.4 (JSON), still found in hot-exit backups after an update. */
interface LegacyObjectDoc {
  qualifiedName?: string;
  kind?: string;
  served?: string[];
  sections: { key: string; label: string; role: 'decl' | 'impl'; editable: boolean; accessor?: 'Get' | 'Set'; text: string; base?: string }[];
}

function fromLegacy(json: LegacyObjectDoc): ParsedObjectText {
  const served = new Set(json.served ?? json.sections.map(s => s.key));
  const header: ObjectTextHeader = {
    v: 1,
    label: json.qualifiedName ?? '',
    kind: json.kind ?? '',
    sections: json.sections.filter(s => served.has(s.key))
      .map(s => ({ key: s.key, role: s.role, label: s.label, editable: s.editable, accessor: s.accessor, base: s.base })),
  };
  return { header, sections: json.sections.map(s => ({ key: s.key, text: s.text, start: 0, end: 0 })) };
}

export class ObjectSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = Buffer.from(content).toString('utf8');
    if (!text.trim()) return new vscode.NotebookData([]);
    const doc = text.trimStart().startsWith('{') ? fromLegacy(JSON.parse(text) as LegacyObjectDoc) : parseObjectText(text);
    const meta = new Map(doc.header.sections.map(m => [m.key, m]));
    const cells = doc.sections.map(s => {
      const c = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, s.text, ST_LANGUAGE);
      const m = meta.get(s.key);
      const cm: CellMeta = {
        key: s.key, label: m?.label ?? s.key, role: m?.role ?? 'impl', editable: m?.editable ?? true, accessor: m?.accessor, base: m?.base,
      };
      c.metadata = cm;
      return c;
    });
    const data = new vscode.NotebookData(cells);
    // The header as loaded: its section list tells cells deleted in the tab from sections that changed on disk.
    data.metadata = { header: doc.header };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const loaded = data.metadata?.header as ObjectTextHeader | undefined;
    const fromCells: SectionMeta[] = data.cells.map(c => {
      const m = cellMeta(c);
      return { key: m?.key ?? '', role: m?.role ?? 'impl', label: m?.label ?? '', editable: m?.editable ?? true, accessor: m?.accessor, base: m?.base };
    });
    const header: ObjectTextHeader = loaded ?? { v: 1, label: '', kind: '', sections: fromCells };
    const texts = data.cells.map((c, i) => ({
      key: c.kind === vscode.NotebookCellKind.Code ? fromCells[i].key : '',
      text: c.value,
    }));
    return Buffer.from(formatObjectText(header, texts), 'utf8');
  }
}

export class FileSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const { text, bom } = decodeBytes(content);
    if (!text.trim()) return new vscode.NotebookData([]);
    const file = parseTcText('', text, bom);
    const cells: vscode.NotebookCellData[] = [];
    for (const obj of file.ordered) {
      const kind = obj.kind === 'pou' && obj.pouKind ? obj.pouKind : KIND_WORD[obj.kind];
      const header = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, `### ${obj.qualifiedName} · ${kind}`, 'markdown');
      header.metadata = { key: `${obj.id}:header`, label: kind, role: 'decl', editable: false, header: true } satisfies CellMeta;
      cells.push(header);
      for (const s of obj.sections) {
        const c = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, s.text, ST_LANGUAGE);
        c.metadata = { key: s.key, label: s.label, role: s.role, editable: s.editable, accessor: s.accessor } satisfies CellMeta;
        cells.push(c);
      }
    }
    const data = new vscode.NotebookData(cells);
    data.metadata = { original: text, bom };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const original = data.metadata?.original as string | undefined;
    if (original === undefined) throw new Error('This TwinCAT notebook cannot be saved');
    const bom = data.metadata?.bom === true;
    const file = parseTcText('', original, bom);
    const edits = data.cells
      .filter(c => c.kind === vscode.NotebookCellKind.Code)
      .map(c => ({ key: cellMeta(c)?.key ?? '', text: c.value }));
    for (const e of edits) {
      if (!file.sections.has(e.key)) throw new Error('Cells cannot be added to a TwinCAT file notebook.');
    }
    const result = applySectionEdits(file, edits);
    return encodeText(result.text, bom);
  }
}

export class CellLabels implements vscode.NotebookCellStatusBarItemProvider {
  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const m = cellMeta(cell);
    if (!m || m.header) return [];
    const item = new vscode.NotebookCellStatusBarItem(m.label, vscode.NotebookCellStatusBarAlignment.Left);
    item.tooltip = m.editable ? `${m.label} (Structured Text)` : `${m.label}: not editable here`;
    return [item];
  }
}

// Notebook serializers: an object notebook shows the sections of one TwinCAT
// object as cells (Declaration above Implementation); a file notebook shows
// every object of a .TcPOU file, used for git comparisons.

import * as vscode from 'vscode';
import { ObjectDoc } from './objectFs';
import { ST_LANGUAGE } from './uris';
import { decodeBytes, parseTcText, encodeText } from '../core/tcfile';
import { applySectionEdits } from '../core/splice';

export interface CellMeta {
  key: string;
  label: string;
  role: 'decl' | 'impl';
  editable: boolean;
  accessor?: 'Get' | 'Set';
  /** Header cell of an object in a file notebook. */
  header?: boolean;
  /** Hash of the section text on disk when the tab was loaded. */
  base?: string;
}

export function cellMeta(cell: vscode.NotebookCell | vscode.NotebookCellData): CellMeta | undefined {
  const m = cell.metadata as CellMeta | undefined;
  return m && typeof m.key === 'string' ? m : undefined;
}

export class ObjectSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = Buffer.from(content).toString('utf8');
    if (!text.trim()) return new vscode.NotebookData([]);
    const doc = JSON.parse(text) as ObjectDoc;
    const cells = doc.sections.map(s => {
      const c = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, s.text, ST_LANGUAGE);
      const meta: CellMeta = { key: s.key, label: s.label, role: s.role, editable: s.editable, accessor: s.accessor, base: s.base };
      c.metadata = meta;
      return c;
    });
    const data = new vscode.NotebookData(cells);
    data.metadata = {
      file: doc.file, objectId: doc.objectId, name: doc.name, qualifiedName: doc.qualifiedName, kind: doc.kind, served: doc.served,
    };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const md = data.metadata ?? {};
    const doc: ObjectDoc = {
      version: 1,
      file: md.file,
      objectId: md.objectId,
      name: md.name,
      qualifiedName: md.qualifiedName,
      kind: md.kind,
      served: md.served,
      sections: data.cells.map(c => {
        const m = cellMeta(c);
        return {
          key: c.kind === vscode.NotebookCellKind.Code && m ? m.key : '',
          label: m?.label ?? '',
          role: m?.role ?? 'impl',
          editable: m?.editable ?? true,
          accessor: m?.accessor,
          text: c.value,
          base: m?.base,
        };
      }),
    };
    return Buffer.from(JSON.stringify(doc, null, 1), 'utf8');
  }
}

const KIND_LABEL: Record<string, string> = {
  pou: 'POU', method: 'Method', property: 'Property', action: 'Action', transition: 'Transition',
  dut: 'DUT', gvl: 'GVL', itf: 'Interface',
};

export class FileSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const { text, bom } = decodeBytes(content);
    if (!text.trim()) return new vscode.NotebookData([]);
    const file = parseTcText('', text, bom);
    const cells: vscode.NotebookCellData[] = [];
    for (const obj of file.ordered) {
      const kind = obj.kind === 'pou' && obj.pouKind ? obj.pouKind : KIND_LABEL[obj.kind] ?? obj.kind;
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

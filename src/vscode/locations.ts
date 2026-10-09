// Locations in the split editor for the parts of VS Code that only open text
// editors at a position (Problems panel, workspace symbols, notebook cells).
// They point into a read-only `twincat-loc:` copy of one section, whose lines
// and columns are those of its pane; opening that copy in an editor tab is
// turned into the split editor at the same place (see extension.ts).

import * as vscode from 'vscode';
import { ParsedObjectText, mapOffset, offsetIn, parseObjectText, positionIn } from '../core/objectText';
import { TcWorkspace, fileKey } from '../core/workspace';
import { LanguageIndex, SectionContext } from '../lang/index';
import { Loc } from '../lang/symbols';
import { objectViewText } from './objectFs';
import { LOC_SCHEME, OBJECT_SCHEME, ObjectRef, locUri, parseLocUri, parseObjectUri, viewKey } from './uris';

export interface LocTarget {
  ref: ObjectRef;
  key: string;
  start: number;
  /** The section text `start` refers to. */
  text: string;
}

export function rangeIn(text: string, start: number, end: number): vscode.Range {
  const a = positionIn(text, start);
  const b = positionIn(text, end);
  return new vscode.Range(a.line, a.character, b.line, b.character);
}

export class LocationService implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ws: TcWorkspace, private readonly index: LanguageIndex) {}

  /** Text of an object view: its open split-editor document, else the disk. */
  current(ref: ObjectRef): ParsedObjectText | undefined {
    const key = viewKey(ref, fileKey);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== OBJECT_SCHEME) continue;
      const r = parseObjectUri(doc.uri);
      if (!r || viewKey(r, fileKey) !== key) continue;
      try {
        return parseObjectText(doc.getText());
      } catch {
        break;
      }
    }
    const obj = this.ws.getFile(ref.fsPath)?.objects.get(ref.objectId);
    if (!obj) return undefined;
    try {
      return parseObjectText(objectViewText(obj, ref.accessor));
    } catch {
      return undefined;
    }
  }

  /** The open split editor document of an object view, if any. */
  private openDocument(ref: ObjectRef): ParsedObjectText | undefined {
    const key = viewKey(ref, fileKey);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== OBJECT_SCHEME) continue;
      const r = parseObjectUri(doc.uri);
      if (!r || viewKey(r, fileKey) !== key) continue;
      try {
        return parseObjectText(doc.getText());
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Text a section copy shows: the open split editor's (its problems are computed on it), else the text
   * the language index has (unsaved notebook edits included), else the disk.
   */
  sectionText(ref: ObjectRef, key: string): string | undefined {
    return this.openDocument(ref)?.sections.find(s => s.key === key)?.text
      ?? this.index.sectionText(fileKey(ref.fsPath), key)
      ?? this.current(ref)?.sections.find(s => s.key === key)?.text;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const ref = parseLocUri(uri);
    return (ref?.section !== undefined ? this.sectionText(ref, ref.section) : undefined) ?? '';
  }

  /** Location of a range of a section in the split editor (see the file comment). */
  locate(ctx: SectionContext, loc: Loc): vscode.Location | undefined {
    const ref: ObjectRef = { fsPath: ctx.filePath, objectId: ctx.object.id, accessor: ctx.accessor };
    const text = this.sectionText(ref, loc.sectionKey);
    if (text === undefined) return undefined;
    // The offsets come from the index text; the copy may show the split editor's version of the section.
    const indexText = this.index.sectionText(loc.fileKey, loc.sectionKey) ?? text;
    const start = mapOffset(indexText, text, loc.start);
    const end = Math.max(start, mapOffset(indexText, text, loc.end));
    return new vscode.Location(locUri(ctx.filePath, ctx.object, ctx.accessor, loc.sectionKey, ctx.label), rangeIn(text, start, end));
  }

  /** Section and offset shown at a position of a section copy. */
  targetAt(uri: vscode.Uri, pos: vscode.Position): LocTarget | undefined {
    const ref = parseLocUri(uri);
    if (!ref || ref.section === undefined) return undefined;
    const text = this.sectionText(ref, ref.section) ?? '';
    return { ref, key: ref.section, start: offsetIn(text, pos.line, pos.character), text };
  }

  /** Tells VS Code that the section copies of an object view changed (an open copy is re-read). */
  changed(objectDocUri: vscode.Uri): void {
    const ref = parseObjectUri(objectDocUri);
    if (!ref) return;
    const key = viewKey(ref, fileKey);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== LOC_SCHEME) continue;
      const r = parseLocUri(doc.uri);
      if (r && viewKey(r, fileKey) === key) this.emitter.fire(doc.uri);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

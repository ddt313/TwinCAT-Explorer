// File system for `twincat:` URIs. Each virtual file is one TwinCAT object
// (POU, method, property, ...) as JSON; saving it splices the edited sections
// back into the real .TcPOU/.TcDUT/.TcGVL/.TcIO file.

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TcObject, TcSourceFile, encodeText, normalizeEol, parseTcFile } from '../core/tcfile';
import { SpliceError, applySectionEdits } from '../core/splice';
import { fileKey } from '../core/workspace';
import { parseObjectUri } from './uris';
import { debugLog } from '../core/debugLog';

export interface ObjectDocSection {
  key: string;
  label: string;
  role: 'decl' | 'impl';
  editable: boolean;
  accessor?: 'Get' | 'Set';
  text: string;
  /** Hash of the text on disk when the tab was loaded: tells edited cells from untouched ones at save time. */
  base?: string;
}

export interface ObjectDoc {
  version: 1;
  file: string;
  objectId: string;
  name: string;
  qualifiedName: string;
  kind: string;
  sections: ObjectDocSection[];
  /** Section keys when the tab was loaded: tells cells deleted in the tab from sections that changed on disk. */
  served?: string[];
}

export function textHash(text: string): string {
  return crypto.createHash('sha1').update(normalizeEol(text)).digest('hex');
}

export function objectDoc(file: TcSourceFile, obj: TcObject): ObjectDoc {
  return {
    version: 1,
    file: file.path,
    objectId: obj.id,
    name: obj.name,
    qualifiedName: obj.qualifiedName,
    kind: obj.kind,
    sections: obj.sections.map(s => ({
      key: s.key, label: s.label, role: s.role, editable: s.editable, accessor: s.accessor, text: s.text, base: textHash(s.text),
    })),
    served: obj.sections.map(s => s.key),
  };
}

interface Stamp {
  sig: string;
  mtime: number;
}

export class ObjectFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly watched = new Map<string, Map<string, vscode.Uri>>();
  private readonly stamps = new Map<string, Stamp>();
  /** Hashes of the section texts this provider last wrote, per URI (a saved notebook is not re-read, so its bases are stale). */
  private readonly written = new Map<string, Map<string, string>>();
  /** Called after a successful save with the real file path. */
  /** Called after a successful save with the real file path and the URI being saved (which must not get a change event). */
  onDidWriteRealFile?: (fsPath: string, savedUri: vscode.Uri) => void;

  private load(uri: vscode.Uri): { file: TcSourceFile; obj: TcObject } {
    const ref = parseObjectUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(ref.fsPath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const file = parseTcFile(ref.fsPath, bytes);
    const obj = file.objects.get(ref.objectId);
    if (!obj) throw vscode.FileSystemError.FileNotFound(uri);
    return { file, obj };
  }

  private content(uri: vscode.Uri): { bytes: Uint8Array; stamp: Stamp } {
    const { file, obj } = this.load(uri);
    const json = JSON.stringify(objectDoc(file, obj), null, 1);
    const sig = crypto.createHash('sha1').update(obj.sections.map(s => s.key + '\u0000' + s.text).join('\u0001')).digest('hex');
    const key = uri.toString();
    let stamp = this.stamps.get(key);
    if (!stamp || stamp.sig !== sig) {
      // The modification time of the object only moves when its own sections change, so saving a
      // sibling object of the same file does not make this one look modified on disk.
      stamp = { sig, mtime: Math.max(Date.now(), (stamp?.mtime ?? 0) + 1) };
      this.stamps.set(key, stamp);
    }
    return { bytes: Buffer.from(json, 'utf8'), stamp };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { bytes, stamp } = this.content(uri);
    debugLog(`stat ${uri.path.split('/').pop()} mtime=${stamp.mtime} size=${bytes.byteLength}`);
    return { type: vscode.FileType.File, ctime: 0, mtime: stamp.mtime, size: bytes.byteLength };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    debugLog(`readFile ${uri.path.split('/').pop()}`);
    // The tab now shows the disk again, so its own bases are current.
    this.written.delete(uri.toString());
    return this.content(uri).bytes;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const ref = parseObjectUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    let doc: ObjectDoc;
    try {
      doc = JSON.parse(Buffer.from(content).toString('utf8'));
    } catch {
      throw new Error('Invalid TwinCAT object document');
    }
    const { file, obj } = this.load(uri);
    const docKeys = doc.sections.map(s => s.key);
    const served = new Set(doc.served ?? docKeys);
    for (const k of docKeys) {
      if (!k || !served.has(k)) {
        throw new Error('Cells cannot be added to a TwinCAT object. Add methods or properties in TwinCAT XAE.');
      }
    }
    for (const k of served) {
      if (!docKeys.includes(k)) throw new Error('Cells of a TwinCAT object cannot be deleted.');
    }
    const lastWritten = this.written.get(uri.toString());
    const edits: { key: string; text: string }[] = [];
    for (const s of doc.sections) {
      const base = lastWritten?.get(s.key) ?? s.base;
      const hash = textHash(s.text);
      // Untouched cells still hold the text of when the tab was loaded: never write them back,
      // or a change made meanwhile outside VS Code (XAE, git) would be reverted.
      if (base !== undefined && hash === base) continue;
      const onDisk = file.sections.get(s.key);
      if (!onDisk) {
        throw new Error(`${s.label} of ${obj.qualifiedName} was removed outside VS Code. Copy your changes and revert this tab.`);
      }
      const diskHash = textHash(onDisk.text);
      if (base !== undefined && diskHash !== base && diskHash !== hash) {
        throw new Error(`${s.label} of ${obj.qualifiedName} was also changed outside VS Code since this tab was loaded. `
          + 'Copy your changes and revert this tab, or use Compare to merge.');
      }
      edits.push({ key: s.key, text: s.text });
    }
    let result;
    try {
      result = applySectionEdits(file, edits);
    } catch (e) {
      if (e instanceof SpliceError) throw new Error(e.message);
      throw e;
    }
    if (result.changedKeys.length > 0) {
      fs.writeFileSync(ref.fsPath, encodeText(result.text, file.bom));
    }
    const hashes = new Map(lastWritten ?? []);
    for (const e of edits) hashes.set(e.key, textHash(e.text));
    this.written.set(uri.toString(), hashes);
    if (result.changedKeys.length > 0) {
      this.onDidWriteRealFile?.(ref.fsPath, uri);
    }
  }

  /** Drops what is kept per URI once VS Code has closed that document. */
  forget(uri: vscode.Uri): void {
    this.stamps.delete(uri.toString());
    this.written.delete(uri.toString());
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const ref = parseObjectUri(uri);
    if (!ref) return new vscode.Disposable(() => undefined);
    const k = fileKey(ref.fsPath);
    let m = this.watched.get(k);
    if (!m) {
      m = new Map();
      this.watched.set(k, m);
    }
    m.set(uri.toString(), uri);
    return new vscode.Disposable(() => {
      const mm = this.watched.get(k);
      mm?.delete(uri.toString());
      if (mm && mm.size === 0) this.watched.delete(k);
    });
  }

  /** Tells VS Code that the objects of a real file may have changed. */
  notifyRealFileChanged(fsPath: string, except?: vscode.Uri): void {
    const m = this.watched.get(fileKey(fsPath));
    debugLog(`notify ${fsPath.split(/[\\/]/).pop()} watched=${m ? [...m.values()].map(u => u.path.split('/').pop()).join(',') : 'none'}`);
    if (!m) return;
    const events: vscode.FileChangeEvent[] = [];
    for (const uri of m.values()) {
      if (except && uri.toString() === except.toString()) continue;
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }
    if (events.length) this.emitter.fire(events);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('TwinCAT objects are created in TwinCAT XAE');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('TwinCAT objects are deleted in TwinCAT XAE');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('TwinCAT objects are renamed in TwinCAT XAE');
  }
}

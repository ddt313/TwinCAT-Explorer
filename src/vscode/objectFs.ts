// File system for `twincat:` URIs. Each virtual file is one TwinCAT object
// (POU, method, property, ...) as JSON; saving it splices the edited sections
// back into the real .TcPOU/.TcDUT/.TcGVL/.TcIO file.

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TcObject, TcSourceFile, encodeText, parseTcFile } from '../core/tcfile';
import { SpliceError, applySectionEdits } from '../core/splice';
import { fileKey } from '../core/workspace';
import { parseObjectUri, objectUri } from './uris';

export interface ObjectDocSection {
  key: string;
  label: string;
  role: 'decl' | 'impl';
  editable: boolean;
  accessor?: 'Get' | 'Set';
  text: string;
}

export interface ObjectDoc {
  version: 1;
  file: string;
  objectId: string;
  name: string;
  qualifiedName: string;
  kind: string;
  sections: ObjectDocSection[];
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
      key: s.key, label: s.label, role: s.role, editable: s.editable, accessor: s.accessor, text: s.text,
    })),
  };
}

export function objectUriOf(file: TcSourceFile, obj: TcObject): vscode.Uri {
  return objectUri(file.path, obj);
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
  /** Called after a successful save with the real file path. */
  onDidWriteRealFile?: (fsPath: string) => void;

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
    return { type: vscode.FileType.File, ctime: 0, mtime: stamp.mtime, size: bytes.byteLength };
  }

  readFile(uri: vscode.Uri): Uint8Array {
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
    const known = new Set(obj.sections.map(s => s.key));
    const seen = new Set<string>();
    for (const s of doc.sections) {
      if (!s.key || !known.has(s.key)) {
        throw new Error('Cells cannot be added to a TwinCAT object. Add methods or properties in TwinCAT XAE.');
      }
      seen.add(s.key);
    }
    if (seen.size !== known.size) {
      throw new Error('Cells of a TwinCAT object cannot be deleted.');
    }
    let result;
    try {
      result = applySectionEdits(file, doc.sections.map(s => ({ key: s.key, text: s.text })));
    } catch (e) {
      if (e instanceof SpliceError) throw new Error(e.message);
      throw e;
    }
    if (result.changedKeys.length > 0) {
      fs.writeFileSync(ref.fsPath, encodeText(result.text, file.bom));
      this.onDidWriteRealFile?.(ref.fsPath);
      this.notifyRealFileChanged(ref.fsPath, uri);
    }
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

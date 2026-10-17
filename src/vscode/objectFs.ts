// File system for `twincat:` URIs. Each virtual file is one view of a TwinCAT
// object (POU, method, property declaration, accessor, ...) in the text form of
// objectText.ts; saving it splices the edited sections back into the real
// .TcPOU/.TcDUT/.TcGVL/.TcIO file.

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Section, TcObject, TcSourceFile, decodeBytes, encodeText, normalizeEol, parseTcFile } from '../core/tcfile';
import { ObjectTextError, duplicateKeys, formatObjectText, headerOf, parseObjectText, viewLabel, viewSections } from '../core/objectText';
import { SpliceError, applySectionEdits } from '../core/splice';
import { fileKey } from '../core/workspace';
import { OBJECT_NOTEBOOK, OBJECT_SCHEME, parseObjectUri } from './uris';
import { debugLog } from '../core/debugLog';

export function textHash(text: string): string {
  return crypto.createHash('sha1').update(normalizeEol(text)).digest('hex');
}

/** A new load id: fixed length, so the size VS Code gets from stat() matches what readFile() returns. */
export function newLoadId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** The served text of an object view. */
export function objectViewText(obj: TcObject, accessor?: 'Get' | 'Set'): string {
  const sections = viewSections(obj, accessor);
  return formatObjectText(headerOf(viewLabel(obj, accessor), obj.kind, sections, textHash, newLoadId()), sections);
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
  /**
   * Hashes of the section texts this provider last wrote, per load of a document (`uri|load`): a saved
   * document is not re-read, so its header bases are stale. Kept per load, not per URI, because a split
   * editor and a notebook can have the same URI open at once.
   */
  private readonly written = new Map<string, Map<string, string>>();
  private static readonly STORE_KEY = 'twincatExplorer.writtenSections';

  /**
   * `store` keeps the written hashes across extension host restarts and window reloads: a document
   * restored with unsaved edits keeps its load id, and without them a section saved earlier would count
   * as edited again.
   */
  constructor(private readonly store?: vscode.Memento) {
    const saved = store?.get<Record<string, Record<string, string>>>(ObjectFileSystem.STORE_KEY) ?? {};
    for (const [k, v] of Object.entries(saved)) this.written.set(k, new Map(Object.entries(v)));
  }

  private persist(): void {
    if (!this.store) return;
    // Load ids are random, so stale entries do no harm; only the most recent ones are kept.
    const entries = [...this.written].slice(-300).map(([k, v]) => [k, Object.fromEntries(v)]);
    void this.store.update(ObjectFileSystem.STORE_KEY, Object.fromEntries(entries));
  }
  /** Called after a successful save with the real file path and the URI being saved (which must not get a change event). */
  onDidWriteRealFile?: (fsPath: string, savedUri: vscode.Uri) => void;

  private load(uri: vscode.Uri): { file: TcSourceFile; obj: TcObject; sections: Section[]; accessor?: 'Get' | 'Set' } {
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
    const sections = viewSections(obj, ref.accessor);
    // An accessor deleted in XAE: its view is gone, not empty.
    if (ref.accessor && sections.length === 0) throw vscode.FileSystemError.FileNotFound(uri);
    return { file, obj, sections, accessor: ref.accessor };
  }

  private content(uri: vscode.Uri): { bytes: Uint8Array; stamp: Stamp } {
    const { obj, sections, accessor } = this.load(uri);
    let text: string;
    try {
      text = objectViewText(obj, accessor);
    } catch (e) {
      if (e instanceof ObjectTextError) throw vscode.FileSystemError.Unavailable(e.message);
      throw e;
    }
    const sig = crypto.createHash('sha1').update(sections.map(s => s.key + '\u0000' + s.text).join('\u0001')).digest('hex');
    const key = uri.toString();
    let stamp = this.stamps.get(key);
    if (!stamp || stamp.sig !== sig) {
      // The modification time of the object only moves when its own sections change, so saving a
      // sibling object of the same file does not make this one look modified on disk.
      stamp = { sig, mtime: Math.max(Date.now(), (stamp?.mtime ?? 0) + 1) };
      this.stamps.set(key, stamp);
    }
    return { bytes: Buffer.from(text, 'utf8'), stamp };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { bytes, stamp } = this.content(uri);
    debugLog(`stat ${uri.path.split('/').pop()} mtime=${stamp.mtime} size=${bytes.byteLength}`);
    return { type: vscode.FileType.File, ctime: 0, mtime: stamp.mtime, size: bytes.byteLength };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    debugLog(`readFile ${uri.path.split('/').pop()}`);
    // Every read is a new load (new id), so what earlier loads of this URI saved does not apply to it.
    return this.content(uri).bytes;
  }

  private static loadKey(uri: vscode.Uri, load: string | undefined): string {
    return `${uri.toString()}|${load ?? ''}`;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const ref = parseObjectUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    let doc;
    try {
      doc = parseObjectText(normalizeEol(decodeBytes(content).text));
    } catch (e) {
      throw new Error(e instanceof ObjectTextError ? e.message : 'Invalid TwinCAT object document');
    }
    const { file, obj, sections: viewOnDisk } = this.load(uri);
    const meta = new Map(doc.header.sections.map(m => [m.key, m]));
    const docKeys = doc.sections.map(s => s.key);
    if (duplicateKeys(doc.sections).length || duplicateKeys(doc.header.sections).length) {
      throw new Error('A section of a TwinCAT object appears twice. Remove the copy and save again.');
    }
    for (const k of docKeys) {
      if (!k || !meta.has(k)) {
        throw new Error('Sections cannot be added to a TwinCAT object. Add methods or properties in TwinCAT XAE.');
      }
    }
    for (const k of meta.keys()) {
      if (!docKeys.includes(k)) throw new Error('Sections of a TwinCAT object cannot be deleted.');
    }
    const loadKey = ObjectFileSystem.loadKey(uri, doc.header.load);
    const lastWritten = this.written.get(loadKey);
    /** An untouched section whose text in the document is older than the disk. */
    let stale = false;
    const edits: { key: string; text: string }[] = [];
    for (const s of doc.sections) {
      const m = meta.get(s.key)!;
      const base = lastWritten?.get(s.key) ?? m.base;
      const hash = textHash(s.text);
      // Untouched sections still hold the text of when the tab was loaded: never write them back,
      // or a change made meanwhile outside VS Code (XAE, git) would be reverted.
      if (base !== undefined && hash === base) {
        if (file.sections.get(s.key)?.text !== s.text) stale = true;
        continue;
      }
      const onDisk = file.sections.get(s.key);
      if (!onDisk) {
        throw new Error(`${m.label} of ${obj.qualifiedName} was removed outside VS Code. Copy your changes and revert this tab.`);
      }
      if (!onDisk.editable) throw new Error(`${m.label} of ${obj.qualifiedName} cannot be edited here.`);
      const diskHash = textHash(onDisk.text);
      if (base !== undefined && diskHash !== base && diskHash !== hash) {
        throw new Error(`${m.label} of ${obj.qualifiedName} was also changed outside VS Code since this tab was loaded. `
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
    this.written.delete(loadKey);
    this.written.set(loadKey, hashes);
    this.persist();
    if (result.changedKeys.length > 0) {
      this.onDidWriteRealFile?.(ref.fsPath, uri);
    }
    if (stale || viewOnDisk.length !== doc.sections.length) this.reloadAfterSave(uri);
  }

  /**
   * The saved document still shows an older text of a section it did not write (changed by XAE or git
   * while the tab had unsaved edits). VS Code takes the stat after the save as the saved version and
   * would never re-read it, so once the save is over the object gets a new modification time and a
   * change event: the now clean tab reloads the disk. (A change event during the save itself can leave
   * the document ignoring later changes.)
   */
  private reloadAfterSave(uri: vscode.Uri): void {
    setTimeout(() => {
      const stamp = this.stamps.get(uri.toString());
      if (stamp) stamp.sig = '';
      debugLog(`reload after save ${uri.path.split('/').pop()}`);
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }, 300);
  }

  /**
   * Hash a section is compared with to decide whether the user edited it: what this provider last wrote
   * for that load of the document, else the hash taken when it was loaded.
   */
  effectiveBase(uri: vscode.Uri, load: string | undefined, key: string, loadBase: string | undefined): string | undefined {
    return this.written.get(ObjectFileSystem.loadKey(uri, load))?.get(key) ?? loadBase;
  }

  /** Drops what was kept for a closed document; `lastOfUri` when no other document of the URI is open. */
  forget(uri: vscode.Uri, load: string | undefined, lastOfUri: boolean): void {
    this.written.delete(ObjectFileSystem.loadKey(uri, load));
    if (lastOfUri) {
      this.stamps.delete(uri.toString());
      const prefix = `${uri.toString()}|`;
      for (const k of [...this.written.keys()]) if (k.startsWith(prefix)) this.written.delete(k);
    }
    this.persist();
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

  /**
   * Tells VS Code that the objects of a real file may have changed. Every open document of the file
   * gets the event, not only the watched ones: VS Code watches non-file URIs only while their editor
   * is visible, so a hidden tab would otherwise keep its old text.
   */
  notifyRealFileChanged(fsPath: string, except?: vscode.Uri): void {
    const k = fileKey(fsPath);
    const targets = new Map<string, vscode.Uri>(this.watched.get(k) ?? []);
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== OBJECT_NOTEBOOK) continue;
      const ref = parseObjectUri(nb.uri);
      if (ref && fileKey(ref.fsPath) === k) targets.set(nb.uri.toString(), nb.uri);
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== OBJECT_SCHEME) continue;
      const ref = parseObjectUri(doc.uri);
      if (ref && fileKey(ref.fsPath) === k) targets.set(doc.uri.toString(), doc.uri);
    }
    if (except) targets.delete(except.toString());
    debugLog(`notify ${fsPath.split(/[\\/]/).pop()} -> ${[...targets.values()].map(u => u.path.split('/').pop()).join(',') || 'none'}`);
    if (targets.size) this.emitter.fire([...targets.values()].map(uri => ({ type: vscode.FileChangeType.Changed, uri })));
  }

  /** Re-announces every watched document (used once after start-up, when changes may have been missed). */
  notifyAllWatched(): void {
    const events: vscode.FileChangeEvent[] = [];
    for (const m of this.watched.values()) for (const uri of m.values()) events.push({ type: vscode.FileChangeType.Changed, uri });
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

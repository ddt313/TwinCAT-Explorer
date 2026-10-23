// The edits the MCP server made, to take them back: Ctrl+Z in TwinCAT XAE does not undo them, and an AI's edit
// should be easy to revert on its own. A section edit is undone when the section still has the text the edit gave
// it; a change of whole files (a member added or deleted, a new object) when the files are still as it left them.
// Kept in memory and appended to a JSON-lines file, so a restarted server still knows them. Independent of the
// VS Code API.

import * as fs from 'fs';
import * as path from 'path';

/** A whole file before and after a change; null: the file did not exist. Texts as on disk, decoded, BOM aside. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  bom: boolean;
}

export type UndoEntry = {
  id: number;
  /** ISO 8601. */
  time: string;
  /** The folder the server works on. */
  root: string;
  /** What was done, for the history: `edit_section FB_Valve.Open impl`. */
  what: string;
  undone?: boolean;
} & (
  | { kind: 'section'; path: string; key: string; object: string; part: 'decl' | 'impl'; before: string; after: string }
  | { kind: 'files'; files: FileChange[] }
);

/** An entry as `add` takes it: Omit on each kind of the union, not on their common part. */
type NewEntry = UndoEntry extends infer E ? E extends unknown ? Omit<E, 'id' | 'time' | 'root'> : never : never;

export class UndoLog {
  private entries: UndoEntry[] = [];
  private nextId = 1;

  /** `file`: where the log is kept (undefined: memory only). */
  constructor(readonly root: string, private readonly file?: string) {
    if (!file) return;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as UndoEntry | { undone: number; root: string };
        if ('undone' in rec && typeof rec.undone === 'number') {
          const e = this.entries.find(x => x.id === rec.undone && x.root === rec.root);
          if (e) e.undone = true;
        } else if ('id' in rec) {
          this.nextId = Math.max(this.nextId, rec.id + 1);
          if (rec.root === root) this.entries.push(rec);
        }
      }
    } catch {
      // no log yet, or a damaged one: start empty
    }
  }

  add(entry: NewEntry): UndoEntry {
    const e = { ...entry, id: this.nextId++, time: new Date().toISOString(), root: this.root } as UndoEntry;
    this.entries.push(e);
    this.append(e);
    return e;
  }

  /** The edits of this folder, newest first. */
  list(): UndoEntry[] {
    return [...this.entries].reverse();
  }

  get(id?: number): UndoEntry | undefined {
    if (id !== undefined) return this.entries.find(e => e.id === id);
    return [...this.entries].reverse().find(e => !e.undone);
  }

  markUndone(e: UndoEntry): void {
    e.undone = true;
    this.append({ undone: e.id, root: this.root });
  }

  private append(rec: unknown): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch {
      // the log on disk is a convenience: the edit is done either way
    }
  }
}

/** Where the server keeps its log: %LOCALAPPDATA%\twincat-explorer\mcp-undo.jsonl (~/.twincat-explorer elsewhere). */
export function defaultUndoFile(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.twincat-explorer');
  return path.join(base, process.env.LOCALAPPDATA ? 'twincat-explorer' : '', 'mcp-undo.jsonl');
}

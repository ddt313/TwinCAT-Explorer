// The declarations of a TwinCAT source library (.library), read from the file without XAE, for the language features
// of a library without a stub. A compiled library (.compiled-library*) holds no declaration text: its objects are
// known by name only (see parseBrowserCache).

import { readZip } from './zip';

/** A POU, DUT, GVL or interface of a library, with its declaration as a stub declares it (see libraryStubText). */
export interface LibraryDeclaration {
  name: string;
  kind: 'pou' | 'dut' | 'interface' | 'gvl';
  /**
   * Its declaration, then (a POU or interface) those of its methods, properties and actions, each closed with
   * END_METHOD, END_PROPERTY or END_ACTION, then END_FUNCTION_BLOCK, END_FUNCTION, END_PROGRAM or END_INTERFACE.
   */
  text: string;
}

/** The TypeGUIDs of XAE's objects in the metas of a library. */
const OBJECT_TYPES = new Map<string, 'pou' | 'dut' | 'interface' | 'gvl' | 'method' | 'property' | 'action'>([
  ['6f9dac99-8de1-4efc-8465-68ac443b7d08', 'pou'],
  ['2db5746d-d284-4425-9f7f-2663a34b0ebc', 'dut'],
  ['40989022-e4d2-4dc7-89d2-9a412930b20e', 'dut'],
  ['6654496c-404d-479a-aad2-8551054e5f1e', 'interface'],
  ['ffbfa93a-b94d-45fc-a329-229860183b1d', 'gvl'],
  ['f8a58466-d7f6-439f-bbb8-d4600e41d099', 'method'],
  ['f89f7675-27f1-46b3-8abb-b7da8e774ffd', 'method'],
  ['62ebfd1c-d342-43e5-8efb-f22b6d8e4a04', 'method'],
  ['5a3b8626-d3e9-4f37-98b5-66420063d91e', 'property'],
  ['8ac092e5-3128-4e26-9e7e-11016c6684f2', 'action'],
]);

/** The keyword a declaration starts with, by the kind of its object. */
const DECLARATION_START: Record<string, RegExp> = {
  pou: /^(FUNCTION_BLOCK|FUNCTION|PROGRAM)\b/i,
  interface: /^INTERFACE\b/i,
  dut: /^TYPE\b/i,
  gvl: /^VAR_GLOBAL\b/i,
  method: /^METHOD\b/i,
  property: /^PROPERTY\b/i,
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The header of a .meta and a .object file before its content. */
const HEADER = 20;

class Reader {
  constructor(readonly b: Buffer, public p = 0) {}

  /** An unsigned LEB128 number; undefined past the end. */
  varint(): number | undefined {
    let value = 0;
    for (let shift = 0; this.p < this.b.length && shift < 35; shift += 7) {
      const c = this.b[this.p++];
      value += (c & 0x7f) * 2 ** shift;
      if (!(c & 0x80)) return value;
    }
    return undefined;
  }
}

/**
 * The strings of `__shared_data_storage_string_table__.auxiliary`, by index: a byte and a number, then
 * `<index> <length> <UTF-8>` per string, the indexes counting from 0 (the numbers LEB128).
 */
export function parseStringTable(bytes: Buffer): string[] {
  const r = new Reader(bytes, 1);
  r.varint();
  const strings: string[] = [];
  while (r.p < bytes.length) {
    const index = r.varint();
    const length = r.varint();
    if (index !== strings.length || length === undefined || r.p + length > bytes.length) break;
    strings.push(bytes.toString('utf8', r.p, r.p + length));
    r.p += length;
  }
  return strings;
}

/** What a `.meta` names, as strings of the table: the object's GUID, its parent's (a folder's, or zeros), name, type. */
interface Meta {
  id: string;
  parent: string;
  name: string;
  type?: string;
}

function parseMeta(bytes: Buffer, strings: string[]): Meta | undefined {
  const r = new Reader(bytes, HEADER);
  const tokens: number[] = [];
  for (let t = r.varint(); t !== undefined; t = r.varint()) tokens.push(t);
  const [id, parent, name] = tokens.slice(2, 5).map(t => strings[t]);
  if (!id || !parent || name === undefined) return undefined;
  const type = tokens.map(t => strings[t]).find(s => s !== undefined && OBJECT_TYPES.has(s));
  return { id, parent, name, type };
}

/** The index of the text of the line at `i` of a `.object` with that tag (see objectTexts), its end at r.p; else undefined. */
function lineAt(bytes: Buffer, i: number, tag: number, strings: string[], r: Reader): number | undefined {
  // A line id is small: its upper bytes are zeros, unlike a tag among the bytes between two texts (`0D 0C 0B 0F`).
  if (bytes[i] !== tag || i + 10 >= bytes.length) return undefined;
  for (let k = i + 3; k < i + 9; k++) if (bytes[k] !== 0) return undefined;
  r.p = i + 10;
  const text = r.varint();
  return text !== undefined && text < strings.length ? text : undefined;
}

/**
 * The tag of the lines in the `.object` files of a library: the byte its schema gives that field, 0B or 0C in those
 * seen. The one that most lines followed by another line of the same tag start with.
 */
export function lineTag(objects: Buffer[], strings: string[]): number | undefined {
  const counts = new Map<number, number>();
  for (const bytes of objects) {
    const r = new Reader(bytes);
    for (let i = HEADER; i < bytes.length; i++) {
      const tag = bytes[i];
      if (tag === 0 || tag >= 0x80 || lineAt(bytes, i, tag, strings, r) === undefined) continue;
      if (lineAt(bytes, r.p, tag, strings, r) !== undefined) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The texts of a `.object`, as lists of lines in their order: a line is its tag (see lineTag), its line id (8 bytes,
 * little endian, below 65536) and a byte, then the index of its text (LEB128), the lines of a text one after the
 * other. An object has its implementation and its declaration, either first.
 */
export function objectTexts(bytes: Buffer, strings: string[], tag: number): string[][] {
  const texts: string[][] = [];
  let lines: string[] = [];
  const r = new Reader(bytes);
  for (let i = HEADER; i < bytes.length;) {
    const text = lineAt(bytes, i, tag, strings, r);
    if (text !== undefined) {
      lines.push(strings[text]);
      i = r.p;
      continue;
    }
    if (lines.length) texts.push(lines);
    lines = [];
    i++;
  }
  if (lines.length) texts.push(lines);
  return texts;
}

/** A text without its comments and pragmas, trimmed: where its first keyword is. */
function code(text: string): string {
  return text.replace(/\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\{[^}]*\}/g, ' ').trim();
}

/** The declaration among the texts of an object: the one that starts with the keyword of its kind. */
function declarationOf(texts: string[][], kind: string): string | undefined {
  const start = DECLARATION_START[kind];
  return texts.map(t => t.join('\n')).find(t => start?.test(code(t)));
}

/**
 * The POUs, DUTs, GVLs and interfaces of a source library (`.library`, a zip archive), with the methods, properties
 * and actions of the POUs and interfaces, as stub text (see LibraryDeclaration). Objects are `<GUID>.meta` (GUID,
 * parent, name and type, as strings of the table) and `<GUID>.object` (texts); folders are left out, and so is an
 * object without a declaration. An action has none: `ACTION <name>` stands for it. Empty when the file is no source
 * library, such as a compiled one.
 */
export function readLibraryDeclarations(bytes: Uint8Array): LibraryDeclaration[] {
  const files = new Map(readZip(bytes).map(e => [e.name.toLowerCase(), e]));
  const table = files.get('__shared_data_storage_string_table__.auxiliary');
  if (!table) return [];
  const strings = parseStringTable(table.read());
  const objects = new Map<string, Meta & { kind: string }>();
  for (const [name, entry] of files) {
    if (!name.endsWith('.meta')) continue;
    const meta = parseMeta(entry.read(), strings);
    const kind = meta?.type && OBJECT_TYPES.get(meta.type);
    if (!meta || !kind || meta.id.toLowerCase() !== name.slice(0, -'.meta'.length) || !IDENTIFIER.test(meta.name)) continue;
    objects.set(meta.id.toLowerCase(), { ...meta, kind });
  }
  const contents = new Map<string, Buffer>();
  for (const id of objects.keys()) {
    const entry = files.get(`${id}.object`);
    if (entry) contents.set(id, entry.read());
  }
  const tag = lineTag([...contents.values()], strings);
  if (tag === undefined) return [];
  const texts = (id: string) => {
    const bytes = contents.get(id);
    return bytes ? objectTexts(bytes, strings, tag) : [];
  };
  const members = new Map<string, (Meta & { kind: string })[]>();
  for (const o of objects.values()) {
    if (o.kind !== 'method' && o.kind !== 'property' && o.kind !== 'action') continue;
    const list = members.get(o.parent.toLowerCase()) ?? [];
    members.set(o.parent.toLowerCase(), list);
    list.push(o);
  }
  const out: LibraryDeclaration[] = [];
  for (const [id, o] of objects) {
    if (o.kind !== 'pou' && o.kind !== 'dut' && o.kind !== 'interface' && o.kind !== 'gvl') continue;
    const declaration = declarationOf(texts(id), o.kind);
    if (!declaration) continue;
    let text = declaration;
    if (o.kind === 'pou' || o.kind === 'interface') {
      const own = (members.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      for (const m of own) {
        if (m.kind === 'action') {
          text += `\nACTION ${m.name}\nEND_ACTION`;
          continue;
        }
        const d = declarationOf(texts(m.id.toLowerCase()), m.kind);
        if (d) text += `\n${d}\nEND_${m.kind.toUpperCase()}`;
      }
      const keyword = o.kind === 'interface' ? 'INTERFACE' : DECLARATION_START.pou.exec(code(declaration))![1].toUpperCase();
      text += `\nEND_${keyword}`;
    }
    out.push({ name: o.name, kind: o.kind, text });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Model of one TwinCAT source file (.TcPOU, .TcDUT, .TcGVL, .TcIO, .TcTTO):
// the openable objects it contains (POU, methods, properties, ...) and the
// Structured Text sections of each object, with their exact place in the XML.

import { XmlElement, parseXml, child, children, cdataText } from './xml';

export type TcFileKind = 'pou' | 'dut' | 'gvl' | 'itf' | 'task' | 'other';
export type ObjectKind = 'pou' | 'method' | 'property' | 'action' | 'transition' | 'dut' | 'gvl' | 'itf';
export type PouKind = 'FB' | 'PRG' | 'FUN';
export type DutKind = 'struct' | 'enum' | 'union' | 'alias';

export interface Section {
  /** Stable key: `<element id>:decl` or `<element id>:impl`. */
  key: string;
  role: 'decl' | 'impl';
  label: string;
  /** Content with line breaks normalized to LF. */
  text: string;
  /** Element holding the CDATA (Declaration or ST). */
  element: XmlElement;
  /** False for implementations in a language other than ST. */
  editable: boolean;
  language: string;
  owner: TcObject;
  accessor?: 'Get' | 'Set';
}

export interface InnerFolder {
  name: string;
  path: string[];
  children: InnerFolder[];
}

export interface TcObject {
  /** Normalized GUID: lower case, no braces. */
  id: string;
  kind: ObjectKind;
  tag: string;
  name: string;
  /** `FB_X` for a POU, `FB_X.Method` for a member. */
  qualifiedName: string;
  folderPath: string[];
  element: XmlElement;
  sections: Section[];
  members: TcObject[];
  parent?: TcObject;
  accessors: { kind: 'Get' | 'Set'; id: string; sections: Section[] }[];
  innerFolders: InnerFolder[];
  pouKind?: PouKind;
  dutKind?: DutKind;
}

export interface TcSourceFile {
  path: string;
  /** Decoded text without BOM. */
  text: string;
  bom: boolean;
  eol: '\r\n' | '\n';
  fileKind: TcFileKind;
  root?: TcObject;
  /** Openable objects (root and members) by id. */
  objects: Map<string, TcObject>;
  sections: Map<string, Section>;
  /** Objects and members in document order. */
  ordered: TcObject[];
  error?: string;
}

export function normalizeId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/[{}]/g, '').toLowerCase();
}

export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export function decodeBytes(bytes: Uint8Array): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8', bom ? 3 : 0);
  return { text, bom };
}

export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = Buffer.from(text, 'utf8');
  if (!bom) return body;
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}

const TOP_LEVEL: Record<string, { kind: ObjectKind; fileKind: TcFileKind }> = {
  POU: { kind: 'pou', fileKind: 'pou' },
  DUT: { kind: 'dut', fileKind: 'dut' },
  GVL: { kind: 'gvl', fileKind: 'gvl' },
  Itf: { kind: 'itf', fileKind: 'itf' },
};

export function fileKindFromPath(path: string): TcFileKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'tcpou': return 'pou';
    case 'tcdut': return 'dut';
    case 'tcgvl': return 'gvl';
    case 'tcio': return 'itf';
    case 'tctto': return 'task';
    default: return 'other';
  }
}

export function parseTcFile(path: string, bytes: Uint8Array): TcSourceFile {
  const { text, bom } = decodeBytes(bytes);
  return parseTcText(path, text, bom);
}

export function parseTcText(path: string, text: string, bom = false): TcSourceFile {
  const file: TcSourceFile = {
    path, text, bom, eol: text.includes('\r\n') ? '\r\n' : '\n',
    fileKind: fileKindFromPath(path), objects: new Map(), sections: new Map(), ordered: [],
  };
  let doc: XmlElement;
  try {
    doc = parseXml(text);
  } catch (e) {
    file.error = (e as Error).message;
    return file;
  }
  const plcObject = child(doc, 'TcPlcObject');
  const top = plcObject?.children.find(c => TOP_LEVEL[c.name]);
  if (!top) {
    const task = child(plcObject, 'Task');
    if (task) file.fileKind = 'task';
    return file;
  }
  const info = TOP_LEVEL[top.name];
  file.fileKind = info.fileKind;
  const root = buildObject(file, top, info.kind, undefined);
  file.root = root;
  if (top.name === 'POU' || top.name === 'Itf') {
    root.innerFolders = buildInnerFolders(children(top, 'Folder'), []);
    for (const el of top.children) {
      const memberKind = memberKindOf(el.name);
      if (!memberKind) continue;
      const member = buildObject(file, el, memberKind, root);
      root.members.push(member);
    }
  }
  return file;
}

function memberKindOf(tag: string): ObjectKind | undefined {
  switch (tag) {
    case 'Method': return 'method';
    case 'Property': return 'property';
    case 'Action': return 'action';
    case 'Transition': return 'transition';
    default: return undefined;
  }
}

function buildInnerFolders(els: XmlElement[], parentPath: string[]): InnerFolder[] {
  return els.map(el => {
    const name = el.attrs.get('Name') ?? '';
    const path = [...parentPath, name];
    return { name, path, children: buildInnerFolders(children(el, 'Folder'), path) };
  });
}

function buildObject(file: TcSourceFile, el: XmlElement, kind: ObjectKind, parent: TcObject | undefined): TcObject {
  const name = el.attrs.get('Name') ?? '';
  const id = normalizeId(el.attrs.get('Id')) ?? `${parent ? parent.id + '/' : ''}${el.name}:${name}`;
  const folderPath = (el.attrs.get('FolderPath') ?? '').split('\\').filter(s => s.length > 0);
  const obj: TcObject = {
    id, kind, tag: el.name, name,
    qualifiedName: parent ? `${parent.name}.${name}` : name,
    folderPath, element: el, sections: [], members: [], parent, accessors: [], innerFolders: [],
  };
  file.objects.set(id, obj);
  file.ordered.push(obj);

  const addSection = (holder: XmlElement, role: 'decl' | 'impl', ownerId: string, label: string,
    accessor?: 'Get' | 'Set'): Section | undefined => {
    if (role === 'decl') {
      const declEl = child(holder, 'Declaration');
      if (!declEl) return undefined;
      return pushSection(file, obj, declEl, `${ownerId}:decl`, role, label, true, 'ST', accessor);
    }
    const implEl = child(holder, 'Implementation');
    if (!implEl) return undefined;
    const st = child(implEl, 'ST');
    if (st) return pushSection(file, obj, st, `${ownerId}:impl`, role, label, true, 'ST', accessor);
    const other = implEl.children[0];
    const language = other?.name ?? 'unknown';
    return pushSection(file, obj, other ?? implEl, `${ownerId}:impl`, role,
      `${label} (${language}, read-only)`, false, language, accessor);
  };

  addSection(el, 'decl', id, 'Declaration');
  if (kind === 'property') {
    for (const accEl of el.children) {
      if (accEl.name !== 'Get' && accEl.name !== 'Set') continue;
      const accKind = accEl.name as 'Get' | 'Set';
      const accId = normalizeId(accEl.attrs.get('Id')) ?? `${id}/${accKind}`;
      const secs: Section[] = [];
      const d = addSection(accEl, 'decl', accId, `${accKind} · Declaration`, accKind);
      if (d) secs.push(d);
      const m = addSection(accEl, 'impl', accId, `${accKind} · Implementation`, accKind);
      if (m) secs.push(m);
      obj.accessors.push({ kind: accKind, id: accId, sections: secs });
    }
  } else {
    addSection(el, 'impl', id, 'Implementation');
  }

  const decl = obj.sections.find(s => s.role === 'decl' && !s.accessor);
  if (decl) {
    if (kind === 'pou') obj.pouKind = pouKindFromDeclaration(decl.text);
    if (kind === 'dut') obj.dutKind = dutKindFromDeclaration(decl.text);
  }
  return obj;
}

function pushSection(file: TcSourceFile, owner: TcObject, element: XmlElement, key: string, role: 'decl' | 'impl',
  label: string, editable: boolean, language: string, accessor?: 'Get' | 'Set'): Section {
  const raw = editable ? cdataText(file.text, element) : '';
  const section: Section = {
    key, role, label, text: normalizeEol(raw), element, editable, language, owner, accessor,
  };
  owner.sections.push(section);
  file.sections.set(key, section);
  return section;
}

/** Removes comments, pragmas and string contents so keywords can be searched with a regex. */
export function stripTrivia(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '(' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '(' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === ')') { depth--; i += 2; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      out += ' ';
      continue;
    }
    if (c === '{') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (text[i] === "'") { i++; while (i < n && text[i] !== "'") i++; }
        else if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c) i += text[i] === '$' ? 2 : 1;
      i++;
      out += "''";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function pouKindFromDeclaration(decl: string): PouKind | undefined {
  const m = /\b(FUNCTION_BLOCK|PROGRAM|FUNCTION)\b/i.exec(stripTrivia(decl));
  if (!m) return undefined;
  switch (m[1].toUpperCase()) {
    case 'FUNCTION_BLOCK': return 'FB';
    case 'PROGRAM': return 'PRG';
    default: return 'FUN';
  }
}

export function dutKindFromDeclaration(decl: string): DutKind | undefined {
  const m = /\bTYPE\s+[A-Za-z_]\w*(?:\s+EXTENDS\s+[\w.]+)?\s*:\s*(\(|STRUCT\b|UNION\b)?/i.exec(stripTrivia(decl));
  if (!m) return undefined;
  if (!m[1]) return 'alias';
  if (m[1] === '(') return 'enum';
  return m[1].toUpperCase() === 'STRUCT' ? 'struct' : 'union';
}

/** Maps an offset in a section's LF-normalized text to an offset in the file text. */
export function sectionOffsetToFileOffset(file: TcSourceFile, section: Section, offset: number): number {
  const segments = section.element.cdata;
  if (segments.length === 0) return section.element.contentStart;
  let remaining = offset;
  for (const seg of segments) {
    let i = seg.contentStart;
    while (i < seg.contentEnd) {
      if (remaining === 0) return i;
      if (file.text[i] === '\r' && file.text[i + 1] === '\n') i += 2;
      else i++;
      remaining--;
    }
  }
  return segments[segments.length - 1].contentEnd;
}

/**
 * Line of the file (1-based, counted like git: by LF) on which each line of a section starts: line `i` of
 * `section.text` is on line `result[i]` of the file.
 */
export function sectionFileLines(file: TcSourceFile, section: Section): number[] {
  const text = file.text;
  const segments = section.element.cdata;
  let pos = segments.length ? segments[0].contentStart : section.element.contentStart;
  let line = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line++;
  const out = [line];
  for (const seg of segments) {
    // Between two CDATA sections (TwinCAT splits `]]>` across them) the section text goes on.
    for (; pos < seg.contentStart; pos++) if (text.charCodeAt(pos) === 10) line++;
    for (; pos < seg.contentEnd; pos++) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        line++;
        out.push(line);
      } else if (c === 13 && text.charCodeAt(pos + 1) !== 10) {
        // A lone CR ends a line of the section (see normalizeEol), not one of git.
        out.push(line);
      }
    }
  }
  return out;
}

/** Object containing the given file offset (deepest member first). */
export function objectAtOffset(file: TcSourceFile, offset: number): TcObject | undefined {
  let best: TcObject | undefined;
  for (const obj of file.ordered) {
    if (offset >= obj.element.start && offset <= obj.element.end) {
      if (!best || obj.element.start >= best.element.start) best = obj;
    }
  }
  return best;
}

export function sectionAtOffset(file: TcSourceFile, offset: number): Section | undefined {
  for (const section of file.sections.values()) {
    const el = section.element;
    if (offset >= el.contentStart && offset <= el.contentEnd) return section;
  }
  return undefined;
}

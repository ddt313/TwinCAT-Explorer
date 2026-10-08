// Minimal XML scanner that keeps exact source offsets, so TwinCAT files can be
// edited by splicing CDATA ranges instead of re-serializing the document.

export interface CdataRange {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

export interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  /** Offset of the opening '<'. */
  start: number;
  /** Offset just after the closing '>' of the end tag (or of the self-closing tag). */
  end: number;
  /** Offset just after the start tag. Equals `end` for a self-closing element. */
  contentStart: number;
  /** Offset of the end tag. Equals `end` for a self-closing element. */
  contentEnd: number;
  selfClosing: boolean;
  children: XmlElement[];
  cdata: CdataRange[];
  parent?: XmlElement;
}

export class XmlError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function isNameChar(c: number): boolean {
  return !(c === 32 || c === 9 || c === 10 || c === 13 || c === 47 /* / */ || c === 62 /* > */ || c === 61 /* = */);
}

export function parseXml(text: string): XmlElement {
  const root: XmlElement = {
    name: '#document', attrs: new Map(), start: 0, end: text.length,
    contentStart: 0, contentEnd: text.length, selfClosing: false, children: [], cdata: [],
  };
  const stack: XmlElement[] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    const top = stack[stack.length - 1];
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close < 0) throw new XmlError('Unterminated CDATA', lt);
      top.cdata.push({ start: lt, end: close + 3, contentStart: lt + 9, contentEnd: close });
      i = close + 3;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) throw new XmlError('Unterminated comment', lt);
      i = close + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2);
      if (close < 0) throw new XmlError('Unterminated processing instruction', lt);
      i = close + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt + 2);
      if (close < 0) throw new XmlError('Unterminated declaration', lt);
      i = close + 1;
      continue;
    }
    if (text.charCodeAt(lt + 1) === 47 /* / */) {
      const gt = text.indexOf('>', lt);
      if (gt < 0) throw new XmlError('Unterminated end tag', lt);
      const name = text.slice(lt + 2, gt).trim();
      const el = stack.pop();
      if (!el || el === root || el.name !== name) {
        throw new XmlError(`Unexpected </${name}>`, lt);
      }
      el.contentEnd = lt;
      el.end = gt + 1;
      i = gt + 1;
      continue;
    }
    // Start tag.
    let j = lt + 1;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    const name = text.slice(lt + 1, j);
    const attrs = new Map<string, string>();
    let selfClosing = false;
    let gt = -1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13) { j++; continue; }
      if (c === 62 /* > */) { gt = j; break; }
      if (c === 47 /* / */ && text.charCodeAt(j + 1) === 62) { selfClosing = true; gt = j + 1; break; }
      const nameStart = j;
      while (j < n && isNameChar(text.charCodeAt(j))) j++;
      const attrName = text.slice(nameStart, j);
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '=') throw new XmlError(`Expected '=' after attribute ${attrName}`, j);
      j++;
      while (j < n && /\s/.test(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") throw new XmlError('Expected quoted attribute value', j);
      const valueEnd = text.indexOf(quote, j + 1);
      if (valueEnd < 0) throw new XmlError('Unterminated attribute value', j);
      attrs.set(attrName, decodeEntities(text.slice(j + 1, valueEnd)));
      j = valueEnd + 1;
    }
    if (gt < 0) throw new XmlError('Unterminated start tag', lt);
    const el: XmlElement = {
      name, attrs, start: lt, end: gt + 1, contentStart: gt + 1, contentEnd: gt + 1,
      selfClosing, children: [], cdata: [], parent: top,
    };
    top.children.push(el);
    if (!selfClosing) stack.push(el);
    i = gt + 1;
  }
  if (stack.length !== 1) {
    throw new XmlError(`Unclosed element <${stack[stack.length - 1].name}>`, stack[stack.length - 1].start);
  }
  return root;
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find(c => c.name === name);
}

export function children(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter(c => c.name === name) : [];
}

/** Concatenated content of the element's CDATA sections (TwinCAT splits `]]>` across sections). */
export function cdataText(text: string, el: XmlElement): string {
  return el.cdata.map(c => text.slice(c.contentStart, c.contentEnd)).join('');
}

/** Plain text content of a leaf element (entities decoded). */
export function elementText(text: string, el: XmlElement | undefined): string | undefined {
  if (!el) return undefined;
  if (el.selfClosing) return '';
  if (el.cdata.length > 0) return cdataText(text, el);
  return decodeEntities(text.slice(el.contentStart, el.contentEnd)).trim();
}

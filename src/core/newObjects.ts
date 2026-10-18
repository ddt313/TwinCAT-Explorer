// New TwinCAT objects as XAE 3.1.4026 makes them: the file of a POU (function block, program, function), a DUT
// (structure, enumeration, union, alias), a global variable list or an interface, with the XML header, line
// breaks and BOM of the other files of its PLC project.

import { SpliceError, escapeCdata, identifierProblem, newGuid } from './splice';
import { TcSourceFile, parseTcText, toEol } from './tcfile';

export type NewObjectKind = 'fb' | 'prg' | 'fun' | 'itf' | 'struct' | 'enum' | 'union' | 'alias' | 'gvl';

export interface NewObjectSpec {
  kind: NewObjectKind;
  name: string;
  /** Function block, structure: the one it extends. Interface: the interfaces it extends (`I_A, I_B`). */
  extends?: string;
  /** Function block: the interfaces it implements (`I_A, I_B`). */
  implements?: string;
  /** Function: its return type. Alias: the type it names. */
  type?: string;
}

/** What a new file takes from the other files of its PLC project. */
export interface FileStyle {
  bom: boolean;
  eol: '\r\n' | '\n';
  /** `<?xml version="1.0" encoding="utf-8"?>` */
  xmlDeclaration: string;
  /** `<TcPlcObject Version="1.1.0.1">`, with a ProductVersion in projects that write it. */
  plcObjectTag: string;
}

/** The files of a project XAE 3.1.4026 made: BOM, CRLF, no ProductVersion. */
export const XAE_FILE_STYLE: FileStyle = {
  bom: true, eol: '\r\n', xmlDeclaration: '<?xml version="1.0" encoding="utf-8"?>', plcObjectTag: '<TcPlcObject Version="1.1.0.1">',
};

/** The XML header, line breaks and BOM of a TwinCAT source file, or undefined when it has none to copy. */
export function fileStyleOf(file: TcSourceFile): FileStyle | undefined {
  const plcObject = file.root?.element.parent;
  const xmlDeclaration = /^<\?xml[^>]*\?>/.exec(file.text)?.[0];
  if (file.error || !plcObject || plcObject.name !== 'TcPlcObject' || !xmlDeclaration) return undefined;
  return { bom: file.bom, eol: file.eol, xmlDeclaration, plcObjectTag: file.text.slice(plcObject.start, plcObject.contentStart) };
}

const EXTENSIONS: Record<NewObjectKind, string> = {
  fb: '.TcPOU', prg: '.TcPOU', fun: '.TcPOU', itf: '.TcIO', struct: '.TcDUT', enum: '.TcDUT', union: '.TcDUT', alias: '.TcDUT', gvl: '.TcGVL',
};

const ELEMENTS: Record<NewObjectKind, string> = {
  fb: 'POU', prg: 'POU', fun: 'POU', itf: 'Itf', struct: 'DUT', enum: 'DUT', union: 'DUT', alias: 'DUT', gvl: 'GVL',
};

/** The extension of the file of a new object: .TcPOU, .TcIO, .TcDUT or .TcGVL. */
export function objectExtension(kind: NewObjectKind): string {
  return EXTENSIONS[kind];
}

function oneLine(text: string | undefined, what: string): string {
  const t = (text ?? '').trim();
  if (/[\r\n]/.test(t)) throw new SpliceError(`${what} must be on one line`);
  return t;
}

/**
 * The declaration XAE 3.1.4026 gives a new object through its Automation Interface (`FUNCTION F_X :INT` with no
 * space after the colon, as it writes it). XAE makes no alias that way: an alias gets its usual form,
 * `TYPE T_X : INT;` and `END_TYPE`.
 */
export function objectDeclaration(spec: NewObjectSpec): string {
  const problem = identifierProblem(spec.name);
  if (problem) throw new SpliceError(problem);
  const name = spec.name;
  const ext = oneLine(spec.extends, 'EXTENDS');
  const impl = oneLine(spec.implements, 'IMPLEMENTS');
  const type = oneLine(spec.type, 'The type');
  if ((spec.kind === 'fun' || spec.kind === 'alias') && !type) {
    throw new SpliceError(spec.kind === 'fun' ? `The function ${name} needs a return type` : `The alias ${name} needs a type`);
  }
  const extendsPart = ext ? ` EXTENDS ${ext}` : '';
  switch (spec.kind) {
    case 'fb': return `FUNCTION_BLOCK ${name}${extendsPart}${impl ? ` IMPLEMENTS ${impl}` : ''}\nVAR_INPUT\nEND_VAR\nVAR_OUTPUT\nEND_VAR\nVAR\nEND_VAR`;
    case 'prg': return `PROGRAM ${name}\nVAR\nEND_VAR`;
    case 'fun': return `FUNCTION ${name} :${type}\nVAR_INPUT\nEND_VAR\nVAR\nEND_VAR`;
    case 'itf': return `INTERFACE ${name}${extendsPart}\n`;
    case 'struct': return `TYPE ${name}${extendsPart}:\n\tSTRUCT\n\tEND_STRUCT\nEND_TYPE`;
    case 'enum': return `TYPE ${name} :\n(\n\tenum_member := 0\n);\nEND_TYPE\n`;
    case 'union': return `TYPE ${name}:\n\tUNION\n\tEND_UNION\nEND_TYPE`;
    case 'alias': return `TYPE ${name} : ${type};\nEND_TYPE`;
    case 'gvl': return 'VAR_GLOBAL\nEND_VAR';
  }
}

/**
 * The text of the file of a new object, as XAE 3.1.4026 writes it: a new GUID, the declaration, an empty
 * Structured Text implementation for a POU, two spaces per level, no line break at the end. The caller writes it
 * with the style's BOM (`encodeText(text, style.bom)`).
 */
export function newObjectText(spec: NewObjectSpec, style: FileStyle = XAE_FILE_STYLE, id: string = newGuid()): string {
  const tag = ELEMENTS[spec.kind];
  const pou = tag === 'POU';
  const cdata = (s: string) => `<![CDATA[${escapeCdata(toEol(s, style.eol))}]]>`;
  const text = [
    style.xmlDeclaration,
    style.plcObjectTag,
    `  <${tag} Name="${spec.name}" Id="${id}"${pou ? ' SpecialFunc="None"' : ''}>`,
    `    <Declaration>${cdata(objectDeclaration(spec))}</Declaration>`,
    ...(pou ? ['    <Implementation>', `      <ST>${cdata('')}</ST>`, '    </Implementation>'] : []),
    `  </${tag}>`,
    '</TcPlcObject>',
  ].join(style.eol);
  const check = parseTcText(`${spec.name}${EXTENSIONS[spec.kind]}`, text, style.bom);
  if (check.error || check.root?.name !== spec.name) throw new SpliceError(`${spec.name} could not be made: ${check.error ?? 'no object'}`);
  return text;
}

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { InstalledSymbols, readInstalledSymbols, readRepositories } from '../../src/core/libraries';
import { LibraryDeclaration, readLibraryDeclarations } from '../../src/core/libraryFile';
import { readZip } from '../../src/core/zip';
import { TcWorkspace } from '../../src/core/workspace';
import { analyze } from '../../src/lang/analyzer';
import { LanguageIndex } from '../../src/lang/index';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

/** A zip archive of these files: deflated, or stored for the names given. */
function zip(files: Record<string, Buffer>, stored: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const method = stored.includes(name) ? 0 : 8;
    const data = method ? zlib.deflateRawSync(content) : content;
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function leb128(n: number): number[] {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return out;
}

const ZERO = '00000000-0000-0000-0000-000000000000';
const TYPE = {
  pou: '6f9dac99-8de1-4efc-8465-68ac443b7d08', dut: '2db5746d-d284-4425-9f7f-2663a34b0ebc', itf: '6654496c-404d-479a-aad2-8551054e5f1e',
  gvl: 'ffbfa93a-b94d-45fc-a329-229860183b1d', folder: '738bea1e-99bb-4f04-90bb-a7a567e74e3a', method: 'f8a58466-d7f6-439f-bbb8-d4600e41d099',
  property: '5a3b8626-d3e9-4f37-98b5-66420063d91e', action: '8ac092e5-3128-4e26-9e7e-11016c6684f2', get: '792f2eb6-721e-4e64-ba20-bc98351056db',
};

interface Obj {
  id: string;
  parent?: string;
  name: string;
  type: string;
  /** Its texts as XAE keeps them: the implementation, then the declaration (or only one). */
  texts: string[];
}

/**
 * A source library as XAE saves one, made up: a zip with the string table, and a `.meta` (GUID, parent, name and type
 * as strings) and `.object` (texts as lines of that tag; between two texts `0D 0C <tag> 0F`) per object.
 */
function library(objects: Obj[], tag = 0x0b): Buffer {
  const strings: string[] = ['11c0fc3a-9bcf-4dd8-ac38-efb93363e521', ZERO];
  const s = (text: string) => {
    let i = strings.indexOf(text);
    if (i < 0) i = strings.push(text) - 1;
    return i;
  };
  const header = (length: number) => {
    const h = Buffer.alloc(20);
    h.set([0x02, 0x20, 0x09, 0x28]);
    h.writeUInt32LE(length, 16);
    return h;
  };
  const files: Record<string, Buffer> = {};
  let lineId = 2;
  for (const o of objects) {
    const meta = [15, 10, s(o.id), s(o.parent ?? ZERO), s(o.name), 1, 0, 0, s(o.type), 2, 83];
    const body = Buffer.from(meta.flatMap(leb128));
    files[`${o.id}.meta`] = Buffer.concat([header(body.length), body]);
    const bytes: number[] = [0x0f, 0x10, ...leb128(s('None')), 0x0f, 0x0c, 0x01, 0x0f];
    o.texts.forEach((text, i) => {
      if (i) bytes.push(0x0d, 0x0c, tag, 0x0f);
      for (const line of text.split('\n')) {
        const id = Buffer.alloc(8);
        id.writeUInt32LE(lineId++, 0);
        bytes.push(tag, ...id, 0x00, ...leb128(s(line)));
      }
    });
    bytes.push(0x5f, 0x00, 0x00);
    files[`${o.id}.object`] = Buffer.concat([header(bytes.length), Buffer.from(bytes)]);
  }
  const table = [0xff, 0x15, ...strings.flatMap((text, i) => {
    const b = Buffer.from(text, 'utf8');
    return [...leb128(i), ...leb128(b.length), ...b];
  })];
  return zip({ '__shared_data_storage_string_table__.auxiliary': Buffer.from(table), ...files }, ['profile.auxiliary']);
}

const guid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** SPT Base Types, cut down: FB_ComponentBase in a folder, its members, a function, an enum, a GVL, an interface. */
const BASE_TYPES: Obj[] = [
  { id: guid(1), name: 'Component Base', type: TYPE.folder, texts: [] },
  {
    id: guid(2), parent: guid(1), name: 'FB_ComponentBase', type: TYPE.pou, texts: ['', `// Basic framework of a component
FUNCTION_BLOCK ABSTRACT FB_ComponentBase EXTENDS FB_CyclicFB IMPLEMENTS I_ComponentBase
VAR
	_Busy : BOOL; // Busy flag
	_Name : STRING;
END_VAR`],
  },
  { id: guid(3), parent: guid(2), name: 'Reset', type: TYPE.method, texts: ['_Busy := FALSE;', '// Clears error flags\nMETHOD PUBLIC Reset : BOOL'] },
  { id: guid(4), parent: guid(2), name: 'Busy', type: TYPE.property, texts: ['PROPERTY Busy : BOOL'] },
  { id: guid(5), parent: guid(4), name: 'Get', type: TYPE.get, texts: ['Busy := _Busy;', 'VAR\nEND_VAR'] },
  { id: guid(6), parent: guid(2), name: 'A_Init', type: TYPE.action, texts: ['_Name := \'\';'] },
  { id: guid(7), name: 'FB_CyclicFB', type: TYPE.pou, texts: ['', 'FUNCTION_BLOCK FB_CyclicFB\nVAR\n\t_Error : BOOL;\nEND_VAR'] },
  { id: guid(8), name: 'F_GetVersion', type: TYPE.pou, texts: ['F_GetVersion.sVersion := \'3.9.0\';', '{attribute \'TcGenerated\'}\nFUNCTION F_GetVersion : ST_LibVersion\nVAR_INPUT\nEND_VAR'] },
  { id: guid(9), name: 'E_PMLUnitMode', type: TYPE.dut, texts: ['TYPE E_PMLUnitMode :\n(\n\tePMLUnitMode_Invalid := 0,\n\tePMLUnitMode_Production := 1\n);\nEND_TYPE'] },
  { id: guid(10), name: 'Parameters_BaseComponent', type: TYPE.gvl, texts: ['{attribute \'qualified_only\'}\nVAR_GLOBAL CONSTANT\n\tCOMPONENT_BASE_ALARM_COUNT : UINT := 2;\nEND_VAR'] },
  { id: guid(11), name: 'I_ComponentBase', type: TYPE.itf, texts: ['INTERFACE I_ComponentBase'] },
  { id: guid(12), parent: guid(11), name: 'Reset', type: TYPE.method, texts: ['METHOD Reset : BOOL'] },
  // No declaration among its texts: left out.
  { id: guid(13), name: 'FB_Broken', type: TYPE.pou, texts: ['x := 1;'] },
];

test('zip: stored and deflated files', () => {
  const entries = readZip(zip({ 'a.txt': Buffer.from('stored'), 'b/c.txt': Buffer.from('deflated '.repeat(20)) }, ['a.txt']));
  assert.deepEqual(entries.map(e => [e.name, e.read().toString()]), [['a.txt', 'stored'], ['b/c.txt', 'deflated '.repeat(20)]]);
  assert.throws(() => readZip(Buffer.from('not a zip')), /not a zip archive/);
});

test('the declarations of a source library: POUs with their methods, properties and actions, DUTs, GVLs, interfaces', () => {
  for (const tag of [0x0b, 0x0c]) {
    const read = readLibraryDeclarations(library(BASE_TYPES, tag));
    assert.deepEqual(read.map(d => `${d.kind} ${d.name}`), [
      'pou F_GetVersion', 'pou FB_ComponentBase', 'pou FB_CyclicFB', 'dut E_PMLUnitMode', 'interface I_ComponentBase', 'gvl Parameters_BaseComponent',
    ].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1])), `tag ${tag}`);
    const text = (name: string) => read.find(d => d.name === name)?.text;
    assert.equal(text('FB_ComponentBase'), `// Basic framework of a component
FUNCTION_BLOCK ABSTRACT FB_ComponentBase EXTENDS FB_CyclicFB IMPLEMENTS I_ComponentBase
VAR
	_Busy : BOOL; // Busy flag
	_Name : STRING;
END_VAR
ACTION A_Init
END_ACTION
PROPERTY Busy : BOOL
END_PROPERTY
// Clears error flags
METHOD PUBLIC Reset : BOOL
END_METHOD
END_FUNCTION_BLOCK`);
    assert.equal(text('F_GetVersion'), '{attribute \'TcGenerated\'}\nFUNCTION F_GetVersion : ST_LibVersion\nVAR_INPUT\nEND_VAR\nEND_FUNCTION');
    assert.equal(text('I_ComponentBase'), 'INTERFACE I_ComponentBase\nMETHOD Reset : BOOL\nEND_METHOD\nEND_INTERFACE');
    assert.equal(text('Parameters_BaseComponent'), BASE_TYPES[9].texts[0]);
  }
  assert.deepEqual(readLibraryDeclarations(zip({ 'other.txt': Buffer.from('x') })), [], 'no string table: no source library');
});

/** A workspace with a PLC project referencing SPT Base Types and SPT Components, with these POUs (declaration --- body). */
function project(root: string, pous: Record<string, string>): TcWorkspace {
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
  write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${Object.keys(pous).map(n => `<Compile Include="POUs\\${n}.TcPOU"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
  <ItemGroup>
    <PlaceholderReference Include="SPT Base Types">
      <DefaultResolution>SPT Base Types, * (Beckhoff Automation LLC)</DefaultResolution>
      <Namespace>SPT_BaseTypes</Namespace>
    </PlaceholderReference>
    <PlaceholderReference Include="SPT Components">
      <DefaultResolution>SPT Components, * (Beckhoff Automation LLC)</DefaultResolution>
      <Namespace>SPT_Components</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`);
  let id = 0;
  for (const [name, text] of Object.entries(pous)) {
    const [decl, impl] = text.split('\n---\n');
    write(`A/Plc/POUs/${name}.TcPOU`, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="{cccccccc-0000-0000-0000-${String(++id).padStart(12, '0')}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl ?? ''}]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`);
  }
  const ws = new TcWorkspace();
  ws.load([path.join(root, 'A/A.tsproj')]);
  return ws;
}

test('installed source libraries are declared from their files: inherited variables, enumeration values, GVLs, other libraries', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-libfile-'));
  try {
    // A repository with SPT Base Types (a source library) and SPT Components, whose function block extends Base Types'.
    const repository = path.join(base, 'Library Repository');
    const install = (title: string, file: string, bytes: Buffer) => {
      const dir = path.join(repository, 'Beckhoff Automation LLC', title, '3.9.0');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), bytes);
    };
    install('SPT Base Types', 'SPT_Base_Types.library', library(BASE_TYPES));
    install('SPT Components', 'SPT_Components.library', library([
      { id: guid(20), name: 'FB_Component_BasicAxis', type: TYPE.pou, texts: ['', 'FUNCTION_BLOCK FB_Component_BasicAxis EXTENDS FB_ComponentBase\nVAR_INPUT\n\tbEnable : BOOL;\nEND_VAR'] },
    ], 0x0c));
    const { libraries } = await readRepositories([repository]);
    const installed: InstalledSymbols[] = await readInstalledSymbols(libraries, [
      { title: 'SPT Base Types', version: '*', company: 'Beckhoff Automation LLC' },
      { title: 'SPT Components', version: '*', company: 'Beckhoff Automation LLC' },
    ]);
    assert.deepEqual(installed.map(l => [l.title, l.declarations.map((d: LibraryDeclaration) => d.name).join(' '), l.objects.length]), [
      ['SPT Base Types', 'E_PMLUnitMode F_GetVersion FB_ComponentBase FB_CyclicFB I_ComponentBase Parameters_BaseComponent', 0],
      ['SPT Components', 'FB_Component_BasicAxis', 0],
    ]);

    const ws = project(path.join(base, 'ws'), {
      FB_Component_Tray: `FUNCTION_BLOCK FB_Component_Tray EXTENDS FB_ComponentBase IMPLEMENTS I_ComponentBase
VAR
	eMode : E_PMLUnitMode := ePMLUnitMode_Production;
	nAlarms : UINT := Parameters_BaseComponent.COMPONENT_BASE_ALARM_COUNT;
END_VAR
---
IF NOT _Busy AND NOT _Error THEN
	Reset();
END_IF
bTrulyUnknown := TRUE;
nAlarms := COMPONENT_BASE_ALARM_COUNT;`,
      FB_Axis: `FUNCTION_BLOCK FB_Axis EXTENDS FB_Component_BasicAxis
---
IF bEnable AND NOT _Busy THEN
	_Name := 'axis';
END_IF`,
    });
    const idx = new LanguageIndex(ws);
    idx.setStubs(BUNDLED_STUBS);
    idx.setInstalledLibraries(installed);
    const problems = (name: string) => idx.allContexts().filter(c => c.object.name === name)
      .flatMap(c => analyze(idx, c, idx.sectionText(c.fileKey, c.sectionKey)!).problems.map(p => `${c.label}: ${p.message}`));
    // Known declarations: inherited variables are found, and what is unknown is reported again; the GVL is qualified only.
    assert.deepEqual(problems('FB_Component_Tray'), [
      "Implementation: Unknown identifier 'bTrulyUnknown'",
      "Implementation: Unknown identifier 'COMPONENT_BASE_ALARM_COUNT'",
    ]);
    // A function block of another library, extending SPT Base Types': its variables are inherited through it.
    assert.deepEqual(problems('FB_Axis'), []);

    const scope = idx.allContexts().find(c => c.object.name === 'FB_Axis')!.scope;
    const fb = idx.lookupGlobal(scope, 'FB_COMPONENTBASE')!;
    assert.equal(fb.namesOnly, undefined);
    assert.equal(fb.doc, 'Basic framework of a component');
    assert.equal(fb.kind === 'pou' && fb.members.map(m => `${m.kind} ${m.name}`).join(', '), 'action A_Init, property Busy, method Reset');
    assert.equal(fb.kind === 'pou' && fb.vars.map(v => `${v.name} : ${v.typeText}`).join(', '), '_Busy : BOOL, _Name : STRING');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

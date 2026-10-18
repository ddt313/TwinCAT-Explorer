import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NewObjectSpec, XAE_FILE_STYLE, fileStyleOf, newObjectText } from '../../src/core/newObjects';
import { PlcProjectEditError, addCompileItem, addFolderItem, parsePlcProject } from '../../src/core/project';
import { SpliceError } from '../../src/core/splice';
import { decodeBytes, encodeText, parseTcFile, parseTcText } from '../../src/core/tcfile';
import { TcWorkspace } from '../../src/core/workspace';
import { LanguageIndex } from '../../src/lang/index';
import { baseProblem, folderNameProblem, newObjectStubs, objectNameProblem } from '../../src/lang/objects';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

const ID = '{aaaaaaaa-0000-4000-8000-000000000001}';
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

/** The file XAE 3.1.4026 writes for a new object (here with LF; it writes CRLF and a BOM). */
function xaeFile(element: string, attrs: string, declaration: string, implementation: boolean, header = '<TcPlcObject Version="1.1.0.1">'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
${header}
  <${element} ${attrs}>
    <Declaration><![CDATA[${declaration}]]></Declaration>${implementation ? `
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>` : ''}
  </${element}>
</TcPlcObject>`;
}

test('a new object is the file XAE 3.1.4026 makes for it, with the line breaks of the project', () => {
  const pou = (name: string) => `Name="${name}" Id="${ID}" SpecialFunc="None"`;
  const other = (name: string) => `Name="${name}" Id="${ID}"`;
  const vars = '\nVAR_INPUT\nEND_VAR\nVAR_OUTPUT\nEND_VAR\nVAR\nEND_VAR';
  const cases: [NewObjectSpec, string, string, string, boolean, string][] = [
    [{ kind: 'fb', name: 'FB_Pump' }, 'POU', pou('FB_Pump'), `FUNCTION_BLOCK FB_Pump${vars}`, true, 'pou FB'],
    [{ kind: 'fb', name: 'FB_Pump', extends: ' FB_Base ', implements: 'I_Pump, I_Valve' }, 'POU', pou('FB_Pump'),
      `FUNCTION_BLOCK FB_Pump EXTENDS FB_Base IMPLEMENTS I_Pump, I_Valve${vars}`, true, 'pou FB'],
    [{ kind: 'prg', name: 'PRG_Cell' }, 'POU', pou('PRG_Cell'), 'PROGRAM PRG_Cell\nVAR\nEND_VAR', true, 'pou PRG'],
    [{ kind: 'fun', name: 'F_Scale', type: 'LREAL' }, 'POU', pou('F_Scale'), 'FUNCTION F_Scale :LREAL\nVAR_INPUT\nEND_VAR\nVAR\nEND_VAR', true, 'pou FUN'],
    [{ kind: 'itf', name: 'I_Pump' }, 'Itf', other('I_Pump'), 'INTERFACE I_Pump\n', false, 'itf'],
    [{ kind: 'itf', name: 'I_Pump', extends: 'I_Device, I_Valve' }, 'Itf', other('I_Pump'), 'INTERFACE I_Pump EXTENDS I_Device, I_Valve\n', false, 'itf'],
    [{ kind: 'struct', name: 'ST_Data' }, 'DUT', other('ST_Data'), 'TYPE ST_Data:\n\tSTRUCT\n\tEND_STRUCT\nEND_TYPE', false, 'dut struct'],
    [{ kind: 'struct', name: 'ST_Data', extends: 'ST_Base' }, 'DUT', other('ST_Data'), 'TYPE ST_Data EXTENDS ST_Base:\n\tSTRUCT\n\tEND_STRUCT\nEND_TYPE', false, 'dut struct'],
    [{ kind: 'enum', name: 'E_Mode' }, 'DUT', other('E_Mode'), 'TYPE E_Mode :\n(\n\tenum_member := 0\n);\nEND_TYPE\n', false, 'dut enum'],
    [{ kind: 'union', name: 'U_Raw' }, 'DUT', other('U_Raw'), 'TYPE U_Raw:\n\tUNION\n\tEND_UNION\nEND_TYPE', false, 'dut union'],
    [{ kind: 'alias', name: 'T_Count', type: 'UDINT' }, 'DUT', other('T_Count'), 'TYPE T_Count : UDINT;\nEND_TYPE', false, 'dut alias'],
    [{ kind: 'gvl', name: 'GVL_Cell' }, 'GVL', other('GVL_Cell'), 'VAR_GLOBAL\nEND_VAR', false, 'gvl'],
  ];
  const lf = { ...XAE_FILE_STYLE, eol: '\n' as const };
  for (const [spec, element, attrs, declaration, implementation, kind] of cases) {
    const expected = xaeFile(element, attrs, declaration, implementation);
    assert.equal(newObjectText(spec, lf, ID), expected, spec.name);
    assert.equal(newObjectText(spec, XAE_FILE_STYLE, ID), crlf(expected), `${spec.name} with CRLF`);
    const root = parseTcText(`${spec.name}.x`, expected).root!;
    assert.equal([root.kind, root.pouKind ?? root.dutKind].filter(k => k).join(' '), kind, spec.name);
  }
  assert.throws(() => newObjectText({ kind: 'fun', name: 'F_Scale' }), /needs a return type/);
  assert.throws(() => newObjectText({ kind: 'alias', name: 'T_Count', type: ' ' }), /needs a type/);
  assert.throws(() => newObjectText({ kind: 'fb', name: '1FB' }), SpliceError);
  assert.throws(() => newObjectText({ kind: 'fb', name: 'FB_Pump', extends: 'FB_A\nFB_B' }), /on one line/);
});

test('a new file takes the XML header, line breaks and BOM of a file of its project', () => {
  const header = '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">';
  const old = parseTcFile('FB_Old.TcPOU', encodeText(xaeFile('POU', `Name="FB_Old" Id="${ID}" SpecialFunc="None"`, 'FUNCTION_BLOCK FB_Old', true, header), false));
  const style = fileStyleOf(old)!;
  assert.deepEqual(style, { bom: false, eol: '\n', xmlDeclaration: '<?xml version="1.0" encoding="utf-8"?>', plcObjectTag: header });
  assert.equal(newObjectText({ kind: 'gvl', name: 'GVL_Cell' }, style, ID), xaeFile('GVL', `Name="GVL_Cell" Id="${ID}"`, 'VAR_GLOBAL\nEND_VAR', false, header));
  const withBom = parseTcFile('FB_Old.TcPOU', encodeText(crlf(xaeFile('POU', `Name="FB_Old" Id="${ID}" SpecialFunc="None"`, 'FUNCTION_BLOCK FB_Old', true)), true));
  assert.deepEqual(fileStyleOf(withBom), XAE_FILE_STYLE);
  assert.equal(fileStyleOf(parseTcText('Bad.TcPOU', '<TcPlcObject><POU')), undefined);
  assert.notEqual(newObjectText({ kind: 'gvl', name: 'GVL_A' }), newObjectText({ kind: 'gvl', name: 'GVL_A' }), 'a new GUID each time');
});

/** A .plcproj as XAE 3.1.4026 writes one, with these items. */
function plcproj(compile: string[], folders?: string[], eol = '\r\n'): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    '    <Name>Plc</Name>',
    '    <SubObjectsSortedByName>true</SubObjectsSortedByName>',
    '  </PropertyGroup>',
    ...(compile.length ? ['  <ItemGroup>', ...compile.flatMap(c => [`    <Compile Include="${c}">`, '      <SubType>Code</SubType>', '    </Compile>']), '  </ItemGroup>'] : []),
    ...(folders?.length ? ['  <ItemGroup>', ...folders.map(f => `    <Folder Include="${f}" />`), '  </ItemGroup>'] : []),
    '  <ItemGroup>',
    '    <PlaceholderReference Include="Tc2_Standard">',
    '      <DefaultResolution>Tc2_Standard, * (Beckhoff Automation GmbH)</DefaultResolution>',
    '      <Namespace>Tc2_Standard</Namespace>',
    '    </PlaceholderReference>',
    '  </ItemGroup>',
    '</Project>',
  ].join(eol);
}

test("a new file's <Compile> item goes where XAE puts it: case aside, character by character by code", () => {
  // The order TwinCAT 3.1.4026 wrote these items in, the files created in another order.
  const xae = ['Alpha\\FB_InAlpha.TcPOU', 'DUTs\\E_A.TcDUT', 'DUTs\\ST_A.TcDUT', 'FB_Root.TcPOU', 'GVLs\\GVL_A.TcGVL', 'PlcTask.TcTTO',
    'POUs\\FB2.TcPOU', 'POUs\\FBB.TcPOU', 'POUs\\FB_A.TcPOU', 'POUs\\FB_Impl.TcPOU', 'POUs\\FB_Impl2.TcPOU', 'POUs\\fb_low.TcPOU',
    'POUs\\F_A.TcPOU', 'POUs\\I_A.TcIO', 'POUs\\MAIN.TcPOU', 'POUs\\Sub\\Deep\\FB_D.TcPOU', 'POUs\\Sub\\FB_C.TcPOU', 'POUs\\Sub_X.TcPOU'];
  const folders = ['DUTs', 'GVLs', 'VISUs', 'POUs'];
  for (const eol of ['\r\n', '\n']) {
    for (let i = 0; i < xae.length; i++) {
      const others = xae.filter((_, j) => j !== i);
      assert.equal(addCompileItem(plcproj(others, folders, eol), xae[i]), plcproj(xae, folders, eol), xae[i]);
    }
  }
});

test('a new folder goes before the first folder after it, as XAE adds one to the unsorted folders of its template', () => {
  let text = plcproj(['POUs\\MAIN.TcPOU'], ['DUTs', 'GVLs', 'VISUs', 'POUs']);
  for (const folder of ['Alpha', 'POUs\\Sub', 'POUs\\Sub\\Deep', 'Zeta']) text = addFolderItem(text, folder);
  assert.equal(text, plcproj(['POUs\\MAIN.TcPOU'], ['Alpha', 'DUTs', 'GVLs', 'POUs\\Sub', 'POUs\\Sub\\Deep', 'VISUs', 'POUs', 'Zeta']));
  assert.deepEqual(parsePlcProject('Plc.plcproj', text).folders, ['Alpha', 'DUTs', 'GVLs', 'POUs\\Sub', 'POUs\\Sub\\Deep', 'VISUs', 'POUs', 'Zeta']);
});

test('a project without items of the kind gets an ItemGroup for them: the files first, then the folders', () => {
  assert.equal(addCompileItem(plcproj([], ['POUs']), 'POUs\\MAIN.TcPOU'), plcproj(['POUs\\MAIN.TcPOU'], ['POUs']));
  assert.equal(addFolderItem(plcproj(['MAIN.TcPOU']), 'POUs'), plcproj(['MAIN.TcPOU'], ['POUs']));
  assert.equal(addCompileItem(plcproj([]), 'MAIN.TcPOU'), plcproj(['MAIN.TcPOU']));
  assert.equal(addFolderItem(plcproj([], [], '\n'), 'POUs'), plcproj([], ['POUs'], '\n'));
});

test('the rest of the .plcproj stays byte for byte, its BOM too; an item already there is refused', () => {
  const before = plcproj(['POUs\\MAIN.TcPOU'], ['POUs']);
  const { text, bom } = decodeBytes(encodeText(before, true));
  assert.equal(bom, true);
  const after = addCompileItem(text, 'POUs\\FB_Pump.TcPOU');
  const added = '    <Compile Include="POUs\\FB_Pump.TcPOU">\r\n      <SubType>Code</SubType>\r\n    </Compile>\r\n';
  assert.equal(after.replace(added, ''), before);
  assert.deepEqual([...encodeText(after, bom).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.throws(() => addCompileItem(before, 'pous\\main.tcpou'), PlcProjectEditError);
  assert.throws(() => addFolderItem(before, 'pous'), PlcProjectEditError);
  assert.throws(() => addCompileItem('<Nothing/>', 'X.TcPOU'), PlcProjectEditError);
  // Names are escaped in the XML and read back as they are.
  const amp = addFolderItem(before, 'Valves & Pumps');
  assert.match(amp, /<Folder Include="Valves &amp; Pumps" \/>/);
  assert.deepEqual(parsePlcProject('Plc.plcproj', amp).folders, ['POUs', 'Valves & Pumps']);
});

test('names of new objects and folders; the base types and interfaces typed in; the members of the interfaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-objects-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const plcFile = (name: string, files: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>${name}</Name></PropertyGroup>
  <ItemGroup>${files.map(f => `<Compile Include="${f}"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
  <ItemGroup><Folder Include="POUs" /><Folder Include="POUs\\Sub" /></ItemGroup>
</Project>`;
  const member = (tag: string, name: string, n: number, decl: string, inner = '') => `
    <${tag} Name="${name}" Id="{dddddddd-0000-0000-0000-00000000000${n}}">
      <Declaration><![CDATA[${decl}]]></Declaration>${inner}
    </${tag}>`;
  const get = '\n      <Get Name="Get" Id="{dddddddd-0000-0000-0000-000000000009}">\n        <Declaration><![CDATA[VAR\nEND_VAR]]></Declaration>\n      </Get>';
  const file = (element: string, name: string, n: number, decl: string, members = '') => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <${element} Name="${name}" Id="{cccccccc-0000-0000-0000-00000000000${n}}">
    <Declaration><![CDATA[${decl}]]></Declaration>${members}
  </${element}>
</TcPlcObject>`;
  try {
    write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/><Project Name="Other" PrjFilePath="Other\\Other.plcproj"/></Plc></Project></TcSmProject>`);
    write('A/Plc/Plc.plcproj', plcFile('Plc', ['POUs\\FB_Base.TcPOU', 'POUs\\I_Device.TcIO', 'POUs\\I_Pump.TcIO', 'DUTs\\ST_Base.TcDUT', 'GVLs\\GVL_Main.TcGVL', 'POUs\\Sub\\FB_Deep.TcPOU']));
    write('A/Plc/POUs/FB_Base.TcPOU', file('POU', 'FB_Base', 1, 'FUNCTION_BLOCK FB_Base', member('Method', 'M_Reset', 1, 'METHOD M_Reset : BOOL')));
    write('A/Plc/POUs/I_Device.TcIO', file('Itf', 'I_Device', 2, 'INTERFACE I_Device\n',
      member('Method', 'M_Reset', 2, 'METHOD M_Reset : BOOL\nVAR_INPUT\nEND_VAR') + member('Property', 'P_Label', 3, 'PROPERTY P_Label : STRING', get)));
    write('A/Plc/POUs/I_Pump.TcIO', file('Itf', 'I_Pump', 3, 'INTERFACE I_Pump EXTENDS I_Device\n',
      member('Method', 'M_Start', 4, 'METHOD M_Start : BOOL\nVAR_INPUT\n\tfSpeed : LREAL;\nEND_VAR')));
    write('A/Plc/DUTs/ST_Base.TcDUT', file('DUT', 'ST_Base', 4, 'TYPE ST_Base:\n\tSTRUCT\n\tEND_STRUCT\nEND_TYPE'));
    write('A/Plc/GVLs/GVL_Main.TcGVL', file('GVL', 'GVL_Main', 5, 'VAR_GLOBAL\nEND_VAR'));
    write('A/Plc/POUs/Sub/FB_Deep.TcPOU', file('POU', 'FB_Deep', 6, 'FUNCTION_BLOCK FB_Deep'));
    write('A/Other/Other.plcproj', plcFile('Other', ['POUs\\FB_Other.TcPOU']));
    write('A/Other/POUs/FB_Other.TcPOU', file('POU', 'FB_Other', 7, 'FUNCTION_BLOCK FB_Other'));
    const ws = new TcWorkspace();
    ws.load([path.join(root, 'A/A.tsproj')]);
    const index = new LanguageIndex(ws);
    index.setStubs(BUNDLED_STUBS);
    const plc = ws.plcProjects.find(p => p.name === 'Plc')!;

    // POUs, DUTs, GVLs and interfaces share one namespace per PLC project, case aside.
    assert.equal(objectNameProblem(ws, plc, 'fb_base'), 'Plc already has a POU named FB_Base');
    assert.equal(objectNameProblem(ws, plc, 'ST_BASE'), 'Plc already has a DUT named ST_Base');
    assert.equal(objectNameProblem(ws, plc, 'GVL_main'), 'Plc already has a GVL named GVL_Main');
    assert.equal(objectNameProblem(ws, plc, 'i_pump'), 'Plc already has an interface named I_Pump');
    assert.equal(objectNameProblem(ws, plc, 'FB_Deep'), 'Plc already has a POU named FB_Deep');
    assert.equal(objectNameProblem(ws, plc, 'FB_Other'), undefined, 'another PLC project');
    assert.equal(objectNameProblem(ws, plc, 'IF'), 'IF is a keyword');
    assert.match(objectNameProblem(ws, plc, '2FB') ?? '', /not an identifier/);

    assert.equal(folderNameProblem(plc, 'POUs', 'Valves'), undefined);
    assert.equal(folderNameProblem(plc, '', 'pous'), 'Plc already has the folder pous');
    assert.equal(folderNameProblem(plc, 'POUs', 'SUB'), 'Plc already has the folder POUs\\SUB');
    assert.equal(folderNameProblem(plc, '', 'GVLs'), 'Plc already has the folder GVLs', 'the folder of a file');
    for (const bad of ['', 'A/B', 'A\\B', 'A:B', 'Ends.', 'Ends ', 'CON', 'lpt1.txt']) assert.ok(folderNameProblem(plc, '', bad), bad);

    assert.equal(baseProblem(index, plc, ' FB_Base ', 'FB', false), undefined);
    assert.deepEqual(baseProblem(index, plc, 'FB_Missing', 'FB', false), { message: 'No function block FB_Missing in Plc or its library stubs', blocking: false });
    assert.equal(baseProblem(index, plc, 'FB_Base, FB_Deep', 'FB', false)?.blocking, true, 'one base only');
    assert.equal(baseProblem(index, plc, 'I_Pump, I_Device', 'ITF', true), undefined);
    assert.equal(baseProblem(index, plc, 'I_Pump, FB_Base', 'ITF', true)?.message, 'No interface FB_Base in Plc or its library stubs');
    assert.equal(baseProblem(index, plc, '1abc', 'ITF', true)?.blocking, true);
    assert.equal(baseProblem(index, plc, 'ST_Base', 'struct', false), undefined);
    assert.equal(baseProblem(index, plc, 'FB_Base', 'struct', false)?.blocking, false);
    assert.equal(baseProblem(index, plc, '', 'FB', false), undefined);

    // A new function block gets the members of its interfaces, less those of the function block it extends.
    const found = newObjectStubs(index, plc, { kind: 'fb', name: 'FB_New', extends: 'FB_Base', implements: 'I_Pump' });
    assert.deepEqual(found.stubs.map(s => `${s.from}.${s.spec.name}`), ['I_Pump.M_Start', 'I_Device.P_Label']);
    assert.deepEqual(found.interfaces, ['I_Pump', 'I_Device']);
    assert.deepEqual(newObjectStubs(index, plc, { kind: 'fb', name: 'FB_New', implements: 'I_Missing' }).missing, ['I_Missing']);
    assert.deepEqual(newObjectStubs(index, plc, { kind: 'prg', name: 'PRG_New' }).stubs, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

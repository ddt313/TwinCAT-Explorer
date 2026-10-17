import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeText, parseTcFile, parseTcText } from '../../src/core/tcfile';
import { MemberSpec, SpliceError, addMember, removeMember } from '../../src/core/splice';
import { viewChanges } from '../../src/core/objectChanges';
import { TcWorkspace } from '../../src/core/workspace';
import { LanguageIndex } from '../../src/lang/index';
import { interfaceStubs, newMemberNameProblem, typeProblem } from '../../src/lang/members';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

const FB = '{11111111-1111-1111-1111-111111111111}';
const ITF = '{12121212-1212-1212-1212-121212121212}';
const RUN = '{22222222-2222-2222-2222-222222222222}';
const STOP = '{33333333-3333-3333-3333-333333333333}';
const PROP = '{44444444-4444-4444-4444-444444444444}';
const GET = '{55555555-5555-5555-5555-555555555555}';
const A = '{aaaaaaaa-0000-4000-8000-000000000001}';
const B = '{aaaaaaaa-0000-4000-8000-000000000002}';
const C = '{aaaaaaaa-0000-4000-8000-000000000003}';
const id = (guid: string) => guid.replace(/[{}]/g, '');

/** Ids handed out in order, so that the expected XML can be written down. */
function ids(...guids: string[]): () => string {
  let i = 0;
  return () => guids[i++] ?? assert.fail('more ids asked for than expected');
}

const method = (guid: string, name: string, type?: string) => `
    <Method Name="${name}" Id="${guid}">
      <Declaration><![CDATA[METHOD ${name}${type ? ` : ${type}` : ''}
VAR_INPUT
END_VAR
]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>`;

const property = (guid: string, name: string, type: string, accessors: [string, string][]) => `
    <Property Name="${name}" Id="${guid}">
      <Declaration><![CDATA[PROPERTY ${name} : ${type}]]></Declaration>${accessors.map(([acc, g]) => `
      <${acc} Name="${acc}" Id="${g}">
        <Declaration><![CDATA[VAR
END_VAR
]]></Declaration>
        <Implementation>
          <ST><![CDATA[]]></ST>
        </Implementation>
      </${acc}>`).join('')}
    </Property>`;

const action = (guid: string, name: string) => `
    <Action Name="${name}" Id="${guid}">
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Action>`;

const LINE_IDS = `
    <LineIds Name="FB_Pump">
      <LineId Id="9" Count="0" />
    </LineIds>`;

/** A function block as XAE writes it, with the given members and LineIds. */
function pou(members = '', lineIds = '', header = 'FUNCTION_BLOCK FB_Pump'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
  <POU Name="FB_Pump" Id="${FB}" SpecialFunc="None">
    <Declaration><![CDATA[${header}
VAR
	bRun : BOOL;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[bRun := TRUE;]]></ST>
    </Implementation>${members}${lineIds}
  </POU>
</TcPlcObject>`;
}

function itf(members = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
  <Itf Name="I_Pump" Id="${ITF}">
    <Declaration><![CDATA[INTERFACE I_Pump
]]></Declaration>${members}
  </Itf>
</TcPlcObject>`;
}

const parse = (text: string, file = 'FB_Pump.TcPOU') => parseTcText(file, text);
const add = (text: string, spec: MemberSpec, ...guids: string[]) => addMember(parse(text), id(FB), spec, ids(...guids));

test('a method goes after the implementation of a POU without members, before its LineIds', () => {
  const start: MemberSpec = { kind: 'method', name: 'Start', type: 'BOOL' };
  assert.equal(add(pou(), start, A), pou(method(A, 'Start', 'BOOL')));
  assert.equal(add(pou('', LINE_IDS), start, A), pou(method(A, 'Start', 'BOOL'), LINE_IDS));
  // Without a return type, and with the type as typed (spaces around it dropped).
  assert.equal(add(pou(), { kind: 'method', name: 'Start', type: ' ' }, A), pou(method(A, 'Start')));
  assert.equal(add(pou(), { kind: 'method', name: 'Start', type: ' POINTER TO INT ' }, A), pou(method(A, 'Start', 'POINTER TO INT')));
  // The Changes view sees it as a new method, which Discard Changes removes again.
  const out = add(pou(), start, A);
  assert.deepEqual(viewChanges(parse(pou()), parse(out)).map(v => `${v.label} ${v.change}`), ['FB_Pump.Start added']);
  assert.equal(removeMember(parse(out), id(A)), pou());
});

test('members in name order get the new one at its place, other members get it last', () => {
  const two = method(RUN, 'Run') + method(STOP, 'Stop');
  assert.equal(add(pou(two, LINE_IDS), { kind: 'method', name: 'Pause' }, A), pou(method(A, 'Pause') + two, LINE_IDS));
  assert.equal(add(pou(two), { kind: 'method', name: 'sleep' }, A), pou(method(RUN, 'Run') + method(A, 'sleep') + method(STOP, 'Stop')));
  assert.equal(add(pou(two, LINE_IDS), { kind: 'action', name: 'Zero' }, A), pou(two + action(A, 'Zero'), LINE_IDS));
  // A property after the methods: not in name order.
  const unsorted = two + property(PROP, 'Count', 'INT', [['Get', GET]]);
  assert.equal(add(pou(unsorted), { kind: 'action', name: 'Pause' }, A), pou(unsorted + action(A, 'Pause')));
});

test('a property gets a Get and a Set, each with an id of its own, or the one asked for', () => {
  const both = add(pou(), { kind: 'property', name: 'Speed', type: 'LREAL' }, A, B, C);
  assert.equal(both, pou(property(A, 'Speed', 'LREAL', [['Get', B], ['Set', C]])));
  const speed = parse(both).objects.get(id(A))!;
  assert.deepEqual(speed.accessors.map(a => `${a.kind} ${a.id}`), [`Get ${id(B)}`, `Set ${id(C)}`]);
  assert.deepEqual(speed.sections.map(s => s.label),
    ['Declaration', 'Get · Declaration', 'Get · Implementation', 'Set · Declaration', 'Set · Implementation']);
  assert.equal(add(pou(), { kind: 'property', name: 'Speed', type: 'LREAL', accessors: ['Get'] }, A, B),
    pou(property(A, 'Speed', 'LREAL', [['Get', B]])));
  assert.equal(add(pou(), { kind: 'property', name: 'Speed', type: 'LREAL', accessors: ['Set'] }, A, B),
    pou(property(A, 'Speed', 'LREAL', [['Set', B]])));
  assert.throws(() => add(pou(), { kind: 'property', name: 'Speed' }, A, B, C), SpliceError, 'a property has a type');
  assert.throws(() => add(pou(), { kind: 'property', name: 'Speed', type: 'LREAL', accessors: [] }, A), SpliceError);
});

test('CRLF and the BOM stay, and removing the new member gives back the file', () => {
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');
  const text = crlf(pou(method(RUN, 'Run'), LINE_IDS));
  const file = parseTcFile('FB_Pump.TcPOU', encodeText(text, true));
  assert.equal(file.bom, true);
  assert.equal(file.eol, '\r\n');
  const out = addMember(file, id(FB), { kind: 'property', name: 'Speed', type: 'LREAL' }, ids(A, B, C));
  assert.equal(out, crlf(pou(method(RUN, 'Run') + property(A, 'Speed', 'LREAL', [['Get', B], ['Set', C]]), LINE_IDS)));
  assert.doesNotMatch(out, /[^\r]\n/, 'no LF without CR, also inside the new CDATA');
  assert.deepEqual([...encodeText(out, file.bom).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(removeMember(parseTcText(file.path, out, true), id(A)), text);
  // LF files stay LF.
  assert.doesNotMatch(add(pou(), { kind: 'action', name: 'Reset' }, A), /\r/);
});

test('an interface gets methods and properties without implementations, and no actions', () => {
  const file = parse(itf(), 'I_Pump.TcIO');
  const withMethod = addMember(file, id(ITF), { kind: 'method', name: 'Start', type: 'BOOL' }, ids(A));
  assert.equal(withMethod, itf(`
    <Method Name="Start" Id="${A}">
      <Declaration><![CDATA[METHOD Start : BOOL
VAR_INPUT
END_VAR
]]></Declaration>
    </Method>`));
  // Speed comes before Start in name order.
  const withProperty = addMember(parse(withMethod, 'I_Pump.TcIO'), id(ITF), { kind: 'property', name: 'Speed', type: 'LREAL', accessors: ['Get'] }, ids(B, C));
  assert.equal(withProperty, itf(`
    <Property Name="Speed" Id="${B}">
      <Declaration><![CDATA[PROPERTY Speed : LREAL]]></Declaration>
      <Get Name="Get" Id="${C}">
        <Declaration><![CDATA[]]></Declaration>
      </Get>
    </Property>
    <Method Name="Start" Id="${A}">
      <Declaration><![CDATA[METHOD Start : BOOL
VAR_INPUT
END_VAR
]]></Declaration>
    </Method>`));
  assert.deepEqual(parse(withProperty, 'I_Pump.TcIO').root!.members.map(m => `${m.kind} ${m.name}`), ['property Speed', 'method Start']);
  assert.throws(() => addMember(file, id(ITF), { kind: 'action', name: 'Reset' }, ids(A)), SpliceError);
});

test('a new member needs an identifier not taken yet (case aside), in a function block, program or interface', () => {
  const text = pou(method(RUN, 'Run'));
  assert.throws(() => add(text, { kind: 'method', name: 'RUN' }, A), /already has a method named Run/);
  assert.throws(() => add(text, { kind: 'action', name: 'run' }, A), /already has a method named Run/);
  for (const name of ['', '2Run', 'Run Fast', 'Run"', 'Läuft']) {
    assert.throws(() => add(text, { kind: 'method', name }, A), SpliceError, name);
  }
  assert.throws(() => add(pou('', '', 'FUNCTION F_Pump : BOOL'), { kind: 'method', name: 'Start' }, A), /not a function block or a program/);
  assert.equal(parse(add(pou('', '', 'PROGRAM FB_Pump'), { kind: 'action', name: 'Reset' }, A)).objects.get(id(A))?.kind, 'action');
  assert.throws(() => addMember(parse(text), id(RUN), { kind: 'method', name: 'Start' }, ids(A)), /added to a POU or an interface/);
  // A declaration given instead of the template declares that member.
  assert.throws(() => add(text, { kind: 'method', name: 'Start', declaration: 'METHOD Stop : BOOL' }, A), SpliceError);
  assert.throws(() => add(text, { kind: 'method', name: 'Start', declaration: 'PROPERTY Start : BOOL' }, A), SpliceError);

  const owner = parse(text).root!;
  assert.equal(newMemberNameProblem(owner, 'Start'), undefined);
  assert.equal(newMemberNameProblem(owner, 'FB_init'), undefined);
  assert.equal(newMemberNameProblem(owner, 'run'), 'FB_Pump already has a method named Run');
  assert.equal(newMemberNameProblem(owner, 'IF'), 'IF is a keyword');
  assert.equal(newMemberNameProblem(owner, 'Bool'), 'Bool is a keyword');
  assert.equal(typeProblem('BOOL'), undefined);
  assert.equal(typeProblem(' ARRAY[0..9] OF POINTER TO ST_Pump '), undefined);
  assert.equal(typeProblem('STRING(80)'), undefined);
  assert.equal(typeProblem('REFERENCE TO I_Pump'), undefined);
  assert.equal(typeProblem(''), 'Enter a type');
  for (const bad of ['INT INT', 'INT := 5', 'POINTER INT', 'IF']) assert.ok(typeProblem(bad), bad);
});

test('the indentation of the file, a folder of the POU, and the methods TwinCAT calls by itself', () => {
  const tabs = (s: string) => s.replace(/^(?: {2})+/gm, m => '\t'.repeat(m.length / 2));
  assert.equal(add(tabs(pou()), { kind: 'method', name: 'Start', type: 'BOOL' }, A), tabs(pou(method(A, 'Start', 'BOOL'))));

  const inFolder = add(pou(), { kind: 'method', name: 'OnEnter', folderPath: ['Methods', 'States'] }, A);
  assert.match(inFolder, new RegExp(`<Method Name="OnEnter" Id="\\${A}" FolderPath="Methods\\\\States\\\\">`));
  assert.deepEqual(parse(inFolder).objects.get(id(A))?.folderPath, ['Methods', 'States']);

  const init = parse(add(pou(), { kind: 'method', name: 'FB_init', type: 'INT' }, A)).sections.get(`${id(A)}:decl`)!.text;
  assert.match(init, /^METHOD FB_init : BOOL\nVAR_INPUT\n\tbInitRetains : BOOL;.*\n\tbInCopyCode : BOOL;.*\nEND_VAR\n$/);
  const exit = parse(add(pou(), { kind: 'method', name: 'FB_exit' }, A)).sections.get(`${id(A)}:decl`)!.text;
  assert.match(exit, /^METHOD FB_exit : BOOL\nVAR_INPUT\n\tbInCopyCode : BOOL;.*\nEND_VAR\n$/);
  // Only a function block has them.
  assert.equal(parse(add(pou('', '', 'PROGRAM FB_Pump'), { kind: 'method', name: 'FB_init' }, A)).sections.get(`${id(A)}:decl`)!.text,
    'METHOD FB_init\nVAR_INPUT\nEND_VAR\n');
});

test('Implement Interfaces: what the function block and the ones it extends lack, declared like in the interface', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-members-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const object = (tag: 'POU' | 'Itf', name: string, guid: string, decl: string, members = '') => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
  <${tag} Name="${name}" Id="{${guid}}">
    <Declaration><![CDATA[${decl}]]></Declaration>${tag === 'POU' ? `
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>` : ''}${members}
  </${tag}>
</TcPlcObject>`;
  const itfMethod = (name: string, guid: string, decl: string) => `
    <Method Name="${name}" Id="{${guid}}">
      <Declaration><![CDATA[${decl}]]></Declaration>
    </Method>`;
  const itfProperty = (name: string, type: string, guid: string, accessors: string[]) => `
    <Property Name="${name}" Id="{${guid}}">
      <Declaration><![CDATA[PROPERTY ${name} : ${type}]]></Declaration>${accessors.map((a, i) => `
      <${a} Name="${a}" Id="{${guid.slice(0, -1)}${i + 1}}">
        <Declaration><![CDATA[]]></Declaration>
      </${a}>`).join('')}
    </Property>`;
  const files = ['I_Device.TcIO', 'I_Pump.TcIO', 'FB_Base.TcPOU', 'FB_Pump.TcPOU', 'FB_Module.TcPOU'];
  try {
    write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
    write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${files.map(f => `<Compile Include="POUs\\${f}"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
</Project>`);
    const resetDecl = 'METHOD Reset : BOOL\nVAR_INPUT\n\tbForce : BOOL; // also when busy\nEND_VAR\n';
    const startDecl = '// Starts the pump\nMETHOD Start : BOOL\nVAR_INPUT\n\tfSpeed : LREAL;\nEND_VAR\n';
    write('A/Plc/POUs/I_Device.TcIO', object('Itf', 'I_Device', 'dddddddd-0000-0000-0000-000000000001', 'INTERFACE I_Device\n',
      itfMethod('Reset', 'dddddddd-0000-0000-0000-000000000002', resetDecl)
      + itfProperty('Label', 'STRING', 'dddddddd-0000-0000-0000-000000000030', ['Get'])));
    write('A/Plc/POUs/I_Pump.TcIO', object('Itf', 'I_Pump', 'eeeeeeee-0000-0000-0000-000000000001', 'INTERFACE I_Pump EXTENDS I_Device\n',
      itfMethod('Start', 'eeeeeeee-0000-0000-0000-000000000002', startDecl)
      + itfMethod('Stop', 'eeeeeeee-0000-0000-0000-000000000003', 'METHOD Stop : BOOL\n')
      + itfProperty('Speed', 'LREAL', 'eeeeeeee-0000-0000-0000-000000000040', ['Get', 'Set'])));
    write('A/Plc/POUs/FB_Base.TcPOU', object('POU', 'FB_Base', 'bbbbbbbb-0000-0000-0000-000000000001', 'FUNCTION_BLOCK FB_Base\n',
      method('{bbbbbbbb-0000-0000-0000-000000000002}', 'Reset', 'BOOL')));
    write('A/Plc/POUs/FB_Pump.TcPOU', object('POU', 'FB_Pump', 'cccccccc-0000-0000-0000-000000000001',
      'FUNCTION_BLOCK FB_Pump EXTENDS FB_Base IMPLEMENTS I_Pump, I_Missing\n', method('{cccccccc-0000-0000-0000-000000000002}', 'Start', 'BOOL')));
    write('A/Plc/POUs/FB_Module.TcPOU', object('POU', 'FB_Module', 'ffffffff-0000-0000-0000-000000000001',
      'FUNCTION_BLOCK FB_Module IMPLEMENTS ITcUnknown\n'));
    const w = new TcWorkspace();
    w.load([path.join(root, 'A/A.tsproj')]);
    const idx = new LanguageIndex(w);
    idx.setStubs(BUNDLED_STUBS);

    const pumpPath = path.join(root, 'A/Plc/POUs/FB_Pump.TcPOU');
    const pump = w.getFile(pumpPath)!;
    const { stubs, interfaces, missing } = interfaceStubs(idx, pump);
    // Start is there, Reset comes from FB_Base.
    assert.deepEqual(stubs.map(s => `${s.from}.${s.spec.name}`), ['I_Pump.Stop', 'I_Pump.Speed', 'I_Device.Label']);
    assert.deepEqual(interfaces, ['I_Pump', 'I_Device']);
    assert.deepEqual(missing, ['I_Missing']);
    assert.deepEqual(stubs.map(s => [s.spec.kind, s.spec.declaration, s.spec.accessors]), [
      ['method', 'METHOD Stop : BOOL\n', undefined],
      ['property', 'PROPERTY Speed : LREAL', ['Get', 'Set']],
      ['property', 'PROPERTY Label : STRING', ['Get']],
    ]);
    let text = pump.text;
    for (const s of stubs) text = addMember(parseTcText(pumpPath, text), pump.root!.id, s.spec);
    const done = parseTcText(pumpPath, text);
    assert.deepEqual(done.root!.members.map(m => `${m.kind} ${m.name} ${m.accessors.map(a => a.kind).join('/')}`),
      ['property Label Get', 'property Speed Get/Set', 'method Start ', 'method Stop ']);
    // Written back, nothing is left to implement.
    fs.writeFileSync(pumpPath, text);
    w.invalidate(pumpPath);
    idx.invalidateFile(pumpPath);
    assert.deepEqual(interfaceStubs(idx, w.getFile(pumpPath)!).stubs, []);

    // A library interface: the declarations come from the stub.
    const module = interfaceStubs(idx, w.getFile(path.join(root, 'A/Plc/POUs/FB_Module.TcPOU'))!);
    assert.deepEqual(module.missing, []);
    assert.deepEqual(module.stubs.map(s => s.spec.declaration), [
      'METHOD TcAddRef : UDINT\nVAR_INPUT\nEND_VAR\n',
      'METHOD TcRelease : UDINT\nVAR_INPUT\nEND_VAR\n',
      'METHOD TcQueryInterface : HRESULT\nVAR_INPUT\n\tiid : REFERENCE TO GUID;\n\tpipItf : POINTER TO PVOID;\nEND_VAR\n',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

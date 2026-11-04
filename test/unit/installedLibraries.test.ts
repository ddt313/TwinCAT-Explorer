import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InstalledSymbols, parseBrowserCache, readInstalledSymbols, readRepositories } from '../../src/core/libraries';
import { TcWorkspace } from '../../src/core/workspace';
import { analyze } from '../../src/lang/analyzer';
import { LanguageIndex } from '../../src/lang/index';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

const SPT = 'Beckhoff Automation LLC';
const POU = '{6f9dac99-8de1-4efc-8465-68ac443b7d08}';
const DUT = '{2db5746d-d284-4425-9f7f-2663a34b0ebc}';
const ITF = '{6654496c-404d-479a-aad2-8551054e5f1e}';
const GVL = '{ffbfa93a-b94d-45fc-a329-229860183b1d}';
const FOLDER = '{738bea1e-99bb-4f04-90bb-a7a567e74e3a}';
const METHOD = '{f8a58466-d7f6-439f-bbb8-d4600e41d099}';
const ITF_METHOD = '{f89f7675-27f1-46b3-8abb-b7da8e774ffd}';
const PROPERTY = '{5a3b8626-d3e9-4f37-98b5-66420063d91e}';
const GET = '{792f2eb6-721e-4e64-ba20-bc98351056db}';
const ACTION = '{8ac092e5-3128-4e26-9e7e-11016c6684f2}';

/** A `browsercache` as XAE writes one, made up after those of the SPT Libraries: UTF-8 with a BOM, folders flat. */
const BROWSERCACHE = '﻿' + `<?xml version="1.0" encoding="utf-8"?>
<Library Name="SPT Base Types, 3.9.0 (Beckhoff Automation LLC)">
  <Node Name="Project Settings" TypeGUID="{8753fe6f-4a22-4320-8103-e553c4fc8e04}" EmbeddedTypeGUIDs="" ProvidesLanguageModel="false" ObjectGUID="{00000000-0000-0000-0000-000000000001}" />
  <Node Name="Component Base" TypeGUID="${FOLDER}" EmbeddedTypeGUIDs="" ProvidesLanguageModel="false" ObjectGUID="{00000000-0000-0000-0000-000000000002}" />
  <Node Name="FB_ComponentBase" TypeGUID="${POU}" EmbeddedTypeGUIDs="" Comment=" Basic framework of a component" ObjectGUID="{00000000-0000-0000-0000-000000000003}">
    <Node Name="Reset" TypeGUID="${METHOD}" EmbeddedTypeGUIDs="" Comment=" Clears error flags&#xD;&#xA; and error IDs" ObjectGUID="{00000000-0000-0000-0000-000000000004}" />
    <Node Name="Busy" TypeGUID="${PROPERTY}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-000000000005}">
      <Node Name="Get" TypeGUID="${GET}" EmbeddedTypeGUIDs="" Comment=" Whether the component is busy" ObjectGUID="{00000000-0000-0000-0000-000000000006}" />
    </Node>
    <Node Name="A_Init" TypeGUID="${ACTION}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-000000000007}" />
    <Node Name="Hidden" TypeGUID="${METHOD}" EmbeddedTypeGUIDs="" IsHidden="true" ObjectGUID="{00000000-0000-0000-0000-000000000008}" />
  </Node>
  <Node Name="F_GetVersion" TypeGUID="${POU}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-000000000009}" />
  <Node Name="E_PMLUnitMode" TypeGUID="${DUT}" EmbeddedTypeGUIDs="" Comment=" The PackML modes" ObjectGUID="{00000000-0000-0000-0000-00000000000a}" />
  <Node Name="I_ComponentBase" TypeGUID="${ITF}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-00000000000b}">
    <Node Name="CyclicLogic" TypeGUID="${ITF_METHOD}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-00000000000c}" />
  </Node>
  <Node Name="Parameters_BaseComponent" TypeGUID="${GVL}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-00000000000d}" />
  <Node Name="_Internal" TypeGUID="${POU}" EmbeddedTypeGUIDs="" IsHidden="true" ObjectGUID="{00000000-0000-0000-0000-00000000000e}" />
  <Node Name="Not an identifier" TypeGUID="${POU}" EmbeddedTypeGUIDs="" ObjectGUID="{00000000-0000-0000-0000-00000000000f}" />
</Library>`;

test('the objects of a browsercache: POUs, DUTs, interfaces and GVLs with their members and comments', () => {
  assert.deepEqual(parseBrowserCache(BROWSERCACHE), [
    {
      name: 'FB_ComponentBase', kind: 'pou', comment: 'Basic framework of a component', members: [
        { name: 'Reset', kind: 'method', comment: 'Clears error flags\n and error IDs' },
        // A property's comment is on its Get.
        { name: 'Busy', kind: 'property', comment: 'Whether the component is busy' },
        { name: 'A_Init', kind: 'action', comment: undefined },
      ],
    },
    { name: 'F_GetVersion', kind: 'pou', comment: undefined, members: [] },
    { name: 'E_PMLUnitMode', kind: 'dut', comment: 'The PackML modes', members: [] },
    { name: 'I_ComponentBase', kind: 'interface', comment: undefined, members: [{ name: 'CyclicLogic', kind: 'method', comment: undefined }] },
    { name: 'Parameters_BaseComponent', kind: 'gvl', comment: undefined, members: [] },
  ]);
  assert.deepEqual(parseBrowserCache('<Other/>'), []);
});

test('the objects of the libraries referenced: of the version named when installed, else of the newest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-installed-'));
  try {
    const version = (title: string, v: string, cache?: string) => {
      const dir = path.join(root, SPT, title, v);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${title.replace(/ /g, '_')}.library`), '');
      if (cache !== undefined) fs.writeFileSync(path.join(dir, 'browsercache'), cache);
    };
    const named = (n: string) => BROWSERCACHE.replace('F_GetVersion', n);
    version('SPT Base Types', '3.3.0', named('F_Old'));
    version('SPT Base Types', '3.9.0', named('F_New'));
    version('SPT Utilities', '3.9.0');
    const { libraries } = await readRepositories([root]);
    const objects = async (title: string, v: string, company = SPT) =>
      (await readInstalledSymbols(libraries, [{ title, version: v, company }])).map(l => `${l.title} ${l.version} ${l.objects[1].name}`);
    assert.deepEqual(await objects('SPT Base Types', '3.3.0'), ['SPT Base Types 3.3.0 F_Old']);
    assert.deepEqual(await objects('SPT Base Types', '*'), ['SPT Base Types 3.9.0 F_New']);
    assert.deepEqual(await objects('SPT Base Types', '3.5.0'), ['SPT Base Types 3.9.0 F_New'], 'not installed: the newest');
    assert.deepEqual(await objects('spt base types', '*', ''), ['SPT Base Types 3.9.0 F_New'], 'no company: by title');
    assert.deepEqual(await objects('SPT Utilities', '*'), [], 'no browsercache');
    assert.deepEqual(await objects('SPT Vision', '*'), [], 'not installed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A workspace with a PLC project that references SPT Base Types and Tc2_System, with these POUs. */
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
    <PlaceholderReference Include="Tc2_System">
      <DefaultResolution>Tc2_System, * (Beckhoff Automation GmbH)</DefaultResolution>
      <Namespace>Tc2_System</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`);
  let id = 0;
  for (const [name, [decl, impl]] of Object.entries(pous).map(([n, t]) => [n, t.split('\n---\n')] as const)) {
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

const INSTALLED: InstalledSymbols[] = [
  { title: 'SPT Base Types', company: SPT, version: '3.9.0', objects: parseBrowserCache(BROWSERCACHE) },
  // Tc2_System has a stub: its browsercache adds what the stub does not declare.
  {
    title: 'Tc2_System', company: 'Beckhoff Automation GmbH', version: '3.4.26.0', objects: [
      { name: 'F_NotInTheStub', kind: 'pou', members: [] },
      { name: 'ADSLOGSTR', kind: 'pou', comment: 'From the browsercache', members: [] },
    ],
  },
];

test('the objects of installed libraries without a stub are known by name; what is not known of them is not reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-installed-'));
  try {
    const ws = project(root, {
      FB_Component_Tray: `FUNCTION_BLOCK FB_Component_Tray EXTENDS FB_ComponentBase IMPLEMENTS I_ComponentBase
VAR
	eMode : E_PMLUnitMode;
	sVersion : STRING;
END_VAR
---
Reset();
A_Init();
IF NOT Busy AND bInheritedButUnknown THEN
	sVersion := F_GetVersion();
	nCount := Parameters_BaseComponent.nMax;
END_IF
eMode := E_PMLUnitMode.Production;
F_NotInTheStub();
ADSLOGSTR(msgCtrlMask := ADSLOG_MSGTYPE_HINT, msgFmtStr := 'x', strArg := '');`,
      FB_Plain: `FUNCTION_BLOCK FB_Plain
VAR
	fbBase : SPT_BaseTypes.FB_ComponentBase;
END_VAR
---
fbBase.Reset();
fbBase.AnythingAtAll := 1;
bTrulyUnknown := TRUE;`,
    });
    const idx = new LanguageIndex(ws);
    idx.setStubs(BUNDLED_STUBS);
    const problems = (name: string) => idx.allContexts().filter(c => c.object.name === name)
      .flatMap(c => analyze(idx, c, idx.sectionText(c.fileKey, c.sectionKey)!).problems.map(p => `${c.label}: ${p.message}`));

    // Without the installed libraries: what EricControls saw.
    assert.ok(problems('FB_Component_Tray').includes("Declaration: Unknown type 'FB_ComponentBase'"));

    idx.setInstalledLibraries(INSTALLED);
    // A variable inherited from a POU known by name only is not reported.
    assert.deepEqual(problems('FB_Component_Tray'), []);
    // Members of an instance are not checked; an unknown name outside such a POU still is.
    assert.deepEqual(problems('FB_Plain'), ["Implementation: Unknown identifier 'bTrulyUnknown'"]);

    // The hover tells where it comes from; the stub's declaration stays where it has one.
    const scope = idx.allContexts().find(c => c.object.name === 'FB_Plain')!.scope;
    const base = idx.lookupGlobal(scope, 'FB_COMPONENTBASE')!;
    assert.equal(base.namesOnly, true);
    assert.match(base.doc ?? '', /^Basic framework of a component\n\nFrom SPT Base Types, 3\.9\.0 \(Beckhoff Automation LLC\)\. Its declaration is not known/);
    assert.equal(base.kind === 'pou' && base.members.map(m => `${m.kind} ${m.name}`).join(', '), 'method Reset, property Busy, action A_Init');
    assert.equal(idx.lookupGlobal(scope, 'ADSLOGSTR')?.namesOnly, undefined, 'declared by the stub');
    assert.equal(idx.lookupGlobal(scope, 'F_NOTINTHESTUB')?.namesOnly, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

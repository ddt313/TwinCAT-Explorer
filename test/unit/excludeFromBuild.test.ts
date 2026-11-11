// Code excluded from the build (XAE: the object's or the folder's Properties, Exclude from build), which XAE never
// compiles: no problem is reported in it, and built code that uses a name it declares gets an error, as XAE's
// compiler knows no such name. Its names still resolve, for hovers, Go to Definition and renames.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { excludedFromBuild, parsePlcProject } from '../../src/core/project';
import { TcWorkspace } from '../../src/core/workspace';
import { LanguageIndex } from '../../src/lang/index';
import { analyze } from '../../src/lang/analyzer';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

const plcproj = (items: string) => `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Name>Plc</Name>
  </PropertyGroup>
  <ItemGroup>${items}
  </ItemGroup>
</Project>`;

const compile = (include: string, excluded?: string) => `
    <Compile Include="${include}">
      <SubType>Code</SubType>${excluded === undefined ? '' : `
      <ExcludeFromBuild>${excluded}</ExcludeFromBuild>`}
    </Compile>`;

test('the items of a .plcproj excluded from the build, and the files they exclude', () => {
  const p = parsePlcProject(path.resolve('P', 'Plc.plcproj'), plcproj(`${compile('POUs\\MAIN.TcPOU')}${compile('POUs\\FB_Single.TcPOU', 'true')}${compile('POUs\\FB_Kept.TcPOU', 'false')}
    <Folder Include="Old">
      <ExcludeFromBuild>True</ExcludeFromBuild>
    </Folder>
    <Folder Include="Older\\">
      <ExcludeFromBuild> true </ExcludeFromBuild>
    </Folder>
    <Folder Include="POUs" />`));
  assert.deepEqual(p.excluded, ['POUs\\FB_Single.TcPOU', 'Old', 'Older']);
  const ex = (include: string) => excludedFromBuild(p, include);
  assert.equal(ex('POUs\\MAIN.TcPOU'), false);
  assert.equal(ex('POUs\\FB_Single.TcPOU'), true);
  assert.equal(ex('pous\\fb_single.tcpou'), true, 'case aside, as XAE compares names');
  assert.equal(ex('POUs\\FB_Kept.TcPOU'), false);
  assert.equal(ex('Old\\FB_Old.TcPOU'), true);
  assert.equal(ex('Old\\Deeper\\GVL_Old.TcGVL'), true, 'a folder excludes what is below it');
  assert.equal(ex('OldStuff\\FB_X.TcPOU'), false, 'that folder only, not one whose name starts the same');
  assert.equal(ex('Older\\FB_Y.TcPOU'), true);
});

const object = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
${body}
</TcPlcObject>`;
const pou = (name: string, n: number, decl: string, impl: string, members = '') => object(`  <POU Name="${name}" Id="{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl}]]></ST>
    </Implementation>${members}
  </POU>`);
const method = (name: string, n: number, decl: string, impl: string) => `
    <Method Name="${name}" Id="{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}">
      <Declaration><![CDATA[${decl}]]></Declaration>
      <Implementation>
        <ST><![CDATA[${impl}]]></ST>
      </Implementation>
    </Method>`;
const dut = (name: string, n: number, decl: string) => object(`  <DUT Name="${name}" Id="{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </DUT>`);
const gvl = (name: string, n: number, decl: string) => object(`  <GVL Name="${name}" Id="{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </GVL>`);

test('no problem in code excluded from the build; built code that uses its names gets an error, once per use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-excluded-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    write('Demo/Demo.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
    write('Demo/Plc/Plc.plcproj', plcproj(`${compile('Old\\E_Old.TcDUT')}${compile('Old\\FB_Old.TcPOU')}${compile('Old\\GVL_Old.TcGVL')}${compile('POUs\\FB_Built.TcPOU')}${compile('POUs\\FB_Single.TcPOU', 'true')}${compile('POUs\\MAIN.TcPOU')}
    <Folder Include="Old">
      <ExcludeFromBuild>true</ExcludeFromBuild>
    </Folder>
    <Folder Include="POUs" />`));
    // Excluded: what they hold is not checked, an unknown name or a syntax error included.
    write('Demo/Plc/Old/FB_Old.TcPOU', pou('FB_Old', 1, 'FUNCTION_BLOCK FB_Old\nVAR\n\tnCount : INT;\nEND_VAR', 'nCount := nCount + UnknownThing;',
      method('M_Run', 2, 'METHOD M_Run : BOOL', 'M_Run := nCount > NotDeclared;')));
    write('Demo/Plc/Old/E_Old.TcDUT', dut('E_Old', 3, 'TYPE E_Old :\n(\n\tA := 0,\n\tB\n);\nEND_TYPE'));
    write('Demo/Plc/Old/GVL_Old.TcGVL', gvl('GVL_Old', 4, 'VAR_GLOBAL\n\tbOld : BOOL;\nEND_VAR'));
    write('Demo/Plc/POUs/FB_Single.TcPOU', pou('FB_Single', 5, 'FUNCTION_BLOCK FB_Single', 'x := ;'));
    // Built: each name of excluded code it uses is an error, once for GVL_Old.bOld and E_Old.B.
    write('Demo/Plc/POUs/FB_Built.TcPOU', pou('FB_Built', 6, 'FUNCTION_BLOCK FB_Built EXTENDS FB_Old', ''));
    write('Demo/Plc/POUs/MAIN.TcPOU', pou('MAIN', 7, 'PROGRAM MAIN\nVAR\n\tfbOld : FB_Old;\n\teState : E_Old;\n\tfbSingle : FB_Single;\nEND_VAR',
      'fbOld.M_Run();\nbOld := TRUE;\nGVL_Old.bOld := FALSE;\neState := E_Old.B;\nfbSingle();'));
    const ws = new TcWorkspace();
    ws.load([path.join(root, 'Demo/Demo.tsproj')]);
    const index = new LanguageIndex(ws);
    index.setStubs(BUNDLED_STUBS);
    const problems: string[] = [];
    for (const ctx of index.allContexts()) {
      const a = analyze(index, ctx, index.sectionText(ctx.fileKey, ctx.sectionKey)!);
      problems.push(...a.problems.map(p => `${ctx.object.qualifiedName} ${ctx.role}: ${p.severity}: ${p.message}`));
    }
    assert.deepEqual(problems.sort(), [
      "FB_Built decl: error: 'FB_Old' is excluded from the build",
      "MAIN decl: error: 'E_Old' is excluded from the build",
      "MAIN decl: error: 'FB_Old' is excluded from the build",
      "MAIN decl: error: 'FB_Single' is excluded from the build",
      "MAIN impl: error: 'E_Old' is excluded from the build",
      "MAIN impl: error: 'GVL_Old' is excluded from the build",
      "MAIN impl: error: 'bOld' of GVL_Old is excluded from the build",
    ]);
    const excluded = index.allContexts().filter(c => c.excluded).map(c => `${c.object.qualifiedName} ${c.role}`).sort();
    assert.deepEqual(excluded, ['E_Old decl', 'FB_Old decl', 'FB_Old impl', 'FB_Old.M_Run decl', 'FB_Old.M_Run impl', 'FB_Single decl', 'FB_Single impl', 'GVL_Old decl']);
    // The name still resolves in built code: a hover, Go to Definition and a rename find FB_Old.
    const mainDecl = index.allContexts().find(c => c.object.name === 'MAIN' && c.role === 'decl')!;
    const text = index.sectionText(mainDecl.fileKey, mainDecl.sectionKey)!;
    const fbOld = analyze(index, mainDecl, text).occurrences.find(o => text.slice(o.start, o.end) === 'FB_Old');
    assert.equal(fbOld?.sym.kind, 'pou');
    assert.equal(fbOld?.sym.name, 'FB_Old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

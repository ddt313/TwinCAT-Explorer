import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TcWorkspace } from '../../src/core/workspace';
import { LanguageIndex } from '../../src/lang/index';
import { analyze } from '../../src/lang/analyzer';
import { parseBody, parseDeclaration } from '../../src/lang/parser';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

test('parser handles TwinCAT declarations and statements', () => {
  const d = parseDeclaration(`{attribute 'qualified_only'}
FUNCTION_BLOCK PUBLIC FB_X EXTENDS FB_Base IMPLEMENTS I_A, I_B
VAR_INPUT
	a, b : INT := 5;
	p AT %I* : BOOL;
	arr : ARRAY[1..GVL.N, 0..2] OF POINTER TO ST_X := [3(0)];
	s : STRING(80) := 'it$'s';
	fb : FB_Y(THIS, E_X.A);
	r : REFERENCE TO FB_Z;
	sub : INT(0..100);
	st : ST_P := (x := 1, y := 2);
END_VAR`);
  assert.deepEqual(d.errors, []);
  const u = d.units[0];
  assert.equal(u.header?.name?.name, 'FB_X');
  assert.deepEqual(u.header?.implements.map(q => q.parts[0].name), ['I_A', 'I_B']);
  assert.equal(u.varBlocks[0].decls.length, 8);

  const b = parseBody(`CASE eState OF;
	E_State.Idle, E_State.Done:
		x := 1;
	10..20:
		fb(IN := TRUE, Q => bQ, NOT bOut => y);
	ELSE
		RETURN;
END_CASE
FOR i := 1 TO 10 BY 2 DO a[i] := THIS^.p^.q.0; END_FOR
bSet S= TRUE; bReset R= FALSE; ref REF= other;
IF a AND_THEN b OR_ELSE NOT c THEN x := T#1S + TIME#2m; ELSIF y THEN ; ELSE z := DINT#5 * 16#FF MOD 2 ** 3; END_IF
REPEAT i := i - 1; UNTIL i <= 0 END_REPEAT
WHILE TRUE DO EXIT; END_WHILE`);
  assert.deepEqual(b.errors, []);
  assert.equal(b.body.length, 8);
});

test('parser reports syntax errors', () => {
  const b = parseBody('x := ;\nIF a THEN y := 1;\n');
  assert.ok(b.errors.length >= 2);
});

test('finds the expression before a dot for member completion', async () => {
  const { expressionBeforeDot } = await import('../../src/lang/completion');
  const at = (s: string) => expressionBeforeDot(s.replace('|', ''), s.indexOf('|'));
  assert.equal(at('x := fbValve.|'), 'fbValve');
  assert.equal(at('x := fbValve.Act|'), 'fbValve');
  assert.equal(at('THIS^.Settings.OpenTime.|'), 'THIS^.Settings.OpenTime');
  assert.equal(at('a := aItems[i + 1].fb.|'), 'aItems[i + 1].fb');
  assert.equal(at('GetThing(a, (b)).Value.|'), 'GetThing(a, (b)).Value');
  assert.equal(at('IF pObj^.|'), 'pObj^');
  assert.equal(at('x := 1..|'), undefined);
  assert.equal(at('x := y |'), undefined);
});

test('a file changed without an event of its own is indexed again at the next change of another file', () => {
  // Workspace folder A, and a PLC project B outside it whose files no watcher reports.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-index-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const pou = (name: string, id: string, decl: string, impl: string) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="{${id}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl}]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;
  const plcproj = (name: string, include: string, refs = '') => `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>${name}</Name></PropertyGroup>
  <ItemGroup><Compile Include="${include}"><SubType>Code</SubType></Compile></ItemGroup>${refs}
</Project>`;
  try {
    write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc>
  <Project Name="Sim" PrjFilePath="Sim\\Sim.plcproj"/>
  <Project Name="Machine" PrjFilePath="..\\B\\Machine\\Machine.plcproj"/>
</Plc></Project></TcSmProject>`);
    write('A/Sim/Sim.plcproj', plcproj('Sim', 'POUs\\MAIN.TcPOU', `
  <ItemGroup><PlaceholderReference Include="Machine"><DefaultResolution>Machine, * (X)</DefaultResolution><Namespace>Machine</Namespace></PlaceholderReference></ItemGroup>`));
    write('B/Machine/Machine.plcproj', plcproj('Machine', 'POUs\\FB_Machine.TcPOU'));
    write('B/Machine/POUs/FB_Machine.TcPOU', pou('FB_Machine', 'aaaaaaaa-0000-0000-0000-000000000001',
      'FUNCTION_BLOCK FB_Machine\nVAR_INPUT\n\tbOld : BOOL;\nEND_VAR', ''));
    write('A/Sim/POUs/MAIN.TcPOU', pou('MAIN', 'bbbbbbbb-0000-0000-0000-000000000001',
      'PROGRAM MAIN\nVAR\n\tfb : FB_Machine;\nEND_VAR', 'fb.bOld := TRUE;'));
    const w = new TcWorkspace();
    w.load([path.join(root, 'A/A.tsproj')]);
    const idx = new LanguageIndex(w);
    idx.setStubs(BUNDLED_STUBS);
    const fbVars = () => (idx.allGlobals().find(g => g.name === 'FB_Machine') as { vars: { name: string }[] }).vars.map(v => v.name);
    assert.deepEqual(fbVars(), ['bOld']);
    // XAE or a checkout renames the input of FB_Machine: no event, B is outside the workspace folder.
    const fbPath = path.join(root, 'B/Machine/POUs/FB_Machine.TcPOU');
    fs.writeFileSync(fbPath, fs.readFileSync(fbPath, 'utf8').replace('bOld', 'bNewInput'));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(fbPath, later, later);
    // MAIN, in the workspace, changes too, and its event arrives (what onSourceChanged does).
    const mainPath = path.join(root, 'A/Sim/POUs/MAIN.TcPOU');
    fs.writeFileSync(mainPath, fs.readFileSync(mainPath, 'utf8').replace('fb.bOld', 'fb.bNewInput'));
    w.invalidate(mainPath);
    idx.invalidateFile(mainPath);
    assert.deepEqual(fbVars(), ['bNewInput']);
    const main = idx.allContexts().find(c => c.object.name === 'MAIN' && c.role === 'impl')!;
    assert.deepEqual(analyze(idx, main, idx.sectionText(main.fileKey, main.sectionKey)!).problems.map(p => p.message), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

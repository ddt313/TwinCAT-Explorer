import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../../src/lang/analyzer';
import { LanguageIndex } from '../../src/lang/index';
import { OutlineSymbol, outline } from '../../src/lang/outline';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { TcWorkspace, fileKey } from '../../src/core/workspace';

/**
 * An outline as indented lines: `kind name — detail`. The name range covers the name, but for a CASE (with its
 * OF) and a region (its pragma).
 */
function lines(text: string, symbols: OutlineSymbol[], depth = 0): string[] {
  return symbols.flatMap(s => {
    if (s.kind !== 'Enum' && s.kind !== 'Package') assert.equal(text.slice(s.nameStart, s.nameEnd).replace(/\s+/g, ' '), s.name);
    return [`${'  '.repeat(depth)}${s.kind} ${s.name}${s.detail ? ' — ' + s.detail : ''}`, ...lines(text, s.children, depth + 1)];
  });
}

test('the branches of a CASE, with their comments, and regions', () => {
  const text = `{region "Sequence"}
CASE nState OF
	0: // Idle
		IF bStart THEN nState := 10; END_IF
	10, 11: (* Move to start *)
		CASE nSub OF
			1..5: x := 1;
		END_CASE
	E_Step.Done:
		nState := 0;
ELSE // Unknown step
	nState := 0;
END_CASE
{endregion}
fbAxis(Execute := TRUE);`;
  assert.deepEqual(lines(text, outline(undefined, text)), [
    'Package Sequence',
    '  Enum CASE nState',
    '    EnumMember 0 — Idle',
    '    EnumMember 10, 11 — Move to start',
    '      Enum CASE nSub',
    '        EnumMember 1..5',
    '    EnumMember E_Step.Done',
    '    EnumMember ELSE — Unknown step',
  ]);
});

test('the declarations of a section, in their VAR blocks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-outline-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
    write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup><Compile Include="POUs\\FB_Axis.TcPOU"><SubType>Code</SubType></Compile></ItemGroup>
</Project>`);
    write('A/Plc/POUs/FB_Axis.TcPOU', `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="FB_Axis" Id="{dddddddd-0000-4000-8000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Axis
VAR_INPUT
	bEnable : BOOL;
	fTarget : LREAL := 10.0;
END_VAR
VAR CONSTANT
	MAX_STEPS : INT := 5;
END_VAR
{region "Internal"}
VAR
	fbTimer : TON;
END_VAR
{endregion}
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`);
    const ws = new TcWorkspace();
    ws.load([path.join(root, 'A/A.tsproj')]);
    const index = new LanguageIndex(ws);
    index.setStubs(BUNDLED_STUBS);
    const key = 'dddddddd-0000-4000-8000-000000000001:decl';
    const fk = fileKey(path.join(root, 'A/Plc/POUs/FB_Axis.TcPOU'));
    const ctx = index.context(fk, key)!;
    const text = index.sectionText(fk, key)!;
    assert.deepEqual(lines(text, outline(analyze(index, ctx, text), text)), [
      'Class FB_Axis',
      '  Namespace VAR_INPUT',
      '    Variable bEnable — BOOL',
      '    Variable fTarget — LREAL',
      '  Namespace VAR CONSTANT',
      '    Constant MAX_STEPS — INT',
      '  Package Internal',
      '    Namespace VAR',
      '      Variable fbTimer — TON',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

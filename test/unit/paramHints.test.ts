import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../../src/lang/analyzer';
import { LanguageIndex } from '../../src/lang/index';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { TcWorkspace, fileKey } from '../../src/core/workspace';

const pou = (name: string, n: number, decl: string, st: string, members = '') => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="{dddddddd-0000-4000-8000-00000000000${n}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${st}]]></ST>
    </Implementation>${members}
  </POU>
</TcPlcObject>`;

test('the parameters that arguments passed by position go to', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-hints-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const files: Record<string, string> = {
    'POUs/F_Scale.TcPOU': pou('F_Scale', 1, `FUNCTION F_Scale : LREAL
VAR_INPUT
	fIn : LREAL;
	fMin : LREAL;
	fMax : LREAL;
END_VAR
`, ''),
    'POUs/FB_Axis.TcPOU': pou('FB_Axis', 2, 'FUNCTION_BLOCK FB_Axis\n', '', `
    <Method Name="MoveTo" Id="{dddddddd-0000-4000-8000-000000000003}">
      <Declaration><![CDATA[METHOD MoveTo : BOOL
VAR_INPUT
	fPos : LREAL;
	fVelo : LREAL;
END_VAR
]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>`),
    'POUs/MAIN.TcPOU': pou('MAIN', 4, `PROGRAM MAIN
VAR
	fbAxis : FB_Axis;
	fIn, fOut, fMin : LREAL;
	n : INT;
	s : STRING;
END_VAR
`, ''),
  };
  try {
    write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
    write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${Object.keys(files).map(f => `<Compile Include="${f.replace(/\//g, '\\')}"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
</Project>`);
    for (const [rel, text] of Object.entries(files)) write(`A/Plc/${rel}`, text);
    const ws = new TcWorkspace();
    ws.load([path.join(root, 'A/A.tsproj')]);
    const index = new LanguageIndex(ws);
    index.setStubs(BUNDLED_STUBS);
    const ctx = index.context(fileKey(path.join(root, 'A/Plc/POUs/MAIN.TcPOU')), 'dddddddd-0000-4000-8000-000000000004:impl')!;
    /** Each hint as `name:` before the text of its argument. */
    const hints = (st: string) => {
      const a = analyze(index, ctx, st);
      assert.deepEqual(a.problems.map(p => p.message), []);
      return a.paramHints.map(h => `${h.name}: ${st.slice(h.offset).split(/[,)]/)[0]}`);
    };
    // A function: fMin is passed a variable of its name, which needs no hint.
    assert.deepEqual(hints('fOut := F_Scale(n * 2.0, fMin, 100.0);'), ['fIn: n * 2.0', 'fMax: 100.0']);
    // A method, the rest passed by name.
    assert.deepEqual(hints('fbAxis.MoveTo(10.0, 5.0);\nfbAxis.MoveTo(fPos := 10.0, fVelo := 5.0);'), ['fPos: 10.0', 'fVelo: 5.0']);
    // Built-ins: none for a lone argument, nor for numbered parameters.
    assert.deepEqual(hints('fOut := LIMIT(0.0, fIn, 100.0);\nn := ABS(n);\nfOut := MIN(fIn, 1.0);\ns := MID(s, 2, 1);'),
      ['min: 0.0', 'in: fIn', 'max: 100.0', 'str: s', 'len: 2', 'pos: 1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

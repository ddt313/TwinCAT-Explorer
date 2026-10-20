import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TcWorkspace } from '../../src/core/workspace';
import { LanguageIndex, SectionContext } from '../../src/lang/index';
import { analyze } from '../../src/lang/analyzer';
import {
  VarScope, autoDeclareStart, declarationEdit, declarationLine, initialValueProblem, integerType, quickFixes, scopeLabel,
  unknownNameAt, variableNameProblem,
} from '../../src/lang/autoDeclare';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

/** The declaration with the variable declared in the scope, as the quick fix and Auto Declare... write it. */
function declare(text: string, scope: VarScope, line = 'bDone : BOOL;'): string {
  const edit = declarationEdit(text, scope, line);
  assert.ok(edit, `no edit for ${scopeLabel(scope)} in ${JSON.stringify(text)}`);
  const out = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset);
  assert.equal(out.slice(edit.start, edit.end), line, 'start and end are those of the new declaration');
  return out;
}

const VAR: VarScope = { section: 'VAR' };

test('a new variable goes before END_VAR of its block, indented like the declarations there', () => {
  const fb = 'FUNCTION_BLOCK FB_Valve\nVAR_INPUT\n\tbOpen : BOOL;\nEND_VAR\nVAR\n\tfPos : LREAL; // mm\nEND_VAR\n';
  assert.equal(declare(fb, VAR), 'FUNCTION_BLOCK FB_Valve\nVAR_INPUT\n\tbOpen : BOOL;\nEND_VAR\nVAR\n\tfPos : LREAL; // mm\n\tbDone : BOOL;\nEND_VAR\n');
  assert.equal(declare(fb, { section: 'VAR_INPUT' }),
    'FUNCTION_BLOCK FB_Valve\nVAR_INPUT\n\tbOpen : BOOL;\n\tbDone : BOOL;\nEND_VAR\nVAR\n\tfPos : LREAL; // mm\nEND_VAR\n');
  // An empty block, spaces instead of tabs, a block written on one line.
  assert.equal(declare('PROGRAM MAIN\nVAR\nEND_VAR', VAR), 'PROGRAM MAIN\nVAR\n\tbDone : BOOL;\nEND_VAR');
  assert.equal(declare('PROGRAM MAIN\nVAR\n    nCount : INT;\nEND_VAR\nVAR_TEMP\nEND_VAR', { section: 'VAR_TEMP' }),
    'PROGRAM MAIN\nVAR\n    nCount : INT;\nEND_VAR\nVAR_TEMP\n    bDone : BOOL;\nEND_VAR');
  assert.equal(declare('PROGRAM MAIN\nVAR nCount : INT; END_VAR', VAR), 'PROGRAM MAIN\nVAR nCount : INT; bDone : BOOL; END_VAR');
  // The plain block, not the CONSTANT one, and the CONSTANT one when asked for.
  const two = 'PROGRAM MAIN\nVAR CONSTANT\n\tcMax : INT := 5;\nEND_VAR\nVAR\n\tnCount : INT;\nEND_VAR\n';
  assert.equal(declare(two, VAR), 'PROGRAM MAIN\nVAR CONSTANT\n\tcMax : INT := 5;\nEND_VAR\nVAR\n\tnCount : INT;\n\tbDone : BOOL;\nEND_VAR\n');
  assert.equal(declare(two, { section: 'VAR', qualifier: 'CONSTANT' }, 'cMin : INT := 1;'),
    'PROGRAM MAIN\nVAR CONSTANT\n\tcMax : INT := 5;\n\tcMin : INT := 1;\nEND_VAR\nVAR\n\tnCount : INT;\nEND_VAR\n');
  // The Get of a property as TwinCAT 3.1.4026 writes it, a GVL with its attribute.
  assert.equal(declare('PUBLIC\nVAR\nEND_VAR\n', VAR), 'PUBLIC\nVAR\n\tbDone : BOOL;\nEND_VAR\n');
  assert.equal(declare("{attribute 'qualified_only'}\nVAR_GLOBAL\n\tnValves : INT := 4;\nEND_VAR\n", { section: 'VAR_GLOBAL' }),
    "{attribute 'qualified_only'}\nVAR_GLOBAL\n\tnValves : INT := 4;\n\tbDone : BOOL;\nEND_VAR\n");
  // A block without END_VAR: nothing is written into a declaration with that syntax error.
  assert.equal(declarationEdit('PROGRAM MAIN\nVAR\n\tnCount : INT;\n', VAR, 'bDone : BOOL;'), undefined);
  assert.equal(declarationEdit('PROGRAM MAIN\nVAR_INPUT\n\tbIn : BOOL;\nVAR\nEND_VAR', VAR, 'bDone : BOOL;'), undefined);
});

test('a missing block is made where the templates of XAE have it', () => {
  const fb = 'FUNCTION_BLOCK FB_Valve\nVAR_INPUT\n\tbOpen : BOOL;\nEND_VAR\nVAR\n\tfPos : LREAL;\nEND_VAR\n';
  // After VAR, after VAR_INPUT, and at the end without a line break after the last END_VAR.
  assert.equal(declare(fb, { section: 'VAR_TEMP' }), `${fb}VAR_TEMP\n\tbDone : BOOL;\nEND_VAR\n`);
  assert.equal(declare(fb, { section: 'VAR_OUTPUT' }),
    'FUNCTION_BLOCK FB_Valve\nVAR_INPUT\n\tbOpen : BOOL;\nEND_VAR\nVAR_OUTPUT\n\tbDone : BOOL;\nEND_VAR\nVAR\n\tfPos : LREAL;\nEND_VAR\n');
  assert.equal(declare(fb.trimEnd(), { section: 'VAR', qualifier: 'CONSTANT' }, 'cMax : INT := 10;'),
    `${fb}VAR CONSTANT\n\tcMax : INT := 10;\nEND_VAR`);
  // Before the first block, with the comment that belongs to it, and indented like the other declarations.
  assert.equal(declare('FUNCTION_BLOCK FB_Pump\n// State\nVAR\n    nState : INT;\nEND_VAR', { section: 'VAR_INPUT' }),
    'FUNCTION_BLOCK FB_Pump\nVAR_INPUT\n    bDone : BOOL;\nEND_VAR\n// State\nVAR\n    nState : INT;\nEND_VAR');
  // No block yet: after the header, or what there is.
  assert.equal(declare('METHOD M_Open : BOOL', VAR), 'METHOD M_Open : BOOL\nVAR\n\tbDone : BOOL;\nEND_VAR');
  assert.equal(declare('METHOD M_Open : BOOL\n', { section: 'VAR_INPUT' }), 'METHOD M_Open : BOOL\nVAR_INPUT\n\tbDone : BOOL;\nEND_VAR\n');
  assert.equal(declare('', VAR), 'VAR\n\tbDone : BOOL;\nEND_VAR');
  assert.equal(declare('PUBLIC', VAR), 'PUBLIC\nVAR\n\tbDone : BOOL;\nEND_VAR');
  assert.equal(declare("{attribute 'qualified_only'}\n", { section: 'VAR_GLOBAL' }),
    "{attribute 'qualified_only'}\nVAR_GLOBAL\n\tbDone : BOOL;\nEND_VAR\n");
});

test('the declaration Auto Declare writes, and what it refuses', () => {
  assert.equal(declarationLine({ name: 'bDone', type: 'BOOL' }), 'bDone : BOOL;');
  assert.equal(declarationLine({ name: ' nCount ', type: ' INT ', init: ' 5 ', comment: ' parts\r\nmade ' }), 'nCount : INT := 5; // parts made');
  assert.equal(declarationLine({ name: 'sName', type: 'STRING(40)', init: '', comment: '  ' }), 'sName : STRING(40);');
  const decl = 'FUNCTION_BLOCK FB_Valve\nVAR_INPUT\n\tbOpen : BOOL;\nEND_VAR\nVAR\n\tfPos, fLast : LREAL;\nEND_VAR\nVAR CONSTANT\n\tcMax : INT := 5;\nEND_VAR\n';
  assert.equal(variableNameProblem(decl, 'bDone'), undefined);
  assert.equal(variableNameProblem(decl, 'FLAST'), 'fLast is declared already, in VAR');
  assert.equal(variableNameProblem(decl, 'cMax'), 'cMax is declared already, in VAR CONSTANT');
  assert.equal(variableNameProblem(decl, 'fb_valve'), 'FB_Valve is the name of the function block itself');
  assert.equal(variableNameProblem(decl, 'IF'), 'IF is a keyword');
  assert.ok(variableNameProblem(decl, '1st'));
  assert.ok(variableNameProblem(decl, ''));
  assert.equal(initialValueProblem('INT', '5'), undefined);
  assert.equal(initialValueProblem('ST_ValveData', '(fPos := 1.5, bOpen := TRUE)'), undefined);
  assert.equal(initialValueProblem('ARRAY[0..2] OF INT', '[1, 2, 3]'), undefined);
  assert.equal(initialValueProblem('TIME', 'T#5S'), undefined);
  assert.ok(initialValueProblem('INT', '5 +'));
  assert.ok(initialValueProblem('INT', '5;\nbOther : BOOL'));
});

test('integers: INT, DINT or LINT, the smallest that holds them; WORD, DWORD or LWORD with a base', () => {
  assert.equal(integerType('0'), 'INT');
  assert.equal(integerType('32767'), 'INT');
  assert.equal(integerType('32768', true), 'INT');
  assert.equal(integerType('32768'), 'DINT');
  assert.equal(integerType('100_000'), 'DINT');
  assert.equal(integerType('3000000000'), 'LINT');
  assert.equal(integerType('16#FF'), 'WORD');
  assert.equal(integerType('16#1_0000'), 'DWORD');
  assert.equal(integerType('2#1010'), 'WORD');
  assert.equal(integerType('16#1_0000_0000'), 'LWORD');
  assert.equal(integerType('10#42'), 'INT');
  assert.equal(integerType('%IX0.0'), undefined);
});

// ------------------------------------------------------------------ a PLC project

const FB = 'aaaaaaaa-0000-4000-8000-000000000001';
const FB_OPEN = 'aaaaaaaa-0000-4000-8000-000000000002';
const FB_POS = 'aaaaaaaa-0000-4000-8000-000000000003';
const FB_POS_GET = 'aaaaaaaa-0000-4000-8000-000000000004';
const FB_RESET = 'aaaaaaaa-0000-4000-8000-000000000005';
const MAIN = 'bbbbbbbb-0000-4000-8000-000000000001';
const SCALE = 'cccccccc-0000-4000-8000-000000000001';
const ITF = 'dddddddd-0000-4000-8000-000000000001';
const ITF_CLOSE = 'dddddddd-0000-4000-8000-000000000002';
const STATE = 'eeeeeeee-0000-4000-8000-000000000001';
const DATA = 'eeeeeeee-0000-4000-8000-000000000002';
const GVL = 'ffffffff-0000-4000-8000-000000000001';

const HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">';

function pou(name: string, guid: string, decl: string, impl: string, members = ''): string {
  return `${HEAD}
  <POU Name="${name}" Id="{${guid}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl}]]></ST>
    </Implementation>${members}
  </POU>
</TcPlcObject>`;
}

const FB_VALVE_DECL = `FUNCTION_BLOCK FB_Valve IMPLEMENTS I_Valve
VAR_INPUT
	bOpen : BOOL;
	nSpeed : INT;
END_VAR
VAR
	fPos : LREAL;
	nState : INT;
	sName : STRING(40);
	aSteps : ARRAY[0..9] OF INT;
	fbTimer : TON;
	stData : ST_ValveData;
END_VAR
`;

const FILES: Record<string, string> = {
  'POUs/FB_Valve.TcPOU': pou('FB_Valve', FB, FB_VALVE_DECL, 'fPos := 0;', `
    <Method Name="M_Open" Id="{${FB_OPEN}}">
      <Declaration><![CDATA[METHOD M_Open : BOOL
VAR_INPUT
	fTarget : LREAL;
END_VAR
]]></Declaration>
      <Implementation>
        <ST><![CDATA[M_Open := TRUE;]]></ST>
      </Implementation>
    </Method>
    <Property Name="P_Pos" Id="{${FB_POS}}">
      <Declaration><![CDATA[PROPERTY PUBLIC P_Pos : LREAL]]></Declaration>
      <Get Name="Get" Id="{${FB_POS_GET}}">
        <Declaration><![CDATA[VAR
END_VAR
]]></Declaration>
        <Implementation>
          <ST><![CDATA[P_Pos := fPos;]]></ST>
        </Implementation>
      </Get>
    </Property>
    <Action Name="A_Reset" Id="{${FB_RESET}}">
      <Implementation>
        <ST><![CDATA[nState := 0;]]></ST>
      </Implementation>
    </Action>`),
  'POUs/MAIN.TcPOU': pou('MAIN', MAIN, 'PROGRAM MAIN\nVAR\n\tfbValve : FB_Valve;\n\tiValve : I_Valve;\n\tnCount : DINT;\nEND_VAR\n', 'fbValve();'),
  'POUs/F_Scale.TcPOU': pou('F_Scale', SCALE, 'FUNCTION F_Scale : REAL\nVAR_INPUT\n\tnRaw : INT;\nEND_VAR\n', 'F_Scale := nRaw / 10.0;'),
  'POUs/I_Valve.TcIO': `${HEAD}
  <Itf Name="I_Valve" Id="{${ITF}}">
    <Declaration><![CDATA[INTERFACE I_Valve
]]></Declaration>
    <Method Name="M_Close" Id="{${ITF_CLOSE}}">
      <Declaration><![CDATA[METHOD M_Close : BOOL
]]></Declaration>
    </Method>
  </Itf>
</TcPlcObject>`,
  'DUTs/E_ValveState.TcDUT': `${HEAD}
  <DUT Name="E_ValveState" Id="{${STATE}}">
    <Declaration><![CDATA[TYPE E_ValveState :
(
	Closed := 0,
	Opening,
	Opened
);
END_TYPE
]]></Declaration>
  </DUT>
</TcPlcObject>`,
  'DUTs/ST_ValveData.TcDUT': `${HEAD}
  <DUT Name="ST_ValveData" Id="{${DATA}}">
    <Declaration><![CDATA[TYPE ST_ValveData :
STRUCT
	fPos : LREAL;
	bOpen : BOOL;
END_STRUCT
END_TYPE
]]></Declaration>
  </DUT>
</TcPlcObject>`,
  'GVLs/GVL_Plant.TcGVL': `${HEAD}
  <GVL Name="GVL_Plant" Id="{${GVL}}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
VAR_GLOBAL
	nValves : INT := 4;
END_VAR
]]></Declaration>
  </GVL>
</TcPlcObject>`,
};

/** Runs a test on a PLC project with FB_Valve (a method, a property, an action), MAIN, F_Scale, I_Valve, two DUTs and a GVL. */
function withProject(run: (idx: LanguageIndex, ctxOf: (object: string, role: 'decl' | 'impl', accessor?: 'Get' | 'Set') => SectionContext) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-autodeclare-'));
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
  <ItemGroup>${Object.keys(FILES).map(f => `<Compile Include="${f.replace('/', '\\')}"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
</Project>`);
    for (const [rel, text] of Object.entries(FILES)) write(`A/Plc/${rel}`, text);
    const w = new TcWorkspace();
    w.load([path.join(root, 'A/A.tsproj')]);
    const idx = new LanguageIndex(w);
    idx.setStubs(BUNDLED_STUBS);
    run(idx, (object, role, accessor) => {
      const ctx = idx.allContexts().find(c => c.object.qualifiedName === object && c.role === role && c.accessor === accessor);
      assert.ok(ctx, `no ${role} section of ${object}`);
      return ctx;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const problemsOf = (idx: LanguageIndex, ctx: SectionContext, text: string) => analyze(idx, ctx, text).problems;

test('the quick fix declares bDone in the VAR block of the function block, and the problem goes', () => {
  withProject((idx, ctxOf) => {
    const impl = ctxOf('FB_Valve', 'impl');
    const text = 'bDone := TRUE;';
    const problems = problemsOf(idx, impl, text);
    assert.deepEqual(problems.map(p => p.message), ["Unknown identifier 'bDone'"]);
    const fixes = quickFixes(idx, impl, text, problems);
    assert.deepEqual(fixes.map(f => `${f.title}${f.preferred ? ' (preferred)' : ''}`), [
      'Declare bDone in VAR (preferred)', 'Declare bDone in VAR_INPUT', 'Declare bDone in VAR_OUTPUT', 'Declare bDone in VAR_IN_OUT',
      'Declare bDone in VAR_TEMP',
    ]);
    const fix = fixes[0];
    assert.ok(fix.kind === 'declare');
    assert.deepEqual(fix.variable, { name: 'bDone', type: 'BOOL' });
    assert.equal(fix.target.key, `${FB}:decl`);
    assert.equal(fix.target.other, false);
    const decl = idx.sectionText(impl.fileKey, fix.target.key)!;
    const declared = declare(decl, fix.scope, declarationLine(fix.variable));
    assert.equal(declared, FB_VALVE_DECL.replace('\tstData : ST_ValveData;\n', '\tstData : ST_ValveData;\n\tbDone : BOOL;\n'));
    // The declaration pane as edited: the language index has it, and bDone is known.
    idx.setOverlay(impl.fileKey, fix.target.key, declared);
    assert.deepEqual(problemsOf(idx, ctxOf('FB_Valve', 'impl'), text), []);
    // No fixes without a problem, nor for the problems of other kinds.
    assert.deepEqual(quickFixes(idx, impl, text, []), []);
    const others = 'fPos := F_Scale(nRaw := 1, nGain := 2) + E_Missing#Value;';
    assert.deepEqual(problemsOf(idx, impl, others).map(p => p.message), ["Unknown parameter 'nGain'", "Unknown type 'E_Missing'"]);
    assert.deepEqual(quickFixes(idx, impl, others, problemsOf(idx, impl, others)), []);
  });
});

test('the type comes from the use: literals, conditions, variables, calls, parameters, and BOOL otherwise', () => {
  withProject((idx, ctxOf) => {
    const impl = ctxOf('FB_Valve', 'impl');
    const lines: [string, string, string][] = [
      ['bDone := TRUE;', 'bDone', 'BOOL'],
      ['fSpeed := 1.5;', 'fSpeed', 'LREAL'],
      ["sText := 'Valve';", 'sText', 'STRING'],
      ['wsText := "Ventil";', 'wsText', 'WSTRING'],
      ['tWait := T#2S;', 'tWait', 'TIME'],
      ['dToday := D#2026-10-19;', 'dToday', 'DATE'],
      ['nCount := 5;', 'nCount', 'INT'],
      ['nBig := 100000;', 'nBig', 'DINT'],
      ['nLow := -40000;', 'nLow', 'DINT'],
      ['wMask := 16#FF00;', 'wMask', 'WORD'],
      ['nTyped := UDINT#7;', 'nTyped', 'UDINT'],
      ['IF bReady THEN END_IF', 'bReady', 'BOOL'],
      ['WHILE NOT bStop AND fPos < 10 DO END_WHILE', 'bStop', 'BOOL'],
      ['IF nLimit > 100 THEN END_IF', 'nLimit', 'INT'],
      ['IF fLevel > fPos THEN END_IF', 'fLevel', 'LREAL'],
      ['nCopy := nState;', 'nCopy', 'INT'],
      ['sCopy := sName;', 'sCopy', 'STRING(40)'],
      ['aCopy := aSteps;', 'aCopy', 'ARRAY[0..9] OF INT'],
      ['nStep := aSteps[2];', 'nStep', 'INT'],
      ['fData := stData.fPos;', 'fData', 'LREAL'],
      ['nSum := nState + nOther;', 'nOther', 'INT'],
      ['nNext := nState + 1;', 'nNext', 'INT'],
      ['bBoth := bOpen AND bOther;', 'bOther', 'BOOL'],
      ['eNext := E_ValveState.Opened;', 'eNext', 'E_ValveState'],
      ['fScaled := F_Scale(nRaw := 5);', 'fScaled', 'REAL'],
      ['fbTimer(IN := bStart, PT := tPreset, Q => bElapsed);', 'bStart', 'BOOL'],
      ['fbTimer(IN := bStart, PT := tPreset, Q => bElapsed);', 'tPreset', 'TIME'],
      ['fbTimer(IN := bStart, PT := tPreset, Q => bElapsed);', 'bElapsed', 'BOOL'],
      ['F_Scale(nRaw2);', 'nRaw2', 'INT'],
      ['bOk := M_Open(fTarget := fWanted);', 'fWanted', 'LREAL'],
      ['bOk := M_Open(1);', 'bOk', 'BOOL'],
      ['aSteps[nIdx] := 1;', 'nIdx', 'INT'],
      ['FOR i := 1 TO 10 DO END_FOR', 'i', 'INT'],
      ['CASE nMode OF 1: ; END_CASE', 'nMode', 'INT'],
      ['pPos := ADR(fPos);', 'pPos', 'POINTER TO LREAL'],
      ['bSet S= bOpen;', 'bSet', 'BOOL'],
      ['refData REF= stData;', 'refData', 'REFERENCE TO ST_ValveData'],
      ['fbOther := fbTimer;', 'fbOther', 'TON'],
      // Nothing to go by: BOOL, which XAE's Auto Declare starts with.
      ['nUnclear := nUnknown;', 'nUnclear', 'BOOL'],
      ['fbNew.M_Run();', 'fbNew', 'BOOL'],
    ];
    for (const [text, name, type] of lines) {
      const at = text.indexOf(name);
      const unknown = unknownNameAt(idx, impl, text, at);
      assert.ok(unknown, `${name} in ${text}`);
      assert.deepEqual([unknown.name, unknown.type, unknown.start, unknown.end], [name, type, at, at + name.length], text);
      assert.equal(unknown.fromUse, !text.startsWith('nUnclear') && !text.startsWith('fbNew'), text);
      // At the end of the name (the cursor right after it) as at its start.
      assert.equal(unknownNameAt(idx, impl, text, at + name.length)?.type, type, `${text}, at the end of ${name}`);
    }
    // The first use that tells: nLater is an INT by its second use.
    const two = 'nLater := nLater2;\nnLater := 7;';
    assert.equal(unknownNameAt(idx, impl, two, 0)?.type, 'INT');
    // An action takes the inputs and outputs of its function block.
    const call = 'fbValve.A_Reset(nSpeed := nWanted);';
    const wanted = unknownNameAt(idx, ctxOf('MAIN', 'impl'), call, call.indexOf('nWanted'));
    assert.deepEqual([wanted?.type, wanted?.fromUse], ['INT', true]);
    // Known names, keywords and literals are not unknown.
    assert.equal(unknownNameAt(idx, impl, 'fPos := 1;', 1), undefined);
    assert.equal(unknownNameAt(idx, impl, 'fPos := 1;', 9), undefined);
    // In a declaration: the bounds of an array, the length of a string, an initial value.
    const decl = ctxOf('FB_Valve', 'decl');
    const own = 'FUNCTION_BLOCK FB_Valve\nVAR\n\taBuffer : ARRAY[0..nMax] OF BYTE;\n\tsLine : STRING(nLen);\n\tfStart : LREAL := fHome;\nEND_VAR\n';
    for (const [name, type] of [['nMax', 'INT'], ['nLen', 'INT'], ['fHome', 'LREAL']]) {
      assert.equal(unknownNameAt(idx, decl, own, own.indexOf(name))?.type, type, name);
    }
  });
});

test('the blocks each object can have, and the POU of an action', () => {
  withProject((idx, ctxOf) => {
    const titles = (ctx: SectionContext, text: string) => quickFixes(idx, ctx, text, problemsOf(idx, ctx, text)).map(f => f.title);
    assert.deepEqual(titles(ctxOf('FB_Valve.M_Open', 'impl'), 'bBusy := TRUE;'),
      ['Declare bBusy in VAR', 'Declare bBusy in VAR_INPUT', 'Declare bBusy in VAR_OUTPUT', 'Declare bBusy in VAR_IN_OUT']);
    assert.deepEqual(titles(ctxOf('F_Scale', 'impl'), 'F_Scale := fFactor;'),
      ['Declare fFactor in VAR', 'Declare fFactor in VAR_INPUT', 'Declare fFactor in VAR_OUTPUT', 'Declare fFactor in VAR_IN_OUT']);
    assert.deepEqual(titles(ctxOf('MAIN', 'impl'), 'bRun := TRUE;'), ['Declare bRun in VAR', 'Declare bRun in VAR_INPUT',
      'Declare bRun in VAR_OUTPUT', 'Declare bRun in VAR_IN_OUT', 'Declare bRun in VAR_TEMP']);
    // The Get of a property: its own VAR block.
    const get = ctxOf('FB_Valve.P_Pos', 'impl', 'Get');
    const getFixes = quickFixes(idx, get, 'P_Pos := fShown;', problemsOf(idx, get, 'P_Pos := fShown;'));
    assert.deepEqual(getFixes.map(f => f.title), ['Declare fShown in VAR']);
    assert.ok(getFixes[0].kind === 'declare' && getFixes[0].target.key === `${FB_POS_GET}:decl` && getFixes[0].variable.type === 'LREAL');
    // An action has no declaration: its function block's.
    const action = ctxOf('FB_Valve.A_Reset', 'impl');
    const actionFixes = quickFixes(idx, action, 'bReset := TRUE;', problemsOf(idx, action, 'bReset := TRUE;'));
    assert.deepEqual(actionFixes.map(f => f.title), ['Declare bReset in VAR of FB_Valve', 'Declare bReset in VAR_INPUT of FB_Valve',
      'Declare bReset in VAR_OUTPUT of FB_Valve', 'Declare bReset in VAR_IN_OUT of FB_Valve', 'Declare bReset in VAR_TEMP of FB_Valve']);
    assert.ok(actionFixes[0].kind === 'declare' && actionFixes[0].target.other && actionFixes[0].target.key === `${FB}:decl`);
    // A GVL: VAR_GLOBAL, with the type of the variable it initializes.
    const gvl = ctxOf('GVL_Plant', 'decl');
    const gvlText = "{attribute 'qualified_only'}\nVAR_GLOBAL\n\tnValves : INT := nDefault;\nEND_VAR\n";
    const gvlFixes = quickFixes(idx, gvl, gvlText, problemsOf(idx, gvl, gvlText));
    assert.deepEqual(gvlFixes.map(f => f.kind === 'declare' && `${f.title} : ${f.variable.type}`), ['Declare nDefault in VAR_GLOBAL : INT']);
    // Not in a DUT.
    const dut = ctxOf('ST_ValveData', 'decl');
    const dutText = 'TYPE ST_ValveData :\nSTRUCT\n\tfPos : LREAL := fHome;\nEND_STRUCT\nEND_TYPE\n';
    assert.equal(problemsOf(idx, dut, dutText).length, 1);
    assert.deepEqual(quickFixes(idx, dut, dutText, problemsOf(idx, dut, dutText)), []);
  });
});

test('an unknown member of a function block or interface of the workspace: add a method or a property', () => {
  withProject((idx, ctxOf) => {
    const main = ctxOf('MAIN', 'impl');
    const fixes = (text: string) => quickFixes(idx, main, text, problemsOf(idx, main, text)).map(f =>
      f.kind === 'member' ? `${f.title}${f.preferred ? ' (preferred)' : ''}: ${f.member} ${f.type ?? '-'}` : f.title);
    assert.deepEqual(fixes('fbValve.M_Reset();'),
      ['Add method M_Reset to FB_Valve (preferred): method -', 'Add property M_Reset to FB_Valve: property BOOL']);
    assert.deepEqual(fixes('IF fbValve.M_Ready() THEN END_IF'),
      ['Add method M_Ready to FB_Valve (preferred): method BOOL', 'Add property M_Ready to FB_Valve: property BOOL']);
    assert.deepEqual(fixes('fbValve.P_Speed := 2.5;'),
      ['Add property P_Speed to FB_Valve (preferred): property LREAL', 'Add method P_Speed to FB_Valve: method LREAL']);
    assert.deepEqual(fixes('nCount := fbValve.P_Cycles;'),
      ['Add property P_Cycles to FB_Valve (preferred): property DINT', 'Add method P_Cycles to FB_Valve: method DINT']);
    assert.deepEqual(fixes('iValve.M_Open();'),
      ['Add method M_Open to I_Valve (preferred): method -', 'Add property M_Open to I_Valve: property BOOL']);
    // Where it is: the file and object of FB_Valve.
    const [fix] = quickFixes(idx, main, 'fbValve.M_Reset();', problemsOf(idx, main, 'fbValve.M_Reset();'));
    assert.ok(fix.kind === 'member');
    const owner = fix.owner.loc && idx.context(fix.owner.loc.fileKey, fix.owner.loc.sectionKey);
    assert.equal(owner?.object.id, FB);
    assert.match(owner?.filePath ?? '', /FB_Valve\.TcPOU$/);
    // Members it has, and members of a library function block, are no problem.
    assert.deepEqual(fixes('fbValve.M_Open(1); fbValve.fbTimer.Q := TRUE;'), []);
  });
});

test('Auto Declare... starts with the unknown name at the cursor, its type and the blocks of the object', () => {
  withProject((idx, ctxOf) => {
    const impl = ctxOf('FB_Valve', 'impl');
    const start = autoDeclareStart(idx, impl, 'nCount := 5;', 3)!;
    assert.deepEqual([start.name, start.type, start.target.key], ['nCount', 'INT', `${FB}:decl`]);
    assert.deepEqual(start.scopes.map(scopeLabel),
      ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR CONSTANT', 'VAR RETAIN', 'VAR PERSISTENT']);
    // On a known name or none: an empty name, and BOOL.
    assert.deepEqual([autoDeclareStart(idx, impl, 'fPos := 5;', 1)?.name, autoDeclareStart(idx, impl, 'fPos := 5;', 1)?.type], ['', 'BOOL']);
    assert.equal(autoDeclareStart(idx, impl, '', 0)?.name, '');
    assert.deepEqual(autoDeclareStart(idx, ctxOf('FB_Valve.M_Open', 'impl'), '', 0)?.scopes.map(scopeLabel),
      ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR CONSTANT', 'VAR_INST']);
    assert.deepEqual(autoDeclareStart(idx, ctxOf('GVL_Plant', 'decl'), '', 0)?.scopes.map(scopeLabel),
      ['VAR_GLOBAL', 'VAR_GLOBAL CONSTANT', 'VAR_GLOBAL RETAIN', 'VAR_GLOBAL PERSISTENT']);
    assert.equal(autoDeclareStart(idx, ctxOf('FB_Valve.A_Reset', 'impl'), '', 0)?.target.other, true);
    assert.equal(autoDeclareStart(idx, ctxOf('E_ValveState', 'decl'), '', 0), undefined);
    assert.equal(autoDeclareStart(idx, ctxOf('I_Valve', 'decl'), '', 0), undefined);
  });
});

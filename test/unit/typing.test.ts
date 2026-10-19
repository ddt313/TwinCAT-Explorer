import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TcWorkspace } from '../../src/core/workspace';
import { LanguageIndex, SectionContext } from '../../src/lang/index';
import { Analyzer, analyze } from '../../src/lang/analyzer';
import { callArguments, callSnippet, callableOfSymbol, findCall, returnsValue, signatureAt } from '../../src/lang/calls';
import { completionContext } from '../../src/lang/completion';
import { snippetPreview, snippetsAt } from '../../src/lang/snippets';
import { BUNDLED_STUBS } from '../../src/lang/stubs';

// A PLC project with a function block that extends another, a function and a program that uses them.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-typing-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
let guid = 0;
const nextId = () => `{dddddddd-0000-4000-8000-${String(++guid).padStart(12, '0')}}`;
const pou = (name: string, decl: string, members = '') => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="${nextId()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>${members}
  </POU>
</TcPlcObject>`;
const method = (name: string, decl: string) => `
    <Method Name="${name}" Id="${nextId()}">
      <Declaration><![CDATA[${decl}]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>`;
const action = (name: string) => `
    <Action Name="${name}" Id="${nextId()}">
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Action>`;

write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${['FB_Base', 'FB_Valve', 'F_Scale', 'PRG_Dosing', 'MAIN'].map(n => `
    <Compile Include="POUs\\${n}.TcPOU"><SubType>Code</SubType></Compile>`).join('')}
  </ItemGroup>
</Project>`);
write('A/Plc/POUs/FB_Base.TcPOU', pou('FB_Base', `FUNCTION_BLOCK FB_Base
VAR_INPUT
	bEnable : BOOL; // Enables the device
END_VAR
VAR_OUTPUT
	bError : BOOL;
END_VAR`));
write('A/Plc/POUs/FB_Valve.TcPOU', pou('FB_Valve', `// A valve that opens after a delay
FUNCTION_BLOCK FB_Valve EXTENDS FB_Base
VAR_INPUT
	bOpen : BOOL; // Opens the valve
	tDelay : TIME := T#2S;
END_VAR
VAR_OUTPUT
	bIsOpen : BOOL;
END_VAR
VAR_IN_OUT
	nCycles : UDINT;
END_VAR
VAR
	nCount : INT;
END_VAR`, method('Open', `// Opens the valve to a position
METHOD Open : BOOL
VAR_INPUT
	nPos : INT; // Position in percent
	bForce : BOOL := FALSE;
END_VAR`) + method('Reset', 'METHOD Reset') + method('FB_init', `METHOD FB_init : BOOL
VAR_INPUT
	bInitRetains : BOOL;
	bInCopyCode : BOOL;
	nId : INT;
END_VAR`) + action('A_Close')));
write('A/Plc/POUs/F_Scale.TcPOU', pou('F_Scale', `FUNCTION F_Scale : LREAL
VAR_INPUT
	fIn : LREAL;
	fMin : LREAL;
	fMax : LREAL := 100;
END_VAR`));
write('A/Plc/POUs/PRG_Dosing.TcPOU', pou('PRG_Dosing', `PROGRAM PRG_Dosing
VAR_INPUT
	nRecipe : INT;
END_VAR`));
write('A/Plc/POUs/MAIN.TcPOU', pou('MAIN', `PROGRAM MAIN
VAR
	fbTimer : TON;
	fbValve : FB_Valve;
	refValve : REFERENCE TO FB_Valve;
	fValue : LREAL;
	bStart : BOOL;
	nCycles : UDINT;
END_VAR`));

const ws = new TcWorkspace();
ws.load([path.join(root, 'A/A.tsproj')]);
const index = new LanguageIndex(ws);
index.setStubs(BUNDLED_STUBS);
const section = (object: string, role: 'decl' | 'impl') => index.allContexts().find(c => c.object.name === object && c.role === role)!;

/** The signature at the `|` of the text, its active parameter as shown in the label. */
function help(text: string, ctx: SectionContext = section('MAIN', 'impl')) {
  const s = signatureAt(index, ctx, text.replace('|', ''), text.indexOf('|'));
  if (!s) return undefined;
  const range = s.params[s.active];
  return { label: s.label, active: range ? s.label.slice(range[0], range[1]) : undefined };
}

test('signature help of a function block instance: the inputs as declared, then the outputs with =>', () => {
  assert.deepEqual(help('fbTimer(|'), { label: 'fbTimer(IN : BOOL, PT : TIME, Q => BOOL, ET => TIME)', active: 'IN : BOOL' });
  assert.equal(help('fbTimer(IN := bStart, |')?.active, 'PT : TIME');
  assert.equal(help('fbTimer(IN := bStart, PT := T#1S, ET => |')?.active, 'ET => TIME');
  // The named parameter being typed, the value of one, an expression in parentheses or a call inside one.
  assert.equal(help('fbTimer(IN := bStart, P|')?.active, 'PT : TIME');
  assert.equal(help('fbTimer(et|')?.active, 'ET => TIME');
  assert.equal(help('fbTimer(bStart, ET =|')?.active, 'ET => TIME');
  assert.equal(help('fbTimer(PT :|')?.active, 'PT : TIME');
  assert.equal(help('fbTimer(PT := T#1S, IN := (bStart AND NOT bStart|')?.active, 'IN : BOOL');
  assert.equal(help('fbTimer(IN := bStart, PT := T#1S, |')?.active, 'Q => BOOL');
  assert.equal(help('fbTimer(PT := T#1S, |')?.active, 'Q => BOOL');
  assert.equal(help('fbTimer(\n\tIN := bStart,\n\t// IN, PT\n\t|')?.active, 'PT : TIME');
  // Inherited parameters first, in-outs with the inputs, initial values; NOT before an output.
  assert.deepEqual(help('fbValve(NOT bIsOpen => |'), {
    label: 'fbValve(bEnable : BOOL, bOpen : BOOL, tDelay : TIME := T#2S, nCycles : UDINT, bError => BOOL, bIsOpen => BOOL)',
    active: 'bIsOpen => BOOL',
  });
  assert.equal(help('refValve(bOpen := TRUE, |')?.active, 'tDelay : TIME := T#2S');
  assert.equal(help('stData.aValves[i](|'), undefined);
});

test('signature help of functions, methods, actions, FB_init and built-ins', () => {
  assert.deepEqual(help('fValue := F_Scale(fValue, 0, |'), { label: 'F_Scale(fIn : LREAL, fMin : LREAL, fMax : LREAL := 100) : LREAL', active: 'fMax : LREAL := 100' });
  assert.equal(help('fbTimer(IN := F_Scale(|')?.active, 'fIn : LREAL');
  assert.deepEqual(help('fValue := F_Scale(fValue, 0, 10, |'), { label: 'F_Scale(fIn : LREAL, fMin : LREAL, fMax : LREAL := 100) : LREAL', active: undefined });
  assert.deepEqual(help('IF fbValve.Open(|'), { label: 'Open(nPos : INT, bForce : BOOL := FALSE) : BOOL', active: 'nPos : INT' });
  assert.equal(help('refValve.Open(nPos := 50, |')?.active, 'bForce : BOOL := FALSE');
  assert.equal(help('fbValve.Reset(|')?.label, 'Reset()');
  // An action takes the inputs and outputs of its function block.
  assert.equal(help('fbValve.A_Close(bOpen := FALSE, |')?.label,
    'A_Close(bEnable : BOOL, bOpen : BOOL, tDelay : TIME := T#2S, nCycles : UDINT, bError => BOOL, bIsOpen => BOOL)');
  // Inside the function block: its methods, THIS^ and SUPER^.
  const fb = section('FB_Valve', 'impl');
  assert.equal(help('Open(|', fb)?.label, 'Open(nPos : INT, bForce : BOOL := FALSE) : BOOL');
  assert.equal(help('THIS^.Open(nPos := 1, |', fb)?.active, 'bForce : BOOL := FALSE');
  assert.equal(help('SUPER^(|', fb)?.label, 'SUPER^(bEnable : BOOL, bError => BOOL)');
  // The arguments of FB_init in a declaration, without those TwinCAT passes itself.
  assert.deepEqual(help('PROGRAM MAIN\nVAR\n\tfbOther : FB_Valve(|', section('MAIN', 'decl')), { label: 'FB_Valve(nId : INT)', active: 'nId : INT' });
  assert.equal(help('fbOther : FB_Valve(|'), undefined);
  // Built-ins, one taking any number of arguments.
  assert.deepEqual(help('fValue := LIMIT(0, |'), { label: 'LIMIT(min, in, max)', active: 'in' });
  assert.equal(help('fValue := MAX(1, 2, 3, |')?.active, '...');
  assert.equal(help('fValue := DINT_TO_LREAL(|')?.label, 'DINT_TO_LREAL(in) : LREAL');
});

test('no signature help outside of a call', () => {
  for (const text of [
    "sText := 'fbTimer(|", '// fbTimer(|', '(* fbTimer(IN := |', 'IF (bStart AND |', 'fbTimer(IN := bStart);|',
    'fbTimer(IN := bStart;\nbStart := |', 'fbTi|mer(', 'nUnknown(|', 'fbValve.bOpen(|',
  ]) {
    assert.equal(help(text), undefined, text);
  }
  // The call goes on after a comment that is closed.
  assert.equal(help('fbTimer(IN := bStart, (* IN *) |')?.active, 'PT : TIME');
});

test('the call the cursor is in: what is called and the arguments before', () => {
  const at = (text: string) => findCall(text.replace('|', ''), text.indexOf('|'));
  assert.deepEqual(at('fbTimer(IN := x, PT := 5, |'), { callee: 'fbTimer', before: ['IN', 'PT'], current: {} });
  assert.deepEqual(at('aPumps[i MOD 2].fb(1, |'), { callee: 'aPumps[i MOD 2].fb', before: [undefined], current: {} });
  assert.deepEqual(at('THIS^ . Open(nPos|'), { callee: 'THIS^.Open', before: [], current: { typing: 'nPos' } });
  assert.deepEqual(at('GetPump(1)^.Start(NOT bBusy => |'), { callee: 'GetPump(1)^.Start', before: [], current: { name: 'bBusy' } });
});

test('a call completes with all its parameters, as a statement with ;', () => {
  const main = section('MAIN', 'impl');
  const analyzer = new Analyzer(index, main, '');
  const callable = (name: string) => {
    const r = analyzer.listScope().find(x => x.sym.name === name)!;
    return callableOfSymbol(analyzer, r.sym, r.ty);
  };
  const timer = callable('fbTimer')!;
  assert.equal(callSnippet(timer, 'fbTimer', true), 'fbTimer(IN := ${1}, PT := ${2}, Q => ${3}, ET => ${4});');
  assert.equal(callArguments(timer), '(IN := , PT := , Q => , ET => )');
  assert.equal(returnsValue(timer), false);
  const scale = callable('F_Scale')!;
  assert.equal(callSnippet(scale, 'F_Scale', false), 'F_Scale(fIn := ${1}, fMin := ${2}, fMax := ${3})');
  assert.equal(returnsValue(scale), true);
  assert.equal(callSnippet(callable('fbValve')!, 'fbValve', true),
    'fbValve(bEnable := ${1}, bOpen := ${2}, tDelay := ${3}, nCycles := ${4}, bError => ${5}, bIsOpen => ${6});');
  assert.ok(callSnippet(callable('refValve')!, 'refValve', true).startsWith('refValve(bEnable := ${1}, '));
  // What is not called: a value, a function block type, the program itself.
  assert.equal(callable('fValue'), undefined);
  assert.equal(callable('FB_Valve'), undefined);
  assert.equal(callable('MAIN'), undefined);
  assert.equal(callSnippet(callable('PRG_Dosing')!, 'PRG_Dosing', true), 'PRG_Dosing(nRecipe := ${1});');
  // Members: methods and actions of an instance.
  const members = analyzer.listMembers(analyzer.typeOfText('fbValve'));
  const member = (name: string) => {
    const r = members.find(x => x.sym.name === name)!;
    return callableOfSymbol(analyzer, r.sym, r.ty)!;
  };
  assert.equal(callSnippet(member('Open'), 'Open', false), 'Open(nPos := ${1}, bForce := ${2})');
  assert.equal(callSnippet(member('Reset'), 'Reset', true), 'Reset();');
  assert.equal(returnsValue(member('Reset')), false);
  assert.equal(member('A_Close').params.length, 6);
});

test('where a completed call is a statement of its own', () => {
  const at = (text: string) => completionContext(text.replace('|', ''), text.indexOf('|'));
  for (const text of ['fbTi|', 'x := 1;\n\tfbTi|', 'IF bStart THEN\n\tfbTi|', 'CASE n OF\n\t1: fbTi|', 'END_IF\nfbValve.Op|', 'fbTi| // starts']) {
    assert.equal(at(text).statement, true, text);
  }
  for (const text of ['x := fbTi|', 'IF fbValve.Op|', 'fbTi| := 1;', 'x := 1 + fbValve.Op|']) {
    assert.equal(at(text).statement, false, text);
  }
  assert.equal(at('fbTi|(IN := TRUE);').callFollows, true);
  assert.equal(at('x := 1; // fbTi|').inComment, true);
  assert.equal(at("s := 'fbTi|").inComment, true);
  assert.deepEqual(at('\t{reg|}').brace, { start: 1, end: 6 });
  assert.equal(at('\t{reg|}').lineStart, true);
  assert.equal(at('x := 1; reg|').lineStart, false);
});

test('statement and region snippets, in upper case', () => {
  const at = (role: 'decl' | 'impl', text: string) => snippetsAt(role, completionContext(text.replace('|', ''), text.indexOf('|')));
  const labels = (role: 'decl' | 'impl', text: string) => at(role, text).map(s => s.label);
  assert.deepEqual(labels('impl', 'x := 1;\nI|'),
    ['IF', 'IF ELSE', 'IF ELSIF ELSE', 'ELSIF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'region', 'endregion']);
  assert.deepEqual(labels('impl', 'x := I|'), []);
  assert.deepEqual(labels('impl', '// I|'), []);
  assert.deepEqual(labels('decl', 'VAR\n\tr|'), ['region', 'endregion']);
  const region = at('decl', 'VAR\n\t{re|}')[0];
  assert.deepEqual({ range: region.range, filterText: region.filterText }, { range: { start: 5, end: 9 }, filterText: '{region' });
  const preview = (label: string) => at('impl', '|').find(s => s.label === label)!.preview;
  assert.equal(preview('IF ELSIF ELSE'), 'IF condition THEN\n\t\nELSIF condition THEN\n\t\nELSE\n\t\nEND_IF');
  assert.equal(preview('CASE'), 'CASE expression OF\n\t0:\n\t\t\nEND_CASE');
  assert.equal(preview('FOR'), 'FOR i := 1 TO 10 DO\n\t\nEND_FOR');
  assert.equal(preview('WHILE'), 'WHILE condition DO\n\t\nEND_WHILE');
  assert.equal(preview('REPEAT'), 'REPEAT\n\t\nUNTIL condition\nEND_REPEAT');
  assert.equal(preview('region'), '{region "name"}\n\n{endregion}');
  assert.equal(snippetPreview('a \\$1 \\} ${2}$0'), 'a $1 } ');
});

test('an action called with the inputs of its function block has no unknown parameters', () => {
  const main = section('MAIN', 'impl');
  const problems = analyze(index, main, 'fbValve.A_Close(bOpen := FALSE, bEnable := TRUE, bIsOpen => bStart, nCycles := nCycles);\n'
    + 'fbValve.A_Close(bShut := TRUE);').problems.map(p => p.message);
  assert.deepEqual(problems, ["Unknown parameter 'bShut'"]);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../../src/lang/analyzer';
import { Highlight, highlightsAcross } from '../../src/lang/highlights';
import { LanguageIndex } from '../../src/lang/index';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { TcWorkspace, fileKey } from '../../src/core/workspace';

/** The highlights at the `|` of a text, as the highlighted texts with their kinds (`END_IF`, `bOk:write`). */
function at(marked: string, analysisOf?: (text: string) => ReturnType<typeof analyze>): string[] {
  const offset = marked.indexOf('|');
  const text = marked.replace('|', '');
  return highlightsAcross({ analysis: analysisOf?.(text), text }, offset, []).own.map((h: Highlight) =>
    text.slice(h.start, h.end) + (h.kind === 'text' ? '' : ':' + h.kind));
}

const IMPL = `IF bA THEN
	FOR i := 1 TO 10 BY 2 DO
		IF bB THEN
			EXIT;
		ELSIF bC THEN
			CONTINUE;
		END_IF
	END_FOR
ELSIF bD THEN
	CASE nState OF
		1: nState := 2;
	ELSE
		REPEAT
			nState := nState + 1;
			IF nState > 5 THEN EXIT; END_IF
		UNTIL nState > 10
		END_REPEAT
	END_CASE
ELSE
	WHILE bA DO bA := FALSE; END_WHILE
END_IF`;

const mark = (text: string, find: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(find, i + 1);
  assert.ok(i >= 0, find);
  return text.slice(0, i) + '|' + text.slice(i);
};

test('the keywords of the block at the cursor', () => {
  const outer = ['IF', 'THEN', 'ELSIF', 'THEN', 'ELSE', 'END_IF'];
  assert.deepEqual(at(mark(IMPL, 'IF bA')), outer);
  assert.deepEqual(at(mark(IMPL, 'END_IF', 2)), outer);
  assert.deepEqual(at(mark(IMPL, 'ELSIF bD')), outer);
  // Right after the keyword counts too.
  assert.deepEqual(at(mark(IMPL, ' bA THEN')), outer);
  // EXIT and CONTINUE belong to the innermost loop, not to the IF they are in.
  assert.deepEqual(at(mark(IMPL, 'FOR')), ['FOR', 'TO', 'BY', 'DO', 'EXIT', 'CONTINUE', 'END_FOR']);
  assert.deepEqual(at(mark(IMPL, 'IF bB')), ['IF', 'THEN', 'ELSIF', 'THEN', 'END_IF']);
  assert.deepEqual(at(mark(IMPL, 'EXIT')), ['FOR', 'TO', 'BY', 'DO', 'EXIT', 'CONTINUE', 'END_FOR']);
  // The ELSE of a CASE, and a loop with an EXIT before its UNTIL.
  assert.deepEqual(at(mark(IMPL, 'CASE')), ['CASE', 'OF', 'ELSE', 'END_CASE']);
  assert.deepEqual(at(mark(IMPL, 'UNTIL')), ['REPEAT', 'EXIT', 'UNTIL', 'END_REPEAT']);
  assert.deepEqual(at(mark(IMPL, 'WHILE')), ['WHILE', 'DO', 'END_WHILE']);
  // Any case, as ST ignores it.
  assert.deepEqual(at('|if x then y := 1; end_if'), ['if', 'then', 'end_if']);
});

test('the keywords of declarations, and blocks left open', () => {
  const decl = 'TYPE ST_Axis :\nSTRUCT\n\tfPos : LREAL;\nEND_STRUCT\nEND_TYPE';
  assert.deepEqual(at(mark(decl, 'STRUCT')), ['STRUCT', 'END_STRUCT']);
  assert.deepEqual(at(mark(decl, 'END_TYPE')), ['TYPE', 'END_TYPE']);
  assert.deepEqual(at('|VAR_INPUT CONSTANT\n\tx : INT;\nEND_VAR\nVAR\nEND_VAR'), ['VAR_INPUT', 'END_VAR']);
  // An IF being typed: the END_IF closes the innermost one, the outer one is left open.
  assert.deepEqual(at('IF a THEN\n\t|IF b THEN\nEND_IF'), ['IF', 'THEN', 'END_IF']);
  assert.deepEqual(at('|IF a THEN\n\tIF b THEN\nEND_IF'), ['IF', 'THEN']);
  // Keywords in comments and strings are none.
  assert.deepEqual(at("|IF a THEN // END_IF\n\ts := 'ELSE';\n(* ELSE *)\nEND_IF"), ['IF', 'THEN', 'END_IF']);
});

test('an identifier the analysis does not know: the same one, in any case', () => {
  assert.deepEqual(at('|nCount := NCOUNT + 1; // nCount'), ['nCount', 'NCOUNT']);
  // Other keywords highlight nothing.
  assert.deepEqual(at('x := a |AND b AND c;'), []);
});

test('the occurrences of the symbol at the cursor, written or read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-highlights-'));
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
  <ItemGroup><Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile></ItemGroup>
</Project>`);
    write('A/Plc/POUs/MAIN.TcPOU', `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="MAIN" Id="{dddddddd-0000-4000-8000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
	fbTimer : TON;
	bDone : BOOL;
	aPos : ARRAY[1..3] OF LREAL;
	i : INT;
END_VAR
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
    const ctx = index.context(fileKey(path.join(root, 'A/Plc/POUs/MAIN.TcPOU')), 'dddddddd-0000-4000-8000-000000000001:impl')!;
    const analysisOf = (text: string) => analyze(index, ctx, text);
    const st = `fbTimer(IN := NOT bDone, PT := T#1S, Q => bDone);
IF fbTimer.Q THEN
	bDone := TRUE;
END_IF
FOR i := 1 TO 3 DO
	aPos[i] := aPos[i] + fbTimer.ET;
END_FOR`;
    assert.deepEqual(at(mark(st, 'bDone'), analysisOf), ['bDone:read', 'bDone:write', 'bDone:write']);
    // aPos[i] := ... writes aPos, the aPos[i] it adds to is read; i is read in the indexes.
    assert.deepEqual(at(mark(st, 'aPos'), analysisOf), ['aPos:write', 'aPos:read']);
    assert.deepEqual(at(mark(st, 'i :='), analysisOf), ['i:write', 'i:read', 'i:read']);
    // A member: only the instance's output, not the input written in the call.
    assert.deepEqual(at(mark(st, 'Q THEN'), analysisOf), ['Q:read', 'Q:read']);
    // Of fbTimer.Q only Q would be written; fbTimer is read.
    assert.deepEqual(at(mark('fbTimer.IN := TRUE;\nfbTimer();', 'fbTimer'), analysisOf), ['fbTimer:read', 'fbTimer:read']);
    assert.deepEqual(at(mark('fbTimer.IN := TRUE;', 'IN'), analysisOf), ['IN:write']);

    // The declaration pane shows the uses there too: the declaration of a variable used in the implementation.
    const declKey = 'dddddddd-0000-4000-8000-000000000001:decl';
    const declCtx = index.context(ctx.fileKey, declKey)!;
    const declText = index.sectionText(ctx.fileKey, declKey)!;
    const decl = { analysis: analyze(index, declCtx, declText), text: declText };
    const across = (marked: string, other: { analysis: ReturnType<typeof analyze> | undefined; text: string }) => {
      const text = marked.replace('|', '');
      const r = highlightsAcross({ analysis: analysisOf(text), text }, marked.indexOf('|'), [other]);
      return r.others[0].map(h => other.text.slice(h.start, h.end) + ':' + h.kind);
    };
    assert.deepEqual(across(mark(st, 'bDone'), decl), ['bDone:write']);
    assert.deepEqual(across(mark(st, 'aPos'), decl), ['aPos:write']);
    // A keyword's block stays in its pane.
    assert.deepEqual(across(mark(st, 'IF'), decl), []);
    // An identifier the analysis does not know: the same one there.
    assert.deepEqual(across('|nUnknown := 1;', { analysis: undefined, text: 'nunknown := NOT NUNKNOWN; // nUnknown' }),
      ['nunknown:text', 'NUNKNOWN:text']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

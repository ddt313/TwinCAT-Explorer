import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseBody, parseDeclaration } from '../../src/lang/parser';

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

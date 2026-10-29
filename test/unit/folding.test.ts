import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { foldingRanges } from '../../src/lang/folding';

/** The folds of a text as `start-end` (1-based lines, as editors number them), `:kind` for comments and regions. */
const folds = (lines: string[]) =>
  foldingRanges(lines.join('\n')).map(f => `${f.startLine + 1}-${f.endLine + 1}${f.kind ? ':' + f.kind : ''}`);

test('blocks fold up to the line before their next part, whatever their indentation', () => {
  assert.deepEqual(folds([
    'IF bStart THEN',             // 1
    '    nState := 1;',           // 2
    '  x := 2;',                  // 3
    'ELSIF bStop THEN',           // 4
    'nState := 0;',               // 5
    'ELSE',                       // 6
    '    FOR i := 1 TO 10 DO',    // 7
    '        a[i] := 0;',         // 8
    '    END_FOR',                // 9
    'END_IF',                     // 10
  ]), ['1-3', '4-5', '6-9', '7-8']);
  // CASE with its ELSE, REPEAT up to its UNTIL, WHILE.
  assert.deepEqual(folds([
    'CASE nState OF',             // 1
    '    1: x := 1;',             // 2
    '    2: x := 2;',             // 3
    'ELSE',                       // 4
    '    REPEAT',                 // 5
    '        x := x + 1;',        // 6
    '    UNTIL x > 5',            // 7
    '    END_REPEAT',             // 8
    'END_CASE',                   // 9
    'WHILE b DO',                 // 10
    '    b := FALSE;',            // 11
    'END_WHILE',                  // 12
  ]), ['1-3', '4-8', '5-6', '10-11']);
});

test('declarations, comments and regions', () => {
  assert.deepEqual(folds([
    'FUNCTION_BLOCK FB_Axis',     // 1
    'VAR_INPUT',                  // 2
    '    bEnable : BOOL;',        // 3
    '    (* The target,',         // 4
    '       in mm *)',            // 5
    '    fPos : LREAL;',          // 6
    'END_VAR',                    // 7
    '{region "State"}',           // 8
    'VAR',                        // 9
    '    nState : INT;',          // 10
    'END_VAR',                    // 11
    '{endregion}',                // 12
  ]), ['2-6', '4-5:comment', '8-12:region', '9-10']);
  assert.deepEqual(folds([
    'TYPE ST_Axis :',             // 1
    'STRUCT',                     // 2
    '    fPos : LREAL;',          // 3
    'END_STRUCT',                 // 4
    'END_TYPE',                   // 5
  ]), ['1-4', '2-3']);
});

test('nothing to fold on one line, in a block being typed, or in comments and strings', () => {
  assert.deepEqual(folds(['IF a THEN b := 1; END_IF', 'IF c THEN', '    d := 1;']), []);
  assert.deepEqual(folds(['// IF a THEN', "s := 'END_IF';", 'x := 1;']), []);
});

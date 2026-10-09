import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ObjectTextError, applyChanges, duplicateKeys, formatObjectText, headerOf, mapOffset, offsetIn, parseObjectText, positionIn,
} from '../../src/core/objectText';
import { stripJsonc, parseJsonc } from '../../src/core/jsonc';
import { parseTmTheme } from '../../src/core/tmTheme';

test('the text form refuses damaged documents and text that would look like a marker', () => {
  assert.throws(() => parseObjectText('METHOD X'), ObjectTextError);
  assert.throws(() => parseObjectText('\uE000twincat-object {broken'), ObjectTextError);
  const header = { v: 1 as const, label: 'X', kind: 'method', sections: [{ key: 'a:decl', role: 'decl' as const, label: 'Declaration', editable: true }] };
  assert.throws(() => formatObjectText(header, [{ key: 'a:decl', text: 'x\n\uE000section b:impl\ny' }]), ObjectTextError);
  // Empty sections and sections ending with a line break keep their exact text.
  const text = formatObjectText({ ...header, sections: [...header.sections, { key: 'a:impl', role: 'impl', label: 'Implementation', editable: true }] },
    [{ key: 'a:decl', text: '' }, { key: 'a:impl', text: 'x := 1;\n' }]);
  assert.deepEqual(parseObjectText(text).sections.map(s => s.text), ['', 'x := 1;\n']);
});

test('webview edits are applied in any order and checked against the text', () => {
  assert.equal(applyChanges('abcdef', [{ offset: 1, length: 1, text: 'X' }, { offset: 4, length: 2, text: '' }]), 'aXcd');
  assert.equal(applyChanges('abcdef', [{ offset: 4, length: 2, text: '' }, { offset: 1, length: 1, text: 'X' }]), 'aXcd');
  assert.equal(applyChanges('abc', [{ offset: 2, length: 5, text: '' }]), undefined);
  assert.equal(applyChanges('abc', [{ offset: 0, length: 2, text: 'y' }, { offset: 1, length: 1, text: 'z' }]), undefined, 'overlapping changes');
});

test('offsets map to lines and back; copied sections are found', () => {
  const text = 'a := 1;\nb := 2;';
  assert.deepEqual(positionIn(text, 9), { line: 1, character: 1 });
  assert.equal(offsetIn(text, 1, 1), 9);
  assert.equal(offsetIn(text, 0, 99), 7, 'clamped to the end of the line');
  assert.deepEqual(duplicateKeys([{ key: 'a' }, { key: 'b' }, { key: 'a' }]), ['a']);
  // Offsets of the index text mapped onto the text an editor shows (an inserted line above, an edited line).
  const indexText = 'VAR\n\tnA : INT;\n\tnB : INT;\nEND_VAR';
  const shown = 'VAR\n\tnNew : BOOL;\n\tnA : INT;\n\tnB : INT;\nEND_VAR';
  assert.equal(shown.slice(mapOffset(indexText, shown, indexText.indexOf('nB')), mapOffset(indexText, shown, indexText.indexOf('nB')) + 2), 'nB');
  assert.equal(mapOffset(indexText, shown, 2), 2, 'before the change');
  assert.equal(mapOffset(indexText, indexText, 7), 7);
  const h = headerOf('X', 'method', [], t => t, 'abc123');
  assert.equal(parseObjectText(formatObjectText(h, [])).header.load, 'abc123');
});

test('theme files: comments, trailing commas and .tmTheme settings', () => {
  const jsonc = '{\n // comment\n "a": "http://x", /* block */ "b": [1, 2,],\n "c": "x,}",\n}';
  assert.deepEqual(parseJsonc(jsonc), { a: 'http://x', b: [1, 2], c: 'x,}' });
  assert.equal(stripJsonc('"\\"//"'), '"\\"//"');
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array>
    <dict><key>settings</key><dict><key>foreground</key><string>#FFFFFF</string></dict></dict>
    <dict><key>scope</key><string>comment, string</string><key>settings</key><dict><key>fontStyle</key><string>italic</string><key>foreground</key><string>#00ff00</string></dict></dict>
  </array></dict></plist>`;
  assert.deepEqual(parseTmTheme(plist), [
    { scope: undefined, settings: { foreground: '#FFFFFF' } },
    { scope: 'comment, string', settings: { fontStyle: 'italic', foreground: '#00ff00' } },
  ]);
});

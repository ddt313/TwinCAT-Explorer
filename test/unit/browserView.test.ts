// The object view of the browser extension (browser/src): which objects of a TwinCAT file a pull request
// changed, the line diff of their sections and the XML line of each changed line, where the review threads go in
// it, and when a navigation turns a view off, on made-up files and made-up comments; and how often a page's commits
// are looked for.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ReviewThread, currentPosition, placeThreads, threadsOfFile } from '../../browser/src/comments';
import { commitsInPage, compareGithubPaths, filesInDiff, filesPage, githubDiffStyle, githubRawTemplate, pullDiffUrl, reviewCommentsUrl, shaKeys, threadsFromGithub } from '../../browser/src/github';
import {
  commitsFromDiffRefs, compareApi, compareGitlabPaths, discussionsUrl, filesFromApi, gitlabDiffStyle, gitlabRawTemplate, gitlabTheme, isChangesTab, isPartialView, mergeRequestApi,
  mergeRequestPage, noteUrl, rapidFileData, rapidLineAnchor, threadsFromGitlab,
} from '../../browser/src/gitlab';
import { Edit, diffLines, lineChange } from '../../browser/src/lineDiff';
import { Lookup } from '../../browser/src/lookup';
import { DiffLine, FileInput, FileView, ObjectView, buildFileView, hasObjectView, isTwinCatFile, splitRows } from '../../browser/src/model';
import { ViewState, anchorId, leaveFor, noteOfAnchor } from '../../browser/src/navigation';
import { TreeParams, ViewerParams, decodeTreeParams, decodeViewerParams, encodeTreeParams, encodeViewerParams, fileUrl } from '../../browser/src/params';
import { fetchAllowed } from '../../browser/src/protocol';
import { TreeNode, buildTree, treeSummary } from '../../browser/src/treeModel';
import { parseTcText } from '../../src/core/tcfile';

const POU = '{a1000000-0000-0000-0000-000000000001}';
const INIT = '{a1000000-0000-0000-0000-000000000002}';
const OPEN = '{a1000000-0000-0000-0000-000000000003}';
const CLOSE = '{a1000000-0000-0000-0000-000000000004}';
const RESET = '{a1000000-0000-0000-0000-000000000005}';
const STATE = '{a1000000-0000-0000-0000-000000000006}';
const GET = '{a1000000-0000-0000-0000-000000000007}';
const SET = '{a1000000-0000-0000-0000-000000000008}';
const DRAW = '{a1000000-0000-0000-0000-000000000009}';

interface Valve {
  version?: string;
  initName?: string;
  openImpl?: string;
  close?: boolean;
  reset?: boolean;
  getImpl?: string;
  set?: boolean;
  cfc?: string;
  lineIds?: string;
  crlf?: boolean;
}

function method(id: string, name: string, decl: string, impl: string): string {
  return `
    <Method Name="${name}" Id="${id}">
      <Declaration><![CDATA[${decl}]]></Declaration>
      <Implementation>
        <ST><![CDATA[${impl}]]></ST>
      </Implementation>
    </Method>`;
}

/** A made-up function block with methods, a property with Get and Set and a CFC action. */
function valve(o: Valve = {}): string {
  const init = o.initName ?? 'Init';
  const text = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="${o.version ?? '3.1.4026.12'}">
  <POU Name="FB_Valve" Id="${POU}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Valve
VAR_INPUT
	bOpen : BOOL;
END_VAR
VAR
	nCycles : UDINT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[IF bOpen THEN
	Open(bForce := FALSE);
END_IF]]></ST>
    </Implementation>${
  method(INIT, init, `METHOD ${init} : BOOL`, `nCycles := 0;\n${init} := TRUE;`)}${
  method(OPEN, 'Open', 'METHOD Open\nVAR_INPUT\n\tbForce : BOOL;\nEND_VAR', o.openImpl ?? 'nCycles := nCycles + 1;\nbOpened := TRUE;')}${
  o.close === false ? '' : method(CLOSE, 'Close', 'METHOD Close', 'bOpened := FALSE;')}${
  o.reset ? method(RESET, 'Reset', 'METHOD Reset\nVAR\n\tnResets : INT;\nEND_VAR', 'nResets := nResets + 1;\nbOpened := FALSE;') : ''}
    <Property Name="State" Id="${STATE}">
      <Declaration><![CDATA[PROPERTY State : INT]]></Declaration>
      <Get Name="Get" Id="${GET}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[${o.getImpl ?? 'State := SEL(bOpened, 0, 1);'}]]></ST>
        </Implementation>
      </Get>${o.set === false ? '' : `
      <Set Name="Set" Id="${SET}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[bOpened := State > 0;]]></ST>
        </Implementation>
      </Set>`}
    </Property>
    <Action Name="A_Draw" Id="${DRAW}">
      <Implementation>
        <CFC>
          <XmlArchive>${o.cfc ?? '<Box Id="1" X="10" Y="20" />'}</XmlArchive>
        </CFC>
      </Implementation>
    </Action>
    <LineIds Name="FB_Valve">
      <LineId Id="3" Count="${o.lineIds ?? '0'}" />
    </LineIds>
  </POU>
</TcPlcObject>`;
  return o.crlf ? text.replace(/\n/g, '\r\n') : text;
}

const view = (input: Partial<FileInput>) => buildFileView({ path: 'POUs/FB_Valve.TcPOU', ...input });
const summary = (v: FileView) => v.objects.map(o => `${o.label} ${o.change}${o.renamedFrom ? ` from ${o.renamedFrom}` : ''}`);
const object = (v: FileView, label: string): ObjectView => {
  const o = v.objects.find(x => x.label === label);
  assert.ok(o, `${label} is in the view`);
  return o;
};
/** Line (1-based, counted by LF like git) of the only line of a text that contains `needle`. */
function lineOf(text: string, needle: string): number {
  const lines = text.split('\n');
  const found = lines.flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  assert.equal(found.length, 1, `'${needle}' is on one line`);
  return found[0];
}
const changedLines = (o: ObjectView) => o.sections.flatMap(s => s.lines.filter(l => l.kind !== 'same')
  .map(l => `${s.label} ${l.kind === 'add' ? '+' : '-'}${l.text} @${l.kind === 'add' ? `R${l.newXml}` : `L${l.oldXml}`}`));

const ALL = ['FB_Valve', 'FB_Valve.Init', 'FB_Valve.Open', 'FB_Valve.Close', 'FB_Valve.State', 'FB_Valve.State.Get',
  'FB_Valve.State.Set', 'FB_Valve.A_Draw'];

test('a modified method: its implementation diff, each changed line with the XML line it is on', () => {
  const before = valve();
  const after = valve({ openImpl: 'nCycles := nCycles + 1;\nbOpened := bForce OR bOpen;\nRETURN;' });
  const v = view({ before, after });
  assert.deepEqual(summary(v), ALL.map(l => `${l} ${l === 'FB_Valve.Open' ? 'modified' : 'unchanged'}`));
  assert.deepEqual(v.counts, { added: 0, modified: 1, deleted: 0, unchanged: 7 });
  assert.equal(v.metadataOnly, undefined);

  const open = object(v, 'FB_Valve.Open');
  assert.equal(open.depth, 1);
  assert.deepEqual(open.sections.map(s => `${s.label} ${s.status}`), ['Declaration same', 'Implementation changed']);
  assert.deepEqual(changedLines(open), [
    `Implementation -bOpened := TRUE; @L${lineOf(before, 'bOpened := TRUE;')}`,
    `Implementation +bOpened := bForce OR bOpen; @R${lineOf(after, 'bOpened := bForce OR bOpen;')}`,
    `Implementation +RETURN; @R${lineOf(after, 'RETURN;')}`,
  ]);
  const impl = open.sections[1];
  assert.deepEqual(impl.lines.map(l => [l.kind, l.oldLine, l.newLine]), [['same', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['add', undefined, 3]]);
  // The unchanged line knows its place in both versions too.
  assert.equal(impl.lines[0].newXml, lineOf(after, 'nCycles := nCycles + 1;'));
  assert.equal(impl.lines[0].oldXml, lineOf(before, 'nCycles := nCycles + 1;'));
  assert.equal(impl.newXml, lineOf(after, 'nCycles := nCycles + 1;'));
  assert.deepEqual([open.added, open.deleted], [2, 1]);
  // Unchanged objects still have their code, to be shown on demand.
  assert.deepEqual(object(v, 'FB_Valve').sections.map(s => `${s.label} ${s.status} ${s.lines.length}`), ['Declaration same 7', 'Implementation same 3']);
});

test('an added and a deleted method: all their lines added or removed; deleted views come last', () => {
  const before = valve();
  const after = valve({ close: false, reset: true });
  const v = view({ before, after });
  assert.deepEqual(summary(v).filter(s => !s.endsWith('unchanged')), ['FB_Valve.Reset added', 'FB_Valve.Close deleted']);
  assert.equal(summary(v).at(-1), 'FB_Valve.Close deleted');
  const reset = object(v, 'FB_Valve.Reset');
  const decl = lineOf(after, 'METHOD Reset');
  assert.deepEqual(changedLines(reset), [
    `Declaration +METHOD Reset @R${decl}`,
    `Declaration +VAR @R${decl + 1}`,
    `Declaration +\tnResets : INT; @R${decl + 2}`,
    `Declaration +END_VAR @R${decl + 3}`,
    `Implementation +nResets := nResets + 1; @R${lineOf(after, 'nResets := nResets + 1;')}`,
    `Implementation +bOpened := FALSE; @R${lineOf(after, 'bOpened := FALSE;')}`,
  ]);
  assert.deepEqual(reset.sections.map(s => `${s.label} ${s.status}`), ['Declaration added', 'Implementation added']);
  assert.deepEqual([reset.added, reset.deleted], [6, 0]);
  const close = object(v, 'FB_Valve.Close');
  assert.deepEqual(close.sections.map(s => `${s.label} ${s.status}`), ['Declaration deleted', 'Implementation deleted']);
  assert.deepEqual(changedLines(close), [
    `Declaration -METHOD Close @L${lineOf(before, 'METHOD Close')}`,
    `Implementation -bOpened := FALSE; @L${lineOf(before, 'bOpened := FALSE;')}`,
  ]);
  assert.deepEqual(v.counts, { added: 1, modified: 0, deleted: 1, unchanged: 7 });
});

test('a changed property Get: the accessor view is modified, the property and its Set are not', () => {
  const before = valve();
  const after = valve({ getImpl: 'IF bOpened THEN\n\tState := 1;\nELSE\n\tState := 0;\nEND_IF' });
  const v = view({ before, after });
  assert.deepEqual(summary(v).filter(s => !s.endsWith('unchanged')), ['FB_Valve.State.Get modified']);
  const get = object(v, 'FB_Valve.State.Get');
  assert.equal(get.accessor, 'Get');
  assert.equal(get.depth, 2);
  assert.deepEqual(get.sections.map(s => `${s.label} ${s.status}`), ['Declaration same', 'Implementation changed']);
  const first = lineOf(after, 'IF bOpened THEN');
  assert.deepEqual(changedLines(get), [
    `Implementation -State := SEL(bOpened, 0, 1); @L${lineOf(before, 'State := SEL(bOpened, 0, 1);')}`,
    `Implementation +IF bOpened THEN @R${first}`,
    `Implementation +\tState := 1; @R${first + 1}`,
    `Implementation +ELSE @R${first + 2}`,
    `Implementation +\tState := 0; @R${first + 3}`,
    `Implementation +END_IF @R${first + 4}`,
  ]);
  assert.match(after.split('\n')[first + 3], /^END_IF\]\]><\/ST>/);
  // The property view is its declaration only.
  assert.deepEqual(object(v, 'FB_Valve.State').sections.map(s => s.label), ['Declaration']);
});

test('a deleted accessor comes right after its property; a deleted property shows the code of its accessors', () => {
  let v = view({ before: valve(), after: valve({ set: false }) });
  assert.deepEqual(summary(v).filter(s => !s.endsWith('unchanged')), ['FB_Valve.State.Set deleted']);
  assert.deepEqual(v.objects.map(o => o.label).slice(4, 7), ['FB_Valve.State', 'FB_Valve.State.Get', 'FB_Valve.State.Set']);

  const withoutState = valve().replace(/\n {4}<Property[\s\S]*<\/Property>/, '');
  v = view({ before: valve(), after: withoutState });
  assert.deepEqual(summary(v).filter(s => !s.endsWith('unchanged')), ['FB_Valve.State deleted']);
  assert.deepEqual(object(v, 'FB_Valve.State').sections.map(s => `${s.label} ${s.status}`), [
    'Declaration deleted', 'Get · Declaration deleted', 'Get · Implementation deleted', 'Set · Declaration deleted', 'Set · Implementation deleted',
  ]);
});

test('a renamed method: modified with its old name; its declaration and code follow the new name', () => {
  const before = valve();
  const after = valve({ initName: 'Setup' });
  const v = view({ before, after });
  assert.deepEqual(summary(v).filter(s => !s.endsWith('unchanged')), ['FB_Valve.Setup modified from Init']);
  const setup = object(v, 'FB_Valve.Setup');
  assert.deepEqual(changedLines(setup), [
    `Declaration -METHOD Init : BOOL @L${lineOf(before, 'METHOD Init : BOOL')}`,
    `Declaration +METHOD Setup : BOOL @R${lineOf(after, 'METHOD Setup : BOOL')}`,
    `Implementation -Init := TRUE; @L${lineOf(before, 'Init := TRUE;')}`,
    `Implementation +Setup := TRUE; @R${lineOf(after, 'Setup := TRUE;')}`,
  ]);
  // A rename alone, without a change of code, is a change too.
  const attributeOnly = view({ before, after: before.replace('Name="Init"', 'Name="Setup"') });
  assert.deepEqual(summary(attributeOnly).filter(s => !s.endsWith('unchanged')), ['FB_Valve.Setup modified from Init']);
  assert.deepEqual(object(attributeOnly, 'FB_Valve.Setup').sections.map(s => s.status), ['same', 'same']);
});

test('a metadata-only change is labelled as such, with every object unchanged', () => {
  const version = view({ before: valve(), after: valve({ version: '3.1.4026.16' }) });
  assert.equal(version.metadataOnly, 'ProductVersion 3.1.4026.12 → 3.1.4026.16');
  assert.deepEqual(version.counts, { added: 0, modified: 0, deleted: 0, unchanged: 8 });
  assert.equal(view({ before: valve(), after: valve({ lineIds: '2' }) }).metadataOnly, 'XML only, no code');
  assert.equal(view({ before: valve(), after: valve() }).metadataOnly, 'No changes');
  assert.equal(view({ oldPath: 'Old/FB_Valve.TcPOU', before: valve(), after: valve() }).metadataOnly, 'Renamed, content unchanged');
  // Line breaks alone are not code.
  assert.equal(view({ before: valve(), after: valve({ crlf: true }) }).metadataOnly, 'XML only, no code');
});

test('project files: a TmcHash rewritten by a build is metadata, other changes are left to the page\'s diff', () => {
  const tsproj = (hash: string, extra = '') => `<TcSmProject>\r\n<Project TmcHash="{${hash}}" TmcPath="Plc\\Plc.tmc">${extra}</Project>\r\n</TcSmProject>`;
  assert.equal(buildFileView({ path: 'Machine.tsproj', before: tsproj('AAAA-1'), after: tsproj('BBBB-2') }).metadataOnly,
    'TmcHash only, rewritten by a build');
  const other = buildFileView({ path: 'Machine.tsproj', before: tsproj('AAAA-1'), after: tsproj('BBBB-2', '<Task/>') });
  assert.equal(other.metadataOnly, undefined);
  assert.match(other.note ?? '', /project file/);
  // On GitLab too.
  assert.doesNotMatch(other.note ?? '', /GitHub/);
});

test('a new file is all added, a deleted file all removed; a renamed file keeps its old path', () => {
  const added = view({ after: valve() });
  assert.equal(added.change, 'added');
  assert.deepEqual(summary(added), ALL.map(l => `${l} added`));
  assert.ok(added.objects.every(o => o.sections.every(s => s.lines.every(l => l.kind === 'add' && l.newXml !== undefined))));

  const deleted = view({ before: valve() });
  assert.equal(deleted.change, 'deleted');
  // A deleted file lists its objects once: the accessors go with their property.
  assert.deepEqual(summary(deleted), ['FB_Valve deleted', 'FB_Valve.Init deleted', 'FB_Valve.Open deleted', 'FB_Valve.Close deleted',
    'FB_Valve.State deleted', 'FB_Valve.A_Draw deleted']);

  const renamed = view({ path: 'POUs/Valves/FB_Valve.TcPOU', oldPath: 'POUs/FB_Valve.TcPOU', before: valve(), after: valve({ initName: 'Setup' }) });
  assert.equal(renamed.oldPath, 'POUs/FB_Valve.TcPOU');
  assert.equal(renamed.change, 'modified');
  assert.deepEqual(summary(renamed).filter(s => !s.endsWith('unchanged')), ['FB_Valve.Setup modified from Init']);
});

test('CRLF files: each section line is on the XML line git counts', () => {
  const before = valve({ crlf: true });
  const after = valve({ crlf: true, openImpl: 'nCycles := nCycles + 2;\nbOpened := TRUE;' });
  const open = object(view({ before, after }), 'FB_Valve.Open');
  assert.deepEqual(changedLines(open), [
    `Implementation -nCycles := nCycles + 1; @L${lineOf(before, 'nCycles := nCycles + 1;')}`,
    `Implementation +nCycles := nCycles + 2; @R${lineOf(after, 'nCycles := nCycles + 2;')}`,
  ]);
  // Section texts have LF line breaks, whatever the file has.
  assert.ok(open.sections.every(s => s.lines.every(l => !l.text.includes('\r'))));
});

test('a changed graphical implementation makes its object modified, without lines to show', () => {
  const after = valve({ cfc: '<Box Id="1" X="30" Y="20" />' });
  const v = view({ before: valve(), after });
  assert.deepEqual(summary(v).filter(s => !s.endsWith('unchanged')), ['FB_Valve.A_Draw modified']);
  const draw = object(v, 'FB_Valve.A_Draw');
  assert.deepEqual(draw.sections.map(s => `${s.label} ${s.status} ${s.text} ${s.lines.length}`), ['Implementation (CFC) changed false 0']);
  // Its link goes to the start of the graphical code in the XML.
  assert.equal(draw.sections[0].newXml, lineOf(after, '<CFC>'));
  assert.equal(v.metadataOnly, undefined);
});

test('a file that is not TwinCAT XML is an error, not a crash', () => {
  assert.match(view({ before: valve(), after: '<TcPlcObject><POU Name="X">' }).error ?? '', /cannot be read/);
});

/** A function block with `n` methods of 30 lines, with CRLF line breaks; the method `changed` adds other numbers. */
function bigPou(n: number, changed = -1): string {
  const impl = (m: number) => Array.from({ length: 30 }, (_, i) => `nCount := nCount + ${m === changed ? i + 1 : i}; // line ${i + 1} of M${m}`);
  const methods = Array.from({ length: n }, (_, m) => method(`{b${String(m).padStart(7, '0')}-0000-0000-0000-000000000000}`, `M${m}`,
    `METHOD M${m} : BOOL\nVAR_INPUT\n\tnIn : INT;\nEND_VAR`, impl(m).join('\n')));
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.12">
  <POU Name="FB_Big" Id="${POU}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Big
VAR
	nCount : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>${methods.join('')}
  </POU>
</TcPlcObject>`.replace(/\n/g, '\r\n');
}

test('a large file\'s view builds in linear time: a few times as long as parsing the file', () => {
  const before = bigPou(200);
  const after = bigPou(200, 100);
  const input: FileInput = { path: 'POUs/FB_Big.TcPOU', before, after };
  const v = buildFileView(input);
  assert.deepEqual(v.counts, { added: 0, modified: 1, deleted: 0, unchanged: 200 });
  assert.equal(object(v, 'FB_Big.M199').sections[1].lines.at(-1)?.newXml, lineOf(after, 'line 30 of M199'));

  /** The shortest of five runs, in milliseconds. */
  const time = (run: () => void): number => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const parse = time(() => {
    parseTcText(input.path, before);
    parseTcText(input.path, after);
  });
  const build = time(() => buildFileView(input));
  // Both read the same text, so a slow or busy machine slows both: about 3 times as long, up to 13 with no core to spare.
  // Counting the lines from the start of the file for each section, as sectionFileLines did, took about 200 times as long.
  assert.ok(build < 40 * parse, `the view took ${build.toFixed(1)} ms, parsing the file ${parse.toFixed(1)} ms`);
});

// ------------------------------------------------------------------ line diff

/** The new lines rebuilt from the old ones and the edits, checking the indexes on the way. */
function apply(a: string[], b: string[], edits: Edit[]): string[] {
  let i = 0;
  let j = 0;
  const out: string[] = [];
  for (const e of edits) {
    if (e.kind !== 'add') assert.equal(e.a, i++);
    if (e.kind !== 'del') assert.equal(e.b, j++);
    if (e.kind === 'same') assert.equal(a[e.a!], b[e.b!]);
    if (e.kind !== 'del') out.push(b[e.b!]);
  }
  assert.equal(i, a.length);
  return out;
}

function lcs(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return t[0][0];
}

test('line diff: the edits rebuild the new text, are minimal, and put deletions before additions', () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: random(14) }, () => 'abcd'[random(4)]);
    const b = Array.from({ length: random(14) }, () => 'abcd'[random(4)]);
    const edits = diffLines(a, b);
    assert.deepEqual(apply(a, b, edits), b);
    assert.equal(edits.filter(e => e.kind === 'same').length, lcs(a, b), `minimal for ${a.join('')} → ${b.join('')}`);
    for (let k = 1; k < edits.length; k++) assert.ok(!(edits[k - 1].kind === 'add' && edits[k].kind === 'del'), 'no deletion right after an addition');
  }
  // Beyond the cost limit the middle is replaced as a whole, still correctly.
  const a = ['x', '1', '2', '3', 'y'];
  const b = ['x', '4', '5', '6', 'y'];
  const edits = diffLines(a, b, 2);
  assert.deepEqual(apply(a, b, edits), b);
  assert.deepEqual(edits.map(e => e.kind), ['same', 'del', 'del', 'del', 'add', 'add', 'add', 'same']);
});

test('line diff: the changed middle of a line', () => {
  assert.deepEqual(lineChange('x := a + 1;', 'x := a + 2;'), { start: 9, endA: 10, endB: 10 });
  assert.deepEqual(lineChange('abc', 'abc'), { start: 3, endA: 3, endB: 3 });
  assert.deepEqual(lineChange('aXa', 'aa'), { start: 1, endA: 2, endB: 1 });
});

// ------------------------------------------------------------------ GitHub

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('split diff: unchanged lines on both sides, each run\'s deletions beside its additions', () => {
  const kinds = (s: string): DiffLine[] => [...s].map(c => ({ kind: c === '=' ? 'same' : c === '-' ? 'del' : 'add', text: '' }));
  // = - - + = + = - -
  const lines = kinds('=--+=+=--');
  assert.deepEqual(splitRows(lines), [
    { left: 0, right: 0 },
    { left: 1, right: 3 }, { left: 2, right: undefined },
    { left: 4, right: 4 },
    { left: undefined, right: 5 },
    { left: 6, right: 6 },
    { left: 7, right: undefined }, { left: 8, right: undefined },
  ]);
  // A part of the lines: an unfolded run of unchanged lines.
  assert.deepEqual(splitRows(lines, 4, 5), [{ left: 4, right: 4 }]);
  // Every line on one row, on its side.
  const rows = splitRows(lines);
  assert.deepEqual(rows.flatMap(r => (r.left === r.right ? [r.left] : [r.left, r.right])).filter(k => k !== undefined).sort((a, b) => a! - b!), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(rows.every(r => r.left === undefined || lines[r.left].kind !== 'add'));
  assert.ok(rows.every(r => r.right === undefined || lines[r.right].kind !== 'del'));
});

test('the host\'s layout: GitHub\'s from a row of its diff, else its URL; GitLab\'s from its cookie, else its URL', () => {
  // A context line: both line numbers, then the code (unified); each number before its side's code (split).
  assert.equal(githubDiffStyle('', ['L', 'R', '-']), 'unified');
  assert.equal(githubDiffStyle('', ['L', '-', 'R', '-']), 'split');
  assert.equal(githubDiffStyle('?diff=unified', ['L', '-', 'R', '-']), 'split');
  assert.equal(githubDiffStyle('?diff=split'), 'split');
  assert.equal(githubDiffStyle('?w=1&diff=unified', ['L', '-']), 'unified');
  assert.equal(githubDiffStyle(''), undefined);
  assert.equal(gitlabDiffStyle('', 'a=1; diff_view=parallel; b=2'), 'split');
  assert.equal(gitlabDiffStyle('?view=parallel', 'diff_view=inline'), 'unified');
  assert.equal(gitlabDiffStyle('?view=parallel', 'a=1'), 'split');
  assert.equal(gitlabDiffStyle('', 'my_diff_view=parallel'), undefined);
  assert.equal(gitlabDiffStyle('', ''), undefined);
});

test('github: the pull request of a "Files changed" page, in the classic and the React page and for a commit range', () => {
  assert.deepEqual(filesPage('/acme/plc/pull/12/files'), { owner: 'acme', repo: 'plc', number: 12 });
  assert.deepEqual(filesPage('/acme/plc/pull/12/changes'), { owner: 'acme', repo: 'plc', number: 12 });
  assert.deepEqual(filesPage(`/acme/plc/pull/12/files/${A.slice(0, 7)}..${B.slice(0, 7)}`),
    { owner: 'acme', repo: 'plc', number: 12, commits: `${A.slice(0, 7)}..${B.slice(0, 7)}` });
  assert.deepEqual(filesPage(`/acme/plc/pull/12/changes/${A}`), { owner: 'acme', repo: 'plc', number: 12, commits: A });
  assert.equal(pullDiffUrl({ owner: 'acme', repo: 'plc', number: 12 }), 'https://github.com/acme/plc/pull/12.diff');
  assert.equal(pullDiffUrl({ owner: 'acme', repo: 'plc', number: 12, commits: A }), `https://github.com/acme/plc/commit/${A}.diff`);
  assert.equal(pullDiffUrl({ owner: 'acme', repo: 'plc', number: 12, commits: `${A}..${B}` }), `https://github.com/acme/plc/compare/${A}...${B}.diff`);
  assert.equal(filesPage('/acme/plc/pull/12'), undefined);
  assert.equal(filesPage('/acme/plc/pull/12/commits'), undefined);
  assert.ok(isTwinCatFile('PLC/POUs/FB_Valve.TcPOU') && isTwinCatFile('a/E_State.tcdut') && isTwinCatFile('Machine.tsproj'));
  assert.ok(!isTwinCatFile('PLC/PLC.plcproj') && !isTwinCatFile('README.md'));
  // A TwinCAT view for source files only: a project file is in the tree, and keeps the host's diff.
  assert.ok(hasObjectView('PLC/POUs/FB_Valve.TcPOU') && hasObjectView('a/I_Motor.tcio') && hasObjectView('GVLs/GVL_Main.TcGVL'));
  assert.ok(!hasObjectView('Machine.tsproj') && !hasObjectView('_Config/IO/Device 1 (EtherCAT).xti'));
  assert.equal(fileUrl(githubRawTemplate({ owner: 'acme', repo: 'plc', number: 12 }), A, 'PLC/My POUs/FB_#1.TcPOU'),
    `https://github.com/acme/plc/raw/${A}/PLC/My%20POUs/FB_%231.TcPOU`);
});

test('github: the commits a page compares, from the classic markup or from the JSON of the React page', () => {
  assert.deepEqual(commitsInPage(`<deferred-diff-lines data-url="/acme/plc/diffs/${A}..${B}?base_sha=${A}&amp;whitespace_ignored=false">`),
    { base: A, head: B, source: 'page: diff URL' });
  assert.deepEqual(commitsInPage(`src="/acme/plc/pull/12/show_partial_comparison?base_commit_oid=${A}&amp;end_commit_oid=${B}"`),
    { base: A, head: B, source: 'page: comparison URL' });
  const json = `<script type="application/json">{"pullRequest":{"baseRefOid":"${C}","headRefOid":"${B}"},"comparison":{"baseOid":"${A}"}}</script>`;
  assert.deepEqual(commitsInPage(json), { base: A, head: B, source: 'page: baseOid, headRefOid' });
  // In an attribute, with its quotes escaped.
  assert.deepEqual(commitsInPage(`data-payload="{&quot;mergeBaseOid&quot;:&quot;${A}&quot;,&quot;headOid&quot;:&quot;${B}&quot;}"`),
    { base: A, head: B, source: 'page: mergeBaseOid, headOid' });
  // The base branch's commit is not what the page compares with: no base then.
  assert.equal(commitsInPage(`{"baseRefOid":"${C}","headRefOid":"${B}"}`), undefined);
  assert.equal(commitsInPage('<html></html>'), undefined);
  // The keys with a commit, as JSON and URLs have them: quoted or not, spaces around the separator, from a key's
  // first letter; not a longer hex string, nor a commit without a key.
  assert.deepEqual(shaKeys(`{"mergeBaseOid" : "${A}", 'headOid':'${B}'} ?x=1&end_commit_oid=${C}&9base_sha=${A}`),
    [['mergeBaseOid', A], ['headOid', B], ['end_commit_oid', C], ['base_sha', A]]);
  assert.deepEqual(shaKeys(`"blob":"${A}${A.slice(0, 24)}" "=${B}" 42=${A} key=${C}x`), [['key', C]]);
});

test('commits: one attempt a page that all who ask share, kept when it found nothing; another on demand, some seconds after', async () => {
  let now = 0;
  const attempts: ((found: string | undefined) => void)[] = [];
  const lookup = new Lookup<string>(() => new Promise(resolve => attempts.push(resolve)), 5000, () => now);
  const first = lookup.get();
  assert.equal(lookup.get(), first);
  assert.equal(lookup.retry(), undefined, 'not while an attempt is going on');
  assert.equal(attempts.length, 1);
  now = 2000;
  attempts[0](undefined);
  assert.equal(await first, undefined);
  // Nothing found is kept: asking again makes no attempt, nor does a demand sooner than 5 s after the last one ended.
  assert.equal(await lookup.get(), undefined);
  now = 6999;
  assert.equal(lookup.retry(), undefined);
  assert.equal(attempts.length, 1);
  now = 7000;
  const second = lookup.retry();
  assert.ok(second);
  assert.equal(lookup.get(), second, 'those who ask now share the new attempt');
  assert.equal(lookup.retry(), undefined);
  assert.equal(attempts.length, 2);
  assert.equal(lookup.value, undefined, 'nothing known while it is looked for');
  attempts[1]('found');
  assert.equal(await second, 'found');
  assert.equal(lookup.value, 'found');
  // Found is kept for good.
  now = 60000;
  assert.equal(lookup.retry(), undefined);
  assert.equal(await lookup.get(), 'found');
  assert.equal(attempts.length, 2);
  // An attempt that fails has found nothing: no rejection, and a demand later makes another.
  let calls = 0;
  const failing = new Lookup<string>(async () => {
    calls++;
    throw new Error('offline');
  }, 5000, () => now);
  assert.equal(await failing.get(), undefined);
  assert.equal(failing.retry(), undefined);
  now += 5000;
  assert.equal(await failing.retry(), undefined);
  assert.equal(calls, 2);
});

test('frames: the parameters of a viewer and of the tree go through their URL, for any host', () => {
  const p: ViewerParams = {
    origin: 'https://gitlab.example.com', raw: 'https://gitlab.example.com/plc/machine/-/raw/{sha}/{path}', order: ['page', 'frame', 'worker'],
    base: A, head: B, path: 'PLC/POUs/New & improved/FB_Valve.TcPOU', oldPath: 'PLC/POUs/FB_Valve.TcPOU', deleted: false, added: false,
    theme: 'dark', source: 'page: Rapid Diffs data',
  };
  assert.deepEqual(decodeViewerParams(`#${encodeViewerParams(p)}`), p);
  assert.equal(decodeViewerParams(`#${encodeViewerParams({ ...p, oldPath: undefined, source: undefined })}`)?.oldPath, undefined);
  // The raw files must be on the page's origin, the commits real ones.
  assert.equal(decodeViewerParams(`#${encodeViewerParams({ ...p, raw: 'https://elsewhere.example.com/{sha}/{path}' })}`), undefined);
  assert.equal(decodeViewerParams(`#${encodeViewerParams({ ...p, base: 'main' })}`), undefined);
  assert.equal(decodeViewerParams('#origin=https%3A%2F%2Fgithub.com&p=a.TcPOU'), undefined);
  const t: TreeParams = {
    origin: 'https://github.com', raw: 'https://github.com/acme/plc/raw/{sha}/{path}', order: ['frame', 'worker', 'page'], base: A, head: B,
    theme: 'auto', diff: 'https://github.com/acme/plc/pull/12.diff', source: undefined, host: 'github',
  };
  assert.deepEqual(decodeTreeParams(`#${encodeTreeParams(t)}`), t);
  assert.equal(decodeTreeParams(`#${encodeTreeParams({ ...t, diff: 'https://elsewhere.example.com/12.diff' })}`), undefined);
  assert.equal(fileUrl(p.raw, A, 'PLC/Ü 1.TcPOU'), `https://gitlab.example.com/plc/machine/-/raw/${A}/PLC/%C3%9C%201.TcPOU`);
  // A frame fetches from the built-in hosts and the sites the user turned the extension on for, nothing else.
  assert.ok(fetchAllowed('https://raw.githubusercontent.com/a/b/c') && fetchAllowed('https://gitlab.com/a/-/raw/x/y'));
  assert.ok(fetchAllowed('https://gitlab.example.com/a/-/raw/x/y', ['https://gitlab.example.com']));
  assert.ok(!fetchAllowed('https://gitlab.example.com/a', []) && !fetchAllowed('http://github.com/a') && !fetchAllowed('not a url'));
});

// ------------------------------------------------------------------ GitLab

test('gitlab: the merge request of a page, its raw files and its REST API', () => {
  assert.deepEqual(mergeRequestPage('/plc/machine/-/merge_requests/7/diffs'), { project: 'plc/machine', iid: 7 });
  assert.deepEqual(mergeRequestPage('/group/sub/machine/-/merge_requests/12'), { project: 'group/sub/machine', iid: 12 });
  assert.equal(mergeRequestPage('/plc/machine/-/issues/7'), undefined);
  assert.ok(isChangesTab('/plc/machine/-/merge_requests/7/diffs') && !isChangesTab('/plc/machine/-/merge_requests/7'));
  assert.equal(fileUrl(gitlabRawTemplate('https://gitlab.example.com', 'group/sub/machine'), A, 'PLC/POUs/FB_Valve.TcPOU'),
    `https://gitlab.example.com/group/sub/machine/-/raw/${A}/PLC/POUs/FB_Valve.TcPOU`);
  assert.equal(mergeRequestApi('https://gitlab.com', 'group/sub/machine', 7), 'https://gitlab.com/api/v4/projects/group%2Fsub%2Fmachine/merge_requests/7');
  assert.equal(mergeRequestApi('https://gitlab.com', 58170678, 7), 'https://gitlab.com/api/v4/projects/58170678/merge_requests/7');
});

test('gitlab: a Changes tab of one commit, version or comparison, and the comparison of its commits', () => {
  assert.ok(isPartialView(`?commit_id=${A}`) && isPartialView('?diff_id=12') && isPartialView(`?diff_id=12&start_sha=${A}`));
  assert.ok(!isPartialView('') && !isPartialView('?diff_head=true') && !isPartialView('?view=parallel'));
  assert.equal(compareApi('https://gitlab.com', 'group/sub/machine', A, B),
    `https://gitlab.com/api/v4/projects/group%2Fsub%2Fmachine/repository/compare?from=${A}&to=${B}&straight=true`);
});

test('gitlab: the files and commits of the REST API and of the Rapid Diffs page', () => {
  const api = [
    { old_path: 'PLC/POUs/FB_Valve.TcPOU', new_path: 'PLC/POUs/FB_Valve.TcPOU', new_file: false, deleted_file: false, renamed_file: false },
    { old_path: 'PLC/DUTs/ST_Old.TcDUT', new_path: 'PLC/DUTs/ST_New.TcDUT', new_file: false, deleted_file: false, renamed_file: true },
    { old_path: 'PLC/GVLs/GVL_New.TcGVL', new_path: 'PLC/GVLs/GVL_New.TcGVL', new_file: true, deleted_file: false },
    { old_path: 'PLC/POUs/FB_Gone.TcPOU', new_path: 'PLC/POUs/FB_Gone.TcPOU', new_file: false, deleted_file: true },
  ];
  assert.deepEqual(filesFromApi(api), [
    { path: 'PLC/POUs/FB_Valve.TcPOU' },
    { path: 'PLC/DUTs/ST_New.TcDUT', oldPath: 'PLC/DUTs/ST_Old.TcDUT' },
    { path: 'PLC/GVLs/GVL_New.TcGVL', added: true },
    { path: 'PLC/POUs/FB_Gone.TcPOU', deleted: true },
  ]);
  assert.deepEqual(filesFromApi({ message: '404 Not found' }), []);
  // GitLab compares the merge base with the head; start_sha is the target branch when the diff was made.
  assert.deepEqual(commitsFromDiffRefs({ base_sha: A, start_sha: C, head_sha: B }, 'REST API'), { base: A, head: B, source: 'REST API' });
  assert.equal(commitsFromDiffRefs({ base_sha: A }, 'x'), undefined);
  const data = JSON.stringify({
    viewer: 'text_inline', old_path: 'PLC/DUTs/ST_Old.TcDUT', new_path: 'PLC/DUTs/ST_New.TcDUT',
    blob_raw_path: `/plc/machine/-/raw/${B}/PLC/DUTs/ST_New.TcDUT`, diff_refs: { base_sha: A, start_sha: C, head_sha: B },
  });
  assert.deepEqual(rapidFileData(data), {
    file: { path: 'PLC/DUTs/ST_New.TcDUT', oldPath: 'PLC/DUTs/ST_Old.TcDUT' }, commits: { base: A, head: B, source: 'page: Rapid Diffs data' },
  });
  assert.equal(rapidFileData('{not json'), undefined);
});

test('gitlab: the line anchors of the Rapid Diffs page and the color mode', () => {
  // The block's id is the sha1 of the path; a line's anchor has its first 9 characters, `A` for an added line.
  assert.equal(rapidLineAnchor('5d2c773018c2590cb27a24e51e7e2d43b6633c83', 'L', 15), 'line_5d2c77301_15');
  assert.equal(rapidLineAnchor('5d2c773018c2590cb27a24e51e7e2d43b6633c83', 'R', 15), 'line_5d2c77301_A15');
  assert.equal(gitlabTheme('gl-system ui-neutral with-top-bar gl-dark'), 'dark');
  assert.equal(gitlabTheme('gl-light ui-neutral'), 'light');
  assert.equal(gitlabTheme('gl-darker-sidebar'), 'light');
});

// ------------------------------------------------------------------ the tree of the changes

/** A function block without members, to fill a folder. */
function pou(name: string, id: string, version = '3.1.4024.12'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="${version}">
  <POU Name="${name}" Id="${id}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK ${name}]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;
}

const ENUM = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <DUT Name="E_Mode" Id="{b1000000-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[TYPE E_Mode :
(
	Auto,
	Manual
);
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`;

/** The tree as text: one node a line, indented, with its change letter and description. */
function treeText(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap(n => [
    `${'  '.repeat(depth)}${n.label}${n.change ? ` [${n.change[0].toUpperCase()}]` : ''}${n.muted ? ' (unchanged)' : ''}${n.description ? ` · ${n.description}` : ''}`,
    ...treeText(n.children, depth + 1),
  ]);
}

test('tree: folders, each file as its object with the members that changed, in the order of XAE; build output apart', () => {
  const valveAfter = valve({ close: false, reset: true, openImpl: 'bOpened := TRUE;', getImpl: 'State := 1;' })
    .replace(`<Method Name="Reset" Id="${RESET}">`, `<Method Name="Reset" Id="${RESET}" FolderPath="Internal\\">`);
  const tsproj = (hash: string) => `<TcSmProject>\r\n<Project TmcHash="{${hash}}" />\r\n</TcSmProject>`;
  const file = (path: string, input: Omit<FileInput, 'path'>) => ({ path, oldPath: input.oldPath, view: buildFileView({ path, ...input }) });
  const files = [
    file('PLC/POUs/Valves/FB_Valve.TcPOU', { before: valve(), after: valveAfter }),
    file('PLC/POUs/Valves/FB_Valve2.TcPOU', { oldPath: 'PLC/POUs/FB_Valve2.TcPOU', before: pou('FB_Valve2', POU), after: pou('FB_Valve2', POU) }),
    file('PLC/DUTs/E_Mode.TcDUT', { after: ENUM }),
    file('PLC/POUs/FB_Pump.TcPOU', { before: pou('FB_Pump', INIT), after: pou('FB_Pump', INIT, '3.1.4026.13') }),
    file('Machine.tsproj', { before: tsproj('AAAA-1'), after: tsproj('BBBB-2') }),
  ];
  assert.deepEqual(treeText(buildTree(files)), [
    'PLC',
    '  DUTs',
    '    E_Mode (ENUM) [A]',
    '  POUs/Valves',
    '    FB_Valve (FB)',
    '      Internal',
    '        Reset [A]',
    '      Close [D]',
    '      Open [M]',
    '      State (unchanged)',
    '        Get [M]',
    '    FB_Valve2 (FB) [R] · moved from PLC/POUs',
    'Build output (no code changes) · 2',
    '  FB_Pump (FB) [M] · ProductVersion 3.1.4024.12 → 3.1.4026.13',
    '  Machine.tsproj [M] · TmcHash only, rewritten by a build',
  ]);
  // Where a click goes: the file's block, the object (and accessor) in its view.
  const valveNode = buildTree(files)[0].children[1].children[0];
  const get = valveNode.children.find(n => n.label === 'State')!.children[0];
  assert.deepEqual([get.file, get.objectId, get.accessor], ['PLC/POUs/Valves/FB_Valve.TcPOU', STATE.slice(1, -1), 'Get']);
  assert.deepEqual([valveNode.icon, get.icon], ['fb', 'get']);
  // While a file is read it shows by its name.
  assert.deepEqual(treeText(buildTree([{ path: 'PLC/POUs/FB_Valve.TcPOU' }])), ['PLC/POUs', '  FB_Valve · reading…']);
  assert.deepEqual(treeSummary([...files, { path: 'a.TcPOU' }]), { files: 6, objects: 5, reading: 1 });
});

test('tree: the folders and files in the order of the host\'s page', () => {
  const files = [
    'PLC/Modules/POUs/FB_Valve.TcPOU', 'PLC/ModuleTests/POUs/FB_ValveTest.TcPOU', 'PLC/Modules/a.TcPOU', 'PLC/Modules/Z.TcPOU',
  ].map(path => ({ path }));
  const names = (paths?: (a: string, b: string) => number) => treeText(buildTree(files, paths)).map(l => l.replace(' · reading…', ''));
  // XAE: folders first, then by name, whatever the case.
  assert.deepEqual(names(), ['PLC', '  Modules', '    POUs', '      FB_Valve', '    a', '    Z', '  ModuleTests/POUs', '    FB_ValveTest']);
  // GitLab: by each part of the path as bytes, a folder before the files beside it.
  assert.deepEqual(names(compareGitlabPaths), ['PLC', '  ModuleTests/POUs', '    FB_ValveTest', '  Modules', '    POUs', '      FB_Valve', '    Z', '    a']);
  // GitHub (git): by the whole path as bytes.
  assert.deepEqual(names(compareGithubPaths), ['PLC', '  ModuleTests/POUs', '    FB_ValveTest', '  Modules', '    POUs', '      FB_Valve', '    Z', '    a']);
  assert.deepEqual(['b/x', 'a.TcPOU', 'a/b', 'B'].sort(compareGitlabPaths), ['a/b', 'b/x', 'B', 'a.TcPOU']);
  assert.deepEqual(['b/x', 'a.TcPOU', 'a/b', 'B'].sort(compareGithubPaths), ['B', 'a.TcPOU', 'a/b', 'b/x']);
});

test('github: the files of a pull request\'s diff, renamed, added, deleted and quoted ones included', () => {
  const diff = String.raw`diff --git a/PLC/POUs/FB_Valve.TcPOU b/PLC/POUs/FB_Valve.TcPOU
index 1111111..2222222 100644
--- a/PLC/POUs/FB_Valve.TcPOU
+++ b/PLC/POUs/FB_Valve.TcPOU
@@ -1,3 +1,3 @@
--- a removed line that looks like a header
+++ b/not/a/file
diff --git a/PLC/POUs/FB_Old.TcPOU b/PLC/POUs/Valves/FB_New.TcPOU
similarity index 90%
rename from PLC/POUs/FB_Old.TcPOU
rename to PLC/POUs/Valves/FB_New.TcPOU
index 3333333..4444444 100644
--- a/PLC/POUs/FB_Old.TcPOU
+++ b/PLC/POUs/Valves/FB_New.TcPOU
@@ -1 +1 @@
-x
+y
diff --git a/PLC/DUTs/E_Moved.TcDUT b/PLC/DUTs/Enums/E_Moved.TcDUT
similarity index 100%
rename from PLC/DUTs/E_Moved.TcDUT
rename to PLC/DUTs/Enums/E_Moved.TcDUT
diff --git a/PLC/GVLs/GVL_New.TcGVL b/PLC/GVLs/GVL_New.TcGVL
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/PLC/GVLs/GVL_New.TcGVL
@@ -0,0 +1 @@
+x
diff --git a/PLC/POUs/FB_Gone.TcPOU b/PLC/POUs/FB_Gone.TcPOU
deleted file mode 100644
index 6666666..0000000
--- a/PLC/POUs/FB_Gone.TcPOU
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git "a/PLC/POUs/FB_Gr\303\266\303\237e.TcPOU" "b/PLC/POUs/FB_Gr\303\266\303\237e.TcPOU"
index 7777777..8888888 100644
--- "a/PLC/POUs/FB_Gr\303\266\303\237e.TcPOU"
+++ "b/PLC/POUs/FB_Gr\303\266\303\237e.TcPOU"
@@ -1 +1 @@
-x
+y
diff --git a/My POUs/FB_Mode.TcPOU b/My POUs/FB_Mode.TcPOU
old mode 100644
new mode 100755
`;
  assert.deepEqual(filesInDiff(diff.replace(/\n/g, '\r\n')), [
    { path: 'PLC/POUs/FB_Valve.TcPOU', status: 'modified' },
    { path: 'PLC/POUs/Valves/FB_New.TcPOU', oldPath: 'PLC/POUs/FB_Old.TcPOU', status: 'renamed' },
    { path: 'PLC/DUTs/Enums/E_Moved.TcDUT', oldPath: 'PLC/DUTs/E_Moved.TcDUT', status: 'renamed' },
    { path: 'PLC/GVLs/GVL_New.TcGVL', status: 'added' },
    { path: 'PLC/POUs/FB_Gone.TcPOU', status: 'deleted' },
    { path: 'PLC/POUs/FB_Größe.TcPOU', status: 'modified' },
    { path: 'My POUs/FB_Mode.TcPOU', status: 'modified' },
  ]);
});

// ------------------------------------------------------------------ review comments

const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const VALVE = 'POUs/FB_Valve.TcPOU';

/** A position of a GitLab diff note on the valve, on the diff from `base` to `head`. */
function at(lines: { old?: number; new?: number }, base = A, head = B): Record<string, unknown> {
  return {
    base_sha: base, start_sha: C, head_sha: head, old_path: VALVE, new_path: VALVE, position_type: 'text', old_line: lines.old ?? null, new_line: lines.new ?? null,
  };
}

/** A discussion of GitLab's `discussions.json`: a diff note and its replies, at a position (and the ones GitLab carried). */
function discussion(id: number, position: Record<string, unknown>, o: { replies?: number; resolved?: boolean; positions?: Record<string, unknown>[] } = {}) {
  const notes = Array.from({ length: 1 + (o.replies ?? 0) }, (_, n) => ({
    id: id * 10 + n, type: 'DiffNote', author: { name: `Reviewer ${n + 1}`, username: `reviewer${n + 1}` }, created_at: '2026-10-20T08:30:00.000Z',
    system: false, note: n === 0 ? `Comment ${id}` : `Reply ${n}`, resolvable: true, resolved: o.resolved ?? false,
  }));
  return {
    id: `d${id}`, diff_discussion: true, individual_note: false, resolvable: true, resolved: o.resolved ?? false, notes, position,
    original_position: position, ...(o.positions ? { positions: o.positions } : {}),
  };
}

const urlOf = (id: string) => noteUrl('https://gitlab.example.com', 'plc/machine', 7, id);
const gitlabThreads = (list: unknown) => threadsFromGitlab(list, urlOf);

/** The threads under section lines, as `thread object section kind text`. */
function underLines(v: FileView, threads: ReviewThread[], commits = { base: A, head: B }): string[] {
  return [...placeThreads(v, threads, commits).lines].flatMap(([key, list]) => {
    const [o, s, k] = key.split(':').map(Number);
    const sec = v.objects[o].sections[s];
    return list.map(p => `${p.thread.id} ${v.objects[o].label} ${sec.label} ${sec.lines[k].kind} ${sec.lines[k].text} @${p.side}${p.line}`);
  }).sort();
}

test('comments: a note goes under the section line its XML line is on: old_line in the base file, new_line in the head file', () => {
  const before = valve();
  const after = valve({ openImpl: 'nCycles := nCycles + 1;\nbOpened := bForce OR bOpen;\nRETURN;' });
  const v = view({ before, after });
  // The head has one line more in Open: below it, the same line has another number at the base than at the head.
  assert.equal(lineOf(after, 'METHOD Close'), lineOf(before, 'METHOD Close') + 1);
  const threads = gitlabThreads([
    discussion(1, at({ new: lineOf(after, 'RETURN;') })),
    discussion(2, at({ old: lineOf(before, 'bOpened := TRUE;') }), { replies: 2 }),
    discussion(3, at({ old: lineOf(before, 'nCycles := nCycles + 1;'), new: lineOf(after, 'nCycles := nCycles + 1;') })),
    discussion(4, at({ old: lineOf(before, 'METHOD Close'), new: lineOf(after, 'METHOD Close') })),
    // On the base side of an unchanged line: the base file's line, which is another line in the head file.
    discussion(5, at({ old: lineOf(before, 'METHOD Close') })),
  ]);
  assert.deepEqual(underLines(v, threads), [
    `d1 FB_Valve.Open Implementation add RETURN; @R${lineOf(after, 'RETURN;')}`,
    `d2 FB_Valve.Open Implementation del bOpened := TRUE; @L${lineOf(before, 'bOpened := TRUE;')}`,
    `d3 FB_Valve.Open Implementation same nCycles := nCycles + 1; @R${lineOf(after, 'nCycles := nCycles + 1;')}`,
    `d4 FB_Valve.Close Declaration same METHOD Close @R${lineOf(after, 'METHOD Close')}`,
    `d5 FB_Valve.Close Declaration same METHOD Close @L${lineOf(before, 'METHOD Close')}`,
  ]);
  const p = placeThreads(v, threads, { base: A, head: B });
  assert.deepEqual(v.objects.map((o, i) => `${o.label} ${p.perObject[i]}`).filter(s => !s.endsWith(' 0')), ['FB_Valve.Open 3', 'FB_Valve.Close 2']);
  assert.deepEqual([p.xml.length, p.outdated.length], [0, 0]);
  // The thread as the view shows it: author, time, text, replies, resolved state, where it is in the page.
  const d2 = threads.find(t => t.id === 'd2')!;
  assert.deepEqual(d2.notes.map(n => `${n.author}: ${n.body}`), ['Reviewer 1: Comment 2', 'Reviewer 2: Reply 1', 'Reviewer 3: Reply 2']);
  assert.deepEqual([d2.resolved, d2.anchor, d2.url], [false, 'note_20', 'https://gitlab.example.com/plc/machine/-/merge_requests/7#note_20']);
});

test('comments: a note on a line in no section (LineIds, the XML declaration, the whole file) goes to the comments on the XML', () => {
  const before = valve();
  const after = valve({ lineIds: '2', cfc: '<Box Id="1" X="30" Y="20" />' });
  const v = view({ before, after });
  const threads = gitlabThreads([
    discussion(1, at({ old: lineOf(before, '<LineId Id="3"') })),
    discussion(2, at({ new: lineOf(after, '<LineId Id="3"') })),
    discussion(3, at({ old: 1, new: 1 })),
    discussion(4, { ...at({}), position_type: 'file' }),
    // A line of graphical code: under its section, which shows no lines.
    discussion(5, at({ new: lineOf(after, '<Box Id="1" X="30"') })),
  ]);
  const p = placeThreads(v, threads, { base: A, head: B });
  assert.equal(p.lines.size, 0);
  assert.deepEqual(p.xml.map(x => `${x.thread.id} ${x.position?.file ? 'file' : `${x.side}${x.line}`} ${x.object === undefined ? '-' : v.objects[x.object].label}`), [
    `d1 L${lineOf(before, '<LineId Id="3"')} FB_Valve`, `d2 R${lineOf(after, '<LineId Id="3"')} FB_Valve`, 'd3 R1 -', 'd4 file -',
  ]);
  const draw = v.objects.findIndex(o => o.label === 'FB_Valve.A_Draw');
  assert.deepEqual([...p.sections.keys()], [`${draw}:0`]);
  assert.deepEqual(v.objects.map((o, i) => `${o.label} ${p.perObject[i]}`).filter(s => !s.endsWith(' 0')), ['FB_Valve.A_Draw 1']);
});

test('comments: a note on other commits than the page compares is outdated; one GitLab carried to the merge ref is placed there', () => {
  const after = valve({ openImpl: 'nCycles := nCycles + 1;\nbOpened := bForce OR bOpen;\nRETURN;' });
  const v = view({ before: valve(), after });
  const ret = lineOf(after, 'RETURN;');
  const threads = gitlabThreads([
    // Made on an older version (head D) and not carried on: its line changed since.
    discussion(1, at({ new: 5 }, A, D)),
    // On the merge base → head diff, and carried by GitLab to the merge ref's diff (target branch E → merge commit C).
    discussion(2, at({ new: ret }), { positions: [at({ new: ret + 2 }, E, C)] }),
  ]);
  let p = placeThreads(v, threads, { base: A, head: B });
  assert.deepEqual(p.outdated.map(x => `${x.thread.id} R${x.position?.newLine} at ${x.position?.head?.slice(0, 7)}`), ['d1 R5 at ddddddd']);
  assert.deepEqual(underLines(v, threads), [`d2 FB_Valve.Open Implementation add RETURN; @R${ret}`]);
  // The page compares the merge ref: the position on it is the one that counts.
  assert.deepEqual(currentPosition(threads[1], { base: E, head: C })?.newLine, ret + 2);
  p = placeThreads(v, threads, { base: E, head: C });
  assert.deepEqual(p.outdated.map(x => x.thread.id), ['d1']);
  // A note's file, renamed or not: by its path at the head or at the base.
  assert.equal(threadsOfFile(threads, VALVE).length, 2);
  assert.equal(threadsOfFile(threads, 'POUs/Valves/FB_Valve.TcPOU', VALVE).length, 2);
  assert.equal(threadsOfFile(threads, 'POUs/FB_Pump.TcPOU').length, 0);
});

test('comments: GitLab\'s discussions of the page and of the REST API, without system notes and comments on the merge request', () => {
  const rest = [
    // The REST API: the position is on the note, its text in `body`.
    { id: 'r1', individual_note: false, notes: [{ id: 91, type: 'DiffNote', body: 'From the API', author: { name: 'API User' }, created_at: '2026-10-19T10:00:00Z', system: false, resolvable: true, resolved: true, position: { ...at({ new: 12 }), line_range: { start: { old_line: null, new_line: 10 }, end: { old_line: null, new_line: 12 } } } }] },
    // A comment on the merge request, not on its diff; a system note.
    { id: 'r2', individual_note: true, notes: [{ id: 92, type: null, body: 'Looks good', author: { name: 'API User' }, system: false }] },
    { id: 'r3', individual_note: true, notes: [{ id: 93, type: null, body: 'added 1 commit', system: true }] },
    // An image's note is on no XML line.
    { id: 'r4', notes: [{ id: 94, type: 'DiffNote', body: 'x', position: { ...at({}), position_type: 'image' } }] },
  ];
  const threads = gitlabThreads(rest);
  assert.deepEqual(threads.map(t => [t.id, t.notes.map(n => n.body), t.resolved]), [['r1', ['From the API'], true]]);
  assert.deepEqual(threads[0].positions, [{ oldPath: VALVE, newPath: VALVE, base: A, head: B, newLine: 12, start: { side: 'R', line: 10 } }]);
  assert.deepEqual(gitlabThreads({ message: '401 Unauthorized' }), []);
  // The page's discussions: all of them (not the filter saved for the user), in pages after a cursor.
  assert.equal(discussionsUrl('https://gitlab.example.com', 'group/plc machine', 7),
    'https://gitlab.example.com/group/plc%20machine/-/merge_requests/7/discussions.json?notes_filter=0&persist_filter=false&per_page=100');
  assert.match(discussionsUrl('https://gitlab.com', 'a/b', 7, 'x+y=='), /&cursor=x%2By%3D%3D$/);
});

test('comments: GitHub\'s review comments make threads with their replies; an outdated one keeps its original line', () => {
  const path = 'PLC/POUs/FB_Valve.TcPOU';
  const comment = (c: Record<string, unknown>) => ({
    path, commit_id: B, original_commit_id: B, side: 'RIGHT', user: { login: 'octocat' }, created_at: '2026-10-20T09:00:00Z', subject_type: 'line',
    html_url: `https://github.com/acme/plc/pull/12#discussion_r${c.id}`, body: `Comment ${c.id}`, ...c,
  });
  const threads = threadsFromGithub([
    comment({ id: 11, line: 40, original_line: 38, original_commit_id: D }),
    comment({ id: 12, in_reply_to_id: 11, line: 40, user: { login: 'hubot' } }),
    comment({ id: 13, line: null, original_line: 12, side: 'LEFT', commit_id: D, original_commit_id: D }),
    comment({ id: 14, line: null, subject_type: 'file' }),
    comment({ id: 15, line: 44, start_line: 42, start_side: 'RIGHT' }),
  ]);
  assert.deepEqual(threads.map(t => `${t.anchor} ${t.notes.map(n => n.author).join('+')} ${t.resolved}`),
    ['discussion_r11 octocat+hubot undefined', 'discussion_r13 octocat undefined', 'discussion_r14 octocat undefined', 'discussion_r15 octocat undefined']);
  const commits = { base: A, head: B };
  assert.deepEqual(currentPosition(threads[0], commits), { newPath: path, head: B, newLine: 40 });
  assert.equal(currentPosition(threads[1], commits), undefined);
  assert.deepEqual(threads[1].positions, [{ newPath: path, head: D, oldLine: 12 }]);
  assert.deepEqual(currentPosition(threads[2], commits), { newPath: path, head: B, file: true });
  assert.deepEqual(currentPosition(threads[3], commits)?.start, { side: 'R', line: 42 });
  assert.equal(reviewCommentsUrl({ owner: 'acme', repo: 'plc', number: 12 }, 2), 'https://api.github.com/repos/acme/plc/pulls/12/comments?per_page=100&page=2');
});

test('navigation: an anchor in the diff a TwinCAT view hides turns that view off, with the way back; a link to the file keeps it', () => {
  const valveBlock = `diff-${'1'.repeat(64)}`;
  const pumpBlock = '5d2c773018c2590cb27a24e51e7e2d43b6633c83';
  const offBlock = `diff-${'2'.repeat(64)}`;
  const views: ViewState[] = [
    { anchor: valveBlock, path: VALVE, on: true },
    { anchor: pumpBlock, path: 'POUs/FB_Pump.TcPOU', oldPath: 'POUs/Old/FB_Pump.TcPOU', on: true },
    { anchor: offBlock, path: 'POUs/FB_Off.TcPOU', on: false },
  ];
  const [onValve] = gitlabThreads([discussion(1, at({ new: 40 }), { replies: 1 })]);
  const onOff: ReviewThread = { ...onValve, id: 'd9', notes: [{ ...onValve.notes[0], id: '99' }], positions: [{ newPath: 'POUs/FB_Off.TcPOU', head: B, newLine: 3 }] };
  const threads = [onValve, onOff];
  // In the page, in the hidden diff of a view that is on: off, coming back to the thread.
  assert.deepEqual(leaveFor('#note_10', views, { anchor: valveBlock, inDiff: true }, threads), { anchor: valveBlock, back: { thread: 'd1' } });
  assert.deepEqual(leaveFor(`#${valveBlock}R12`, views, { anchor: valveBlock, inDiff: true }, []), { anchor: valveBlock, back: { xml: { side: 'R', line: 12 } } });
  // In the file's header or its block itself, or in the diff of a view that is off: nothing to do.
  assert.equal(leaveFor('#note_10', views, { anchor: valveBlock, inDiff: false }, threads), undefined);
  assert.equal(leaveFor('#note_99', views, { anchor: offBlock, inDiff: true }, threads), undefined);
  // Not in the page (not rendered yet): the thread's file, from the threads, a reply's anchor too.
  assert.deepEqual(leaveFor('#note_11', views, undefined, threads), { anchor: valveBlock, back: { thread: 'd1' }, thread: onValve });
  assert.equal(leaveFor('#note_99', views, undefined, threads), undefined);
  assert.equal(leaveFor('#note_12345', views, undefined, threads), undefined);
  // Line anchors: GitHub's; GitLab's Rapid Diffs (`A`: an added line) and classic page.
  const line = (anchor: string, side: 'L' | 'R', n: number) => ({ anchor, back: { xml: { side, line: n } }, line: { side, line: n } });
  assert.deepEqual(leaveFor(`#${valveBlock}L7`, views, undefined, []), line(valveBlock, 'L', 7));
  assert.deepEqual(leaveFor('#line_5d2c77301_A15', views, undefined, []), line(pumpBlock, 'R', 15));
  assert.deepEqual(leaveFor('#line_5d2c77301_14', views, undefined, []), line(pumpBlock, 'L', 14));
  assert.deepEqual(leaveFor(`#${pumpBlock}_10_11`, views, undefined, []), line(pumpBlock, 'R', 11));
  assert.equal(leaveFor(`#${offBlock}R3`, views, undefined, []), undefined);
  // A link to a file, another anchor, no anchor.
  assert.equal(leaveFor(`#${valveBlock}`, views, undefined, []), undefined);
  assert.equal(leaveFor('#top', views, undefined, threads), undefined);
  assert.equal(leaveFor('', views, undefined, threads), undefined);
  assert.deepEqual(['note_5', 'discussion_r1234', 'r77', 'notes'].map(noteOfAnchor), ['5', '1234', '77', undefined]);
  assert.equal(anchorId('#note_%31'), 'note_1');
});

test('tree: the review threads on an object and on its file', () => {
  const path = 'PLC/POUs/FB_Valve.TcPOU';
  const v = buildFileView({ path, before: valve(), after: valve({ openImpl: 'bOpened := TRUE;', getImpl: 'State := 1;' }) });
  const perObject = v.objects.map(o => (o.label === 'FB_Valve.Open' ? 2 : o.label === 'FB_Valve.State.Get' ? 1 : 0));
  const file = buildTree([{ path, view: v, comments: { perObject, total: 4 } }])[0].children[0];
  assert.equal(file.comments, 4);
  assert.equal(file.children.find(n => n.label === 'Open')?.comments, 2);
  const state = file.children.find(n => n.label === 'State')!;
  assert.deepEqual([state.comments, state.children[0].comments], [undefined, 1]);
});

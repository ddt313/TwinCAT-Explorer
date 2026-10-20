// The object view of the browser extension (browser/src): which objects of a TwinCAT file a pull request
// changed, the line diff of their sections and the XML line of each changed line, on made-up files.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { commitsInPage, filesInDiff, filesPage, githubRawTemplate } from '../../browser/src/github';
import {
  commitsFromDiffRefs, filesFromApi, gitlabRawTemplate, gitlabTheme, isChangesTab, mergeRequestApi, mergeRequestPage, rapidFileData, rapidLineAnchor,
} from '../../browser/src/gitlab';
import { Edit, diffLines, lineChange } from '../../browser/src/lineDiff';
import { FileInput, FileView, ObjectView, buildFileView, isTwinCatFile } from '../../browser/src/model';
import { TreeParams, ViewerParams, decodeTreeParams, decodeViewerParams, encodeTreeParams, encodeViewerParams, fileUrl } from '../../browser/src/params';
import { fetchAllowed } from '../../browser/src/protocol';
import { TreeNode, buildTree, treeSummary } from '../../browser/src/treeModel';

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

test('project files: a TmcHash rewritten by a build is metadata, other changes are left to GitHub', () => {
  const tsproj = (hash: string, extra = '') => `<TcSmProject>\r\n<Project TmcHash="{${hash}}" TmcPath="Plc\\Plc.tmc">${extra}</Project>\r\n</TcSmProject>`;
  assert.equal(buildFileView({ path: 'Machine.tsproj', before: tsproj('AAAA-1'), after: tsproj('BBBB-2') }).metadataOnly,
    'TmcHash only, rewritten by a build');
  const other = buildFileView({ path: 'Machine.tsproj', before: tsproj('AAAA-1'), after: tsproj('BBBB-2', '<Task/>') });
  assert.equal(other.metadataOnly, undefined);
  assert.match(other.note ?? '', /project file/);
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

test('github: the pull request of a "Files changed" page, in the classic and the React page and for a commit range', () => {
  assert.deepEqual(filesPage('/acme/plc/pull/12/files'), { owner: 'acme', repo: 'plc', number: 12 });
  assert.deepEqual(filesPage('/acme/plc/pull/12/changes'), { owner: 'acme', repo: 'plc', number: 12 });
  assert.deepEqual(filesPage(`/acme/plc/pull/12/files/${A.slice(0, 7)}..${B.slice(0, 7)}`), { owner: 'acme', repo: 'plc', number: 12 });
  assert.equal(filesPage('/acme/plc/pull/12'), undefined);
  assert.equal(filesPage('/acme/plc/pull/12/commits'), undefined);
  assert.ok(isTwinCatFile('PLC/POUs/FB_Valve.TcPOU') && isTwinCatFile('a/E_State.tcdut') && isTwinCatFile('Machine.tsproj'));
  assert.ok(!isTwinCatFile('PLC/PLC.plcproj') && !isTwinCatFile('README.md'));
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
    theme: 'auto', diff: 'https://github.com/acme/plc/pull/12.diff', source: undefined,
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

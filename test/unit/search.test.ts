import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { viewLabel } from '../../src/core/objectText';
import { PlcProject } from '../../src/core/project';
import { TcSourceFile, parseTcText } from '../../src/core/tcfile';
import { SourceEntry, fileKey } from '../../src/core/workspace';
import {
  QueryError, SearchCount, SearchHit, SearchQuery, SearchScope, SearchSource, compileQuery, matchLines, searchSections,
} from '../../src/lang/search';

/** The texts of the matches of a query. */
const found = (q: SearchQuery, text: string) => compileQuery(q).matches(text).map(m => text.slice(m.start, m.end));

test('finds a text case aside, as Structured Text has it, and as written with Match Case', () => {
  const text = 'nCount := NCOUNT + ncount;';
  assert.deepEqual(found({ text: 'ncount' }, text), ['nCount', 'NCOUNT', 'ncount']);
  assert.deepEqual(found({ text: 'ncount', matchCase: true }, text), ['ncount']);
  // The characters of regular expressions are plain characters in a text.
  assert.deepEqual(found({ text: 'a.b(1)' }, 'a.b(1) axb(1) a.b(1'), ['a.b(1)']);
  assert.deepEqual(found({ text: 'Größe' }, '// GRÖSSE größe Größe'), ['größe', 'Größe']);
});

test('a whole word is not part of a longer name, and may start or end with an operator', () => {
  const text = 'nCount nCountMax _nCount nCount2 (nCount) x.nCount\nnCount';
  assert.deepEqual(compileQuery({ text: 'nCount', wholeWord: true }).matches(text).map(m => m.start),
    [0, text.indexOf('(nCount)') + 1, text.indexOf('x.nCount') + 2, text.lastIndexOf('nCount')]);
  // `:=` needs no boundary; the `0` at its end does.
  assert.deepEqual(found({ text: ':= 0', wholeWord: true }, 'a:= 0; b := 01;'), [':= 0']);
});

test('regular expressions: RE2 syntax, case aside, ^ and $ for each line, lookbehind, whole words', () => {
  assert.deepEqual(found({ text: 'n\\w+Max', regex: true }, 'nCountMax NSPEEDMAX nMax'), ['nCountMax', 'NSPEEDMAX']);
  assert.deepEqual(found({ text: 'IF', regex: true, matchCase: true }, 'IF if If'), ['IF']);
  assert.deepEqual(found({ text: '^\\s*IF\\b', regex: true }, 'x := 1; IF a\n  IF b THEN\nEND_IF'), ['  IF']);
  assert.deepEqual(compileQuery({ text: ';$', regex: true }).matches('a;\nb; // c\nd;').map(m => m.start), [1, 12]);
  assert.deepEqual(found({ text: '(?<=:=\\s*)TRUE', regex: true }, 'b := TRUE; IF TRUE THEN'), ['TRUE']);
  // A candidate joined to a longer name is looked for again further on.
  assert.deepEqual(found({ text: 'n\\w*', regex: true, wholeWord: true }, 'nA _nB nC'), ['nA', 'nC']);
  // Empty matches are no result.
  assert.deepEqual(found({ text: 'x*', regex: true }, 'axxb x'), ['xx', 'x']);
  // Offsets of the JavaScript string, after characters outside the BMP too.
  const text = '// 🙂 𝔸 nCount := 1;';
  assert.deepEqual(compileQuery({ text: 'ncount', regex: true }).matches(text), [{ start: text.indexOf('nCount'), end: text.indexOf('nCount') + 6 }]);
});

test('a query that cannot run is a QueryError, which says what RE2 lacks', () => {
  const error = (q: SearchQuery, re: RegExp) => assert.throws(() => compileQuery(q), e => e instanceof QueryError && re.test(e.message));
  error({ text: '[a', regex: true }, /^Invalid regular expression: missing closing \]/);
  error({ text: 'IF(?= THEN)', regex: true }, /lookahead is not supported/);
  error({ text: '(a)\\1', regex: true }, /backreferences are not supported/);
  error({ text: '' }, /Type the text/);
  // Not a regular expression: plain characters.
  assert.deepEqual(found({ text: '[a' }, 'x[a'), ['[a']);
});

test('a regular expression that backtracks for minutes in JavaScript runs in linear time', () => {
  // JavaScript takes about a minute for this pattern on 8 such words (47 characters) without END_VAR.
  const line = Array.from({ length: 2000 }, (_, i) => `nVar${i}`).join(' ');
  const pattern: SearchQuery = { text: '(\\w+\\s*)*END_VAR', regex: true };
  const t = Date.now();
  assert.deepEqual(compileQuery(pattern).matches(line), []);
  assert.equal(compileQuery(pattern).matches(`${line} END_VAR`).length, 1);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});

test('Skip Comments leaves out the matches in comments, nested ones too, and keeps those in pragmas and strings', () => {
  const text = "nX := 1; // nX\n(* nX (* nX *) nX *)\n{attribute 'nX'}\ns := 'nX';\nnX := 2;";
  assert.equal(found({ text: 'nX' }, text).length, 8);
  const kept = compileQuery({ text: 'nX', skipComments: true }).matches(text).map(m => m.start);
  assert.deepEqual(kept, [0, text.indexOf("'nX'}") + 1, text.indexOf("'nX';") + 1, text.lastIndexOf('nX')]);
  assert.deepEqual(compileQuery({ text: 'n\\w', regex: true, skipComments: true }).matches(text).map(m => m.start), kept);
  // A whole word looked for again past a comment.
  assert.deepEqual(found({ text: 'nX', wholeWord: true, skipComments: true }, '(* nX *) nXa nX'), ['nX']);
});

test('the line of a match: line and column, the line without its indentation, the match highlighted, long lines shortened', () => {
  const lines = (text: string, q: SearchQuery) => matchLines(text, compileQuery(q).matches(text));
  assert.deepEqual(lines('VAR\n\tnCount : INT;\nEND_VAR', { text: 'ncount' }),
    [{ line: 1, character: 1, preview: 'nCount : INT;', highlight: [0, 6] }]);
  assert.deepEqual(lines('a := b;\tc := a;', { text: 'a', wholeWord: true }).map(l => [l.preview, l.highlight]),
    [['a := b; c := a;', [0, 1]], ['a := b; c := a;', [13, 14]]]);
  // In the indentation: kept.
  assert.deepEqual(lines('IF x THEN\n   y := 1;', { text: '^\\s+', regex: true }), [{ line: 1, character: 0, preview: '   y := 1;', highlight: [0, 3] }]);
  // Over two lines: highlighted to the end of the first.
  assert.deepEqual(lines('IF a\nTHEN', { text: 'a\\nTHEN', regex: true }), [{ line: 0, character: 3, preview: 'IF a', highlight: [3, 4] }]);
  // At most 26 characters before the match, from the start of a word: a narrow list shows it.
  const gvl = '\tabValveCmd : ARRAY[1..4] OF BOOL; // bOpen of each valve';
  const [cut] = matchLines(gvl, compileQuery({ text: 'bopen' }).matches(gvl), 250, 26);
  assert.deepEqual(cut, { line: 0, character: 38, preview: '…ARRAY[1..4] OF BOOL; // bOpen of each valve', highlight: [25, 30] });
  assert.equal(cut.preview.slice(...cut.highlight), 'bOpen');
  const long = `${'x'.repeat(300)} TARGET ${'y'.repeat(300)}`;
  const [l] = lines(long, { text: 'target' });
  assert.equal(l.character, 301);
  assert.ok(l.preview.startsWith('…') && l.preview.endsWith('…') && l.preview.length <= 252, l.preview);
  assert.equal(l.preview.slice(...l.highlight), 'TARGET');
});

// ------------------------------------------------------------------ sections and scopes

const HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1">';
let ids = 0;
const id = () => `{00000000-0000-0000-0000-${String(++ids).padStart(12, '0')}}`;
const folderAttr = (folder: string) => (folder ? ` FolderPath="${folder}\\"` : '');
const method = (name: string, impl: string, folder = '') => `
    <Method Name="${name}" Id="${id()}"${folderAttr(folder)}>
      <Declaration><![CDATA[METHOD ${name} : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[${impl}]]></ST>
      </Implementation>
    </Method>`;
const property = (name: string, get: string, folder = '') => `
    <Property Name="${name}" Id="${id()}"${folderAttr(folder)}>
      <Declaration><![CDATA[PROPERTY ${name} : BOOL]]></Declaration>
      <Get Name="Get" Id="${id()}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[${get}]]></ST>
        </Implementation>
      </Get>
    </Property>`;
const pou = (name: string, decl: string, impl: string, members = '') => `${HEAD}
  <POU Name="${name}" Id="${id()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl}]]></ST>
    </Implementation>${members}
  </POU>
</TcPlcObject>`;
const gvl = (name: string, decl: string) => `${HEAD}
  <GVL Name="${name}" Id="${id()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </GVL>
</TcPlcObject>`;

const project = (name: string): PlcProject => ({
  path: path.resolve('S', name, `${name}.plcproj`), dir: path.resolve('S', name), name, compile: [], folders: [], excluded: [], libraries: [],
});

/** Two PLC projects: Machine (FB_Valve in POUs\Valves with members in folders, MAIN, GVL_IO) and Cell (FB_Other). */
function workspace(): { source: SearchSource; files: Map<string, TcSourceFile>; machine: PlcProject; valve: string } {
  const machine = project('Machine');
  const cell = project('Cell');
  const files = new Map<string, TcSourceFile>();
  const entries: SourceEntry[] = [];
  const add = (p: PlcProject, include: string, text: string) => {
    const full = path.join(p.dir, ...include.split('\\'));
    entries.push({ path: full, key: fileKey(full), include, project: p });
    files.set(fileKey(full), parseTcText(full, text));
    return full;
  };
  const valve = add(machine, 'POUs\\Valves\\FB_Valve.TcPOU', pou('FB_Valve', 'FUNCTION_BLOCK FB_Valve\nVAR\n\tbOpen : BOOL;\nEND_VAR', 'IF bOpen THEN\n\tM_Open();\nEND_IF',
    method('M_Open', 'bOpen := TRUE;', 'Commands') + property('P_Open', 'P_Open := bOpen;', 'Commands\\Sub') + method('M_Init', 'bOpen := FALSE;')));
  add(machine, 'POUs\\MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN\nVAR\n\tfbValve : FB_Valve;\nEND_VAR', 'fbValve(bOpen := GVL_IO.bOpen);'));
  add(machine, 'GVLs\\GVL_IO.TcGVL', gvl('GVL_IO', 'VAR_GLOBAL\n\tbOpen : BOOL;\nEND_VAR'));
  add(cell, 'POUs\\FB_Other.TcPOU', pou('FB_Other', 'FUNCTION_BLOCK FB_Other', 'bOpen := TRUE;'));
  return { source: { entries, file: e => files.get(e.key) }, files, machine, valve };
}

const describe = (h: SearchHit) => `${h.entry.project.name}:${viewLabel(h.section.owner, h.section.accessor)} ${h.section.role} ${h.matches.length}`;
const hits = (source: SearchSource, scope: SearchScope, q: SearchQuery = { text: 'bopen' }, limit = 1000, count?: SearchCount) =>
  [...searchSections(source, scope, compileQuery(q), limit, count)].filter((h): h is SearchHit => !!h).map(describe);

test('searches the sections of the PLC projects in order: a project, a folder with its subfolders, a folder inside a POU', () => {
  const { source, machine, valve } = workspace();
  const valveHits = [
    'Machine:FB_Valve decl 1', 'Machine:FB_Valve impl 1', 'Machine:FB_Valve.M_Open impl 1', 'Machine:FB_Valve.P_Open.Get impl 1',
    'Machine:FB_Valve.M_Init impl 1',
  ];
  const all = [...valveHits, 'Machine:MAIN impl 2', 'Machine:GVL_IO decl 1', 'Cell:FB_Other impl 1'];
  assert.deepEqual(hits(source, { kind: 'all' }), all);
  assert.deepEqual(hits(source, { kind: 'projects', plcprojPaths: [machine.path] }), all.slice(0, -1));
  // Case aside, with its subfolders.
  assert.deepEqual(hits(source, { kind: 'folder', plcprojPath: machine.path, folder: 'pous' }), [...valveHits, 'Machine:MAIN impl 2']);
  assert.deepEqual(hits(source, { kind: 'folder', folder: 'POUs/Valves/' }), valveHits);
  // Without a project: the folder of each one.
  assert.deepEqual(hits(source, { kind: 'folder', folder: 'POUs' }), [...valveHits, 'Machine:MAIN impl 2', 'Cell:FB_Other impl 1']);
  assert.deepEqual(hits(source, { kind: 'folder', folder: 'POUs\\Val' }), []);
  // A folder inside the POU: the members in it and in its subfolders, not the POU itself.
  assert.deepEqual(hits(source, { kind: 'objectFolder', fsPath: valve, folderPath: ['commands'] }),
    ['Machine:FB_Valve.M_Open impl 1', 'Machine:FB_Valve.P_Open.Get impl 1']);
  assert.deepEqual(hits(source, { kind: 'objectFolder', fsPath: valve, folderPath: ['Commands', 'Sub'] }), ['Machine:FB_Valve.P_Open.Get impl 1']);
});

test('the search stops at its limit and says whether there are more; it pauses after each section', () => {
  const { source } = workspace();
  const count = (limit: number) => {
    const c: SearchCount = { matches: 0, capped: false };
    const out = hits(source, { kind: 'all' }, { text: 'bOpen' }, limit, c);
    return { out: out.length, ...c };
  };
  assert.deepEqual(count(3), { out: 3, matches: 3, capped: true });
  // The limit inside a section: its first matches.
  assert.deepEqual(count(6), { out: 6, matches: 6, capped: true });
  assert.deepEqual(count(9), { out: 8, matches: 9, capped: false });
  assert.deepEqual(count(100), { out: 8, matches: 9, capped: false });
  // A section without a match is an undefined, so that the caller can pause.
  const steps = [...searchSections(source, { kind: 'all' }, compileQuery({ text: 'FB_Valve' }), 100)];
  assert.ok(steps.length > 2 && steps.filter(s => s).length === 2, `${steps.length} steps`);
});

test('the text of a section can come from an editor with unsaved edits', () => {
  const { source, valve } = workspace();
  const edited: SearchSource = {
    ...source,
    text: (entry, section) => (entry.path === valve && section.role === 'impl' && !section.owner.parent ? 'bClosed := NOT bOpen; bOpen := FALSE;' : undefined),
  };
  const [hit] = [...searchSections(edited, { kind: 'all' }, compileQuery({ text: 'bOpen' }), 100)].filter((h): h is SearchHit => !!h && h.section.role === 'impl');
  assert.equal(hit.text, 'bClosed := NOT bOpen; bOpen := FALSE;');
  assert.deepEqual(hit.matches, [{ start: 15, end: 20 }, { start: 22, end: 27 }]);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { viewChanges } from '../../src/core/objectChanges';
import { SpliceError, takeView } from '../../src/core/splice';
import {
  RunGit, discardFiles, discardView, indexEntry, parseIndexEntries, stageFiles, stageView, unstageFiles, unstageView,
} from '../../src/core/staging';
import { parseTcFile, parseTcText } from '../../src/core/tcfile';

const FB = '{11111111-1111-1111-1111-111111111111}';
const OPEN = '{22222222-2222-2222-2222-222222222222}';
const CLOSE = '{33333333-3333-3333-3333-333333333333}';
const PROP = '{44444444-4444-4444-4444-444444444444}';
const STOP = '{77777777-7777-7777-7777-777777777777}';
const RESET = '{88888888-8888-8888-8888-888888888888}';
const id = (guid: string) => guid.replace(/[{}]/g, '');
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

interface Valve {
  /** Name of the function block. */
  pou?: string;
  body?: string;
  /** The action A_Reset, before the methods. */
  reset?: boolean;
  close?: string;
  closeName?: string;
  open?: string;
  /** The method M_Stop, after M_Open. */
  stop?: boolean;
  /** The property P_Position with its Get (false: none), and its Set. */
  prop?: boolean;
  get?: string;
  set?: boolean;
  /** LineIds, as XAE writes them when its option WriteLineIDs is on; `openLines` changes those of M_Open. */
  lines?: boolean;
  openLines?: number;
}

/** FB_Valve as XAE writes it (with LF; members in XAE's order, LineIds last). */
function valve(o: Valve = {}): string {
  const name = o.pou ?? 'FB_Valve';
  const closeName = o.closeName ?? 'M_Close';
  const method = (guid: string, method: string, impl: string) => `
    <Method Name="${method}" Id="${guid}">
      <Declaration><![CDATA[METHOD ${method} : BOOL
VAR_INPUT
END_VAR
]]></Declaration>
      <Implementation>
        <ST><![CDATA[${impl}]]></ST>
      </Implementation>
    </Method>`;
  const accessor = (kind: 'Get' | 'Set', guid: string, impl: string) => `
      <${kind} Name="${kind}" Id="${guid}">
        <Declaration><![CDATA[VAR
END_VAR
]]></Declaration>
        <Implementation>
          <ST><![CDATA[${impl}]]></ST>
        </Implementation>
      </${kind}>`;
  const lineIds = (of: string, count = 0) => `
    <LineIds Name="${of}">
      <LineId Id="2" Count="${count}" />
    </LineIds>`;
  const prop = o.prop ?? true;
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${FB}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK ${name}
VAR
	bOpen : BOOL;
	fPosition : REAL;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[${o.body ?? ''}]]></ST>
    </Implementation>${o.reset ? `
    <Action Name="A_Reset" Id="${RESET}">
      <Implementation>
        <ST><![CDATA[bOpen := FALSE;]]></ST>
      </Implementation>
    </Action>` : ''}${method(CLOSE, closeName, o.close ?? `bOpen := FALSE;\nfPosition := 0;\n${closeName} := TRUE;`)}${
    method(OPEN, 'M_Open', o.open ?? 'bOpen := TRUE;\nfPosition := 100;\nM_Open := TRUE;')}${o.stop ? method(STOP, 'M_Stop', 'M_Stop := M_Close();') : ''}${prop ? `
    <Property Name="P_Position" Id="${PROP}">
      <Declaration><![CDATA[PROPERTY P_Position : REAL]]></Declaration>${
    accessor('Get', '{55555555-5555-5555-5555-555555555555}', o.get ?? 'P_Position := fPosition;')}${
    o.set ? accessor('Set', '{66666666-6666-6666-6666-666666666666}', 'fPosition := P_Position;') : ''}
    </Property>` : ''}${o.lines ? `${lineIds(name)}${o.reset ? lineIds(`${name}.A_Reset`) : ''}${lineIds(`${name}.${closeName}`, 1)}${
    lineIds(`${name}.M_Open`, o.openLines ?? 1)}${o.stop ? lineIds(`${name}.M_Stop`) : ''}${prop ? lineIds(`${name}.P_Position.Get`) : ''}${
    prop && o.set ? lineIds(`${name}.P_Position.Set`) : ''}` : ''}
  </POU>
</TcPlcObject>`;
}

const parse = (text: string) => parseTcText('FB_Valve.TcPOU', text);
/** `into` with the view of `objectId` (and `accessor`) taken from `from`. */
const take = (into: string, from: string, objectId: string, accessor?: 'Get' | 'Set') => takeView(parse(into), parse(from), id(objectId), accessor);

test('taking one changed method of two: its code only, every other byte as it was', () => {
  const both = valve({ open: 'bOpen := TRUE;', close: 'bOpen := FALSE;' });
  assert.equal(take(valve(), both, OPEN), valve({ open: 'bOpen := TRUE;' }));
  assert.equal(take(valve(), both, CLOSE), valve({ close: 'bOpen := FALSE;' }));
  // And back (unstage, or Discard Changes from the index), the POU's own code, a view that is the same.
  assert.equal(take(valve({ open: 'bOpen := TRUE;' }), valve(), OPEN), valve());
  assert.equal(take(valve(), valve({ body: 'M_Open();' }), FB), valve({ body: 'M_Open();' }));
  assert.equal(take(valve(), both, PROP), valve());
  assert.equal(take(valve({ get: 'P_Position := 0;' }), valve(), PROP, 'Get'), valve());
});

test('a new member goes in at its place in the other version, a deleted one goes', () => {
  assert.equal(take(valve(), valve({ stop: true }), STOP), valve({ stop: true }));
  assert.equal(take(valve({ stop: true }), valve(), STOP), valve());
  assert.equal(take(valve(), valve({ reset: true }), RESET), valve({ reset: true }));
  assert.equal(take(valve(), valve({ set: true }), PROP, 'Set'), valve({ set: true }));
  assert.equal(take(valve({ set: true }), valve(), PROP, 'Set'), valve());
  // A new property comes whole, or with only the accessor taken.
  assert.equal(take(valve({ prop: false }), valve({ set: true }), PROP), valve({ set: true }));
  assert.equal(take(valve({ prop: false }), valve({ set: true }), PROP, 'Get'), valve());
  assert.equal(take(valve({ set: true }), valve({ prop: false }), PROP), valve({ prop: false }));
  // Placed after what precedes it there: here, with M_Close missing too, after the implementation.
  const without = (text: string, ...names: string[]) =>
    names.reduce((t, n) => t.replace(new RegExp(`\\n {4}<Method Name="${n}"[\\s\\S]*?</Method>`), ''), text);
  const taken = take(without(valve(), 'M_Close', 'M_Open'), valve({ stop: true }), OPEN);
  assert.equal(taken, without(valve(), 'M_Close'));
  assert.deepEqual(viewChanges(parse(taken), parse(valve({ stop: true }))).map(v => `${v.label} ${v.change}`),
    ['FB_Valve.M_Close added', 'FB_Valve.M_Stop added']);
  assert.equal(take(without(valve({ stop: true }), 'M_Close', 'M_Open'), valve(), CLOSE), without(valve({ stop: true }), 'M_Open'));
});

test('a renamed method: its Name, its code and its LineIds; LineIds come along with the code', () => {
  assert.equal(take(valve({ lines: true }), valve({ lines: true, closeName: 'M_Shut' }), CLOSE), valve({ lines: true, closeName: 'M_Shut' }));
  assert.equal(take(valve({ closeName: 'M_Shut' }), valve(), CLOSE), valve());
  // A renamed POU renames the LineIds of its members too; its members keep their code.
  assert.equal(take(valve({ lines: true }), valve({ lines: true, pou: 'FB_Gate', open: 'bOpen := TRUE;' }), FB),
    valve({ lines: true, pou: 'FB_Gate' }));
  // XAE rewrites the LineIds of the code it saves: they belong to the method.
  const changed = valve({ lines: true, open: 'bOpen := TRUE;', openLines: 0, close: 'bOpen := FALSE;' });
  assert.equal(take(valve({ lines: true }), changed, OPEN), valve({ lines: true, open: 'bOpen := TRUE;', openLines: 0 }));
  assert.equal(take(valve({ lines: true }), valve({ lines: true, stop: true }), STOP), valve({ lines: true, stop: true }));
  assert.equal(take(valve({ lines: true, stop: true }), valve({ lines: true }), STOP), valve({ lines: true }));
  assert.equal(take(valve({ lines: true }), valve({ lines: true, set: true }), PROP, 'Set'), valve({ lines: true, set: true }));
  assert.equal(take(valve({ lines: true, prop: false }), valve({ lines: true, set: true }), PROP, 'Get'), valve({ lines: true }));
  // Not when the POU or the property has another name there: the names of the LineIds would not fit.
  assert.equal(take(valve({ lines: true }), valve({ lines: true, pou: 'FB_Gate', open: 'bOpen := TRUE;', openLines: 0 }), OPEN),
    valve({ lines: true, open: 'bOpen := TRUE;' }));
  const renamedProp = (o: Valve) => valve({ lines: true, ...o }).replace(/P_Position\b/g, 'P_Opening');
  assert.equal(take(valve({ lines: true }), renamedProp({ get: 'P_Opening := 0;' }), PROP, 'Get'), valve({ lines: true, get: 'P_Opening := 0;' }));
  // The property's own view renames it, and the LineIds of its accessors; their code is theirs.
  assert.equal(take(valve({ lines: true }), renamedProp({}), PROP), renamedProp({}).replace('P_Opening := fPosition;', 'P_Position := fPosition;'));
});

test('line breaks: what is taken gets those of the file it goes into; the BOM stays', () => {
  const both = crlf(valve({ open: 'bOpen := TRUE;', close: 'bOpen := FALSE;', stop: true }));
  assert.equal(take(valve(), both, OPEN), valve({ open: 'bOpen := TRUE;' }));
  assert.equal(take(valve(), both, STOP), valve({ stop: true }));
  assert.equal(take(crlf(valve()), valve({ stop: true, set: true }), STOP), crlf(valve({ stop: true })));
  assert.equal(take(crlf(valve()), valve({ set: true }), PROP, 'Set'), crlf(valve({ set: true })));
  const bom = parseTcFile('FB_Valve.TcPOU', Buffer.from(`\uFEFF${crlf(valve())}`, 'utf8'));
  assert.ok(bom.bom);
  assert.equal(takeView(bom, parse(valve({ open: 'x;' })), id(OPEN)), crlf(valve({ open: 'x;' })));
});

test('refused: a whole file (the POU new or gone), a view with other sections, an unreadable file', () => {
  const other = valve().replace(FB, '{99999999-9999-9999-9999-999999999999}');
  assert.throws(() => take(valve(), other, FB), SpliceError);
  assert.throws(() => take(other, valve({ stop: true }), STOP), /FB_Valve is not in/);
  const noImpl = valve().replace(/(<Method Name="M_Open"[\s\S]*?)\s*<Implementation>[\s\S]*?<\/Implementation>/, '$1');
  assert.throws(() => take(valve(), noImpl, OPEN), /changed more than its code/);
  assert.throws(() => take(valve(), '<TcPlcObject>', OPEN), /cannot be read/);
  // A method made again with the name of a deleted one: two of a name would not compile.
  const again = valve({ stop: true }).replace(/(<Method Name="M_Stop" Id=")[^"]*/, '$1{abcdabcd-0000-4000-8000-000000000001}');
  assert.throws(() => takeView(parse(valve({ stop: true })), parse(again), 'abcdabcd-0000-4000-8000-000000000001'), /already has a method named M_Stop/);
  assert.throws(() => take(valve({ stop: true }), valve({ stop: true, closeName: 'M_Stop' }), CLOSE), /already has a method named M_Stop/);
});

// ------------------------------------------------------------------------------- with git

const runGit: RunGit = async (args, cwd, input) => cp.execFileSync('git', args, { cwd, input, maxBuffer: 1 << 26, stdio: 'pipe' });

/** A temporary repository with FB_Valve committed; `attributes` is its .gitattributes, `eol` how the files are written. */
function tempRepo(opts: { attributes?: string; config?: Record<string, string>; eol?: '\n' | '\r\n' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-staging-')));
  const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 1 << 26, stdio: 'pipe' }).toString('utf8');
  git('init', '-q', '-b', 'main');
  for (const [k, v] of Object.entries({ 'user.email': 'test@example.com', 'user.name': 'Test', 'core.autocrlf': 'false', ...opts.config })) {
    git('config', k, v);
  }
  if (opts.attributes) fs.writeFileSync(path.join(root, '.gitattributes'), opts.attributes);
  const file = path.join(root, 'POUs', 'FB_Valve.TcPOU');
  const write = (text: string, to = file) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // As XAE writes it: with a BOM.
    fs.writeFileSync(to, `\uFEFF${opts.eol === '\r\n' ? crlf(text) : text}`);
  };
  write(valve());
  git('add', '-A');
  git('commit', '-qm', 'FB_Valve');
  return {
    root, file, git, write,
    /** The file as the index has it, as stored. */
    staged: () => cp.execFileSync('git', ['cat-file', 'blob', ':POUs/FB_Valve.TcPOU'], { cwd: root }).toString('utf8'),
    head: () => cp.execFileSync('git', ['cat-file', 'blob', 'HEAD:POUs/FB_Valve.TcPOU'], { cwd: root }).toString('utf8'),
    /** Files and their changed lines (`git diff --numstat`), staged or not. */
    numstat: (cached: boolean) => git('diff', ...(cached ? ['--cached'] : []), '--numstat').trim(),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** The changed lines of a diff, without its headers. */
function changedLines(diff: string): string[] {
  return diff.split('\n').filter(l => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l)).map(l => l.replace(/\r$/, ''));
}

/** M_Open's and M_Close's code with a comment on their first line. */
const OPENED = (comment: string) => `bOpen := TRUE;\nfPosition := 100; ${comment}\nM_Open := TRUE;`;
const CLOSED = (comment: string) => `bOpen := FALSE;\nfPosition := 0; ${comment}\nM_Close := TRUE;`;

const SETUPS: { title: string; attributes?: string; config?: Record<string, string>; eol?: '\n' | '\r\n' }[] = [
  { title: 'LF files' },
  { title: 'CRLF files, no attributes', eol: '\r\n' },
  { title: 'CRLF files with * text=auto (LF in the repository)', eol: '\r\n', attributes: '* text=auto\n' },
  { title: 'CRLF files with * text=auto, checked out with CRLF', eol: '\r\n', attributes: '* text=auto\n', config: { 'core.eol': 'crlf' } },
  { title: 'CRLF files with core.autocrlf=true', eol: '\r\n', config: { 'core.autocrlf': 'true' } },
  { title: 'CRLF files with *.TcPOU -text', eol: '\r\n', attributes: '*.TcPOU -text\n' },
];

for (const setup of SETUPS) {
  test(`staging one of two changed methods, then unstaging it (${setup.title})`, async () => {
    const r = tempRepo(setup);
    try {
      const committed = r.head();
      r.write(valve({ open: OPENED('// staged'), close: CLOSED('// not staged') }));
      await stageView(runGit, r.root, r.file, id(OPEN));
      assert.deepEqual(changedLines(r.git('diff', '--cached')), ['-fPosition := 100;', '+fPosition := 100; // staged']);
      assert.deepEqual(changedLines(r.git('diff')), ['-fPosition := 0;', '+fPosition := 0; // not staged']);
      // No whole-file change of line endings: the index has the committed bytes but for that line.
      assert.equal(r.numstat(true), '1\t1\tPOUs/FB_Valve.TcPOU');
      const eolOf = (s: string) => (s.includes('\r\n') ? 'CRLF' : 'LF');
      assert.equal(eolOf(r.staged()), eolOf(committed));
      assert.ok(r.staged().startsWith('\uFEFF'), 'the BOM stays');

      await stageView(runGit, r.root, r.file, id(CLOSE));
      assert.equal(r.git('diff'), '', 'all of the file is staged');
      await unstageView(runGit, r.root, r.file, id(OPEN));
      assert.deepEqual(changedLines(r.git('diff', '--cached')), ['-fPosition := 0;', '+fPosition := 0; // not staged']);
      await unstageView(runGit, r.root, r.file, id(CLOSE));
      assert.equal(r.git('diff', '--cached'), '');
      assert.equal(r.staged(), committed);
    } finally {
      r.dispose();
    }
  });
}

test('a CRLF file committed before an eol=lf attribute keeps its CRLF in the index', async () => {
  const r = tempRepo({ eol: '\r\n' });
  try {
    fs.writeFileSync(path.join(r.root, '.gitattributes'), '*.TcPOU text eol=lf\n');
    r.git('add', '.gitattributes');
    r.git('commit', '-qm', 'eol');
    r.write(valve({ open: OPENED('// staged'), close: CLOSED('// not staged') }));
    await stageView(runGit, r.root, r.file, id(OPEN));
    assert.equal(r.numstat(true), '1\t1\tPOUs/FB_Valve.TcPOU');
    assert.equal(r.staged(), `\uFEFF${crlf(valve({ open: OPENED('// staged') }))}`);
  } finally {
    r.dispose();
  }
});

test('staging and unstaging new and deleted members and accessors, and the index as Discard Changes goes back to', async () => {
  const r = tempRepo({ eol: '\r\n' });
  try {
    r.write(valve({ stop: true, set: true, prop: true, open: 'bOpen := TRUE; // changed' }));
    await stageView(runGit, r.root, r.file, id(STOP));
    await stageView(runGit, r.root, r.file, id(PROP), 'Set');
    assert.equal(r.staged(), `\uFEFF${crlf(valve({ stop: true, set: true }))}`);
    await unstageView(runGit, r.root, r.file, id(STOP));
    assert.equal(r.staged(), `\uFEFF${crlf(valve({ set: true }))}`);

    // Discard Changes puts an object back as the index has it, staged changes and all.
    r.write(valve({ set: true, open: 'bOpen := TRUE; // staged' }));
    await stageView(runGit, r.root, r.file, id(OPEN));
    r.write(valve({ open: 'bOpen := TRUE; // staged, then changed', stop: true }));
    await discardView(runGit, r.root, r.file, id(OPEN));
    await discardView(runGit, r.root, r.file, id(STOP));
    await discardView(runGit, r.root, r.file, id(PROP), 'Set');
    assert.equal(fs.readFileSync(r.file, 'utf8'), `\uFEFF${crlf(valve({ set: true, open: 'bOpen := TRUE; // staged' }))}`);
    assert.equal(r.git('diff'), '');

    // A deleted member and accessor.
    r.write(valve({ prop: false }));
    await stageView(runGit, r.root, r.file, id(PROP));
    assert.equal(r.staged(), `\uFEFF${crlf(valve({ prop: false, open: 'bOpen := TRUE; // staged' }))}`);
    await unstageView(runGit, r.root, r.file, id(PROP));
    assert.equal(r.staged(), `\uFEFF${crlf(valve({ open: 'bOpen := TRUE; // staged' }))}`);
  } finally {
    r.dispose();
  }
});

test('whole files: new, deleted, all at once; a new file has no objects to stage one by one', async () => {
  const r = tempRepo({ eol: '\r\n', attributes: '* text=auto\n' });
  try {
    const status = () => r.git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort();
    const main = path.join(r.root, 'POUs', 'MAIN.TcPOU');
    r.write(valve().replace(/FB_Valve/g, 'MAIN').replace(FB, '{abababab-abab-abab-abab-abababababab}'), main);
    r.write(valve({ open: 'bOpen := TRUE; // changed' }));
    await assert.rejects(stageView(runGit, r.root, main, id(OPEN)), /not in the index/);
    await stageFiles(runGit, r.root, [{ path: 'POUs/MAIN.TcPOU' }, { path: 'POUs/FB_Valve.TcPOU' }]);
    assert.deepEqual(status(), ['A  POUs/MAIN.TcPOU', 'M  POUs/FB_Valve.TcPOU']);
    await unstageFiles(runGit, r.root, ['POUs/MAIN.TcPOU', 'POUs/FB_Valve.TcPOU']);
    assert.deepEqual(status(), [' M POUs/FB_Valve.TcPOU', '?? POUs/MAIN.TcPOU']);
    await discardFiles(runGit, r.root, ['POUs/FB_Valve.TcPOU']);
    assert.deepEqual(status(), ['?? POUs/MAIN.TcPOU']);

    fs.rmSync(r.file);
    await stageFiles(runGit, r.root, [{ path: 'POUs/FB_Valve.TcPOU', deleted: true }]);
    assert.deepEqual(status(), ['?? POUs/MAIN.TcPOU', 'D  POUs/FB_Valve.TcPOU']);
    await unstageFiles(runGit, r.root, ['POUs/FB_Valve.TcPOU']);
    assert.deepEqual(status(), [' D POUs/FB_Valve.TcPOU', '?? POUs/MAIN.TcPOU']);
    await discardFiles(runGit, r.root, ['POUs/FB_Valve.TcPOU']);
    assert.deepEqual(status(), ['?? POUs/MAIN.TcPOU']);
  } finally {
    r.dispose();
  }
});

test('a file with a merge conflict is refused', async () => {
  const r = tempRepo();
  try {
    r.git('checkout', '-q', '-b', 'feature');
    r.write(valve({ open: 'bOpen := TRUE; // feature' }));
    r.git('commit', '-qam', 'feature');
    r.git('checkout', '-q', 'main');
    r.write(valve({ open: 'bOpen := TRUE; // main' }));
    r.git('commit', '-qam', 'main');
    assert.throws(() => r.git('merge', '-q', 'feature'));
    const entries = parseIndexEntries(r.git('ls-files', '-s', '-z'));
    assert.deepEqual(entries.map(e => e.stage), [1, 2, 3]);
    await assert.rejects(indexEntry(runGit, r.root, r.file), /merge conflict/);
    await assert.rejects(stageView(runGit, r.root, r.file, id(CLOSE)), /merge conflict/);
  } finally {
    r.dispose();
  }
});

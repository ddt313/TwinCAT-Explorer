import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  UNCOMMITTED, blameArgs, blobBefore, fileLogArgs, mergeRanges, parseBlame, parseFileLog, unquotePath,
} from '../../src/core/gitLog';
import { historyStep, viewChange, viewExists } from '../../src/core/objectChanges';
import { parseTcText, sectionFileLines } from '../../src/core/tcfile';

const FB = '{11111111-1111-1111-1111-111111111111}';
const RUN = '{22222222-2222-2222-2222-222222222222}';
const STOP = '{33333333-3333-3333-3333-333333333333}';
const PROP = '{44444444-4444-4444-4444-444444444444}';
const SET = '{66666666-6666-6666-6666-666666666666}';
const id = (guid: string) => guid.replace(/[{}]/g, '');

/** A POU with a method Run (renamed with `runName`), optionally Stop, and a property Count with Get (and Set). */
function pou(opts: { run?: string; runName?: string; stop?: string; set?: boolean; eol?: string } = {}): string {
  const method = (guid: string, name: string, impl: string) => `
    <Method Name="${name}" Id="${guid}">
      <Declaration><![CDATA[METHOD ${name}
VAR
END_VAR]]></Declaration>
      <Implementation>
        <ST><![CDATA[${impl}]]></ST>
      </Implementation>
    </Method>`;
  const text = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
  <POU Name="FB_Test" Id="${FB}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Test
VAR
	nCount : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>${method(RUN, opts.runName ?? 'Run', opts.run ?? 'nCount := nCount + 1;\nnCount := nCount * 2;')}${opts.stop !== undefined ? method(STOP, 'Stop', opts.stop) : ''}
    <Property Name="Count" Id="${PROP}">
      <Declaration><![CDATA[PROPERTY Count : INT]]></Declaration>
      <Get Name="Get" Id="{55555555-5555-5555-5555-555555555555}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[Count := nCount;]]></ST>
        </Implementation>
      </Get>${opts.set ? `
      <Set Name="Set" Id="${SET}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[nCount := Count;]]></ST>
        </Implementation>
      </Set>` : ''}
    </Property>
  </POU>
</TcPlcObject>`;
  return opts.eol ? text.replace(/\n/g, opts.eol) : text;
}

const parse = (text: string) => parseTcText('FB_Test.TcPOU', text);

// ------------------------------------------------------------------------------- git output parsers

test('parseFileLog reads commits, blobs and renames of git log --follow --raw -z', () => {
  const b = (c: string) => c.repeat(40);
  const out = `\x1e${b('a')}\x1f${b('p')}\x1fAlice\x1falice@example.com\x1f1700000000\x1fChange Run\x1fWhy:\nbecause\n\0\n`
    + `:100644 100644 ${b('2')} ${b('3')} M\0PLC/FB_Test.TcPOU\0`
    + `\x1e${b('b')}\x1f${b('q')}\x1fBob\x1fbob@example.com\x1f1690000000\x1fMove it\x1f\0\n`
    + `:100644 100644 ${b('1')} ${b('2')} R097\0PLC/Old/FB_Test.TcPOU\0PLC/FB_Test.TcPOU\0`
    + `\x1e${b('c')}\x1f\x1fBob\x1fbob@example.com\x1f1680000000\x1fCreate\x1f\0\n`
    + `:000000 100644 ${'0'.repeat(40)} ${b('1')} A\0PLC/Old/FB_Test.TcPOU\0`;
  const entries = parseFileLog(out);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0].commit, {
    sha: b('a'), parents: [b('p')], author: 'Alice', email: 'alice@example.com', date: 1700000000, subject: 'Change Run', body: 'Why:\nbecause',
  });
  assert.deepEqual([entries[0].status, entries[0].oldBlob, entries[0].newBlob, entries[0].oldPath, entries[0].newPath],
    ['M', b('2'), b('3'), 'PLC/FB_Test.TcPOU', 'PLC/FB_Test.TcPOU']);
  assert.deepEqual([entries[1].status, entries[1].oldPath, entries[1].newPath], ['R', 'PLC/Old/FB_Test.TcPOU', 'PLC/FB_Test.TcPOU']);
  assert.deepEqual([entries[2].status, entries[2].oldBlob, entries[2].newBlob, entries[2].commit.parents], ['A', undefined, b('1'), []]);
});

test('parseBlame reads the commit of each line and the commits of git blame --porcelain', () => {
  const a = 'a'.repeat(40);
  const p = 'f'.repeat(40);
  const out = [
    `${a} 10 1 2`, 'author Alice', 'author-mail <alice@example.com>', 'author-time 1700000000', 'author-tz +0100',
    'committer Alice', 'committer-mail <alice@example.com>', 'committer-time 1700000000', 'committer-tz +0100',
    'summary Change Run', `previous ${p} PLC/Old/FB_Test.TcPOU`, 'filename PLC/FB_Test.TcPOU', '\tnCount := nCount + 1;\r',
    `${a} 11 2`, '\tnCount := nCount * 2;\r',
    `${UNCOMMITTED} 3 3 1`, 'author Not Committed Yet', 'author-mail <not.committed.yet>', 'author-time 1700000100',
    'summary Version of PLC/FB_Test.TcPOU from PLC/FB_Test.TcPOU', 'filename PLC/FB_Test.TcPOU', '\t// typed\r',
    `${'b'.repeat(40)} 1 4 1`, 'author Bob', 'author-mail <bob@example.com>', 'author-time 1690000000', 'summary Create',
    'boundary', 'filename "PLC/\\303\\244 \\"x\\".TcPOU"', '\tEND_VAR\r', '',
  ].join('\n');
  const { lines, commits } = parseBlame(out);
  assert.deepEqual([...lines], [[1, a], [2, a], [3, UNCOMMITTED], [4, 'b'.repeat(40)]]);
  assert.deepEqual(commits.get(a), {
    sha: a, author: 'Alice', email: 'alice@example.com', time: 1700000000, summary: 'Change Run', filename: 'PLC/FB_Test.TcPOU',
    previous: { sha: p, filename: 'PLC/Old/FB_Test.TcPOU' },
  });
  assert.equal(commits.get(UNCOMMITTED)?.author, 'Not Committed Yet');
  assert.equal(commits.get('b'.repeat(40))?.filename, 'PLC/ä "x".TcPOU');
  assert.equal(unquotePath('PLC/plain.TcPOU'), 'PLC/plain.TcPOU');
});

test('mergeRanges joins overlapping and touching line ranges', () => {
  assert.deepEqual(mergeRanges([[20, 25], [1, 3], [4, 6], [5, 8], [10, 10]]), [[1, 8], [10, 10], [20, 25]]);
  assert.deepEqual(mergeRanges([]), []);
});

// ------------------------------------------------------------------------------- lines of sections in the file

test('sectionFileLines gives the file line of every line of a section, CR LF or LF', () => {
  for (const eol of ['\n', '\r\n']) {
    const file = parse(pou({ eol }));
    const lines = file.text.split('\n').map(l => l.replace(/\r$/, ''));
    for (const s of file.sections.values()) {
      const at = sectionFileLines(file, s);
      const sectionLines = s.text.split('\n');
      assert.equal(at.length, sectionLines.length, s.key);
      sectionLines.forEach((l, i) => assert.ok(lines[at[i] - 1].includes(l), `${s.key} line ${i}: '${l}' is not on file line ${at[i]}`));
    }
    const runImpl = file.sections.get(`${id(RUN)}:impl`)!;
    assert.deepEqual(sectionFileLines(file, runImpl), [16, 17]);
  }
});

test('sectionFileLines follows a section split into several CDATA parts and lone CRs', () => {
  const text = '<TcPlcObject>\n  <POU Name="P" Id="{77777777-7777-7777-7777-777777777777}">\n'
    + '    <Declaration><![CDATA[PROGRAM P\nVAR\n  s : STRING := \']]]]><![CDATA[>\';\rEND_VAR]]></Declaration>\n'
    + '    <Implementation>\n      <ST><![CDATA[]]></ST>\n    </Implementation>\n  </POU>\n</TcPlcObject>';
  const file = parse(text);
  const decl = file.sections.get('77777777-7777-7777-7777-777777777777:decl')!;
  assert.equal(decl.text, "PROGRAM P\nVAR\n  s : STRING := ']]>';\nEND_VAR");
  // The lone CR ends a line of the section; git sees END_VAR on the same line as the string.
  assert.deepEqual(sectionFileLines(file, decl), [3, 4, 5, 5]);
});

// ------------------------------------------------------------------------------- one object across versions

test('viewChange tells added, deleted, modified, renamed and unchanged object views apart', () => {
  const base = parse(pou());
  assert.equal(viewChange(base, parse(pou()), id(RUN)), undefined);
  assert.deepEqual(viewChange(base, parse(pou({ run: 'nCount := 0;' })), id(RUN)), { change: 'modified' });
  assert.deepEqual(viewChange(base, parse(pou({ runName: 'Execute' })), id(RUN)), { change: 'modified', renamedFrom: 'Run' });
  assert.deepEqual(viewChange(base, parse(pou({ stop: '' })), id(STOP)), { change: 'added' });
  assert.deepEqual(viewChange(parse(pou({ stop: '' })), base, id(STOP)), { change: 'deleted' });
  assert.deepEqual(viewChange(undefined, base, id(FB)), { change: 'added' });
  assert.equal(viewChange(undefined, undefined, id(FB)), undefined);
  // Accessors: a Set added to an existing property is added; the property's own view did not change.
  assert.deepEqual(viewChange(base, parse(pou({ set: true })), id(PROP), 'Set'), { change: 'added' });
  assert.equal(viewChange(base, parse(pou({ set: true })), id(PROP)), undefined);
  assert.ok(viewExists(base, id(PROP), 'Get'));
  assert.ok(!viewExists(base, id(PROP), 'Set'));
  // A method's change is not a change of the POU's own view.
  assert.equal(viewChange(base, parse(pou({ run: 'nCount := 0;' })), id(FB)), undefined);
});

test('historyStep lists the views a commit changed and stops at the commit that created the object', () => {
  const base = parse(pou());
  const changed = historyStep(base, parse(pou({ run: 'nCount := 0;' })), id(RUN), undefined, false);
  assert.deepEqual(changed.views.map(v => [v.label, v.change]), [['FB_Test.Run', 'modified']]);
  assert.ok(!changed.created);
  const created = historyStep(base, parse(pou({ stop: '' })), id(STOP), undefined, false);
  assert.deepEqual(created.views.map(v => [v.label, v.change]), [['FB_Test.Stop', 'added']]);
  assert.ok(created.created, 'nothing older can have changed Stop');
  const untouched = historyStep(base, parse(pou({ stop: '' })), id(RUN), undefined, false);
  assert.deepEqual([untouched.views, untouched.created], [[], false]);
  // Not there on either side (a commit of a branch made before Stop came to it): nothing, and not the end.
  assert.deepEqual(historyStep(base, parse(pou({ run: 'nCount := 0;' })), id(STOP), undefined, false), { views: [], created: false });
  // A POU (whole file): every changed view, until the commit that created the POU.
  const whole = historyStep(base, parse(pou({ run: 'nCount := 0;', stop: '', set: true })), id(FB), undefined, true);
  assert.deepEqual(whole.views.map(v => `${v.label} ${v.change}`), ['FB_Test.Run modified', 'FB_Test.Stop added', 'FB_Test.Count.Set added']);
  assert.ok(!whole.created);
  assert.ok(historyStep(undefined, base, id(FB), undefined, true).created);
});

// ------------------------------------------------------------------------------- with git

/** A temporary repository; `commit` commits everything at a day of October 2026 (the dates order git log). */
function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-history-'));
  let day = 1;
  const git = (args: string[], at = day) => {
    const date = `2026-10-${String(at).padStart(2, '0')}T10:00:00Z`;
    return cp.execFileSync('git', args, {
      cwd: repo, maxBuffer: 1 << 26, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).toString('utf8');
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  return {
    git,
    write: (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), '﻿' + text);
    },
    commit: (message: string, at?: number) => {
      day = at ?? day + 1;
      git(['add', '-A']);
      git(['commit', '-qm', message]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    blob: (sha: string | undefined) => (sha ? parse(git(['cat-file', 'blob', sha]).replace(/^﻿/, '')) : undefined),
    dispose: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

/** The history of an object as the TwinCAT History view walks it: `<subject>: <change>` per change. */
function historyOf(r: ReturnType<typeof tempRepo>, relPath: string, objectId: string, whole = false): string[] {
  const out: string[] = [];
  for (const e of parseFileLog(r.git(fileLogArgs(relPath)))) {
    const step = historyStep(r.blob(blobBefore(e)), r.blob(e.newBlob), objectId, undefined, whole);
    out.push(...step.views.map(v => `${e.commit.subject}: ${whole ? `${v.label} ` : ''}${v.change}`));
    if (step.created) break;
  }
  return out;
}

test('the history of one method follows its file through a rename and skips commits of other methods', () => {
  const r = tempRepo();
  try {
    r.write('Old/FB_Test.TcPOU', pou({ eol: '\r\n' }));
    const created = r.commit('Create FB_Test');
    r.write('Old/FB_Test.TcPOU', pou({ eol: '\r\n', run: 'nCount := nCount + 1;\nnCount := nCount * 3;' }));
    const changedRun = r.commit('Triple it');
    r.git(['mv', 'Old/FB_Test.TcPOU', 'FB_Test.TcPOU']);
    const moved = r.commit('Move FB_Test');
    r.write('FB_Test.TcPOU', pou({ eol: '\r\n', run: 'nCount := nCount + 1;\nnCount := nCount * 3;', stop: 'nCount := 0;' }));
    const addedStop = r.commit('Add Stop');

    // git log --follow: every commit of the file, the rename included, newest first.
    const entries = parseFileLog(r.git(fileLogArgs('FB_Test.TcPOU')));
    assert.deepEqual(entries.map(e => [e.commit.sha, e.status]), [[addedStop, 'M'], [moved, 'R'], [changedRun, 'M'], [created, 'A']]);
    assert.deepEqual([entries[1].oldPath, entries[1].newPath], ['Old/FB_Test.TcPOU', 'FB_Test.TcPOU']);
    assert.equal(entries[2].newPath, 'Old/FB_Test.TcPOU');

    // Run was changed by two commits, Stop by one.
    assert.deepEqual(historyOf(r, 'FB_Test.TcPOU', id(RUN)), ['Triple it: modified', 'Create FB_Test: added']);
    assert.deepEqual(historyOf(r, 'FB_Test.TcPOU', id(STOP)), ['Add Stop: added']);

    // git blame of Run's implementation in HEAD: its first line is from the first commit, the second was changed.
    const file = r.blob(entries[0].newBlob)!;
    const impl = file.sections.get(`${id(RUN)}:impl`)!;
    const at = sectionFileLines(file, impl);
    const { lines, commits } = parseBlame(r.git(blameArgs(addedStop, 'FB_Test.TcPOU', [[at[0], at[at.length - 1]]])));
    assert.deepEqual(at.map(l => lines.get(l)), [created, changedRun]);
    assert.equal(commits.get(changedRun)?.summary, 'Triple it');
    // The commit's file is where it was then; the line came from its parent's version.
    assert.equal(commits.get(changedRun)?.filename, 'Old/FB_Test.TcPOU');
    assert.deepEqual(commits.get(changedRun)?.previous, { sha: created, filename: 'Old/FB_Test.TcPOU' });
  } finally {
    r.dispose();
  }
});

test('in a merged history, commits of a branch made before the method came there do not end its history', () => {
  const r = tempRepo();
  try {
    r.write('FB_Test.TcPOU', pou({ eol: '\r\n' }));
    r.commit('Create FB_Test', 1);
    r.git(['checkout', '-q', '-b', 'feature']);
    r.write('FB_Test.TcPOU', pou({ eol: '\r\n', stop: 'nCount := 0;' }));
    r.commit('Add Stop', 2);
    r.write('FB_Test.TcPOU', pou({ eol: '\r\n', stop: 'nCount := -1;' }));
    r.commit('Change Stop', 3);
    r.git(['checkout', '-q', 'main']);
    // Later on main, without Stop: listed before the feature's commits, and Stop is on neither side of it.
    r.write('FB_Test.TcPOU', pou({ eol: '\r\n', run: 'nCount := nCount + 2;' }));
    r.commit('Change Run on main', 4);
    r.git(['merge', '-q', '--no-edit', 'feature'], 5);
    assert.deepEqual(historyOf(r, 'FB_Test.TcPOU', id(STOP)), ['Change Stop: modified', 'Add Stop: added']);
    assert.deepEqual(historyOf(r, 'FB_Test.TcPOU', id(RUN)), ['Change Run on main: modified', 'Create FB_Test: added']);
  } finally {
    r.dispose();
  }
});

test('a POU created as a copy of another one starts with its own objects, not with the other one', () => {
  const r = tempRepo();
  try {
    const original = pou({ eol: '\r\n', stop: 'nCount := 0;' });
    r.write('FB_Test.TcPOU', original);
    r.commit('Create FB_Test');
    // FB_Copy: FB_Test's text with its own name and GUIDs, as XAE makes a copy; FB_Test stays.
    const g = (n: number) => `{${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}}`;
    const copy = original.replace(/FB_Test/g, 'FB_Copy').replace(FB, g(7)).replace(RUN, g(8)).replace(STOP, g(9));
    r.write('FB_Copy.TcPOU', copy);
    r.commit('Copy FB_Test');
    const entries = parseFileLog(r.git(fileLogArgs('FB_Copy.TcPOU')));
    assert.equal(entries[0].status, 'C', 'git log --follow takes it for a copy');
    assert.deepEqual([entries[0].oldPath, blobBefore(entries[0])], ['FB_Test.TcPOU', undefined]);
    assert.deepEqual(historyOf(r, 'FB_Copy.TcPOU', id(g(7)), true), [
      'Copy FB_Test: FB_Copy added', 'Copy FB_Test: FB_Copy.Run added', 'Copy FB_Test: FB_Copy.Stop added',
      'Copy FB_Test: FB_Copy.Count added', 'Copy FB_Test: FB_Copy.Count.Get added',
    ]);
  } finally {
    r.dispose();
  }
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TcWorkspace } from '../../src/core/workspace';

test('recognizes paths inside hidden folders with either separator', async () => {
  const { isInHiddenFolder } = await import('../../src/core/paths');
  const bs = String.fromCharCode(92);
  assert.equal(isInHiddenFolder(['.claude', 'worktrees', 'x', 'PLC', 'A.tsproj'].join(bs)), true);
  assert.equal(isInHiddenFolder('PC/.claude/worktrees/x/PLC/A.tsproj'), true);
  assert.equal(isInHiddenFolder(['PLC', 'Machine', 'Machine.tsproj'].join(bs)), false);
  assert.equal(isInHiddenFolder('.hidden.tsproj'), false, 'only folders count');
  assert.equal(isInHiddenFolder(['..', 'other', 'A.tsproj'].join(bs)), false);
});

test('a file that cannot be read gives the version read before, or a file with the error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-read-'));
  const p = path.join(dir, 'FB_A.TcPOU');
  try {
    fs.writeFileSync(p, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="FB_A" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_A]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`);
    const ws = new TcWorkspace();
    const first = ws.getFile(p);
    assert.equal(first?.root?.name, 'FB_A');
    // Replaced by something that has a stat but cannot be read (a folder), like a file another program holds.
    fs.rmSync(p);
    fs.mkdirSync(p);
    ws.invalidate(p);
    assert.strictEqual(ws.getFile(p), first, 'the version read before');
    const unread = new TcWorkspace().getFile(p);
    assert.ok(unread?.error, 'an error when nothing was read before');
    assert.equal(unread.root, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finds a program on PATH in full folder paths only, never in the current folder', async () => {
  const { findOnPath } = await import('../../src/core/paths');
  const file = process.platform === 'win32' ? 'git.exe' : 'git';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-path-'));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  for (const dir of [repo, bin]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, file), '');
    fs.chmodSync(path.join(dir, file), 0o755);
  }
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    // An empty entry, `.` and `../repo` all name the current folder: a repository with a file named like git.
    const relative = ['', '.', path.join('..', 'repo')];
    assert.equal(findOnPath('git', [...relative, bin].join(path.delimiter)), path.join(bin, file));
    assert.equal(findOnPath('git', relative.join(path.delimiter)), undefined);
    if (process.platform === 'win32') assert.equal(findOnPath('git', `"${bin}"`), path.join(bin, file), 'quoted entry');
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

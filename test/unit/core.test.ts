import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('recognizes paths inside hidden folders with either separator', async () => {
  const { isInHiddenFolder } = await import('../../src/core/paths');
  const bs = String.fromCharCode(92);
  assert.equal(isInHiddenFolder(['.claude', 'worktrees', 'x', 'PLC', 'A.tsproj'].join(bs)), true);
  assert.equal(isInHiddenFolder('PC/.claude/worktrees/x/PLC/A.tsproj'), true);
  assert.equal(isInHiddenFolder(['PLC', 'Machine', 'Machine.tsproj'].join(bs)), false);
  assert.equal(isInHiddenFolder('.hidden.tsproj'), false, 'only folders count');
  assert.equal(isInHiddenFolder(['..', 'other', 'A.tsproj'].join(bs)), false);
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

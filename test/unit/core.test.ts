import { test } from 'node:test';
import * as assert from 'node:assert/strict';

test('recognizes paths inside hidden folders with either separator', async () => {
  const { isInHiddenFolder } = await import('../../src/core/paths');
  const bs = String.fromCharCode(92);
  assert.equal(isInHiddenFolder(['.claude', 'worktrees', 'x', 'PLC', 'A.tsproj'].join(bs)), true);
  assert.equal(isInHiddenFolder('PC/.claude/worktrees/x/PLC/A.tsproj'), true);
  assert.equal(isInHiddenFolder(['PLC', 'Machine', 'Machine.tsproj'].join(bs)), false);
  assert.equal(isInHiddenFolder('.hidden.tsproj'), false, 'only folders count');
  assert.equal(isInHiddenFolder(['..', 'other', 'A.tsproj'].join(bs)), false);
});

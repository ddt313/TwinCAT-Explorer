// https://github.com/ddt313/TwinCAT-Explorer/issues/135
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { countStatuses, describeCounts, parsePorcelainStatus, strongestStatus } from '../../src/core/gitStatus';

test('parsePorcelainStatus: each path with how it differs from HEAD, staged or not', () => {
  const out = [
    ' M POUs/FB_Valve.TcPOU', 'M  POUs/MAIN.TcPOU', 'MM GVLs/GVL_IO.TcGVL', ' T link',
    ' D DUTs/ST_Recipe.TcDUT', 'D  DUTs/E_Old.TcDUT',
    'A  POUs/FB_New.TcPOU', 'AM POUs/FB_New2.TcPOU', 'AD POUs/FB_Gone.TcPOU',
    '?? GVLs/GVL_New.TcGVL',
    'UU POUs/FB_Conflict.TcPOU', 'AA POUs/FB_Both.TcPOU', 'DU POUs/FB_DelOurs.TcPOU',
    // A rename is followed by the path it came from; a copy keeps its source.
    'R  POUs/Sequences/FB_Moved.TcPOU', 'POUs/FB_Moved.TcPOU', 'C  POUs/FB_Copy.TcPOU', 'POUs/FB_Valve.TcPOU',
    'RD POUs/FB_MovedGone.TcPOU', 'POUs/FB_Was.TcPOU',
    '',
  ].join('\0');
  assert.deepEqual(Object.fromEntries(parsePorcelainStatus(out)), {
    'POUs/FB_Valve.TcPOU': 'modified', 'POUs/MAIN.TcPOU': 'modified', 'GVLs/GVL_IO.TcGVL': 'modified', 'link': 'modified',
    'DUTs/ST_Recipe.TcDUT': 'deleted', 'DUTs/E_Old.TcDUT': 'deleted',
    'POUs/FB_New.TcPOU': 'added', 'POUs/FB_New2.TcPOU': 'added',
    'GVLs/GVL_New.TcGVL': 'untracked',
    'POUs/FB_Conflict.TcPOU': 'conflict', 'POUs/FB_Both.TcPOU': 'conflict', 'POUs/FB_DelOurs.TcPOU': 'conflict',
    'POUs/Sequences/FB_Moved.TcPOU': 'added', 'POUs/FB_Moved.TcPOU': 'deleted', 'POUs/FB_Copy.TcPOU': 'added',
    'POUs/FB_Was.TcPOU': 'deleted',
  });
  assert.equal(parsePorcelainStatus('').size, 0);
});

test('a folder shows the strongest change it holds: a conflict, a deletion, a modification, an addition', () => {
  assert.equal(countStatuses([]), undefined);
  const counts = countStatuses(['added', 'modified', 'deleted', 'modified', 'untracked'])!;
  assert.deepEqual(counts, { added: 1, modified: 2, deleted: 1, untracked: 1 });
  assert.equal(strongestStatus(counts), 'deleted');
  assert.equal(describeCounts(counts), '1 deleted, 2 modified, 1 added, 1 untracked');
  assert.equal(strongestStatus({ untracked: 1, conflict: 1 }), 'conflict');
  assert.equal(strongestStatus({ added: 3, untracked: 1 }), 'added');
});

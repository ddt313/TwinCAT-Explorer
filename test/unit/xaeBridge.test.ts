import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Xae, XaeError } from '../../src/core/xae';

/**
 * Fake bridges: a script that answers one request as XaeBridge.exe does, as a 64-bit process (anycpu) or a 32-bit one
 * (x86). XAE 1234 is 32-bit, XAE 5678 64-bit. As in the report, a 64-bit bridge gets no running document table of a
 * 32-bit XAE, whose COM proxies are registered for 32-bit processes only.
 */
function fakeBridges(): { anycpu: string[]; x86: string[]; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-xaebridge-'));
  const log = path.join(dir, 'log.txt');
  const script = path.join(dir, 'bridge.js');
  fs.writeFileSync(script, `
const fs = require('fs');
const bits = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8').on('data', d => { input += d; }).on('end', () => {
  const req = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(log)}, bits + ' ' + req.cmd + (req.pid ? ' ' + req.pid : '') + '\\n');
  const say = a => process.stdout.write(JSON.stringify({ id: req.id, ...a }) + '\\n');
  if (req.cmd === 'instances') {
    return say({ ok: true, result: [
      { pid: 1234, progId: 'TcXaeShell.DTE.15.0', solution: 'C:\\\\A\\\\A.sln', projects: ['C:\\\\A\\\\A.tsproj'], x86: true },
      { pid: 5678, progId: 'TcXaeShell.DTE.17.0', solution: 'C:\\\\B\\\\B.sln', projects: ['C:\\\\B\\\\B.tsproj'] },
    ] });
  }
  if (req.cmd === 'build') {
    if (req.pid === 1234 && bits !== 'x86') return say({ ok: false, error: 'TwinCAT XAE gave no running document table' });
    return say({ ok: true, result: { output: 'Build: 0 errors, 0 warnings' } });
  }
  say({ ok: false, error: 'unknown command' });
});
`);
  return { anycpu: [process.execPath, script, 'anycpu'], x86: [process.execPath, script, 'x86'], log };
}

const calls = (log: string) => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];

// https://github.com/ddt313/TwinCAT-Explorer/issues/124
test('a 32-bit XAE is driven by the 32-bit bridge, a 64-bit one by the AnyCPU bridge', () => {
  const bridges = fakeBridges();
  const xae = new Xae({ bridges });
  assert.deepEqual(xae.instances().map(i => i.pid), [1234, 5678]);
  const a = xae.build({ pid: 1234, tsproj: 'C:\\A\\A.tsproj', plc: 'Plc' }, 'C:\\A\\Plc\\Plc.plcproj');
  assert.equal(a.output, 'Build: 0 errors, 0 warnings');
  xae.build({ pid: 5678, tsproj: 'C:\\B\\B.tsproj', plc: 'Plc' }, 'C:\\B\\Plc\\Plc.plcproj');
  assert.deepEqual(calls(bridges.log), ['anycpu instances', 'x86 build 1234', 'anycpu build 5678']);
});

test('a request for an XAE not listed yet looks up its architecture first', async () => {
  const bridges = fakeBridges();
  const xae = new Xae({ bridges });
  const a = await xae.requestAsync<{ output: string }>({ cmd: 'build', pid: 1234, tsproj: 'C:\\A\\A.tsproj', plc: 'Plc', path: [] });
  assert.equal(a.output, 'Build: 0 errors, 0 warnings');
  assert.deepEqual(calls(bridges.log), ['anycpu instances', 'x86 build 1234']);
});

test('without a 32-bit bridge, a 32-bit XAE is asked by the AnyCPU one, as before', () => {
  const { anycpu, log } = fakeBridges();
  const xae = new Xae({ bridges: { anycpu } });
  xae.instances();
  assert.throws(() => xae.build({ pid: 1234, tsproj: 'C:\\A\\A.tsproj', plc: 'Plc' }, 'C:\\A\\Plc\\Plc.plcproj'),
    (e: unknown) => e instanceof XaeError && /no running document table/.test(e.message));
  assert.deepEqual(calls(log), ['anycpu instances', 'anycpu build 1234']);
});

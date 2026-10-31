import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { firstToExpire, licenseFolders, parseLicenseFile, readLicenses, timeLeft } from '../../src/core/license';

/** A 7-day trial license as XAE writes one, made up. */
const TRIAL = `<?xml version="1.0"?>
<TcLicenseInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<LicenseInfo>
\t\t<SystemId>00000000-0000-0000-0000-000000000000</SystemId>
\t\t<IssueTime>2026-10-31T11:18:00</IssueTime>
\t\t<ExpireTime>2026-11-08T00:00:00</ExpireTime>
\t\t<LicenseKey>00</LicenseKey>
\t\t<License>
\t\t\t<LicenseId>{A19036CF-A53B-4E3A-99FF-023EF5C4798B}</LicenseId>
\t\t\t<Name>TC3 NC PTP Axis</Name>
\t\t\t<Instances>10</Instances>
\t\t</License>
\t\t<License>
\t\t\t<LicenseId>{66689887-CCBD-452C-AC9A-039D997C6E66}</LicenseId>
\t\t\t<Name>TC3 PLC</Name>
\t\t\t<OrderNo>TC1200</OrderNo>
\t\t</License>
\t</LicenseInfo>
</TcLicenseInfo>
`;

test('parseLicenseFile reads the times as UTC and each license', () => {
  const f = parseLicenseFile(TRIAL, 'C:\\L\\TrialLicense.tclrs', 'UmRT_Default')!;
  assert.equal(f.trial, true);
  assert.equal(f.runtime, 'UmRT_Default');
  assert.equal(f.issued?.toISOString(), '2026-10-31T11:18:00.000Z');
  assert.equal(f.expires?.toISOString(), '2026-11-08T00:00:00.000Z');
  assert.deepEqual(f.licenses, [
    { id: '{A19036CF-A53B-4E3A-99FF-023EF5C4798B}', name: 'TC3 NC PTP Axis', orderNo: undefined, instances: 10 },
    { id: '{66689887-CCBD-452C-AC9A-039D997C6E66}', name: 'TC3 PLC', orderNo: 'TC1200', instances: undefined },
  ]);
});

test('parseLicenseFile: a file without an end, and one that is no license file', () => {
  const f = parseLicenseFile(TRIAL.replace(/\s*<ExpireTime>.*<\/ExpireTime>/, ''), 'C:\\L\\Response.tclrs', 'UmRT_Default')!;
  assert.equal(f.trial, false);
  assert.equal(f.expires, undefined);
  assert.equal(parseLicenseFile('<Other/>', 'x.tclrs', 'r'), undefined);
  assert.equal(parseLicenseFile('not xml <', 'x.tclrs', 'r'), undefined);
});

test('timeLeft rounds down to minutes, by the two largest units', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  assert.equal(timeLeft(new Date('2026-11-07T14:30:00Z'), now), '6 d 4 h');
  assert.equal(timeLeft(new Date('2026-11-03T10:00:00Z'), now), '2 d');
  assert.equal(timeLeft(new Date('2026-11-01T15:12:59Z'), now), '5 h 12 min');
  assert.equal(timeLeft(new Date('2026-11-01T10:03:00Z'), now), '3 min');
  assert.equal(timeLeft(new Date('2026-11-01T09:59:00Z'), now), 'expired');
});

test('licenseFolders and readLicenses find the files of each runtime, the trial first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-license-'));
  try {
    const folder = path.join(root, 'Beckhoff', 'TwinCAT', '3.1', 'Runtimes', 'UmRT_Default', '3.1', 'Target', 'License');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'TrialLicense.tclrs'), TRIAL);
    fs.writeFileSync(path.join(folder, 'A_Response.tclrs'), TRIAL.replace('2026-11-08', '2026-11-05'));
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    const folders = licenseFolders({ ProgramData: root, TWINCAT3DIR: path.join(root, 'none') }, 'win32');
    assert.deepEqual(folders, [{ runtime: 'UmRT_Default', folder: path.win32.join(folder) }]);
    const files = readLicenses(folders);
    assert.deepEqual(files.map(f => path.basename(f.file)), ['TrialLicense.tclrs', 'A_Response.tclrs']);
    assert.equal(path.basename(firstToExpire(files)!.file), 'A_Response.tclrs');
    assert.deepEqual(licenseFolders({}, 'linux'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  adsRoutes, firstToExpire, lastLicenseWrite, licenseFolders, netIdOfRegistryXml, parseLicenseFile, readLicenses, remoteLicenses, routesOfStaticRoutesXml,
  runtimeNetId, timeLeft,
} from '../../src/core/license';
import { solutionProjects } from '../../src/core/xae';

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

test('netIdOfRegistryXml reads the AmsNetId of the System key, not DefaultTransportAmsNetId', () => {
  const xml = `<TcRegistry><Key Name="HKLM"><Key Name="System">
	<Value Name="DefaultTransportAmsNetId" Type="BIN">0F0F0F0F0101</Value>
	<Value Name="AmsNetId" Type="BIN">0A01B4160101</Value>
</Key></Key></TcRegistry>`;
  assert.equal(netIdOfRegistryXml(xml), '10.1.180.22.1.1');
  assert.equal(netIdOfRegistryXml('<Value Name="AmsNetId" Type="BIN">0A01</Value>'), undefined);
  assert.equal(netIdOfRegistryXml('<TcRegistry/>'), undefined);
});

test('runtimeNetId reads TcRegistry.xml beside the Target folder; lastLicenseWrite sees a new license file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-netid-'));
  try {
    const folder = path.join(root, 'UmRT_Default', '3.1', 'Target', 'License');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(root, 'UmRT_Default', '3.1', 'TcRegistry.xml'), '<Value Name="AmsNetId" Type="BIN">C0A800010101</Value>');
    assert.equal(runtimeNetId({ runtime: 'UmRT_Default', folder }), '192.168.0.1.1.1');
    assert.equal(runtimeNetId({ runtime: 'Other', folder: path.join(root, 'none', 'a', 'b') }), undefined);
    assert.equal(lastLicenseWrite(folder), 0);
    fs.writeFileSync(path.join(folder, 'TrialLicense.tclrs'), TRIAL);
    assert.ok(lastLicenseWrite(folder) > 0);
    assert.equal(lastLicenseWrite(path.join(root, 'missing')), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adsRoutes reads the routes of the runtimes and of the Routes folder, once per AMS Net ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-routes-'));
  try {
    const target = path.join(root, 'Beckhoff', 'TwinCAT', '3.1', 'Runtimes', 'UmRT_Default', '3.1', 'Target');
    fs.mkdirSync(path.join(target, 'License'), { recursive: true });
    fs.writeFileSync(path.join(target, 'StaticRoutes.xml'), `<?xml version="1.0"?>
<TcConfig><RemoteConnections>
\t<Route><Name>xar-1</Name><Address>192.168.0.11</Address><NetId>15.15.15.15.1.1</NetId><Type>TCP_IP</Type></Route>
\t<Route><Name>broken</Name><NetId>15.15</NetId></Route>
</RemoteConnections></TcConfig>`);
    const routes = path.join(root, 'x86', 'Beckhoff', 'TwinCAT', '3.1', 'Target', 'Routes');
    fs.mkdirSync(routes, { recursive: true });
    fs.writeFileSync(path.join(routes, 'xar.xml'), `<TcConfig><RemoteConnections>
<Route><Name>xar-1 again</Name><NetId RegKey="x">15.15.15.15.1.1</NetId></Route>
<Route><Name>xar-2</Name><NetId>15.15.15.16.1.1</NetId></Route>
</RemoteConnections></TcConfig>`);
    assert.deepEqual(adsRoutes({ ProgramData: root, 'ProgramFiles(x86)': path.join(root, 'x86'), TWINCAT3DIR: path.join(root, 'none') }, 'win32'), [
      { name: 'xar-1', netId: '15.15.15.15.1.1', address: '192.168.0.11' },
      { name: 'xar-2', netId: '15.15.15.16.1.1', address: undefined },
    ]);
    assert.deepEqual(adsRoutes({}, 'linux'), []);
    assert.deepEqual(routesOfStaticRoutesXml('not xml <'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remoteLicenses parses the files read over ADS, with the system and its AMS Net ID', () => {
  const files = remoteLicenses([
    { name: 'Response.tclrs', data: Buffer.from(TRIAL.replace(/\s*<ExpireTime>.*<\/ExpireTime>/, '')) },
    { name: 'TrialLicense.tclrs', data: Buffer.from('﻿' + TRIAL.replace('2026-11-08', '2026-11-05')) },
    { name: 'broken.tclrs', data: Buffer.from('<Other/>') },
  ], 'xar-1', '15.15.15.15.1.1');
  assert.deepEqual(files.map(f => [f.file, f.runtime, f.netId, f.trial, f.expires?.toISOString()]), [
    ['TrialLicense.tclrs', 'xar-1', '15.15.15.15.1.1', true, '2026-11-05T00:00:00.000Z'],
    ['Response.tclrs', 'xar-1', '15.15.15.15.1.1', false, undefined],
  ]);
});

test('solutionProjects lists the .tsproj files of a solution, resolved beside it', () => {
  const sln = `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{B1E792BE-AA5F-4E3C-8C82-674BF9C0715B}") = "Machine", "..\\..\\Projects\\Machine\\Machine.tsproj", "{11111111-0000-0000-0000-000000000000}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Docs", "Docs", "{22222222-0000-0000-0000-000000000000}"
EndProject
`;
  const at = path.join(os.tmpdir(), 'repo', 'Solutions', 'Machine', 'Machine.sln');
  assert.deepEqual(solutionProjects(sln, at), [path.resolve(os.tmpdir(), 'repo', 'Projects', 'Machine', 'Machine.tsproj')]);
});

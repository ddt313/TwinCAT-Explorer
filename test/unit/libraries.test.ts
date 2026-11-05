import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProfilePlaceholder, compareVersions, decodeXml, libraryReference, parseProfile, parseProjectInfoNamespace, placeholderName, readRepositories,
  systemRepositories,
} from '../../src/core/libraries';
import { PlcProjectEditError, addPlaceholderReference, parseLibrarySpec, parsePlcProject, referenceTo } from '../../src/core/project';
import { decodeBytes, encodeText } from '../../src/core/tcfile';

const BECKHOFF = 'Beckhoff Automation GmbH';
const ACME = 'Acme Automation';
const category = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A library repository as TwinCAT 3.1.4026 keeps one, made up: version folders with their files, cache, profile, categories. */
function writeRepository(root: string, versions: [company: string, title: string, version: string, file: string][], top: Record<string, Uint8Array>): void {
  for (const [company, title, version, file] of versions) {
    const dir = path.join(root, company, title, version);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [file, 'browsercache', 'dependencies', 'projectinfo']) if (f) fs.writeFileSync(path.join(dir, f), '');
  }
  for (const [name, bytes] of Object.entries(top)) fs.writeFileSync(path.join(root, name), bytes);
}

/** The `cache` of a repository: UTF-16 LE with a BOM, one <Library> per installed version. */
function cache(entries: [path: string, title: string, version: string, company: string, namespace: string, categories: string][]): Uint8Array {
  const text = [
    '<?xml version="1.0" encoding="utf-16"?>',
    '<LibraryRepository TimestampLegacyCache="638650000000000000">',
    ...entries.map(([p, title, version, company, namespace, categories]) =>
      `  <Library Path="${p}" Title="${title}" Version="${version}" Company="${company}" DefaultNamespace="${namespace}" CategoryIds="${categories}" />`),
    '</LibraryRepository>',
  ].join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

const utf8 = (text: string) => Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8');

const PROFILE = utf8(`<?xml version="1.0" encoding="utf-8"?>
<LibraryProfile>
  <Resolution PlaceholderName="Tc2_Standard" CompilerVersion="3.5.4.0">Tc2_Standard, * (Beckhoff Automation GmbH)</Resolution>
  <Resolution PlaceholderName="tc2_system" CompilerVersion="3.3.2.0">Tc2_System, * (Beckhoff Automation GmbH)</Resolution>
  <Resolution PlaceholderName="Tc2_System" CompilerVersion="3.5.4.0">Tc2_System, * (Beckhoff Automation GmbH)</Resolution>
  <Resolution PlaceholderName="Tc2_Utilities" CompilerVersion="3.5.4.0">Tc2_Utilities, * (Beckhoff Automation GmbH)</Resolution>
  <Resolution PlaceholderName="AcmeValves" CompilerVersion="3.5.4.0">Valve Control, * (Acme Automation)</Resolution>
</LibraryProfile>`);

const libcat = (cats: [id: number, name: string, parent?: number][]) => utf8(`<?xml version="1.0" encoding="utf-8"?>
<LibraryCategoryList xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${cats.map(([id, name, parent]) => `  <LibraryCategory>
    <Id>${category(id)}</Id>
    <Version>1.0.0.0</Version>${parent ? `
    <ParentCategory>
      <Id>${category(parent)}</Id>
      <Version>1.0.0.0</Version>
    </ParentCategory>` : ''}
    <DefaultName>${name}</DefaultName>
  </LibraryCategory>`).join('\n')}
</LibraryCategoryList>`);

/**
 * The system repository: Beckhoff's libraries (the cache names .compiled-library files where the folders hold
 * .compiled-library-ge33 ones), TcUnit installed since the cache was written, and a library of Acme Automation
 * whose file is named otherwise, whose namespace is not its title and whose folder is spelled in another case.
 */
function systemRepository(root: string): void {
  const b = (title: string, version: string, ext = '.compiled-library-ge33'): [string, string, string, string] => [BECKHOFF, title, version, `${title}${ext}`];
  writeRepository(root, [
    b('Tc2_Standard', '3.4.5.0'), b('Tc2_Standard', '3.4.7.0'), b('Tc2_System', '3.4.26.0'),
    b('Tc2_Utilities', '3.4.5.0', '.compiled-library'), b('Tc2_Utilities', '3.4.10.0'), b('Tc2_Utilities', '3.4.9.0'),
    ['www.tcunit.org', 'TcUnit', '1.3.1.0', 'TcUnit.library'],
    [ACME, 'valve control', '1.2.0.0', 'Acme_ValveCtrl.compiled-library'],
    // Not installed versions: no library file, a folder that is no version.
    [ACME, 'valve control', '1.3.0.0', ''], [ACME, 'valve control', 'Backup', 'Valve Control.library'],
  ], {
    cache: cache([
      ...[['Tc2_Standard', '3.4.5.0'], ['Tc2_Standard', '3.4.7.0']].map(([t, v]) =>
        [`${BECKHOFF}\\${t}\\${v}\\${t}.compiled-library`, t, v, BECKHOFF, t, `{${category(1)}}`] as [string, string, string, string, string, string]),
      [`${BECKHOFF}\\Tc2_System\\3.4.26.0\\Tc2_System.compiled-library`, 'Tc2_System', '3.4.26.0', BECKHOFF, 'Tc2_System', `{${category(1)}}`],
      ...['3.4.5.0', '3.4.9.0', '3.4.10.0'].map(v =>
        [`${BECKHOFF}\\Tc2_Utilities\\${v}\\Tc2_Utilities.compiled-library`, 'Tc2_Utilities', v, BECKHOFF, 'Tc2_Utilities', `{${category(2)}}`] as [string, string, string, string, string, string]),
      [`${ACME}\\Valve Control\\1.2.0.0\\Acme_ValveCtrl.compiled-library`, 'Valve Control', '1.2.0.0', ACME, 'AcmeValves', `{${category(4)}};{${category(5)}}`],
      // Removed since: no folder.
      [`${BECKHOFF}\\Tc2_Removed\\1.0.0.0\\Tc2_Removed.compiled-library`, 'Tc2_Removed', '1.0.0.0', BECKHOFF, 'Tc2_Removed', ''],
    ]),
    profile: PROFILE,
    'LibraryCategoryBase.libcat.xml': libcat([[1, 'System'], [2, 'Utilities', 1], [3, 'Acme'], [4, 'Valves', 3]]),
  });
}

/** The reference XAE writes for a library: `Tc3_Module`, as the system adds it, has more. */
const placeholder = (include: string, resolution: string, namespace = include, system?: string) => [
  `<PlaceholderReference Include="${include}">`,
  `  <DefaultResolution>${resolution}</DefaultResolution>`,
  `  <Namespace>${namespace}</Namespace>`,
  ...(system ? ['  <SystemLibrary>true</SystemLibrary>', `  <ResolverGuid>${system}</ResolverGuid>`] : []),
  '</PlaceholderReference>',
];
const STANDARD = placeholder('Tc2_Standard', 'Tc2_Standard, * (Beckhoff Automation GmbH)');
const SYSTEM = placeholder('Tc2_System', 'Tc2_System, * (Beckhoff Automation GmbH)');
const MODULE = placeholder('Tc3_Module', 'Tc3_Module, * (Beckhoff Automation GmbH)', 'Tc3_Module', 'bbbbbbbb-0000-4000-8000-000000000001');
const UTILITIES = placeholder('Tc2_Utilities', 'Tc2_Utilities, * (Beckhoff Automation GmbH)');

/** A .plcproj as XAE 3.1.4026 writes one, with these ItemGroups: files, folders, the references (one per line array), <None>. */
function plcproj(references: string[][], groups: { files?: boolean; none?: boolean } = {}, eol = '\r\n'): string {
  const { files = true, none = true } = groups;
  const group = (lines: string[]) => ['  <ItemGroup>', ...lines.map(l => `    ${l}`), '  </ItemGroup>'];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    '    <FileVersion>1.0.0.0</FileVersion>',
    '    <Name>Plc</Name>',
    '    <ProgramVersion>3.1.4026.0</ProgramVersion>',
    '  </PropertyGroup>',
    ...(files ? [
      ...group(['<Compile Include="PlcTask.TcTTO">', '  <SubType>Code</SubType>', '</Compile>', '<Compile Include="POUs\\MAIN.TcPOU">', '  <SubType>Code</SubType>', '</Compile>']),
      ...group(['<Folder Include="DUTs" />', '<Folder Include="GVLs" />', '<Folder Include="VISUs" />', '<Folder Include="POUs" />']),
    ] : []),
    ...(references.length ? group(references.flat()) : []),
    ...(none ? group(['<None Include="Plc.tmc">', '  <SubType>Content</SubType>', '</None>']) : []),
    '  <ProjectExtensions>',
    '    <PlcProjectOptions />',
    '  </ProjectExtensions>',
    '</Project>',
  ].join(eol);
}

test('the libraries of a repository: its version folders, with the names, namespaces and categories of its cache', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-libraries-'));
  const root = path.join(base, 'Managed Libraries');
  try {
    systemRepository(root);
    const read = await readRepositories([root]);
    assert.deepEqual(read.found, [root]);
    assert.deepEqual(read.missing, []);
    assert.deepEqual(read.libraries.map(l => [l.title, l.company, l.versions.map(v => [v.version, path.basename(v.file), v.namespace, v.categories.join(', ')])]), [
      ['Tc2_Standard', BECKHOFF, [
        ['3.4.7.0', 'Tc2_Standard.compiled-library-ge33', 'Tc2_Standard', 'System'],
        ['3.4.5.0', 'Tc2_Standard.compiled-library-ge33', 'Tc2_Standard', 'System']]],
      ['Tc2_System', BECKHOFF, [['3.4.26.0', 'Tc2_System.compiled-library-ge33', 'Tc2_System', 'System']]],
      ['Tc2_Utilities', BECKHOFF, [
        ['3.4.10.0', 'Tc2_Utilities.compiled-library-ge33', 'Tc2_Utilities', 'System / Utilities'],
        ['3.4.9.0', 'Tc2_Utilities.compiled-library-ge33', 'Tc2_Utilities', 'System / Utilities'],
        ['3.4.5.0', 'Tc2_Utilities.compiled-library', 'Tc2_Utilities', 'System / Utilities']]],
      // Not in the cache: its folders' names, its title as namespace, no category.
      ['TcUnit', 'www.tcunit.org', [['1.3.1.0', 'TcUnit.library', 'TcUnit', '']]],
      // The cache's names; a category no category file names is left out.
      ['Valve Control', ACME, [['1.2.0.0', 'Acme_ValveCtrl.compiled-library', 'AcmeValves', 'Acme / Valves']]],
    ]);
    assert.deepEqual(read.placeholders.map(p => `${p.name} ${p.compilerVersion}`),
      ['Tc2_Standard 3.5.4.0', 'tc2_system 3.3.2.0', 'Tc2_System 3.5.4.0', 'Tc2_Utilities 3.5.4.0', 'AcmeValves 3.5.4.0']);

    // A repository XAE was told about, besides: what it adds to a library, a version both have counts once.
    const other = path.join(base, 'Other');
    writeRepository(other, [
      [BECKHOFF, 'Tc2_Standard', '3.4.7.0', 'Tc2_Standard.compiled-library-ge33'], [BECKHOFF, 'Tc2_Standard', '3.4.8.0', 'Tc2_Standard.library'],
      [ACME, 'Acme Pumps', '2.0.0.0', 'AcmePumps.library'],
    ], {});
    const both = await readRepositories([root, other, root, 'relative\\folder', path.join(root, 'missing'), path.join(root, 'profile')]);
    assert.deepEqual(both.found, [root, other]);
    assert.deepEqual(both.missing, [
      { folder: 'relative\\folder', reason: 'not an absolute path' },
      { folder: path.join(root, 'missing'), reason: 'not found' },
      { folder: path.join(root, 'profile'), reason: 'not a folder' },
    ]);
    assert.deepEqual(both.libraries.map(l => `${l.title} ${l.versions.map(v => v.version).join(' ')}`),
      ['Acme Pumps 2.0.0.0', 'Tc2_Standard 3.4.8.0 3.4.7.0 3.4.5.0', 'Tc2_System 3.4.26.0', 'Tc2_Utilities 3.4.10.0 3.4.9.0 3.4.5.0', 'TcUnit 1.3.1.0',
        'Valve Control 1.2.0.0']);
    const standard = both.libraries.find(l => l.title === 'Tc2_Standard')!;
    assert.equal(path.dirname(path.dirname(path.dirname(path.dirname(standard.versions[1].file)))), root, 'the first repository');
    assert.deepEqual(standard.versions[0].categories, [], 'not in a cache');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('no repository: the folders looked in; the system ones on Windows only', async () => {
  assert.deepEqual(systemRepositories({ ProgramData: 'C:\\ProgramData', TWINCAT3DIR: 'C:\\Program Files (x86)\\Beckhoff\\TwinCAT\\3.1\\' }, 'win32'), [
    'C:\\ProgramData\\Beckhoff\\TwinCAT\\PlcEngineering\\Managed Libraries',
    'C:\\Program Files (x86)\\Beckhoff\\TwinCAT\\3.1\\Components\\Plc\\Managed Libraries',
  ]);
  assert.deepEqual(systemRepositories({ TWINCAT3DIR: 'D:\\TwinCAT\\3.1\\' }, 'win32'), [
    'C:\\ProgramData\\Beckhoff\\TwinCAT\\PlcEngineering\\Managed Libraries',
    'D:\\TwinCAT\\3.1\\Components\\Plc\\Managed Libraries',
  ]);
  assert.equal(systemRepositories({}, 'win32')[1], 'C:\\TwinCAT\\3.1\\Components\\Plc\\Managed Libraries');
  assert.deepEqual(systemRepositories({ ProgramData: 'C:\\ProgramData' }, 'linux'), []);
  const nowhere = path.join(os.tmpdir(), 'twincat-no-repository', 'Managed Libraries');
  assert.deepEqual(await readRepositories([nowhere]), {
    found: [], missing: [{ folder: nowhere, reason: 'not found' }], libraries: [], placeholders: [], empty: [],
  });
});

/** A number as LEB128, as `projectinfo` writes its indexes and lengths. */
function leb128(n: number): number[] {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return out;
}

/**
 * A `projectinfo` as XAE writes one, made up: a header, the table of its strings (System.String first), then the
 * properties as objects naming them, a pair per property (a string object is `D0 00 01 2D <index>`).
 */
function projectinfo(strings: string[], properties: [name: string, value: string][]): Buffer {
  const table = ['System.String', ...strings];
  const string = (s: string) => [0xd0, 0x00, 0x01, 0x2d, ...leb128(table.indexOf(s) + 1)];
  return Buffer.from([
    0x21, 0x1d, 0x30, 0x85, 0x6a, 0xfc, 0x6f, 0x07, ...new Array(32).fill(0),
    ...table.flatMap((s, i) => { const text = Buffer.from(s, 'utf16le'); return [...leb128(i + 1), ...leb128(text.length), ...text]; }),
    0xd0, 0x00, 0x02, 0x1a, 0x0c, 0x9a, 0x03, 0x04,
    ...properties.flatMap(([name, value]) => [...string(name), ...string(value)]),
  ]);
}

test('the default namespace of a projectinfo: the string its property names, not the next one in the table', () => {
  // SPT Base Types: the namespace follows its name in the table.
  assert.equal(parseProjectInfoNamespace(projectinfo(['Company', ACME, 'DefaultNamespace', 'SPT_BaseTypes', 'Title', 'SPT Base Types'],
    [['Company', ACME], ['DefaultNamespace', 'SPT_BaseTypes'], ['Title', 'SPT Base Types']])), 'SPT_BaseTypes');
  // VisuShared: the namespace is its title, in the table before; another string follows the name.
  assert.equal(parseProjectInfoNamespace(projectinfo(['Title', 'VisuShared', 'DefaultNamespace', 'LanguageModelAttribute', 'qualified-access-only'],
    [['Title', 'VisuShared'], ['DefaultNamespace', 'VisuShared'], ['LanguageModelAttribute', 'qualified-access-only']])), 'VisuShared');
  // Indexes past 127 take two bytes.
  const many = Array.from({ length: 140 }, (_, i) => `Property${i}`);
  assert.equal(parseProjectInfoNamespace(projectinfo([...many, 'DefaultNamespace', 'CAA'], [['Property0', 'Property1'], ['DefaultNamespace', 'CAA']])), 'CAA');
  // None: no namespace, one that is no identifier, no projectinfo.
  assert.equal(parseProjectInfoNamespace(projectinfo(['Title', 'SPT EtherCat'], [['Title', 'SPT EtherCat']])), undefined);
  assert.equal(parseProjectInfoNamespace(projectinfo(['DefaultNamespace', 'Not one'], [['DefaultNamespace', 'Not one']])), undefined);
  assert.equal(parseProjectInfoNamespace(Buffer.from('not a projectinfo')), undefined);
});

test('a cloned repository without a cache: in a subfolder, the namespaces of its projectinfo files; a folder without libraries', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-libraries-'));
  const clone = path.join(base, 'SPT-Libraries');
  const repository = path.join(clone, 'Library Repository');
  const nothing = path.join(base, 'Nothing');
  try {
    const SPT = 'Beckhoff Automation LLC';
    writeRepository(repository, [
      [SPT, 'SPT Base Types', '3.3.0', 'SPT_Base_Types.library'], [SPT, 'SPT Base Types', '3.9.0', 'SPT_Base_Types.library'],
      [SPT, 'SPT EtherCat', '3.9.0', 'SPT_EtherCat.library'],
    ], {});
    for (const v of ['3.3.0', '3.9.0']) {
      fs.writeFileSync(path.join(repository, SPT, 'SPT Base Types', v, 'projectinfo'),
        projectinfo(['Company', SPT, 'DefaultNamespace', 'SPT_BaseTypes', 'Title', 'SPT Base Types'],
          [['Company', SPT], ['DefaultNamespace', 'SPT_BaseTypes'], ['Title', 'SPT Base Types']]));
    }
    // The other folders of the clone are no repository; git's are not looked in.
    fs.mkdirSync(path.join(clone, 'docs', 'images'), { recursive: true });
    fs.mkdirSync(path.join(clone, '.git', 'objects', 'ab'), { recursive: true });
    fs.mkdirSync(nothing);

    const read = await readRepositories([clone, nothing]);
    assert.deepEqual(read.found, [repository, nothing]);
    assert.deepEqual(read.empty, [nothing]);
    assert.deepEqual(read.libraries.map(l => [l.title, l.company, l.versions.map(v => `${v.version} ${v.namespace}`)]), [
      ['SPT Base Types', SPT, ['3.9.0 SPT_BaseTypes', '3.3.0 SPT_BaseTypes']],
      // Its projectinfo names no namespace: its title.
      ['SPT EtherCat', SPT, ['3.9.0 SPT EtherCat']],
    ]);
    assert.deepEqual((await readRepositories([repository])).libraries.map(l => l.versions[0].namespace), ['SPT_BaseTypes', 'SPT EtherCat']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the XML of a repository is read by its BOM: UTF-16 LE, UTF-16 BE, UTF-8', () => {
  const xml = '<?xml version="1.0"?><LibraryProfile Name="Größe"/>';
  assert.equal(decodeXml(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])), xml);
  assert.equal(decodeXml(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(xml, 'utf16le').swap16()])), xml);
  assert.equal(decodeXml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, 'utf8')])), xml);
  assert.equal(decodeXml(Buffer.from(xml, 'utf8')), xml);
  assert.equal(decodeXml(Buffer.from(xml, 'utf16le')), xml);
});

test('versions compare by number; a library named in a .plcproj', () => {
  const sorted = ['3.4.10.0', '3.3.65.0', '3.4.9.0', '3.4', '3.4.0.1'].sort(compareVersions);
  assert.deepEqual(sorted, ['3.3.65.0', '3.4', '3.4.0.1', '3.4.9.0', '3.4.10.0']);
  assert.equal(compareVersions('3.4', '3.4.0.0'), 0);
  assert.deepEqual(parseLibrarySpec('Tc2_Standard, * (Beckhoff Automation GmbH)'), { title: 'Tc2_Standard', version: '*', company: BECKHOFF });
  assert.deepEqual(parseLibrarySpec(' TcUnit,1.3.1.0 (www.tcunit.org) '), { title: 'TcUnit', version: '1.3.1.0', company: 'www.tcunit.org' });
  assert.deepEqual(parseLibrarySpec('Valve Control, 1.2.0.0 (Acme Automation (Europe))'), { title: 'Valve Control', version: '1.2.0.0', company: 'Acme Automation (Europe)' });
  assert.equal(parseLibrarySpec('Tc2_Standard'), undefined);
});

test('the placeholder of a new reference: the profile\'s, for the newest compiler version, else the title', () => {
  const p = (name: string, compilerVersion: string, spec: string): ProfilePlaceholder => ({ name, compilerVersion, library: parseLibrarySpec(spec)! });
  const system = { title: 'Tc2_System', company: BECKHOFF };
  const older = p('tc2_system', '3.3.2.0', 'Tc2_System, * (Beckhoff Automation GmbH)');
  const newer = p('Tc2_System', '3.5.4.0', 'Tc2_System, * (Beckhoff Automation GmbH)');
  assert.equal(placeholderName(system, [older, newer]), 'Tc2_System');
  assert.equal(placeholderName(system, [newer, older]), 'Tc2_System');
  assert.equal(placeholderName(system, [older]), 'tc2_system');
  // One named like the title before another one the profile gives it; then the newest.
  assert.equal(placeholderName(system, [older, p('SysAlias', '3.5.10.0', 'Tc2_System, * (Beckhoff Automation GmbH)')]), 'tc2_system');
  assert.equal(placeholderName({ title: 'Valve Control', company: ACME }, [p('AcmeValves', '3.5.4.0', 'Valve Control, * (Acme Automation)')]), 'AcmeValves');
  // Another company's library of that title, or none in the profile: the title.
  assert.equal(placeholderName({ title: 'Tc2_System', company: ACME }, [newer]), 'Tc2_System');
  assert.equal(placeholderName({ title: 'TcUnit', company: 'www.tcunit.org' }, [older, newer]), 'TcUnit');
  assert.deepEqual(parseProfile('<LibraryProfile><Resolution PlaceholderName="X">no library</Resolution><Resolution>A, * (B)</Resolution></LibraryProfile>'), []);
});

test('Add Library: Tc2_Utilities, always newest or 3.4.5.0, at its place among the references; the rest byte for byte', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-libraries-'));
  try {
    systemRepository(root);
    const { libraries, placeholders } = await readRepositories([root]);
    const lib = (title: string) => libraries.find(l => l.title === title)!;
    const before = plcproj([STANDARD, SYSTEM, MODULE]);
    const { text, bom } = decodeBytes(encodeText(before, true));
    const project = parsePlcProject('Plc.plcproj', text);

    const utilities = lib('Tc2_Utilities');
    assert.equal(referenceTo(project.libraries, placeholderName(utilities, placeholders), utilities.title, utilities.company), undefined);
    const newest = libraryReference(utilities, '*', placeholders);
    assert.deepEqual(newest, { include: 'Tc2_Utilities', resolution: 'Tc2_Utilities, * (Beckhoff Automation GmbH)', namespace: 'Tc2_Utilities' });
    const after = addPlaceholderReference(text, newest);
    assert.equal(after, plcproj([STANDARD, SYSTEM, UTILITIES, MODULE]));
    const added = [
      '    <PlaceholderReference Include="Tc2_Utilities">',
      '      <DefaultResolution>Tc2_Utilities, * (Beckhoff Automation GmbH)</DefaultResolution>',
      '      <Namespace>Tc2_Utilities</Namespace>',
      '    </PlaceholderReference>',
      '',
    ].join('\r\n');
    assert.equal(after.replace(added, ''), before, 'the rest byte for byte');
    assert.deepEqual([...encodeText(after, bom).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(parsePlcProject('Plc.plcproj', after).libraries.find(l => l.include === 'Tc2_Utilities'),
      { include: 'Tc2_Utilities', name: 'Tc2_Utilities', namespace: 'Tc2_Utilities', resolution: 'Tc2_Utilities, * (Beckhoff Automation GmbH)', system: false });

    const pinned = libraryReference(utilities, '3.4.5.0', placeholders);
    assert.equal(pinned.resolution, 'Tc2_Utilities, 3.4.5.0 (Beckhoff Automation GmbH)');
    assert.equal(addPlaceholderReference(text, pinned), plcproj([STANDARD, SYSTEM, placeholder('Tc2_Utilities', pinned.resolution), MODULE]));
    assert.throws(() => libraryReference(utilities, '3.4.6.0', placeholders), /not installed/);

    // Libraries of other companies are placeholders too: the title, or the profile's placeholder; the cache's namespace.
    assert.deepEqual(libraryReference(lib('TcUnit'), '*', placeholders),
      { include: 'TcUnit', resolution: 'TcUnit, * (www.tcunit.org)', namespace: 'TcUnit' });
    assert.deepEqual(libraryReference(lib('Valve Control'), '1.2.0.0', placeholders),
      { include: 'AcmeValves', resolution: 'Valve Control, 1.2.0.0 (Acme Automation)', namespace: 'AcmeValves' });
    assert.equal(addPlaceholderReference(text, libraryReference(lib('TcUnit'), '*', placeholders)),
      plcproj([STANDARD, SYSTEM, MODULE, placeholder('TcUnit', 'TcUnit, * (www.tcunit.org)')]), 'TcUnit after Tc3_Module');

    // Referenced already, by its Include or by the library it resolves to, either kind of reference: refused.
    const standard = lib('Tc2_Standard');
    assert.equal(referenceTo(project.libraries, placeholderName(standard, placeholders), standard.title, standard.company)?.include, 'Tc2_Standard');
    assert.throws(() => addPlaceholderReference(text, libraryReference(standard, '3.4.5.0', placeholders)), PlcProjectEditError);
    assert.throws(() => addPlaceholderReference(text, { include: 'TC2_STANDARD', resolution: 'Other, * (Acme Automation)', namespace: 'Other' }),
      /references Tc2_Standard already/);
    assert.throws(() => addPlaceholderReference(text, { include: 'Std', resolution: 'tc2_standard, 3.4.5.0 (BECKHOFF AUTOMATION GMBH)', namespace: 'Std' }),
      /references Tc2_Standard already/);
    const old = plcproj([['<LibraryReference Include="Tc2_Standard, 3.4.5.0 (Beckhoff Automation GmbH)">', '  <Namespace>Tc2_Standard</Namespace>', '</LibraryReference>']]);
    const oldProject = parsePlcProject('Plc.plcproj', old);
    assert.equal(referenceTo(oldProject.libraries, 'Tc2_Standard', 'Tc2_Standard', BECKHOFF)?.include, 'Tc2_Standard, 3.4.5.0 (Beckhoff Automation GmbH)');
    assert.throws(() => addPlaceholderReference(old, libraryReference(standard, '*', placeholders)), /references Tc2_Standard, 3\.4\.5\.0/);
    assert.match(addPlaceholderReference(old, newest), /<\/LibraryReference>\r\n {4}<PlaceholderReference Include="Tc2_Utilities">/);
    assert.throws(() => addPlaceholderReference(text, { include: 'X', resolution: 'X', namespace: 'X' }), /names no library/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a reference goes after the last when the references are not in order; without references, in an ItemGroup of its own', () => {
  assert.equal(addPlaceholderReference(plcproj([SYSTEM, STANDARD, MODULE]), { include: 'Tc2_Utilities', resolution: 'Tc2_Utilities, * (Beckhoff Automation GmbH)', namespace: 'Tc2_Utilities' }),
    plcproj([SYSTEM, STANDARD, MODULE, UTILITIES]));
  const utilities = { include: 'Tc2_Utilities', resolution: 'Tc2_Utilities, * (Beckhoff Automation GmbH)', namespace: 'Tc2_Utilities' };
  for (const eol of ['\r\n', '\n']) {
    // After the ItemGroups of the files and folders, before that of <None>; before the first one without them.
    assert.equal(addPlaceholderReference(plcproj([], {}, eol), utilities), plcproj([UTILITIES], {}, eol));
    assert.equal(addPlaceholderReference(plcproj([], { files: false }, eol), utilities), plcproj([UTILITIES], { files: false }, eol));
    assert.equal(addPlaceholderReference(plcproj([], { files: false, none: false }, eol), utilities), plcproj([UTILITIES], { files: false, none: false }, eol));
    assert.equal(addPlaceholderReference(plcproj([STANDARD], {}, eol), utilities), plcproj([STANDARD, UTILITIES], {}, eol));
  }
  // Names are escaped in the XML and read back as they are.
  const amp = addPlaceholderReference(plcproj([]), { include: 'A&B', resolution: 'A&B, * (Acme <Europe>)', namespace: 'AB' });
  assert.match(amp, /<PlaceholderReference Include="A&amp;B">\r\n {6}<DefaultResolution>A&amp;B, \* \(Acme &lt;Europe&gt;\)<\/DefaultResolution>/);
  assert.deepEqual(parsePlcProject('Plc.plcproj', amp).libraries.map(l => [l.include, l.resolution]), [['A&B', 'A&B, * (Acme <Europe>)']]);
  assert.throws(() => addPlaceholderReference('<Nothing/>', utilities), PlcProjectEditError);
});

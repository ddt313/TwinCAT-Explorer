import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalyzeOptions, analyze, problemLevels } from '../../src/lang/analyzer';
import { quickFixes } from '../../src/lang/autoDeclare';
import { LanguageIndex } from '../../src/lang/index';
import { TypeTree, hierarchyTypeAt, implementations, relatedMembers, subtypes, supertypes, typeTree } from '../../src/lang/hierarchy';
import { symbolLabel } from '../../src/lang/rename';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { MemberSym, PouSym, Sym, isLibrarySym } from '../../src/lang/symbols';
import { blankTrivia } from '../../src/core/splice';
import { TcWorkspace, fileKey } from '../../src/core/workspace';

const guid = (n: number) => `{dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}}`;

const object = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
${inner}
</TcPlcObject>`;

const impl = (st: string, indent = '    ') => `
${indent}<Implementation>
${indent}  <ST><![CDATA[${st}]]></ST>
${indent}</Implementation>`;

const method = (name: string, n: number, decl: string, st?: string) => `
    <Method Name="${name}" Id="${guid(n)}">
      <Declaration><![CDATA[${decl}]]></Declaration>${st === undefined ? '' : impl(st, '      ')}
    </Method>`;

const property = (name: string, n: number, decl: string, get?: string) => `
    <Property Name="${name}" Id="${guid(n)}">
      <Declaration><![CDATA[${decl}]]></Declaration>
      <Get Name="Get" Id="${guid(n + 1)}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>${get === undefined ? '' : impl(get, '        ')}
      </Get>
    </Property>`;

const pou = (name: string, n: number, decl: string, st: string, members = '') => object(`  <POU Name="${name}" Id="${guid(n)}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>${impl(st)}${members}
  </POU>`);

const itf = (name: string, n: number, decl: string, members: string) => object(`  <Itf Name="${name}" Id="${guid(n)}">
    <Declaration><![CDATA[${decl}]]></Declaration>${members}
  </Itf>`);

// I_Valve extends I_Device; FB_ValveBase implements I_Valve, FB_Valve extends it and overrides Open; FB_Pump
// implements I_Device; FB_Motor implements it with the Reset of FB_Drive, which it extends, and implements the
// library interface ITcUnknown (Tc3_Module) too.
const FILES: Record<string, string> = {
  'POUs/I_Device.TcIO': itf('I_Device', 1, 'INTERFACE I_Device\n',
    method('Reset', 2, 'METHOD Reset : BOOL\n') + property('Ready', 3, 'PROPERTY Ready : BOOL')),
  'POUs/I_Valve.TcIO': itf('I_Valve', 10, 'INTERFACE I_Valve EXTENDS I_Device\n',
    method('Open', 11, 'METHOD Open : BOOL\n') + method('Close', 12, 'METHOD Close : BOOL\n')),
  'POUs/FB_ValveBase.TcPOU': pou('FB_ValveBase', 20, `FUNCTION_BLOCK FB_ValveBase IMPLEMENTS I_Valve
VAR
	bOpen : BOOL;
END_VAR
`, '',
  method('Open', 21, 'METHOD Open : BOOL\n', 'bOpen := TRUE;\nOpen := TRUE;')
  + method('Close', 22, 'METHOD Close : BOOL\n', 'bOpen := FALSE;\nClose := TRUE;')
  + method('Reset', 23, 'METHOD Reset : BOOL\n', 'Reset := Close();')
  + property('Ready', 24, 'PROPERTY Ready : BOOL', 'Ready := NOT bOpen;')),
  'POUs/FB_Valve.TcPOU': pou('FB_Valve', 30, 'FUNCTION_BLOCK FB_Valve EXTENDS FB_ValveBase\n', '',
    method('Open', 31, 'METHOD Open : BOOL\n', 'Open := SUPER^.Open();')),
  'POUs/FB_Pump.TcPOU': pou('FB_Pump', 40, 'FUNCTION_BLOCK FB_Pump IMPLEMENTS I_Device\n', '',
    method('Reset', 41, 'METHOD Reset : BOOL\n', 'Reset := TRUE;') + property('Ready', 42, 'PROPERTY Ready : BOOL', 'Ready := TRUE;')),
  'POUs/FB_Drive.TcPOU': pou('FB_Drive', 50, 'FUNCTION_BLOCK FB_Drive\n', '',
    method('Reset', 51, 'METHOD Reset : BOOL\n', 'Reset := TRUE;')),
  'POUs/FB_Motor.TcPOU': pou('FB_Motor', 60, 'FUNCTION_BLOCK FB_Motor EXTENDS FB_Drive IMPLEMENTS I_Device, ITcUnknown\n', '',
    property('Ready', 61, 'PROPERTY Ready : BOOL', 'Ready := TRUE;') + method('TcAddRef', 63, 'METHOD TcAddRef : UDINT\n', 'TcAddRef := 1;')),
  'POUs/MAIN.TcPOU': pou('MAIN', 70, `PROGRAM MAIN
VAR
	fbValve : FB_Valve;
	fbPump : FB_Pump;
	itfValve : I_Valve;
	itfDevice : I_Device;
	bReady : BOOL;
END_VAR
`, `itfValve := fbValve;
itfValve.Open();
itfValve.Reset();
itfDevice := fbPump;
bReady := itfDevice.Ready;
fbValve.Open();`),
};

/** A workspace of the files above, with its index. */
function project(overrides: Record<string, string> = {}): { root: string; index: LanguageIndex; file: (rel: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-hierarchy-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const files = { ...FILES, ...overrides };
  write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
  write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${Object.keys(files).map(f => `<Compile Include="${f.replace(/\//g, '\\')}"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
</Project>`);
  for (const [rel, text] of Object.entries(files)) write(`A/Plc/${rel}`, text);
  const ws = new TcWorkspace();
  ws.load([path.join(root, 'A/A.tsproj')]);
  const index = new LanguageIndex(ws);
  index.setStubs(BUNDLED_STUBS);
  return { root, index, file: rel => path.join(root, 'A/Plc', rel) };
}

/**
 * Where a cursor is: in the `decl` or `impl` section of the object with this GUID, at the `|` of a piece of its
 * code (`itfValve.|Open()`). The section, its analysis and the offset.
 */
function cursor(index: LanguageIndex, filePath: string, n: number, role: 'decl' | 'impl', marked: string) {
  const key = `${guid(n).replace(/[{}]/g, '')}:${role}`;
  const ctx = index.context(fileKey(filePath), key)!;
  const text = index.sectionText(fileKey(filePath), key)!;
  const at = blankTrivia(text).indexOf(marked.replace('|', ''));
  assert.ok(at >= 0, `${marked} is not in ${ctx.object.qualifiedName} (${ctx.label})`);
  return { ctx, analysis: analyze(index, ctx, text), offset: at + marked.indexOf('|') };
}

/** The symbol of the name at a cursor (see cursor). */
function symAt(index: LanguageIndex, filePath: string, n: number, role: 'decl' | 'impl', marked: string): Sym {
  const { analysis, offset } = cursor(index, filePath, n, role, marked);
  const o = analysis.occurrences.find(x => x.start <= offset && offset <= x.end);
  assert.ok(o, `no symbol at ${marked}`);
  return o.sym;
}

const labels = (syms: Sym[]) => syms.map(symbolLabel);

/** A type tree as lines, indented by depth, a library's marked. */
const lines = (trees: TypeTree[], depth = 0): string[] => trees.flatMap(t => [
  `${'  '.repeat(depth)}${t.sym.name}${isLibrarySym(t.sym) ? ` (${t.sym.scope.name})` : ''}`, ...lines(t.children, depth + 1),
]);

test('implementations of an interface and of a function block: at the declaration and at a use', () => {
  const { root, index, file } = project();
  try {
    // Directly (FB_Pump, FB_Motor), through I_Valve, which extends it (FB_ValveBase), and by extending a function
    // block that implements it (FB_Valve). I_Valve is an interface: not an implementation.
    const device = symAt(index, file('POUs/I_Device.TcIO'), 1, 'decl', 'INTERFACE |I_Device');
    assert.deepEqual(labels(implementations(index, device)), ['FB_Motor', 'FB_Pump', 'FB_Valve', 'FB_ValveBase']);
    const valve = symAt(index, file('POUs/MAIN.TcPOU'), 70, 'decl', 'itfValve : |I_Valve');
    assert.deepEqual(labels(implementations(index, valve)), ['FB_Valve', 'FB_ValveBase']);
    // A function block: those that extend it, whatever the depth.
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/FB_ValveBase.TcPOU'), 20, 'decl', 'FUNCTION_BLOCK |FB_ValveBase'))),
      ['FB_Valve']);
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/MAIN.TcPOU'), 70, 'decl', 'fbValve : |FB_Valve'))), []);
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/FB_Motor.TcPOU'), 60, 'decl', 'EXTENDS |FB_Drive'))), ['FB_Motor']);
    // A library interface: the function blocks of the workspace that implement it.
    const unknown = symAt(index, file('POUs/FB_Motor.TcPOU'), 60, 'decl', '|ITcUnknown');
    assert.ok(isLibrarySym(unknown));
    assert.deepEqual(labels(implementations(index, unknown)), ['FB_Motor']);
    // Neither a program nor a variable has implementations.
    assert.deepEqual(implementations(index, symAt(index, file('POUs/MAIN.TcPOU'), 70, 'decl', 'PROGRAM |MAIN')), []);
    assert.deepEqual(implementations(index, symAt(index, file('POUs/MAIN.TcPOU'), 70, 'impl', '|itfValve := fbValve')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('implementations of a method or property: those of the implementing function blocks, and the overrides', () => {
  const { root, index, file } = project();
  try {
    // At the declaration in the interface and at a call through it: FB_ValveBase's and FB_Valve's override.
    const open = symAt(index, file('POUs/I_Valve.TcIO'), 11, 'decl', 'METHOD |Open') as MemberSym;
    assert.deepEqual(labels(implementations(index, open)), ['FB_Valve.Open', 'FB_ValveBase.Open']);
    assert.equal(symAt(index, file('POUs/MAIN.TcPOU'), 70, 'impl', 'itfValve.|Open()'), open);
    // What relatedMembers finds for a rename, less the interface itself.
    assert.deepEqual(labels(relatedMembers(index, open).members).sort(), ['FB_Valve.Open', 'FB_ValveBase.Open']);

    // A method of I_Device called through I_Valve: also the one FB_Motor has from FB_Drive, which it extends.
    const reset = symAt(index, file('POUs/MAIN.TcPOU'), 70, 'impl', 'itfValve.|Reset()');
    assert.equal(symbolLabel(reset), 'I_Device.Reset');
    assert.deepEqual(labels(implementations(index, reset)), ['FB_Drive.Reset', 'FB_Pump.Reset', 'FB_ValveBase.Reset']);
    // A property, read through the interface.
    const ready = symAt(index, file('POUs/MAIN.TcPOU'), 70, 'impl', 'itfDevice.|Ready');
    assert.equal(ready.kind, 'property');
    assert.deepEqual(labels(implementations(index, ready)), ['FB_Motor.Ready', 'FB_Pump.Ready', 'FB_ValveBase.Ready']);

    // A method of a function block: the overrides in those that extend it.
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/FB_ValveBase.TcPOU'), 21, 'decl', 'METHOD |Open'))), ['FB_Valve.Open']);
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/FB_ValveBase.TcPOU'), 22, 'decl', 'METHOD |Close'))), []);
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/MAIN.TcPOU'), 70, 'impl', 'fbValve.|Open()'))), []);
    assert.deepEqual(labels(implementations(index, symAt(index, file('POUs/FB_Valve.TcPOU'), 31, 'impl', 'SUPER^.|Open()'))), ['FB_Valve.Open']);

    // A method of a library interface: the workspace's only.
    const unknown = symAt(index, file('POUs/FB_Motor.TcPOU'), 60, 'decl', '|ITcUnknown') as PouSym;
    const addRef = unknown.members.find(m => m.name === 'TcAddRef')!;
    assert.ok(isLibrarySym(addRef));
    assert.deepEqual(labels(implementations(index, addRef)), ['FB_Motor.TcAddRef']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the type hierarchy: supertypes up to the roots and subtypes down to the leaves, a library as a supertype', () => {
  const { root, index, file } = project();
  try {
    const valve = symAt(index, file('POUs/FB_Valve.TcPOU'), 30, 'decl', 'FUNCTION_BLOCK |FB_Valve') as PouSym;
    assert.deepEqual(lines(typeTree(index, valve, 'supertypes')), ['FB_ValveBase', '  I_Valve', '    I_Device']);
    assert.deepEqual(lines(typeTree(index, valve, 'subtypes')), []);

    const device = symAt(index, file('POUs/I_Device.TcIO'), 1, 'decl', 'INTERFACE |I_Device') as PouSym;
    assert.deepEqual(lines(typeTree(index, device, 'supertypes')), []);
    // The interfaces that extend it and the function blocks that implement or extend either, by name.
    assert.deepEqual(lines(typeTree(index, device, 'subtypes')), ['FB_Motor', 'FB_Pump', 'I_Valve', '  FB_ValveBase', '    FB_Valve']);

    // EXTENDS, then IMPLEMENTS in their order; a library's interface is a supertype, its subtypes are the workspace's.
    const motor = symAt(index, file('POUs/FB_Motor.TcPOU'), 60, 'decl', 'FUNCTION_BLOCK |FB_Motor') as PouSym;
    assert.deepEqual(lines(typeTree(index, motor, 'supertypes')), ['FB_Drive', 'I_Device', 'ITcUnknown (Tc3_Module)']);
    const unknown = supertypes(index, motor)[2];
    assert.deepEqual(labels(subtypes(index, unknown)), ['FB_Motor']);
    assert.deepEqual(labels(supertypes(index, unknown)), []);

    // The type a type hierarchy shows at a cursor: the one named there, the one of a method, else the section's.
    const at = (n: number, role: 'decl' | 'impl', marked: string, f: string) => {
      const c = cursor(index, file(f), n, role, marked);
      return hierarchyTypeAt(c.analysis, c.ctx, c.offset)?.name;
    };
    assert.equal(at(70, 'decl', 'itfValve : |I_Valve', 'POUs/MAIN.TcPOU'), 'I_Valve');
    assert.equal(at(70, 'impl', 'itfDevice.|Ready', 'POUs/MAIN.TcPOU'), 'I_Device');
    assert.equal(at(70, 'impl', 'itf|Valve := fbValve', 'POUs/MAIN.TcPOU'), undefined, 'a variable of a program');
    assert.equal(at(31, 'impl', 'Open := |SUPER', 'POUs/FB_Valve.TcPOU'), 'FB_ValveBase', 'SUPER is its base');
    assert.equal(at(31, 'impl', 'Open :|= SUPER', 'POUs/FB_Valve.TcPOU'), 'FB_Valve', 'the method of FB_Valve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXTENDS that go round end the hierarchy and the implementations', () => {
  const { root, index, file } = project({
    'POUs/FB_Drive.TcPOU': pou('FB_Drive', 50, 'FUNCTION_BLOCK FB_Drive EXTENDS FB_Motor\n', '',
      method('Reset', 51, 'METHOD Reset : BOOL\n', 'Reset := TRUE;')),
  });
  try {
    const motor = symAt(index, file('POUs/FB_Motor.TcPOU'), 60, 'decl', 'FUNCTION_BLOCK |FB_Motor') as PouSym;
    assert.deepEqual(lines(typeTree(index, motor, 'supertypes')), ['FB_Drive', '  FB_Motor', 'I_Device', 'ITcUnknown (Tc3_Module)']);
    assert.deepEqual(lines(typeTree(index, motor, 'subtypes')), ['FB_Drive', '  FB_Motor']);
    assert.deepEqual(labels(implementations(index, motor)), ['FB_Drive']);
    const reset = symAt(index, file('POUs/FB_Drive.TcPOU'), 51, 'decl', 'METHOD |Reset');
    assert.deepEqual(labels(implementations(index, reset)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The problems of the declaration of the POU with this GUID, as `code: message`, with these analysis options. */
function declProblems(index: LanguageIndex, filePath: string, n: number, options?: AnalyzeOptions): string[] {
  const key = `${guid(n).replace(/[{}]/g, '')}:decl`;
  const ctx = index.context(fileKey(filePath), key)!;
  return analyze(index, ctx, index.sectionText(fileKey(filePath), key)!, options).problems.map(p => `${p.severity} ${p.code}: ${p.message}`);
}

test('a function block that lacks methods or properties of its interfaces: an error at the name after IMPLEMENTS', () => {
  const { root, index, file } = project({
    // Close of I_Valve, Reset and Ready of I_Device (which I_Valve extends) are lacking.
    'POUs/FB_Half.TcPOU': pou('FB_Half', 80, 'FUNCTION_BLOCK FB_Half IMPLEMENTS I_Valve\n', '',
      method('Open', 81, 'METHOD Open : BOOL\n', 'Open := TRUE;')),
    // Each of its interfaces gets its own error; Reset comes from its base, FB_Drive.
    'POUs/FB_Two.TcPOU': pou('FB_Two', 90, 'FUNCTION_BLOCK FB_Two EXTENDS FB_Drive IMPLEMENTS I_Device, I_Valve\n', ''),
    'POUs/FB_Abstract.TcPOU': pou('FB_Abstract', 100, 'FUNCTION_BLOCK ABSTRACT FB_Abstract IMPLEMENTS I_Valve\n', ''),
    // Its base is not found: it may have them.
    'POUs/FB_Lost.TcPOU': pou('FB_Lost', 110, 'FUNCTION_BLOCK FB_Lost EXTENDS FB_Nowhere IMPLEMENTS I_Valve\n', ''),
  });
  try {
    assert.deepEqual(declProblems(index, file('POUs/FB_Half.TcPOU'), 80),
      ['error unimplemented-interface: FB_Half does not implement method Close, method Reset (of I_Device), property Ready (of I_Device) of I_Valve']);
    const at = index.context(fileKey(file('POUs/FB_Half.TcPOU')), `${guid(80).replace(/[{}]/g, '')}:decl`)!;
    const text = index.sectionText(at.fileKey, at.sectionKey)!;
    const p = analyze(index, at, text).problems[0];
    assert.equal(text.slice(p.start, p.end), 'I_Valve');
    // A member lacking through two names is reported at the first.
    assert.deepEqual(declProblems(index, file('POUs/FB_Two.TcPOU'), 90), [
      'error unimplemented-interface: FB_Two does not implement property Ready of I_Device',
      'error unimplemented-interface: FB_Two does not implement method Open, method Close of I_Valve',
    ]);
    // A library interface: ITcUnknown of Tc3_Module, of which FB_Motor has TcAddRef only.
    assert.deepEqual(declProblems(index, file('POUs/FB_Motor.TcPOU'), 60),
      ['error unimplemented-interface: FB_Motor does not implement method TcRelease, method TcQueryInterface of ITcUnknown']);
    assert.deepEqual(declProblems(index, file('POUs/FB_Abstract.TcPOU'), 100), [], 'an ABSTRACT function block');
    assert.deepEqual(declProblems(index, file('POUs/FB_Lost.TcPOU'), 110), ["error unknown-type: Unknown type 'FB_Nowhere'"]);
    // Implemented by itself, by its base, or both.
    for (const [f, n] of [['POUs/FB_ValveBase.TcPOU', 20], ['POUs/FB_Valve.TcPOU', 30], ['POUs/FB_Pump.TcPOU', 40]] as const) {
      assert.deepEqual(declProblems(index, file(f), n), [], f);
    }

    // The levels of the setting twincatExplorer.diagnostics.rules.
    assert.deepEqual(declProblems(index, file('POUs/FB_Pump.TcPOU'), 40, { levels: { 'unimplemented-interface': 'off' } }), []);
    assert.deepEqual(declProblems(index, file('POUs/FB_Lost.TcPOU'), 110, { levels: problemLevels({ 'unknown-type': 'warning', 'nonsense': 'off', 'syntax': 'loud' }) }),
      ["warning unknown-type: Unknown type 'FB_Nowhere'"]);
    assert.deepEqual(problemLevels({ 'unknown-type': 'warning', 'nonsense': 'off', 'syntax': 'loud' }), { 'unknown-type': 'warning' });
    assert.deepEqual(problemLevels(['unknown-type']), {});

    // Its quick fix: Implement Interfaces.
    const fixes = quickFixes(index, at, text, analyze(index, at, text).problems);
    assert.deepEqual(fixes.map(f => [f.kind, f.title, f.preferred]), [['implement', 'Implement Interfaces in FB_Half...', true]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the attribute 'explorer.disable' turns checks off in a POU and its members, or in a member", () => {
  const { root, index, file } = project({
    'POUs/FB_Half.TcPOU': pou('FB_Half', 80, `{attribute 'explorer.disable' := 'unimplemented-interface, Unknown-Identifier'}
FUNCTION_BLOCK FB_Half IMPLEMENTS I_Valve
VAR
	x : INT := nUnknown;
	t : T_Unknown;
END_VAR
`, 'x := nOther;',
    method('Open', 81, 'METHOD Open : BOOL\nVAR\n\ty : T_Other;\nEND_VAR\n', 'Open := nThird;')
    + method('Close', 82, "{attribute 'explorer.disable'}\nMETHOD Close : BOOL\nVAR\n\ty : T_Other;\nEND_VAR\n", 'Close := nThird;')),
    'POUs/MAIN.TcPOU': pou('MAIN', 70, "PROGRAM MAIN\n{attribute 'explorer.disable' := 'unknown-type'}\nVAR\n\tt : T_Unknown;\nEND_VAR\n", 'nUnknown := 1;'),
  });
  try {
    const problems = (n: number, role: 'decl' | 'impl', f = 'POUs/FB_Half.TcPOU') => {
      const key = `${guid(n).replace(/[{}]/g, '')}:${role}`;
      const ctx = index.context(fileKey(file(f)), key)!;
      return analyze(index, ctx, index.sectionText(ctx.fileKey, key)!).problems.map(p => `${p.code}: ${p.message}`);
    };
    // Codes in any case; those not named are still reported.
    assert.deepEqual(problems(80, 'decl'), ["unknown-type: Unknown type 'T_Unknown'"]);
    assert.deepEqual(problems(80, 'impl'), []);
    // A method gets those of its POU.
    assert.deepEqual(problems(81, 'decl'), ["unknown-type: Unknown type 'T_Other'"]);
    assert.deepEqual(problems(81, 'impl'), []);
    // Without a value: all.
    assert.deepEqual(problems(82, 'decl'), []);
    // Anywhere in the declaration; the implementation of the POU too.
    assert.deepEqual(problems(70, 'decl', 'POUs/MAIN.TcPOU'), []);
    assert.deepEqual(problems(70, 'impl', 'POUs/MAIN.TcPOU'), ["unknown-identifier: Unknown identifier 'nUnknown'"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// samples/Demo, a TwinCAT solution saved by TwinCAT XAE (samples/Demo/README.md): the extension reads it as XAE
// builds it, and writes its files back as XAE wrote them. XAE builds it with 0 errors and 0 warnings, so a problem the
// extension finds there is the extension's own.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session } from '../../src/mcp/session';
import * as T from '../../src/mcp/tools';
import { UndoLog } from '../../src/mcp/undo';
import { TcWorkspace } from '../../src/core/workspace';
import { decodeBytes, encodeText, parseTcText } from '../../src/core/tcfile';
import { applySectionEdits } from '../../src/core/splice';
import { LanguageIndex } from '../../src/lang/index';
import { analyze } from '../../src/lang/analyzer';
import { SectionFeatures, accessGroups } from '../../src/lang/features';
import { GvlSym, PouSym } from '../../src/lang/symbols';
import { ioLinkHover } from '../../src/lang/ioHover';
import { parseBody, parseDeclaration } from '../../src/lang/parser';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { findFiles } from './helpers';

const SAMPLE = path.join(__dirname, '..', '..', '..', 'samples', 'Demo');
const SOURCE = /\.(TcPOU|TcDUT|TcGVL|TcIO|TcTTO)$/i;

function load(): TcWorkspace {
  const ws = new TcWorkspace();
  ws.load(findFiles(SAMPLE, '.tsproj'));
  return ws;
}

test('samples/Demo: both PLC projects load, with every source file on disk in them', () => {
  const ws = load();
  assert.deepEqual(ws.loadErrors, []);
  assert.deepEqual(ws.plcProjects.map(p => p.name).sort(), ['DemoLib', 'Machine']);
  const entries = ws.sourceEntries;
  const onDisk = ws.plcProjects.flatMap(p => findFiles(p.dir, '').filter(f => SOURCE.test(f)));
  assert.deepEqual(entries.map(e => path.resolve(e.path)).sort(), onDisk.map(f => path.resolve(f)).sort());
  for (const e of entries) assert.equal(ws.getFile(e.path)?.error, undefined, e.include);
});

test('samples/Demo: no syntax error in any section', () => {
  const ws = load();
  const errors: string[] = [];
  let sections = 0;
  for (const e of ws.sourceEntries) {
    for (const s of ws.getFile(e.path)!.sections.values()) {
      if (!s.editable) continue;
      sections++;
      const r = s.role === 'decl' ? parseDeclaration(s.text) : parseBody(s.text);
      errors.push(...r.errors.map(err => `${s.owner.qualifiedName} [${s.label}] ${err.message}`));
    }
  }
  assert.ok(sections > 40, `${sections} sections read`);
  assert.deepEqual(errors, []);
});

test('samples/Demo: no problem, the unknown name in the code excluded from the build left aside', () => {
  const ws = load();
  const index = new LanguageIndex(ws);
  index.setStubs(BUNDLED_STUBS);
  const problems: string[] = [];
  for (const ctx of index.allContexts()) {
    const a = analyze(index, ctx, index.sectionText(ctx.fileKey, ctx.sectionKey)!);
    problems.push(...a.problems.map(p => `${ctx.object.qualifiedName} [${ctx.label}] ${p.severity}: ${p.message}`));
  }
  assert.deepEqual(problems, []);
  // FB_Prototype is in POUs\Experimental, which Machine.plcproj excludes from the build (ExcludeFromBuild): XAE's build
  // never compiles it, so its unknown name UnknownSymbol is no problem, as for XAE.
  const excluded = index.allContexts().filter(c => c.excluded).map(c => `${c.object.qualifiedName} [${c.label}]`);
  assert.deepEqual(excluded.sort(), ['FB_Prototype [Declaration]', 'FB_Prototype [Implementation]']);
});

test('samples/Demo: the MCP tool check finds no problem, and names the object excluded from the build', () => {
  const undo = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sample-undo-'));
  try {
    const t: T.Tools = { session: new Session(SAMPLE), undo: new UndoLog(SAMPLE, path.join(undo, 'undo.jsonl')) };
    t.session.refresh();
    assert.equal(T.check(t, {}), 'Syntax and name check of the extension (not the TwinCAT compiler): no problems.\n'
      + 'Excluded from the build, not checked: FB_Prototype');
    assert.equal(T.check(t, { object: 'FB_Prototype' }), 'FB_Prototype is excluded from the build (Exclude from build in XAE): not checked.');
  } finally {
    fs.rmSync(undo, { recursive: true, force: true });
  }
});

/**
 * The MCP tool check on a copy of samples/Demo with FB_ValveBase (DemoLib), which implements I_Valve, changed by
 * `change`; Machine's FB_Valve extends it and overrides Open only.
 */
function checkChangedValveBase(change: (text: string) => string): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sample-copy-'));
  try {
    fs.cpSync(SAMPLE, copy, { recursive: true });
    const base = path.join(copy, 'Demo', 'DemoLib', 'POUs', 'Valves', 'FB_ValveBase.TcPOU');
    fs.writeFileSync(base, change(fs.readFileSync(base, 'utf8')));
    const t: T.Tools = { session: new Session(copy), undo: new UndoLog(copy, path.join(copy, 'undo.jsonl')) };
    t.session.refresh();
    return T.check(t, {});
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const withoutClose = (text: string) => {
  const out = text.replace(/\s*<Method Name="Close"[\s\S]*?<\/Method>/, '');
  assert.notEqual(out, text, 'FB_ValveBase has a method Close');
  return out;
};

test('samples/Demo: FB_ValveBase without ABSTRACT and without Close lacks Close of I_Valve, and so does FB_Valve', () => {
  // FB_ValveBase is ABSTRACT: without it and with all its methods, no problem.
  const concrete = (text: string) => {
    const out = text.replace('FUNCTION_BLOCK ABSTRACT FB_ValveBase', 'FUNCTION_BLOCK FB_ValveBase');
    assert.notEqual(out, text, 'FB_ValveBase is ABSTRACT');
    return out;
  };
  assert.match(checkChangedValveBase(concrete), /: no problems\./);
  assert.equal(checkChangedValveBase(text => withoutClose(concrete(text))),
    'Syntax and name check of the extension (not the TwinCAT compiler): 2 problem(s)\n'
    + 'FB_Valve decl:1  error: FB_Valve does not implement method Close of I_Valve (through FB_ValveBase) [unimplemented-interface]\n'
    + 'FB_ValveBase decl:1  error: FB_ValveBase does not implement method Close of I_Valve [unimplemented-interface]\n'
    + 'Excluded from the build, not checked: FB_Prototype');
});

test('samples/Demo: FB_ValveBase ABSTRACT without Close may lack it, FB_Valve that extends it may not', () => {
  assert.equal(checkChangedValveBase(withoutClose),
    'Syntax and name check of the extension (not the TwinCAT compiler): 1 problem(s)\n'
    + 'FB_Valve decl:1  error: FB_Valve does not implement method Close of I_Valve (through FB_ValveBase) [unimplemented-interface]\n'
    + 'Excluded from the build, not checked: FB_Prototype');
});

test('samples/Demo: the MCP tool references tells who writes a variable, through which member', () => {
  const undo = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sample-undo-'));
  try {
    const t: T.Tools = { session: new Session(SAMPLE), undo: new UndoLog(SAMPLE, path.join(undo, 'undo.jsonl')) };
    t.session.refresh();
    // stStatus of FB_ValveBase, written in its methods and in FB_Valve, which extends it.
    assert.equal(T.references(t, { symbol: 'FB_ValveBase.stStatus', access: ['write', 'readwrite', 'address'] }), [
      'stStatus: 9 of 18 place(s) (write, readwrite, address); all: 9 write, 8 read, 1 declaration',
      'FB_Valve impl:4  write .eState  stStatus.eState := E_ValveState.Open;',
      'FB_Valve impl:6  write .eState  stStatus.eState := E_ValveState.Closed;',
      'FB_Valve.A_Reset impl:1  write .eState  stStatus.eState := E_ValveState.Closed;',
      'FB_Valve.A_Reset impl:2  write .nCycles  stStatus.nCycles := 0;',
      'FB_ValveBase impl:3  write .eState  stStatus.eState := E_ValveState.Error;',
      'FB_ValveBase impl:5  write .bInterlocked  stStatus.bInterlocked := bInterlock;',
      'FB_ValveBase.Close impl:1  write .eState  stStatus.eState := E_ValveState.Closing;',
      'FB_ValveBase.Open impl:4  write .eState  stStatus.eState := E_ValveState.Opening;',
      'FB_ValveBase.Open impl:5  write .nCycles  stStatus.nCycles := stStatus.nCycles + 1;',
    ].join('\n'));
    // A function block instance: called, a property set, a method called, an output read.
    assert.equal(T.references(t, { symbol: 'MAIN.fbConveyor' }), [
      'fbConveyor: 6 place(s): 1 write, 2 call, 2 read, 1 declaration',
      'MAIN decl:4  declaration  fbConveyor\t: FB_Conveyor;',
      'MAIN impl:6  call  fbConveyor(bEnable := fbFill.bDone);',
      'MAIN impl:7  read .bRunning  IF fbFill.bDone AND NOT fbConveyor.bRunning THEN',
      'MAIN impl:8  write .Speed  fbConveyor.Speed := GVL_Parameters.fMaxSpeed;',
      'MAIN impl:9  call .Start  fbConveyor.Start();',
      'MAIN impl:11  read .bRunning  GVL_IO.bConveyorRun := fbConveyor.bRunning;',
    ].join('\n'));
  } finally {
    fs.rmSync(undo, { recursive: true, force: true });
  }
});

test('samples/Demo: Show References by Access groups the places of stStatus, writes first, each with its line', () => {
  const index = new LanguageIndex(load());
  index.setStubs(BUNDLED_STUBS);
  const features = new SectionFeatures(index);
  const base = index.allGlobals().find((g): g is PouSym => g.kind === 'pou' && g.name === 'FB_ValveBase')!;
  const stStatus = base.vars.find(v => v.name === 'stStatus')!;
  const groups = accessGroups(index, features.references(stStatus, true));
  assert.deepEqual(groups.map(g => `${g.kind} ${g.places.length}`), ['write 9', 'read 8', 'declaration 1']);
  const write = groups[0].places[3];
  assert.equal(write.line, 'stStatus.nCycles := 0;');
  assert.equal(write.where, '.nCycles  FB_Valve.A_Reset · Implementation:2');
  assert.equal(write.line.slice(...write.highlight), 'stStatus');
  // The name's range in the line as shown, its indentation left out.
  const indented = groups[0].places[0];
  assert.equal(indented.where, '.eState  FB_Valve · Implementation:4');
  assert.equal(indented.line.slice(...indented.highlight), 'stStatus');
  assert.equal(groups[2].places[0].where, 'FB_ValveBase · Declaration:6');
});

test('samples/Demo: the MCP tool calls: who calls a method, through its interface too, up to the task', () => {
  const undo = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sample-undo-'));
  try {
    const t: T.Tools = { session: new Session(SAMPLE), undo: new UndoLog(SAMPLE, path.join(undo, 'undo.jsonl')) };
    t.session.refresh();
    const fill = 'MAIN impl:2  fbFill(bStart := GVL_IO.bStartButton, fLevel := F_Clamp(WORD_TO_LREAL(uRaw.nValue) / 327.67, 0, 100), stRecipe := GVL_Parameters.stRecipe, iInlet := fbInlet);';
    // FB_Valve.Open overrides it and calls it through SUPER^; FB_FillSequence calls it through I_Valve; MAIN, run by PlcTask, calls FB_FillSequence.
    assert.equal(T.calls(t, { symbol: 'FB_ValveBase.Open', depth: 2 }), [
      'FB_ValveBase.Open: called by (2 levels)',
      '  FB_Valve.Open',
      '    · FB_Valve.Open impl:1  Open := SUPER^.Open(bForce := bForce);',
      '    FB_FillSequence (via I_Valve.Open)',
      '      · FB_FillSequence impl:9  IF iInlet.Open(bForce := FALSE) THEN',
      '  FB_FillSequence (via I_Valve.Open)',
      '    · FB_FillSequence impl:9  IF iInlet.Open(bForce := FALSE) THEN',
      '    MAIN',
      `      · ${fill}`,
    ].join('\n'));
    // A call through SUPER^ reaches the base's own, not the override.
    assert.doesNotMatch(T.calls(t, { symbol: 'FB_Valve.Open' }), /SUPER/);
    assert.equal(T.calls(t, { symbol: 'MAIN' }), 'MAIN: called by\n  PlcTask (task)');
    const out = T.calls(t, { symbol: 'FB_FillSequence', direction: 'outgoing' });
    assert.match(out, /^  TON \(Tc2_Standard\)\n    · FB_FillSequence impl:20  tonSettle\(IN := TRUE, PT := stRecipe\.tSettle\);$/m);
    assert.match(out, /^  I_Valve\.Close\n    · FB_FillSequence impl:15  iInlet\.Close\(\);$/m);
  } finally {
    fs.rmSync(undo, { recursive: true, force: true });
  }
});

test('samples/Demo: its files have the bytes XAE wrote, and a section edited and edited back gives them again', () => {
  const ws = load();
  let edited = 0;
  for (const e of ws.sourceEntries) {
    const bytes = fs.readFileSync(e.path);
    const { text, bom } = decodeBytes(bytes);
    // A failure here: git or an editor changed the sample's line endings or BOM (.gitattributes: samples/** -text).
    assert.ok(bom, `${e.include}: BOM`);
    if (!/\.TcTTO$/i.test(e.path)) assert.ok(!/(^|[^\r])\n/.test(text), `${e.include}: CRLF line breaks only`);
    const file = parseTcText(e.path, text, bom);
    for (const [key, s] of file.sections) {
      if (!s.editable) continue;
      const changed = parseTcText(e.path, applySectionEdits(file, [{ key, text: `${s.text}\n// edited` }]).text, bom);
      assert.equal(normalize(changed.sections.get(key)!.text), normalize(`${s.text}\n// edited`), `${e.include} ${s.label}`);
      const back = applySectionEdits(changed, [{ key, text: s.text }]).text;
      assert.ok(Buffer.from(encodeText(back, bom)).equals(bytes), `${e.include} ${s.owner.qualifiedName} [${s.label}]: the bytes again`);
      edited++;
    }
  }
  assert.ok(edited > 40, `${edited} sections edited`);
});

const normalize = (s: string) => s.replace(/\r\n?/g, '\n');

test('samples/Demo: the hover of a GVL variable AT %I* / %Q* tells what it is linked to, as XAE saved Demo.tsproj', () => {
  const ws = load();
  const index = new LanguageIndex(ws);
  const gvl = (owner: string) => index.allGlobals().find((g): g is GvlSym => g.kind === 'gvl' && g.name === owner)!;
  const hover = (owner: string, name: string) => ioLinkHover(ws, index, gvl(owner).vars.find(v => v.name === name)!);
  const term = 'Device 1 (EtherCAT) › Term 1 (EK1100) › ';
  assert.equal(hover('GVL_IO', 'bStartButton'), `**I/O** · Demo.tsproj\n\n- \`${term}Term 2 (EL1008) › Channel 1 › Input\``);
  assert.equal(hover('GVL_IO', 'bConveyorRun'), `**I/O** · Demo.tsproj\n\n- \`${term}Term 3 (EL2008) › Channel 2 › Output\``);
  // A struct and an array: the links of their members and elements.
  assert.equal(hover('GVL_IO', 'stDrive'), [
    '**I/O** · Demo.tsproj', '',
    `- \`.bFault\` → \`${term}Term 2 (EL1008) › Channel 4 › Input\``,
    `- \`.bReady\` → \`${term}Term 2 (EL1008) › Channel 3 › Input\``,
  ].join('\n'));
  assert.match(hover('GVL_IO', 'aLamps')!, /^- `\[1\]` → `.*Channel 3 › Output`\n- `\[2\]` → `.*Channel 4 › Output`$/m);
  // Left unlinked on purpose; the process image of the last build has it.
  assert.equal(hover('GVL_IO', 'bSpareOut'), '**I/O** · Demo.tsproj\n\nNot linked.');
  // No address, or in a GVL of DemoLib, which no task runs and nothing links: no I/O to tell.
  assert.equal(hover('GVL_Parameters', 'fMaxSpeed'), undefined);
  assert.equal(hover('GVL_DemoLib', gvl('GVL_DemoLib').vars[0].name), undefined);
});

test('samples/Demo: a GVL variable AT %I* added since the last build is not linked yet, and says so', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sample-copy-'));
  try {
    fs.cpSync(SAMPLE, copy, { recursive: true });
    const file = path.join(copy, 'Demo', 'Machine', 'GVLs', 'GVL_IO.TcGVL');
    const { text, bom } = decodeBytes(fs.readFileSync(file));
    fs.writeFileSync(file, encodeText(text.replace('VAR_GLOBAL', 'VAR_GLOBAL\r\n\tbNewSensor\tAT %I*\t: BOOL;'), bom));
    const ws = new TcWorkspace();
    ws.load(findFiles(copy, '.tsproj'));
    const index = new LanguageIndex(ws);
    const gvl = index.allGlobals().find((g): g is GvlSym => g.kind === 'gvl' && g.name === 'GVL_IO')!;
    assert.match(ioLinkHover(ws, index, gvl.vars.find(v => v.name === 'bNewSensor')!)!, /^\*\*I\/O\*\* · Demo\.tsproj\n\nNot linked\. The last build in TwinCAT XAE did not have this variable/);
    // Without <Mappings> the project's I/O is not known: nothing is said, not even "not linked".
    const tsproj = path.join(copy, 'Demo', 'Demo.tsproj');
    fs.writeFileSync(tsproj, fs.readFileSync(tsproj, 'utf8').replace(/<Mappings>[\s\S]*<\/Mappings>/, ''));
    ws.load(findFiles(copy, '.tsproj'));
    const bareIndex = new LanguageIndex(ws);
    const bare = bareIndex.allGlobals().find((g): g is GvlSym => g.kind === 'gvl' && g.name === 'GVL_IO')!;
    assert.equal(ioLinkHover(ws, bareIndex, bare.vars.find(v => v.name === 'bStartButton')!), undefined);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('samples/Demo: the hover of a variable AT %I* of a function block tells the links of each of its instances', () => {
  const ws = load();
  const index = new LanguageIndex(ws);
  const fb = index.allGlobals().find((g): g is PouSym => g.kind === 'pou' && g.name === 'FB_Sensor')!;
  assert.equal(ioLinkHover(ws, index, fb.vars.find(v => v.name === 'bSignal')!), [
    '**I/O** · Demo.tsproj', '',
    '- `MAIN.fbSensorLeft.bSignal` → `Device 1 (EtherCAT) › Term 1 (EK1100) › Term 2 (EL1008) › Channel 2 › Input`',
    '- `MAIN.fbSensorRight.bSignal`: not linked',
  ].join('\n'));
  // A variable of the function block without an address has no I/O.
  assert.equal(ioLinkHover(ws, index, fb.vars.find(v => v.name === 'bActive')!), undefined);
});

test('samples/Demo: instances of a function block in an array of a GVL and in a program, each path checked against the declarations', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sample-copy-'));
  try {
    fs.cpSync(SAMPLE, copy, { recursive: true });
    const edit = (rel: string, change: (t: string) => string) => {
      const file = path.join(copy, 'Demo', ...rel.split('/'));
      const { text, bom } = decodeBytes(fs.readFileSync(file));
      fs.writeFileSync(file, encodeText(change(text), bom));
    };
    edit('Machine/GVLs/GVL_IO.TcGVL', t => t.replace('VAR_GLOBAL', 'VAR_GLOBAL\r\n\taSensors\t: ARRAY[1..2] OF FB_Sensor;'));
    edit('Machine/POUs/MAIN.TcPOU', t => t.replace('VAR', 'VAR\r\n\tbLocal\tAT %I*\t: BOOL;'));
    // As a build would list them, with a path that ends in bSignal but is no FB_Sensor (FB_Conveyor has none).
    const vars = ['GVL_IO.aSensors[1].bSignal', 'GVL_IO.aSensors[2].bSignal', 'MAIN.fbConveyor.bSignal', 'MAIN.bLocal']
      .map(n => `\t\t\t\t\t\t<Var>\r\n\t\t\t\t\t\t\t<Name>${n}</Name>\r\n\t\t\t\t\t\t\t<Type>BOOL</Type>\r\n\t\t\t\t\t\t</Var>\r\n`).join('');
    edit('Demo.tsproj', t => t
      .replace(/(<Name>PlcTask Inputs<\/Name>\r\n)/, `$1${vars}`)
      .replace('<Link VarA="PlcTask Inputs^GVL_IO.bStartButton"', '<Link VarA="PlcTask Inputs^GVL_IO.aSensors[2].bSignal" VarB="Channel 5^Input"/>\r\n\t\t\t\t<Link VarA="PlcTask Inputs^GVL_IO.bStartButton"'));
    const ws = new TcWorkspace();
    ws.load(findFiles(copy, '.tsproj'));
    const index = new LanguageIndex(ws);
    const pou = (name: string) => index.allGlobals().find((g): g is PouSym => g.kind === 'pou' && g.name === name)!;
    assert.equal(ioLinkHover(ws, index, pou('FB_Sensor').vars.find(v => v.name === 'bSignal')!), [
      '**I/O** · Demo.tsproj', '',
      '- `GVL_IO.aSensors[1].bSignal`: not linked',
      '- `GVL_IO.aSensors[2].bSignal` → `Device 1 (EtherCAT) › Term 1 (EK1100) › Term 2 (EL1008) › Channel 5 › Input`',
      '- `MAIN.fbSensorLeft.bSignal` → `Device 1 (EtherCAT) › Term 1 (EK1100) › Term 2 (EL1008) › Channel 2 › Input`',
      '- `MAIN.fbSensorRight.bSignal`: not linked',
    ].join('\n'));
    // A variable of a program is one variable of the process image, as one of a GVL.
    assert.equal(ioLinkHover(ws, index, pou('MAIN').vars.find(v => v.name === 'bLocal')!), '**I/O** · Demo.tsproj\n\nNot linked.');
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

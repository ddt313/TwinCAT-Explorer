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
import { PouSym } from '../../src/lang/symbols';
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

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../../src/lang/analyzer';
import { LanguageIndex } from '../../src/lang/index';
import {
  RenamePlan, changesElsewhere, objectKey, planFiles, planObjects, planRename, relatedMembers, renameConflicts, renameTargetAt, renameTexts,
  symbolNameProblem,
} from '../../src/lang/rename';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { MemberSym, Sym, TypeSym, VarSym } from '../../src/lang/symbols';
import { SpliceError, blankTrivia } from '../../src/core/splice';
import { encodeText, parseTcFile } from '../../src/core/tcfile';
import { TcWorkspace, fileKey } from '../../src/core/workspace';

const guid = (n: number) => `{eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}}`;

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

const accessor = (kind: 'Get' | 'Set', n: number, st?: string) => `
      <${kind} Name="${kind}" Id="${guid(n)}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>${st === undefined ? '' : impl(st, '        ')}
      </${kind}>`;

const property = (name: string, n: number, decl: string, accessors: string) => `
    <Property Name="${name}" Id="${guid(n)}">
      <Declaration><![CDATA[${decl}]]></Declaration>${accessors}
    </Property>`;

const lineIds = (...names: string[]) => names.map(name => `
    <LineIds Name="${name}">
      <LineId Id="3" Count="0" />
    </LineIds>`).join('');

const pou = (name: string, n: number, decl: string, st: string, members = '') => object(`  <POU Name="${name}" Id="${guid(n)}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>${impl(st)}${members}
  </POU>`);

const FILES: Record<string, string> = {
  'POUs/FB_Pump.TcPOU': pou('FB_Pump', 1, `// FB_Pump: a pump
FUNCTION_BLOCK FB_Pump IMPLEMENTS I_Pump
VAR_INPUT
	nSpeed : INT; // in rpm
END_VAR
VAR
	pSelf : POINTER TO FB_Pump;
END_VAR
`, `pSelf := ADR(THIS^);
IF THIS^.M_Start(fSpeed := 0.5) THEN
	nSpeed := 0;
END_IF`,
  method('M_Start', 2, 'METHOD M_Start : BOOL\nVAR_INPUT\n\tfSpeed : LREAL;\nEND_VAR\n', 'M_Start := nSpeed > 0 AND fSpeed > 0;')
  + property('P_Speed', 3, 'PROPERTY P_Speed : INT', accessor('Get', 4, 'P_Speed := nSpeed;') + accessor('Set', 5, 'nSpeed := P_Speed;'))
  + lineIds('FB_Pump', 'FB_Pump.M_Start', 'FB_Pump.P_Speed.Get', 'FB_Pump.P_Speed.Set')),
  'POUs/FB_PumpEx.TcPOU': pou('FB_PumpEx', 10, `FUNCTION_BLOCK FB_PumpEx EXTENDS FB_Pump
VAR
	fbInner : FB_Pump;
END_VAR
`, `SUPER^.M_Start(fSpeed := 1.0);
THIS^.M_Start(fSpeed := 2.0);
fbInner(nSpeed := 3);`,
  method('M_Start', 11, 'METHOD M_Start : BOOL\nVAR_INPUT\n\tfSpeed : LREAL;\nEND_VAR\n', 'M_Start := SUPER^.M_Start(fSpeed := fSpeed);')),
  'POUs/I_Pump.TcIO': object(`  <Itf Name="I_Pump" Id="${guid(20)}">
    <Declaration><![CDATA[INTERFACE I_Pump
]]></Declaration>${method('M_Start', 21, 'METHOD M_Start : BOOL\nVAR_INPUT\n\tfSpeed : LREAL;\nEND_VAR\n')}${property('P_Speed', 22, 'PROPERTY P_Speed : INT', accessor('Get', 23))}
  </Itf>`),
  'POUs/MAIN.TcPOU': pou('MAIN', 30, `PROGRAM MAIN
VAR
	fbPump : FB_Pump;
	aPumps : ARRAY[0..1] OF FB_Pump;
	ipPump : I_Pump;
	bOk : BOOL;
	nRate : INT;
	stData : ST_Data := (nId := 7);
	eState : E_State := E_State.Idle;
	fbUnknown : FB_Missing;
	sName : STRING := 'FB_Pump';
END_VAR
`, `fbPump(nSpeed := 5);
bOk := fbPump.M_Start(fSpeed := 2.0);
nRate := fbPump.P_Speed;
fbPump.nSpeed := nRate;
ipPump := fbPump;
bOk := ipPump.M_Start(fSpeed := 1.0) AND ipPump.P_Speed > 0;
GVL_Main.fbShared.M_Start(fSpeed := 0.1);
fbUnknown.M_Start(); // FB_Missing has no source: M_Start is not resolved
stData.nId := stData.fbPump.P_Speed;
(* FB_Pump in a comment stays *)
IF eState = E_State.Running THEN
	eState := E_State#Idle;
END_IF`),
  'GVLs/GVL_Main.TcGVL': object(`  <GVL Name="GVL_Main" Id="${guid(40)}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
VAR_GLOBAL
	fbShared : FB_Pump;
END_VAR
]]></Declaration>
  </GVL>`),
  'DUTs/ST_Data.TcDUT': object(`  <DUT Name="ST_Data" Id="${guid(50)}">
    <Declaration><![CDATA[TYPE ST_Data :
STRUCT
	nId : INT;
	fbPump : FB_Pump;
END_STRUCT
END_TYPE
]]></Declaration>
  </DUT>`),
  'DUTs/E_State.TcDUT': object(`  <DUT Name="E_State" Id="${guid(60)}">
    <Declaration><![CDATA[TYPE E_State :
(
	Idle := 0,
	Running
);
END_TYPE
]]></Declaration>
  </DUT>`),
  // A program in CFC, which the language index does not read.
  'POUs/PRG_Cfc.TcPOU': object(`  <POU Name="PRG_Cfc" Id="${guid(70)}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM PRG_Cfc
VAR
	fbPump : FB_Pump;
END_VAR
]]></Declaration>
    <Implementation>
      <CFC>
        <Box Id="1" Name="fbPump" Type="FB_Pump" />
      </CFC>
    </Implementation>
  </POU>`),
};

/** A workspace of the files above (one with CRLF and a BOM), with its index. */
function project(overrides: Record<string, string> = {}): { root: string; ws: TcWorkspace; index: LanguageIndex; file: (rel: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-rename-'));
  const write = (rel: string, text: string | Uint8Array) => {
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
  for (const [rel, text] of Object.entries(files)) {
    // GVL_Main as XAE writes it: CRLF and a BOM.
    write(`A/Plc/${rel}`, rel.startsWith('GVLs') ? encodeText(text.replace(/\n/g, '\r\n'), true) : text);
  }
  const ws = new TcWorkspace();
  ws.load([path.join(root, 'A/A.tsproj')]);
  const index = new LanguageIndex(ws);
  index.setStubs(BUNDLED_STUBS);
  return { root, ws, index, file: rel => path.join(root, 'A/Plc', rel) };
}

/** The symbol declared at the first `word` of a section of a file (`decl` or `impl` of the object with this GUID). */
function declared(index: LanguageIndex, filePath: string, n: number, role: 'decl' | 'impl', word: string): Sym {
  const key = `${guid(n).replace(/[{}]/g, '')}:${role}`;
  const ctx = index.context(fileKey(filePath), key)!;
  const text = index.sectionText(fileKey(filePath), key)!;
  const offset = new RegExp(`\\b${word}\\b`).exec(blankTrivia(text))!.index;
  const target = renameTargetAt(analyze(index, ctx, text), offset);
  assert.ok('sym' in target, `${word}: ${'problem' in target ? target.problem : ''}`);
  return target.sym;
}

/** Each file the rename writes, as a list of the changes from the text it had: [old, new] pairs, in order. */
function changes(before: string, after: string): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    // A changed name: up to the end of the identifier on both sides.
    let si = i;
    let sj = j;
    while (si > 0 && /\w/.test(before[si - 1])) si--;
    while (sj > 0 && /\w/.test(after[sj - 1])) sj--;
    let ei = i;
    let ej = j;
    while (ei < before.length && /\w/.test(before[ei])) ei++;
    while (ej < after.length && /\w/.test(after[ej])) ej++;
    out.push(`${before.slice(si, ei)} -> ${after.slice(sj, ej)}`);
    i = ei;
    j = ej;
  }
  return out;
}

/** The changes a rename makes, file by file (relative paths), checked with what the plan says. */
function written(plan: RenamePlan, root: string, leaveOut?: Set<string>): Record<string, string[]> {
  const texts = renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)), leaveOut);
  assert.deepEqual([...texts.values()].map(f => f.filePath).sort(), planFiles(plan, leaveOut).sort());
  const out: Record<string, string[]> = {};
  for (const f of texts.values()) {
    const before = parseTcFile(f.filePath, fs.readFileSync(f.filePath));
    assert.equal(f.bom, before.bom);
    out[path.relative(path.join(root, 'A/Plc'), f.filePath).replace(/\\/g, '/')] = changes(before.text, f.text);
  }
  return out;
}

test('a renamed function block: its file, and the declarations, EXTENDS and types that use it elsewhere', () => {
  const { root, index, file } = project();
  try {
    const fb = declared(index, file('POUs/FB_Pump.TcPOU'), 1, 'decl', 'FB_Pump');
    assert.equal(fb.kind, 'pou');
    const plan = planRename(index, [fb], 'FB_Motor');
    assert.deepEqual(planObjects(plan).map(o => `${o.label}: ${o.changes} (${o.line})`), [
      'FB_Pump: 1 (pSelf : POINTER TO FB_Pump;)',
      'FB_PumpEx: 2 (FUNCTION_BLOCK FB_PumpEx EXTENDS FB_Pump)',
      'MAIN: 2 (fbPump : FB_Pump;)',
      'GVL_Main: 1 (fbShared : FB_Pump;)',
      'ST_Data: 1 (fbPump : FB_Pump;)',
      'PRG_Cfc: 1 (fbPump : FB_Pump;)',
    ]);
    // Not THIS^ and SUPER^, the comments, the string, nor the name in the CFC, which is said to be not read.
    assert.deepEqual(plan.unresolved, []);
    assert.deepEqual(plan.unread.map(u => `${u.object} ${u.language}`), ['PRG_Cfc CFC']);
    assert.deepEqual(written(plan, root), {
      'POUs/FB_Pump.TcPOU': ['FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor',
        'FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor'],
      'POUs/FB_PumpEx.TcPOU': ['FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor'],
      'POUs/MAIN.TcPOU': ['FB_Pump -> FB_Motor', 'FB_Pump -> FB_Motor'],
      'GVLs/GVL_Main.TcGVL': ['FB_Pump -> FB_Motor'],
      'DUTs/ST_Data.TcDUT': ['FB_Pump -> FB_Motor'],
      'POUs/PRG_Cfc.TcPOU': ['FB_Pump -> FB_Motor'],
    });
    const texts = renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)));
    const pump = texts.get(fileKey(file('POUs/FB_Pump.TcPOU')))!.text;
    // Its Name, header, own use and LineIds; the comment before the header stays.
    assert.match(pump, /<POU Name="FB_Motor"/);
    assert.match(pump, /\/\/ FB_Pump: a pump\nFUNCTION_BLOCK FB_Motor IMPLEMENTS I_Pump/);
    assert.match(pump, /pSelf : POINTER TO FB_Motor;/);
    assert.match(pump, /<LineIds Name="FB_Motor.P_Speed.Set">/);
    // CRLF and the BOM of GVL_Main stay.
    const gvl = texts.get(fileKey(file('GVLs/GVL_Main.TcGVL')))!;
    assert.equal(gvl.text, fs.readFileSync(file('GVLs/GVL_Main.TcGVL')).toString('utf8').slice(1).replace('fbShared : FB_Pump;', 'fbShared : FB_Motor;'));
    assert.deepEqual(renameConflicts(index, plan, texts), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a renamed method: its calls, through THIS^, SUPER^, an instance, an interface and a GVL, and the members that implement or override it', () => {
  const { root, index, file } = project();
  try {
    const start = declared(index, file('POUs/FB_Pump.TcPOU'), 2, 'decl', 'M_Start') as MemberSym;
    const related = relatedMembers(index, start);
    assert.deepEqual(related.members.map(m => `${m.owner.name}.${m.name}`).sort(), ['FB_PumpEx.M_Start', 'I_Pump.M_Start']);
    assert.deepEqual(related.library, []);
    // From the interface, the same family.
    const itf = declared(index, file('POUs/I_Pump.TcIO'), 21, 'decl', 'M_Start') as MemberSym;
    assert.deepEqual(relatedMembers(index, itf).members.map(m => `${m.owner.name}.${m.name}`).sort(), ['FB_Pump.M_Start', 'FB_PumpEx.M_Start']);

    const plan = planRename(index, [start, ...related.members], 'M_Begin');
    assert.deepEqual(plan.declarations.map(d => path.basename(d.filePath)).sort(), ['FB_Pump.TcPOU', 'FB_PumpEx.TcPOU', 'I_Pump.TcIO']);
    assert.deepEqual(planObjects(plan).map(o => `${o.label}: ${o.changes}`), ['FB_Pump: 1', 'FB_PumpEx: 2', 'FB_PumpEx.M_Start: 1', 'MAIN: 3']);
    // The call on an instance of a function block without source is not resolved.
    assert.deepEqual(plan.unresolved.map(u => index.sectionText(u.fileKey, u.sectionKey)!.slice(u.start - 10, u.end + 2)), ['fbUnknown.M_Start()']);
    assert.deepEqual(written(plan, root), {
      // Its Name, header, return value and LineIds; the call through THIS^.
      'POUs/FB_Pump.TcPOU': ['M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin'],
      // SUPER^ and THIS^ in the body, the override's Name, header, return value and its call of SUPER^.
      'POUs/FB_PumpEx.TcPOU': ['M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin',
        'M_Start -> M_Begin'],
      'POUs/I_Pump.TcIO': ['M_Start -> M_Begin', 'M_Start -> M_Begin'],
      'POUs/MAIN.TcPOU': ['M_Start -> M_Begin', 'M_Start -> M_Begin', 'M_Start -> M_Begin'],
    });
    const texts = renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)));
    assert.match(texts.get(fileKey(file('POUs/MAIN.TcPOU')))!.text,
      /bOk := fbPump\.M_Begin\(fSpeed := 2\.0\);[\s\S]*ipPump\.M_Begin\(fSpeed := 1\.0\)[\s\S]*GVL_Main\.fbShared\.M_Begin\(fSpeed := 0\.1\);\nfbUnknown\.M_Start\(\);/);
    assert.match(texts.get(fileKey(file('POUs/FB_PumpEx.TcPOU')))!.text, /M_Begin := SUPER\^\.M_Begin\(fSpeed := fSpeed\);/);
    assert.deepEqual(renameConflicts(index, plan, texts), []);

    // Without the members that go with it, the interface's stays and calls through it keep the name.
    const alone = planRename(index, [start], 'M_Begin');
    assert.deepEqual(planObjects(alone).map(o => `${o.label}: ${o.changes}`), ['FB_Pump: 1', 'FB_PumpEx: 1', 'FB_PumpEx.M_Start: 1', 'MAIN: 2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a renamed input: its declaration, its uses inside, as a named parameter and as a member', () => {
  const { root, index, file } = project();
  try {
    const speed = declared(index, file('POUs/FB_Pump.TcPOU'), 1, 'decl', 'nSpeed') as VarSym;
    assert.equal(speed.kind, 'var');
    // MAIN has an nRate of its own: fbPump.nRate is the input, nRate MAIN's.
    const plan = planRename(index, [speed], 'nRate');
    assert.deepEqual(plan.declarations, []);
    assert.deepEqual(planObjects(plan).map(o => `${o.label}: ${o.changes}`),
      ['FB_Pump: 2', 'FB_Pump.M_Start: 1', 'FB_Pump.P_Speed.Get: 1', 'FB_Pump.P_Speed.Set: 1', 'FB_PumpEx: 1', 'MAIN: 2']);
    assert.deepEqual(written(plan, root), {
      'POUs/FB_Pump.TcPOU': ['nSpeed -> nRate', 'nSpeed -> nRate', 'nSpeed -> nRate', 'nSpeed -> nRate', 'nSpeed -> nRate'],
      'POUs/FB_PumpEx.TcPOU': ['nSpeed -> nRate'],
      'POUs/MAIN.TcPOU': ['nSpeed -> nRate', 'nSpeed -> nRate'],
    });
    const texts = renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)));
    assert.match(texts.get(fileKey(file('POUs/MAIN.TcPOU')))!.text, /fbPump\(nRate := 5\);[\s\S]*fbPump\.nRate := nRate;/);
    assert.deepEqual(renameConflicts(index, plan, texts), []);

    // fSpeed, the input of M_Start, would hide it there: its use in M_Start would mean the other one.
    assert.equal(symbolNameProblem(index, speed, 'fSpeed'), undefined);
    const hidden = planRename(index, [speed], 'fSpeed');
    const conflicts = renameConflicts(index, hidden, renameTexts(hidden, p => parseTcFile(p, fs.readFileSync(p))));
    assert.deepEqual(conflicts.map(c => `${index.context(c.loc.fileKey, c.loc.sectionKey)!.object.qualifiedName}: ${c.message}`),
      ['FB_Pump.M_Start: would refer to FB_Pump.M_Start.fSpeed instead of FB_Pump.nSpeed']);

    // Names declared next to it, in what it extends and what extends it.
    assert.equal(symbolNameProblem(index, speed, 'PSELF'), 'FB_Pump already has pSelf');
    assert.equal(symbolNameProblem(index, speed, 'm_start'), 'FB_Pump already has M_Start');
    assert.equal(symbolNameProblem(index, speed, 'fbInner'), 'FB_PumpEx already has fbInner');
    assert.equal(symbolNameProblem(index, speed, 'NSPEED'), undefined, 'its own name in another case');
    assert.equal(symbolNameProblem(index, speed, 'IF'), 'IF is a keyword');
    assert.match(symbolNameProblem(index, speed, '1x') ?? '', /not an identifier/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a renamed DUT field and enum value, and a renamed GVL', () => {
  const { root, index, file } = project();
  try {
    const id = declared(index, file('DUTs/ST_Data.TcDUT'), 50, 'decl', 'nId') as VarSym;
    assert.equal((id.owner as TypeSym).name, 'ST_Data');
    // The field, its initial value in MAIN, its use.
    assert.deepEqual(written(planRename(index, [id], 'nIndex'), root), {
      'DUTs/ST_Data.TcDUT': ['nId -> nIndex'],
      'POUs/MAIN.TcPOU': ['nId -> nIndex', 'nId -> nIndex'],
    });
    assert.equal(symbolNameProblem(index, id, 'fbPump'), 'ST_Data already has fbPump');

    const idle = declared(index, file('DUTs/E_State.TcDUT'), 60, 'decl', 'Idle');
    assert.equal(idle.kind, 'enumValue');
    // E_State.Idle and E_State#Idle.
    const plan = planRename(index, [idle], 'Stopped');
    assert.deepEqual(written(plan, root), { 'DUTs/E_State.TcDUT': ['Idle -> Stopped'], 'POUs/MAIN.TcPOU': ['Idle -> Stopped', 'Idle -> Stopped'] });
    assert.deepEqual(renameConflicts(index, plan, renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)))), []);
    assert.equal(symbolNameProblem(index, idle as never, 'running'), 'E_State already has Running');

    // A GVL: the name that qualifies its variables.
    const gvl = index.context(fileKey(file('GVLs/GVL_Main.TcGVL')), `${guid(40).replace(/[{}]/g, '')}:decl`)!.gvl!;
    const renamed = planRename(index, [gvl], 'GVL_Cell');
    assert.deepEqual(written(renamed, root), { 'GVLs/GVL_Main.TcGVL': ['GVL_Main -> GVL_Cell'], 'POUs/MAIN.TcPOU': ['GVL_Main -> GVL_Cell'] });
    assert.deepEqual(renameConflicts(index, renamed, renameTexts(renamed, p => parseTcFile(p, fs.readFileSync(p)))), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('objects left out keep the old name; a section changed since the plan is refused; what cannot be renamed', () => {
  const { root, index, file } = project();
  try {
    const fb = declared(index, file('POUs/FB_Pump.TcPOU'), 1, 'decl', 'FB_Pump');
    const plan = planRename(index, [fb], 'FB_Motor');
    const leaveOut = new Set(plan.sections.filter(s => s.object.qualifiedName === 'MAIN').map(objectKey));
    const out = written(plan, root, leaveOut);
    assert.equal(out['POUs/MAIN.TcPOU'], undefined);
    assert.deepEqual(Object.keys(out).sort(), ['DUTs/ST_Data.TcDUT', 'GVLs/GVL_Main.TcGVL', 'POUs/FB_Pump.TcPOU', 'POUs/FB_PumpEx.TcPOU', 'POUs/PRG_Cfc.TcPOU']);
    // What MAIN then no longer finds is what leaving it out does, not a conflict.
    assert.deepEqual(renameConflicts(index, plan, renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)), leaveOut), leaveOut), []);

    // MAIN changed on disk after the plan was made.
    const main = file('POUs/MAIN.TcPOU');
    fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('fbPump : FB_Pump;', 'fbPump : FB_Pump; // changed'));
    assert.throws(() => renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p))), (e: Error) => e instanceof SpliceError && /MAIN \(Declaration\)/.test(e.message));

    // THIS, a library function block, a built-in function and a keyword.
    const ctxKey = `${guid(1).replace(/[{}]/g, '')}:impl`;
    const ctx = index.context(fileKey(file('POUs/FB_Pump.TcPOU')), ctxKey)!;
    const text = index.sectionText(ctx.fileKey, ctxKey)!;
    const at = (word: string) => renameTargetAt(analyze(index, ctx, text), text.indexOf(word));
    assert.deepEqual(at('THIS^.M_Start'), { problem: 'THIS cannot be renamed.' });
    assert.deepEqual(at('ADR'), { problem: 'ADR is built in.' });
    assert.deepEqual(at('IF'), { problem: 'Only a name the language index resolves can be renamed here.' });
    assert.equal((at('M_Start(') as { sym: Sym }).sym.kind, 'method');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a function and its return value, a program and its calls, an interface and the properties that go with one', () => {
  const extra = {
    'POUs/F_Scale.TcPOU': pou('F_Scale', 80, `FUNCTION F_Scale : LREAL
VAR_INPUT
	fIn : LREAL;
END_VAR
`, `F_Scale := fIn * 2;
IF F_Scale > 100 THEN
	F_Scale := 100;
END_IF`),
    'POUs/PRG_Cell.TcPOU': pou('PRG_Cell', 90, `PROGRAM PRG_Cell
VAR
	fOut : LREAL;
END_VAR
`, `MAIN();
fOut := F_Scale(fIn := MAIN.fbPump.P_Speed) + F_Scale(1);`),
    // A visualization, which the language index does not read.
    'VISUs/Visu.TcVIS': object(`  <Visu Name="Visu" Id="${guid(95)}">
    <Element Variable="MAIN.fbPump.P_Speed" />
  </Visu>`),
  };
  const { root, index, file } = project(extra);
  try {
    const scale = declared(index, file('POUs/F_Scale.TcPOU'), 80, 'decl', 'F_Scale');
    const plan = planRename(index, [scale], 'F_Double');
    // Its return value changes with it (renameObject); the calls with their named parameter elsewhere.
    assert.deepEqual(written(plan, root), {
      'POUs/F_Scale.TcPOU': ['F_Scale -> F_Double', 'F_Scale -> F_Double', 'F_Scale -> F_Double', 'F_Scale -> F_Double', 'F_Scale -> F_Double'],
      'POUs/PRG_Cell.TcPOU': ['F_Scale -> F_Double', 'F_Scale -> F_Double'],
    });
    assert.deepEqual(renameConflicts(index, plan, renameTexts(plan, p => parseTcFile(p, fs.readFileSync(p)))), []);

    const main = declared(index, file('POUs/MAIN.TcPOU'), 30, 'decl', 'MAIN');
    const cell = planRename(index, [main], 'MAIN_Cell');
    assert.deepEqual(written(cell, root), {
      'POUs/MAIN.TcPOU': ['MAIN -> MAIN_Cell', 'MAIN -> MAIN_Cell'],
      'POUs/PRG_Cell.TcPOU': ['MAIN -> MAIN_Cell', 'MAIN -> MAIN_Cell'],
    });
    assert.deepEqual(cell.unread.map(u => path.basename(u.filePath)), ['Visu.TcVIS']);

    const itf = declared(index, file('POUs/I_Pump.TcIO'), 20, 'decl', 'I_Pump');
    assert.deepEqual(written(planRename(index, [itf], 'I_Device'), root), {
      'POUs/I_Pump.TcIO': ['I_Pump -> I_Device', 'I_Pump -> I_Device'],
      'POUs/FB_Pump.TcPOU': ['I_Pump -> I_Device'],
      'POUs/MAIN.TcPOU': ['I_Pump -> I_Device'],
    });

    // A property of the interface: the function block's goes with it, and the uses of both.
    const speed = declared(index, file('POUs/I_Pump.TcIO'), 22, 'decl', 'P_Speed') as MemberSym;
    const related = relatedMembers(index, speed).members;
    assert.deepEqual(related.map(m => `${m.owner.name}.${m.name}`), ['FB_Pump.P_Speed']);
    const rate = planRename(index, [speed, ...related], 'P_Rate');
    assert.deepEqual(planObjects(rate).map(o => `${o.label}: ${o.changes}`), ['MAIN: 3', 'PRG_Cell: 1']);
    assert.deepEqual(written(rate, root), {
      'POUs/I_Pump.TcIO': ['P_Speed -> P_Rate', 'P_Speed -> P_Rate'],
      // Its Name, header, its value in Get and Set, and the LineIds of both.
      'POUs/FB_Pump.TcPOU': ['P_Speed -> P_Rate', 'P_Speed -> P_Rate', 'P_Speed -> P_Rate', 'P_Speed -> P_Rate', 'P_Speed -> P_Rate', 'P_Speed -> P_Rate'],
      'POUs/MAIN.TcPOU': ['P_Speed -> P_Rate', 'P_Speed -> P_Rate', 'P_Speed -> P_Rate'],
      'POUs/PRG_Cell.TcPOU': ['P_Speed -> P_Rate'],
    });
    assert.deepEqual(rate.unread.map(u => path.basename(u.filePath)), ['Visu.TcVIS']);
    assert.deepEqual(renameConflicts(index, rate, renameTexts(rate, p => parseTcFile(p, fs.readFileSync(p)))), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symbol of an index built again is found where it is declared; what changes outside what declares it', () => {
  const { root, ws, index, file } = project();
  try {
    const pumpPath = file('POUs/FB_Pump.TcPOU');
    const speed = declared(index, pumpPath, 1, 'decl', 'nSpeed');
    // The file read again: the index has new symbols for it.
    ws.invalidate(pumpPath);
    index.invalidateFile(pumpPath);
    assert.notEqual(declared(index, pumpPath, 1, 'decl', 'nSpeed'), speed);
    const plan = planRename(index, [speed], 'nRate');
    assert.equal(plan.symbols[0], declared(index, pumpPath, 1, 'decl', 'nSpeed'));
    assert.equal(planObjects(plan).length, 6);

    // A local variable used in its own object only changes nothing elsewhere; an input does.
    const pSelf = declared(index, pumpPath, 1, 'decl', 'pSelf');
    assert.equal(changesElsewhere(planRename(index, [pSelf], 'pMe')), false);
    assert.equal(changesElsewhere(plan), true);
    const start = declared(index, pumpPath, 2, 'decl', 'M_Start');
    assert.equal(changesElsewhere(planRename(index, [start], 'M_Begin')), true, 'called in the body of the function block');

    // Moved away in its file, it is no longer found.
    fs.writeFileSync(pumpPath, fs.readFileSync(pumpPath, 'utf8').replace('VAR_INPUT\n\tnSpeed', 'VAR_INPUT\n\tnOther : INT;\n\tnSpeed'));
    ws.invalidate(pumpPath);
    index.invalidateFile(pumpPath);
    assert.throws(() => planRename(index, [speed], 'nRate'), /no longer where it was declared/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

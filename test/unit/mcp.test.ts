import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session } from '../../src/mcp/session';
import { UndoLog } from '../../src/mcp/undo';
import * as T from '../../src/mcp/tools';

const HEAD = '<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">';

const FILES: Record<string, string> = {
  'POUs/FB_Valve.TcPOU': `${HEAD}
  <POU Name="FB_Valve" Id="{11111111-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Valve
VAR_INPUT
	bOpen : BOOL;
END_VAR
VAR
	nCount : INT;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[IF bOpen THEN
	nCount := nCount + 1;
END_IF
]]></ST>
    </Implementation>
    <Method Name="M_Close" Id="{11111111-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD M_Close : BOOL
]]></Declaration>
      <Implementation>
        <ST><![CDATA[nCount := 0;
M_Close := TRUE;
]]></ST>
      </Implementation>
    </Method>
  </POU>
</TcPlcObject>`.replace(/\n/g, '\r\n'),
  'POUs/MAIN.TcPOU': `${HEAD}
  <POU Name="MAIN" Id="{11111111-0000-0000-0000-000000000003}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
	fbValve : FB_Valve;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[fbValve(bOpen := TRUE);
fbValve.M_Close();
]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`.replace(/\n/g, '\r\n'),
};

/** Runs a test on a PLC project `Plc` with FB_Valve (and its method M_Close) and MAIN, in a folder of its own. */
function withTools(run: (t: T.Tools, root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-mcp-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
    write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${Object.keys(FILES).map(f => `
    <Compile Include="${f.replace('/', '\\')}">
      <SubType>Code</SubType>
    </Compile>`).join('')}
  </ItemGroup>
</Project>`);
    for (const [rel, text] of Object.entries(FILES)) write(`A/Plc/${rel}`, text);
    const t: T.Tools = { session: new Session(root), undo: new UndoLog(root, path.join(root, 'undo.jsonl')) };
    t.session.refresh();
    run(t, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const hashOf = (out: string, part: 'decl' | 'impl') => new RegExp(`── ${part} · hash (\\w+)`).exec(out)![1];

test('lists the objects and reads a method with line numbers and a hash', () => withTools(t => {
  const list = T.objects(t, {});
  assert.match(list, /^FB_Valve \(FB\)  POUs$/m);
  assert.match(list, /^  FB_Valve\.M_Close \(method\)$/m);
  assert.match(list, /^MAIN \(PRG\)  POUs$/m);
  const out = T.read(t, { object: 'fb_valve.m_close' });
  assert.match(out, /^FB_Valve\.M_Close \(method\)/);
  assert.match(out, /── impl · hash \w{12} · 2 lines\n1  nCount := 0;\n2  M_Close := TRUE;/);
  assert.throws(() => T.read(t, { object: 'FB_Pump' }), /No TwinCAT object 'FB_Pump'/);
}));

test('finds definitions and references by name and by a word of a line', () => withTools(t => {
  assert.match(T.definition(t, { symbol: 'FB_Valve.nCount' }), /nCount : INT[\s\S]*Declared at FB_Valve decl:6/);
  assert.match(T.definition(t, { object: 'MAIN', part: 'impl', line: 2, word: 'M_Close' }), /^FB_Valve\.M_Close — Method of FB_Valve/);
  const refs = T.references(t, { symbol: 'FB_Valve.M_Close' });
  assert.match(refs, /MAIN impl:2  fbValve\.M_Close\(\);/);
  assert.match(T.findSymbol(t, { query: 'fbv' }), /^FB_Valve  — Function block in Plc/m);
}));

test('edit_section saves only that section, keeps CRLF, reports problems, and undo takes it back', () => withTools((t, root) => {
  const file = path.join(root, 'A/Plc/POUs/FB_Valve.TcPOU');
  const before = fs.readFileSync(file, 'utf8');
  const hash = hashOf(T.read(t, { object: 'FB_Valve' }), 'impl');
  const out = T.editSection(t, { object: 'FB_Valve', part: 'impl', oldText: 'nCount + 1', newText: 'nCount + nStep', hash });
  assert.match(out, /-\tnCount := nCount \+ 1;\n\+\tnCount := nCount \+ nStep;/);
  assert.match(out, /Problems now:\nFB_Valve impl:2  error: .*nStep/);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before.replace('nCount + 1', 'nCount + nStep'), 'only the edited text changes, CRLF kept');
  // The old hash no longer fits.
  assert.throws(() => T.writeSection(t, { object: 'FB_Valve', part: 'impl', text: 'x', hash }), /changed since it was read/);
  assert.match(T.undoLastEdit(t, {}), /Undid edit 1: edit_section FB_Valve impl/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.match(T.editHistory(t, {}), /^1 .* edit_section FB_Valve impl  \(undone\)$/m);
}));

test('edits are refused when the anchor is not unique, and a rename through the header', () => withTools(t => {
  assert.throws(() => T.editSection(t, { object: 'FB_Valve', part: 'decl', oldText: 'END_VAR', newText: 'END_VAR ' }), /more than once/);
  assert.throws(() => T.editSection(t, { object: 'FB_Valve', part: 'decl', oldText: 'FUNCTION_BLOCK FB_Valve', newText: 'FUNCTION_BLOCK FB_Pump' }), /renames 'FB_Valve' to 'FB_Pump'/);
}));

test('undo refuses an edit whose section changed since', () => withTools((t, root) => {
  T.editSection(t, { object: 'MAIN', part: 'impl', oldText: 'TRUE', newText: 'FALSE' });
  const file = path.join(root, 'A/Plc/POUs/MAIN.TcPOU');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('fbValve.M_Close();', 'fbValve.M_Close(); // by hand'));
  assert.throws(() => T.undoLastEdit(t, {}), /changed after edit 1/);
}));

test('add_member, add_object and delete_member change the files, and undo restores them', () => withTools((t, root) => {
  const fb = path.join(root, 'A/Plc/POUs/FB_Valve.TcPOU');
  const plcproj = path.join(root, 'A/Plc/Plc.plcproj');
  const fbBefore = fs.readFileSync(fb, 'utf8');
  const plcBefore = fs.readFileSync(plcproj, 'utf8');
  assert.match(T.addMember(t, { owner: 'FB_Valve', kind: 'method', name: 'M_Open', type: 'BOOL' }), /Added method FB_Valve\.M_Open/);
  assert.match(T.read(t, { object: 'FB_Valve.M_Open' }), /METHOD M_Open : BOOL/);
  assert.throws(() => T.addMember(t, { owner: 'FB_Valve', kind: 'method', name: 'm_open' }), /already has a method named M_Open/);
  assert.throws(() => T.deleteMember(t, { object: 'FB_Valve.M_Close', confirm: false }), /needs confirm: true/);
  T.deleteMember(t, { object: 'FB_Valve.M_Close', confirm: true });
  assert.throws(() => T.read(t, { object: 'FB_Valve.M_Close' }), /No TwinCAT object/);
  assert.match(T.addObject(t, { folder: 'POUs/Pumps', kind: 'FB', name: 'FB_Pump' }), /Added FB_Pump \(FB\) as A[\\/]Plc[\\/]POUs[\\/]Pumps[\\/]FB_Pump\.TcPOU/);
  assert.match(fs.readFileSync(plcproj, 'utf8'), /<Compile Include="POUs\\Pumps\\FB_Pump\.TcPOU">/);
  assert.throws(() => T.addObject(t, { kind: 'FB', name: 'fb_pump' }), /already has/);
  for (let i = 0; i < 3; i++) T.undoLastEdit(t, {});
  assert.equal(fs.existsSync(path.join(root, 'A/Plc/POUs/Pumps/FB_Pump.TcPOU')), false);
  assert.equal(fs.readFileSync(plcproj, 'utf8'), plcBefore);
  assert.equal(fs.readFileSync(fb, 'utf8'), fbBefore);
}));

test('the undo log survives a restart of the server', () => withTools((t, root) => {
  T.editSection(t, { object: 'MAIN', part: 'impl', oldText: 'TRUE', newText: 'FALSE' });
  const again: T.Tools = { session: new Session(root), undo: new UndoLog(root, path.join(root, 'undo.jsonl')) };
  again.session.refresh();
  assert.match(T.undoLastEdit(again, {}), /Undid edit 1/);
  assert.match(T.read(again, { object: 'MAIN', part: 'impl' }), /fbValve\(bOpen := TRUE\);/);
  assert.equal(new UndoLog(root, path.join(root, 'undo.jsonl')).get(), undefined, 'the undo is logged too');
}));

const BUNDLE = path.join(__dirname, '..', '..', 'mcp', 'server.js');

test('the bundled server answers over stdio: initialize, tools/list, a tool call', { skip: !fs.existsSync(BUNDLE) && 'out/mcp/server.js is not built' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-mcp-stdio-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('A/A.tsproj', '<?xml version="1.0"?>\n<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>');
  write('A/Plc/Plc.plcproj', '<?xml version="1.0" encoding="utf-8"?>\n<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><Name>Plc</Name></PropertyGroup><ItemGroup><Compile Include="POUs\\MAIN.TcPOU" /></ItemGroup></Project>');
  write('A/Plc/POUs/MAIN.TcPOU', FILES['POUs/MAIN.TcPOU']);
  const { spawn } = await import('child_process');
  const child = spawn(process.execPath, [BUNDLE, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCALAPPDATA: root } });
  const answers = new Map<number, Record<string, unknown>>();
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (typeof msg.id === 'number') answers.set(msg.id, msg);
    }
  });
  const ask = async (id: number, method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 200 && !answers.has(id); i++) await new Promise(r => setTimeout(r, 25));
    const a = answers.get(id);
    assert.ok(a, `no answer to ${method}`);
    return a.result as Record<string, unknown>;
  };
  try {
    const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.match(String(init.instructions), /never read or edit them as text/);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await ask(2, 'tools/list', {});
    const names = (list.tools as { name: string }[]).map(x => x.name);
    assert.ok(['read', 'edit_section', 'undo_last_edit', 'references'].every(n => names.includes(n)), names.join(', '));
    const call = await ask(3, 'tools/call', { name: 'read', arguments: { object: 'MAIN', part: 'impl' } });
    assert.match((call.content as { text: string }[])[0].text, /1  fbValve\(bOpen := TRUE\);/);
    const bad = await ask(4, 'tools/call', { name: 'read', arguments: { object: 'FB_None' } });
    assert.equal(bad.isError, true);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check reports problems of one object or of all code', () => withTools(t => {
  assert.match(T.check(t, {}), /no problems/);
  T.editSection(t, { object: 'MAIN', part: 'impl', oldText: 'fbValve.M_Close();', newText: 'fbValve.M_Missing();' });
  assert.match(T.check(t, { object: 'MAIN' }), /MAIN impl:2  error: .*M_Missing/);
}));

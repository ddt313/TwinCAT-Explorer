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

test('locate: the object, part and line of code at lines of the XML file, as git numbers them', () => withTools(t => {
  const file = 'A/Plc/POUs/FB_Valve.TcPOU';
  assert.equal(T.locate(t, { file, line: 14 }), 'POUs\\FB_Valve.TcPOU (Plc)\n14: FB_Valve impl:2  nCount := nCount + 1;');
  assert.match(T.locate(t, { file, line: 4 }), /^4: FB_Valve decl:1  FUNCTION_BLOCK FB_Valve$/m);
  assert.equal(T.locate(t, { file, line: 1, to: 3 }).split('\n').slice(1).join('\n'),
    '1-2: XML outside the objects\n3: XML of FB_Valve, not code');
  // A diff hunk: the method's code, then the XML that closes it.
  assert.equal(T.locate(t, { file, line: 22, to: 24 }).split('\n').slice(1).join('\n'),
    '22-23: FB_Valve.M_Close impl:1-2\n24: XML of FB_Valve.M_Close, not code');
  assert.match(T.locate(t, { file, line: 28, to: 30 }), /^28: XML outside the objects\n29-30: after the end of the file \(28 lines\)$/m);
  assert.throws(() => T.locate(t, { file: 'A/A.tsproj', line: 1 }), /not a source file of the PLC projects/);
}));

test('the language index checks the files once per call, not once per section a tool asks for', () => withTools(t => {
  const ws = t.session.ws;
  const getFile = ws.getFile.bind(ws);
  let reads = 0;
  ws.getFile = p => {
    reads++;
    return getFile(p);
  };
  // Before every call: each file once, for changes made outside.
  t.session.refresh();
  assert.equal(reads, ws.sourceEntries.length);
  reads = 0;
  T.references(t, { symbol: 'FB_Valve.M_Close' });
  T.check(t, {});
  T.findSymbol(t, { query: 'fb' });
  assert.equal(reads, 0);
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
  assert.match(T.undoLastEdit(t, {}), /Undid edit 1 in the files: edit_section FB_Valve impl/);
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
  assert.equal(fs.existsSync(path.join(root, 'A/Plc/POUs/Pumps')), false, 'the folder the new object made goes too');
  assert.ok(fs.existsSync(path.join(root, 'A/Plc/POUs')));
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
  const child = spawn(process.execPath, [BUNDLE, '--root', root, '--no-xae'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCALAPPDATA: root } });
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

/**
 * A stand-in for the running TwinCAT XAE, with the project open: its texts by tree path, with each text's editor
 * state; calls are recorded.
 */
function fakeXae(t: T.Tools, dirtyFiles: string[] = []) {
  const { textHash } = require('../../src/core/objectText') as typeof import('../../src/core/objectText');
  const s = t.session;
  const texts = new Map<string, string>();
  for (const v of s.views()) {
    for (const sec of v.obj.sections.filter(x => x.accessor === v.accessor)) {
      const { viewPath } = require('../../src/mcp/live') as typeof import('../../src/mcp/live');
      texts.set(`${viewPath(v).join('^')}|${sec.role}`, sec.text);
    }
  }
  const calls: string[] = [];
  const key = (item: { path: string[] }, part: string) => `${item.path.join('^')}|${part}`;
  const live = (text: string, file?: string) => ({ text, hash: textHash(text), open: false, dirty: !!file && dirtyFiles.includes(file) });
  const xae = {
    instances: () => [{ pid: 4242, progId: 'TcXaeShell.DTE.15.0', solution: 'A.sln', projects: s.ws.tsProjects.map(p => p.path) }],
    instanceFor: () => xae.instances()[0],
    get: (item: { path: string[]; file?: string }, part: string) => {
      calls.push(`get ${key(item, part)}`);
      return live(texts.get(key(item, part)) ?? '', item.file);
    },
    set: (item: { path: string[]; file?: string }, part: string, text: string, expected: string) => {
      const now = texts.get(key(item, part)) ?? '';
      if (textHash(now) !== expected) return { ...live(now), conflict: true };
      calls.push(`set ${key(item, part)}`);
      texts.set(key(item, part), text);
      return live(text);
    },
    texts: (item: { path: string[] }) => {
      const base = item.path.join('^');
      const out = new Map<string, Record<string, string>>();
      for (const [k, text] of texts) {
        const [p, part] = k.split('|');
        if (p !== base && !p.startsWith(base + '^')) continue;
        const rel = p.slice(base.length + 1);
        out.set(rel, { ...out.get(rel), path: rel, [part]: text });
      }
      return [...out.values()];
    },
    dirty: () => dirtyFiles,
    save: (_: unknown, file: string) => calls.push(`save ${path.basename(file)}`),
    children: () => [],
    create: (parent: { path: string[] }, name: string, subType: number) => calls.push(`create ${[...parent.path, name].join('^')} ${subType}`),
    delete: (parent: { path: string[] }, name: string) => calls.push(`delete ${[...parent.path, name].join('^')}`),
  };
  t.xae = xae as unknown as T.Tools['xae'];
  return { texts, calls };
}

test('with XAE open, edits go through XAE: its text, its hash, undo there too, and the file is left to XAE', () => withTools((t, root) => {
  const file = path.join(root, 'A/Plc/POUs/FB_Valve.TcPOU');
  const before = fs.readFileSync(file, 'utf8');
  const { texts, calls } = fakeXae(t);
  texts.set('POUs^FB_Valve^M_Close|impl', 'nCount := 0;\nM_Close := TRUE; // unsaved in XAE\n');
  const out = T.read(t, { object: 'FB_Valve.M_Close', part: 'impl' });
  assert.match(out, /live in TwinCAT XAE \(process 4242\)/);
  assert.match(out, /── impl · hash \w+ · 2 lines · has unsaved edits in XAE\n[\s\S]*2  M_Close := TRUE; \/\/ unsaved in XAE/);
  const edit = { object: 'FB_Valve.M_Close', part: 'impl' as const, oldText: 'nCount := 0;', newText: 'nCount := -1;', hash: hashOf(out, 'impl') };
  // XAE's DTE does not see its PLC editors as unsaved: told by the text, which differs from the file.
  assert.throws(() => T.editSection(t, edit), /FB_Valve\.M_Close has unsaved changes in TwinCAT XAE[\s\S]*saveUserEdits: true/);
  assert.throws(() => T.editSection(t, { ...edit, object: 'FB_Valve', part: 'decl', oldText: 'nCount : INT;', newText: 'nCount : DINT;', hash: undefined }),
    /FB_Valve\.M_Close has unsaved/, 'unsaved edits of another object of the file count too');
  const done = T.editSection(t, { ...edit, saveUserEdits: true });
  assert.match(done, /Written in TwinCAT XAE \(process 4242\)/);
  assert.equal(texts.get('POUs^FB_Valve^M_Close|impl'), 'nCount := -1;\nM_Close := TRUE; // unsaved in XAE\n');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is XAE\'s to save');
  assert.match(T.undoLastEdit(t, {}), /Undid edit 1 in TwinCAT XAE/);
  assert.equal(texts.get('POUs^FB_Valve^M_Close|impl'), 'nCount := 0;\nM_Close := TRUE; // unsaved in XAE\n');
  assert.ok(calls.filter(c => c.startsWith('set')).length === 2);
}));

test('with XAE open, a file with unsaved edits there is refused unless the user agreed, and a changed text too', () => withTools((t, root) => {
  const file = path.join(root, 'A/Plc/POUs/MAIN.TcPOU');
  const { texts } = fakeXae(t, [file]);
  assert.throws(() => T.editSection(t, { object: 'MAIN', part: 'impl', oldText: 'TRUE', newText: 'FALSE' }), /unsaved changes in TwinCAT XAE[\s\S]*saveUserEdits: true/);
  T.editSection(t, { object: 'MAIN', part: 'impl', oldText: 'TRUE', newText: 'FALSE', saveUserEdits: true });
  assert.match(texts.get('POUs^MAIN|impl')!, /bOpen := FALSE/);
  assert.throws(() => T.addMember(t, { owner: 'MAIN', kind: 'action', name: 'A_Reset' }), /unsaved changes in TwinCAT XAE/);
  assert.throws(() => T.writeSection(t, { object: 'MAIN', part: 'impl', text: 'x', hash: 'deadbeef', saveUserEdits: true }), /changed since it was read/);
}));

test('with XAE open, members are made and deleted by CreateChild and DeleteChild, as the extension writes them', () => withTools(t => {
  const { calls } = fakeXae(t);
  T.addMember(t, { owner: 'FB_Valve', kind: 'property', name: 'P_Speed', type: 'LREAL', accessors: ['Get'] });
  assert.deepEqual(calls.filter(c => !c.startsWith('get')), [
    'create POUs^FB_Valve^P_Speed 611', 'create POUs^FB_Valve^P_Speed^Get 613', 'save FB_Valve.TcPOU',
  ]);
  calls.length = 0;
  T.deleteMember(t, { object: 'FB_Valve.M_Close', confirm: true });
  assert.deepEqual(calls, ['delete POUs^FB_Valve^M_Close', 'save FB_Valve.TcPOU']);
}));

test('the Claude Code command line of the setup: scope local, node when on PATH, else the editor as Node', async () => {
  const { claudeAddArgs, claudeRemoveArgs, commandLine, serverLaunch } = await import('../../src/core/mcpSetup');
  // Paths with forward slashes: a quoted path loses its backslashes through claude.cmd.
  const js = 'C:/Users/me/.vscode/extensions/thanhdang.explorer-for-twincat-0.15.0/out/mcp/server.js';
  const code = 'C:/Program Files/Microsoft VS Code/Code.exe';
  assert.deepEqual(claudeAddArgs(serverLaunch(js.replace(/\//g, '\\'), true, code)), ['mcp', 'add', 'twincat', '--scope', 'local', '--', 'node', js]);
  const electron = claudeAddArgs(serverLaunch(js, false, code.replace(/\//g, '\\')));
  assert.deepEqual(electron, ['mcp', 'add', 'twincat', '--scope', 'local', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', code, js]);
  assert.equal(commandLine('claude', electron), `claude mcp add twincat --scope local -e ELECTRON_RUN_AS_NODE=1 -- "${code}" ${js}`);
  assert.deepEqual(claudeRemoveArgs(), ['mcp', 'remove', 'twincat', '--scope', 'local']);
});

test('the setup runs claude in the folder as Claude Code spells it (C:), and removes a registration under VS Code\'s c:', async () => {
  const { claudeFolder, registerServer, serverLaunch } = await import('../../src/core/mcpSetup');
  assert.equal(claudeFolder('c:\\Users\\me\\repo'), 'C:\\Users\\me\\repo');
  assert.equal(claudeFolder('C:\\Users\\me\\repo'), 'C:\\Users\\me\\repo');
  assert.equal(claudeFolder('\\\\server\\share\\repo'), '\\\\server\\share\\repo');
  assert.equal(claudeFolder('/home/me/c:repo'), '/home/me/c:repo');
  const calls: string[] = [];
  // Nothing to remove: claude fails, which changes nothing.
  const run = async (args: string[], cwd: string) => {
    calls.push(`${args.slice(0, 2).join(' ')} in ${cwd}`);
    return { ok: args[1] === 'add', output: '' };
  };
  const launch = serverLaunch('C:/Users/me/out/mcp/server.js', true, 'C:/Code.exe');
  // VS Code's fsPath, and a folder given as Claude Code spells it: the same three runs.
  for (const folder of ['c:\\Users\\me\\repo', 'C:\\Users\\me\\repo']) {
    calls.length = 0;
    assert.deepEqual(await registerServer(run, folder, launch), { ok: true, output: '' });
    assert.deepEqual(calls, ['mcp remove in c:\\Users\\me\\repo', 'mcp remove in C:\\Users\\me\\repo', 'mcp add in C:\\Users\\me\\repo']);
  }
  calls.length = 0;
  await registerServer(run, '/home/me/repo', launch);
  assert.deepEqual(calls, ['mcp remove in /home/me/repo', 'mcp add in /home/me/repo']);
});

test('the permission rules of the setup: reading tools allowed, the XML of source files never edited, added once', async () => {
  const { addPermissionRules, permissionRules } = await import('../../src/core/mcpSetup');
  const rules = permissionRules();
  assert.ok(rules.allow.includes('mcp__twincat__read') && rules.allow.includes('mcp__twincat__locate'));
  assert.ok(!rules.allow.some(r => /edit_section|write_section|add_|delete_|undo_/.test(r)), 'no tool that writes');
  assert.deepEqual(rules.deny, ['Edit(**/*.TcPOU)', 'Edit(**/*.TcDUT)', 'Edit(**/*.TcGVL)', 'Edit(**/*.TcIO)']);
  assert.deepEqual(permissionRules({ reads: true, xml: false }), { allow: rules.allow, deny: [] });
  assert.deepEqual(permissionRules({ reads: false, xml: true }), { allow: [], deny: rules.deny });
  // A new file.
  const fresh = addPermissionRules(undefined, rules);
  assert.deepEqual(JSON.parse(fresh.text), { permissions: { allow: rules.allow, deny: rules.deny } });
  assert.equal(fresh.added.length, rules.allow.length + rules.deny.length);
  // The user's settings and rules stay, in their order; only the missing rules are added.
  const own = JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)', 'mcp__twincat__read'], ask: ['Bash(git push:*)'] } }, null, 2);
  const merged = addPermissionRules(own, rules);
  const settings = JSON.parse(merged.text);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions.ask, ['Bash(git push:*)']);
  assert.deepEqual(settings.permissions.allow.slice(0, 2), ['Bash(npm test)', 'mcp__twincat__read']);
  assert.equal(settings.permissions.allow.filter((r: string) => r === 'mcp__twincat__read').length, 1);
  assert.ok(!merged.added.includes('mcp__twincat__read'));
  // Again: nothing to add, the text as it was.
  assert.deepEqual(addPermissionRules(merged.text, rules), { text: merged.text, added: [] });
  // Comments would be lost: such a file is left alone.
  assert.throws(() => addPermissionRules('{\n  // mine\n  "model": "opus"\n}', rules), /not plain JSON/);
  assert.throws(() => addPermissionRules('{"permissions": {"deny": "Edit"}}', rules), /permissions\.deny is not a list/);
});

test('the setup gives a folder\'s settings.local.json the rules and keeps it out of git, never a tracked one', async () => {
  const { LOCAL_SETTINGS, addFolderPermissions: add, permissionRules } = await import('../../src/core/mcpSetup');
  const cp = await import('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-perms-'));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-perms-plain-'));
  const git = async (args: string[], cwd: string) => cp.execFileSync('git', args, { cwd, stdio: 'pipe' });
  const addFolderPermissions = (g: typeof git, folder: string) => add(g, folder, permissionRules());
  const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString('utf8');
  try {
    run('init', '-q');
    // No ignore file of the user's here (Claude Code's global one usually has the settings file).
    fs.writeFileSync(path.join(root, 'none.ignore'), '');
    run('config', 'core.excludesFile', path.join(root, 'none.ignore').replace(/\\/g, '/'));
    const folder = path.join(root, 'sub');
    fs.mkdirSync(folder);
    // No rule picked: the folder is left as it is.
    assert.equal(await add(git, folder, permissionRules({ reads: false, xml: false })), '');
    assert.equal(fs.existsSync(path.join(folder, LOCAL_SETTINGS)), false);
    assert.match(await addFolderPermissions(git, folder),
      /reading tools without asking, and Claude Code's Edit and Write tools never change \.TcPOU, \.TcDUT, \.TcGVL, \.TcIO files .*which git ignores/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(folder, LOCAL_SETTINGS), 'utf8')).permissions.deny.includes('Edit(**/*.TcPOU)'));
    const exclude = fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8');
    assert.match(exclude, /^\/sub\/\.claude\/settings\.local\.json$/m);
    assert.ok(!run('status', '--porcelain', '--untracked-files=all').includes('settings.local.json'), 'git ignores it');
    // Again: nothing added twice.
    const settings = fs.readFileSync(path.join(folder, LOCAL_SETTINGS), 'utf8');
    await addFolderPermissions(git, folder);
    assert.equal(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), exclude);
    assert.equal(fs.readFileSync(path.join(folder, LOCAL_SETTINGS), 'utf8'), settings);
    // A settings file that the repository tracks is the team's: left as it is.
    const tracked = path.join(root, 'tracked');
    fs.mkdirSync(path.join(tracked, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tracked, LOCAL_SETTINGS), '{}\n');
    run('add', '-f', 'tracked/.claude/settings.local.json');
    assert.match(await addFolderPermissions(git, tracked), /is committed in the repository.*Add them by hand/);
    assert.equal(fs.readFileSync(path.join(tracked, LOCAL_SETTINGS), 'utf8'), '{}\n');
    // Outside a repository: the settings file only.
    assert.doesNotMatch(await addFolderPermissions(git, plain), /git ignores/);
    assert.ok(fs.existsSync(path.join(plain, LOCAL_SETTINGS)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('finds claude.exe or claude.cmd on a Windows PATH, full folders only', async () => {
  const { findClaude } = await import('../../src/core/mcpSetup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-claude-'));
  try {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
    if (process.platform === 'win32') {
      assert.equal(findClaude(`relative;${dir}`, 'win32')?.toLowerCase(), path.join(dir, 'claude.cmd').toLowerCase());
      fs.writeFileSync(path.join(dir, 'claude.exe'), '');
      assert.equal(findClaude(`"${dir}"`, 'win32')?.toLowerCase(), path.join(dir, 'claude.exe').toLowerCase(), 'the native one first');
    }
    assert.equal(findClaude('relative', 'win32'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

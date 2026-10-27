import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TcWorkspace, fileKey } from '../../src/core/workspace';
import { parseTcFile } from '../../src/core/tcfile';
import { textHash } from '../../src/core/objectText';
import { Xae, XaeError } from '../../src/core/xae';
import { XaeSaveHost, saveThroughXae, xaePathOf } from '../../src/core/xaeSave';

const POU = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
  <POU Name="FB_Valve" Id="{11111111-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Valve
VAR
	nCount : INT;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[nCount := nCount + 1;
]]></ST>
    </Implementation>
    <Method Name="M_Close" Id="{11111111-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD M_Close : BOOL
]]></Declaration>
      <Implementation>
        <ST><![CDATA[nCount := 0;
]]></ST>
      </Implementation>
    </Method>
  </POU>
</TcPlcObject>`.replace(/\n/g, '\r\n');

/** A PLC project `Plc` with POUs/FB_Valve.TcPOU, and a fake XAE that has it open (when `open`) with its texts. */
function withProject(run: (ctx: {
  ws: TcWorkspace; file: string; xae: ReturnType<typeof fakeXae>; host: XaeSaveHost & { asked: string[]; warned: string[] };
}) => Promise<void>, opts: { open?: boolean; answer?: boolean; broken?: boolean } = {}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-xaesave-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
  write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup><Compile Include="POUs\\FB_Valve.TcPOU"><SubType>Code</SubType></Compile></ItemGroup>
</Project>`);
  write('A/Plc/POUs/FB_Valve.TcPOU', POU);
  const ws = new TcWorkspace();
  ws.load([path.join(root, 'A/A.tsproj')]);
  const file = path.join(root, 'A/Plc/POUs/FB_Valve.TcPOU');
  const xae = fakeXae(path.join(root, 'A/A.tsproj'), file, opts.open !== false, opts.broken === true);
  const asked: string[] = [];
  const warned: string[] = [];
  const host = {
    asked, warned,
    confirm: async (message: string, action: string) => { asked.push(`${message} [${action}]`); return opts.answer ?? true; },
    warn: (message: string) => { warned.push(message); },
  };
  return run({ ws, file, xae, host }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

/** XAE's texts by item path (`POUs/FB_Valve/M_Close`) and part, read from the file; `set` changes them. */
function fakeXae(tsproj: string, file: string, open: boolean, broken: boolean) {
  const texts = new Map<string, string>();
  for (const sec of parseTcFile(file, fs.readFileSync(file)).sections.values()) {
    texts.set(`${xaePathOf('POUs\\FB_Valve.TcPOU', sec).join('/')}:${sec.role}`, sec.text);
  }
  const sets: string[] = [];
  const at = (item: { path: string[] }, part: string) => `${item.path.join('/')}:${part}`;
  const live = (item: { path: string[] }, part: string) => {
    const text = texts.get(at(item, part))!;
    return { text, hash: textHash(text), open: false, dirty: false };
  };
  return {
    texts, sets,
    instanceForAsync: async (p: string) => {
      if (broken) throw new XaeError('TwinCAT XAE is running but cannot be driven (it is broken); the files are left alone');
      return open && fileKey(p) === fileKey(tsproj) ? { pid: 42, progId: 'TcXaeShell.DTE.15.0', solution: '', projects: [tsproj] } : undefined;
    },
    textsAsync: async (item: { path: string[] }) => {
      const out = new Map<string, { path: string; decl?: string; impl?: string }>();
      const prefix = item.path.join('/');
      for (const [k, text] of texts) {
        const [p, part] = k.split(':');
        if (p !== prefix && !p.startsWith(prefix + '/')) continue;
        const rel = p.slice(prefix.length + 1).replace(/\//g, '^');
        const e = out.get(rel) ?? { path: rel };
        e[part as 'decl' | 'impl'] = text;
        out.set(rel, e);
      }
      return [...out.values()];
    },
    getAsync: async (item: { path: string[] }, part: string) => live(item, part),
    setAsync: async (item: { path: string[] }, part: string, text: string, expected: string) => {
      if (live(item, part).hash !== expected) return { ...live(item, part), conflict: true };
      texts.set(at(item, part), text);
      sets.push(at(item, part));
      return live(item, part);
    },
    saveAsync: async () => undefined,
  };
}

const sectionKey = (file: string, owner: string, role: 'decl' | 'impl') =>
  [...parseTcFile(file, fs.readFileSync(file)).sections.values()].find(s => s.owner.name === owner && s.role === role)!.key;
const parsed = (file: string) => parseTcFile(file, fs.readFileSync(file));
const asXae = (x: unknown) => x as Xae;

test('the XAE path of a section: folders of the file, the POU, the member, the accessor', () => {
  const file = parseTcFile('FB_Valve.TcPOU', Buffer.from(POU));
  const close = [...file.sections.values()].find(s => s.owner.name === 'M_Close')!;
  assert.deepEqual(xaePathOf('POUs\\Valves\\FB_Valve.TcPOU', close), ['POUs', 'Valves', 'FB_Valve', 'M_Close']);
  assert.deepEqual(xaePathOf('FB_Valve.TcPOU', { owner: close.owner.parent! }), ['FB_Valve']);
});

test('with XAE closed the file is left to the caller', () => withProject(async ({ ws, file, xae, host }) => {
  const key = sectionKey(file, 'M_Close', 'impl');
  assert.equal(await saveThroughXae(ws, asXae(xae), parsed(file), [{ key, text: 'nCount := 1;\n' }], host), false);
  assert.deepEqual(xae.sets, []);
}, { open: false }));

test('with XAE open the edited sections are set in XAE, nothing asked', () => withProject(async ({ ws, file, xae, host }) => {
  const key = sectionKey(file, 'M_Close', 'impl');
  assert.equal(await saveThroughXae(ws, asXae(xae), parsed(file), [{ key, text: 'nCount := 1;\n' }], host), true);
  assert.deepEqual(xae.sets, ['POUs/FB_Valve/M_Close:impl']);
  assert.equal(xae.texts.get('POUs/FB_Valve/M_Close:impl'), 'nCount := 1;\n');
  assert.deepEqual(host.asked, []);
}));

test('unsaved edits of another member in XAE are asked about; declining saves nothing', () => withProject(async ({ ws, file, xae, host }) => {
  xae.texts.set('POUs/FB_Valve:impl', 'nCount := nCount + 2;\n');
  const key = sectionKey(file, 'M_Close', 'impl');
  await assert.rejects(saveThroughXae(ws, asXae(xae), parsed(file), [{ key, text: 'nCount := 1;\n' }], host), /^Error: Not saved/);
  assert.match(host.asked[0], /^FB_Valve has unsaved changes in TwinCAT XAE, which XAE saves along with this change\. \[Save Them Too\]$/);
  assert.deepEqual(xae.sets, []);
}, { answer: false }));

test('unsaved edits of the saved section in XAE are replaced once the user agrees', () => withProject(async ({ ws, file, xae, host }) => {
  xae.texts.set('POUs/FB_Valve/M_Close:impl', 'nCount := 5;\n');
  const key = sectionKey(file, 'M_Close', 'impl');
  assert.equal(await saveThroughXae(ws, asXae(xae), parsed(file), [{ key, text: 'nCount := 1;\n' }], host), true);
  assert.match(host.asked[0], /^FB_Valve\.M_Close implementation has unsaved changes in TwinCAT XAE, which this save replaces .*\[Replace and Save\]$/);
  assert.equal(xae.texts.get('POUs/FB_Valve/M_Close:impl'), 'nCount := 1;\n');
}));

test('XAE running but not drivable: a warning, and the file is left to the caller', () => withProject(async ({ ws, file, xae, host }) => {
  const key = sectionKey(file, 'M_Close', 'impl');
  assert.equal(await saveThroughXae(ws, asXae(xae), parsed(file), [{ key, text: 'nCount := 1;\n' }], host), false);
  assert.match(host.warned[0], /cannot be driven.*The file was written/);
}, { broken: true }));

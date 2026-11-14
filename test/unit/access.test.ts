// How code uses each name (Occurrence.access and path): what references and the MCP server's references tell of
// a variable, read or written, and through which member or index.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../../src/lang/analyzer';
import { highlightsAcross } from '../../src/lang/highlights';
import { LanguageIndex } from '../../src/lang/index';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
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
const pou = (name: string, n: number, decl: string, st: string, members = '') => object(`  <POU Name="${name}" Id="${guid(n)}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>${impl(st)}${members}
  </POU>`);
const accessor = (kind: 'Get' | 'Set', n: number, st: string) => `
      <${kind} Name="${kind}" Id="${guid(n)}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>${impl(st, '        ')}
      </${kind}>`;

const FILES: Record<string, string> = {
  'DUTs/ST_Status.TcDUT': object(`  <DUT Name="ST_Status" Id="${guid(1)}">
    <Declaration><![CDATA[TYPE ST_Status :
STRUCT
	eState : INT;
	nCount : INT;
END_STRUCT
END_TYPE
]]></Declaration>
  </DUT>`),
  'POUs/FB_Valve.TcPOU': pou('FB_Valve', 10, `FUNCTION_BLOCK FB_Valve
VAR_INPUT
	bIn : BOOL;
END_VAR
VAR_OUTPUT
	bOut : BOOL;
END_VAR
VAR
	nPos : INT;
END_VAR
`, 'bOut := bIn;', `
    <Method Name="Open" Id="${guid(11)}">
      <Declaration><![CDATA[METHOD Open : BOOL
]]></Declaration>${impl('Open := TRUE;', '      ')}
    </Method>
    <Property Name="Pos" Id="${guid(12)}">
      <Declaration><![CDATA[PROPERTY Pos : INT
]]></Declaration>${accessor('Get', 13, 'Pos := nPos;')}${accessor('Set', 14, 'nPos := Pos;')}
    </Property>`),
  'POUs/F_Inc.TcPOU': pou('F_Inc', 20, `FUNCTION F_Inc : BOOL
VAR_IN_OUT
	n : INT;
END_VAR
`, 'n := n + 1;\nF_Inc := TRUE;'),
  'GVLs/GVL_IO.TcGVL': object(`  <GVL Name="GVL_IO" Id="${guid(30)}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
VAR_GLOBAL
	bStart : BOOL;
END_VAR
]]></Declaration>
  </GVL>`),
  'POUs/MAIN.TcPOU': pou('MAIN', 40, `PROGRAM MAIN
VAR
	stStatus : ST_Status;
	stOther : ST_Status;
	aPos : ARRAY[1..3] OF INT;
	fbValve : FB_Valve;
	pSt : POINTER TO ST_Status;
	refSt : REFERENCE TO ST_Status;
	n : INT;
	i : INT;
	b : BOOL;
	w : WORD;
	p : POINTER TO INT;
END_VAR
`, ''),
};

/** A workspace of the files above, with its index. */
function project(): { root: string; index: LanguageIndex; file: (rel: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-access-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('A/A.tsproj', `<?xml version="1.0"?>
<TcSmProject><Project><Plc><Project Name="Plc" PrjFilePath="Plc\\Plc.plcproj"/></Plc></Project></TcSmProject>`);
  write('A/Plc/Plc.plcproj', `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>Plc</Name></PropertyGroup>
  <ItemGroup>${Object.keys(FILES).map(f => `<Compile Include="${f.replace(/\//g, '\\')}"><SubType>Code</SubType></Compile>`).join('')}</ItemGroup>
</Project>`);
  for (const [rel, text] of Object.entries(FILES)) write(`A/Plc/${rel}`, text);
  const ws = new TcWorkspace();
  ws.load([path.join(root, 'A/A.tsproj')]);
  const index = new LanguageIndex(ws);
  index.setStubs(BUNDLED_STUBS);
  return { root, index, file: rel => path.join(root, 'A/Plc', rel) };
}

test('how code uses each name: written, read, called, its address taken, through a member or index', () => {
  const { root, index, file } = project();
  try {
    const ctx = index.context(fileKey(file('POUs/MAIN.TcPOU')), `${guid(40).replace(/[{}]/g, '')}:impl`)!;
    /** The uses in a line of MAIN as `name access path`, in their order; the problems none. */
    const uses = (st: string) => {
      const a = analyze(index, ctx, st);
      assert.deepEqual(a.problems.map(p => p.message), [], st);
      return a.occurrences.filter(o => o.role !== 'type').map(o => [st.slice(o.start, o.end), o.access, o.path].filter(x => x).join(' '));
    };
    // A struct: its member written, and the variable through it; as a whole.
    assert.deepEqual(uses('stStatus.eState := 1;'), ['stStatus write .eState', 'eState write']);
    assert.deepEqual(uses('stStatus := stOther;'), ['stStatus write', 'stOther read']);
    assert.deepEqual(uses('n := stStatus.eState;'), ['n write', 'stStatus read .eState', 'eState read']);
    // An array element; the index is read.
    assert.deepEqual(uses('aPos[i + 1] := 0;'), ['aPos write [i + 1]', 'i read']);
    assert.deepEqual(uses('aPos[i] := aPos[i] + 1;'), ['aPos write [i]', 'i read', 'aPos read [i]', 'i read']);
    // A bit.
    assert.deepEqual(uses('w.3 := TRUE;'), ['w write .3']);
    // A function block: an input written through it, a property set, a method called, the instance called.
    assert.deepEqual(uses('fbValve.bIn := TRUE;'), ['fbValve write .bIn', 'bIn write']);
    assert.deepEqual(uses('fbValve.Pos := 3;'), ['fbValve write .Pos', 'Pos write']);
    assert.deepEqual(uses('fbValve.Open();'), ['fbValve call .Open', 'Open call']);
    assert.deepEqual(uses('b := fbValve.Open();'), ['b write', 'fbValve call .Open', 'Open call']);
    // A call: the input written, the output read and the variable it goes to written.
    assert.deepEqual(uses('fbValve(bIn := b, bOut => stStatus.eState);'),
      ['fbValve call', 'bIn write', 'b read', 'bOut read', 'stStatus write .eState', 'eState write']);
    // A VAR_IN_OUT, by name or by position.
    assert.deepEqual(uses('F_Inc(n := n);'), ['F_Inc call', 'n write', 'n readwrite']);
    assert.deepEqual(uses('F_Inc(stStatus.nCount);'), ['F_Inc call', 'stStatus readwrite .nCount', 'nCount readwrite']);
    // An address taken; a pointer dereferenced is read, what it points to is not followed.
    assert.deepEqual(uses('p := ADR(n);'), ['p write', 'ADR call', 'n address']);
    assert.deepEqual(uses('pSt^.eState := 1;'), ['pSt read', 'eState write']);
    assert.deepEqual(uses('refSt REF= stStatus;'), ['refSt write', 'stStatus address']);
    // FOR, S=, R=.
    assert.deepEqual(uses('FOR i := 1 TO n DO\nEND_FOR'), ['i write', 'n read']);
    assert.deepEqual(uses('b S= fbValve.bOut;'), ['b write', 'fbValve read .bOut', 'bOut read']);
    // A qualified name: the GVL is no variable written.
    assert.deepEqual(uses('GVL_IO.bStart := TRUE;'), ['GVL_IO read', 'bStart write']);

    // The highlights in a pane: written as a whole (through indexes too), else read.
    const highlights = (st: string, at: string) => {
      const r = highlightsAcross({ analysis: analyze(index, ctx, st), text: st }, st.indexOf(at), []);
      return r.own.map(h => `${st.slice(h.start, h.end)}:${h.kind}`);
    };
    assert.deepEqual(highlights('F_Inc(n);\nn := 1;\ni := n;', 'n)'), ['n:write', 'n:write', 'n:read']);
    assert.deepEqual(highlights('aPos[i] := 1;\nstStatus.eState := 1;', 'aPos'), ['aPos:write']);
    assert.deepEqual(highlights('stStatus.eState := 1;\nstStatus := stOther;', 'stStatus.'), ['stStatus:read', 'stStatus:write']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

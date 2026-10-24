import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  PlcProjectEditError, parsePlcProject, projectFolderList, removeItem, renameCompileItem, renameFolderItems, renameTaskCalls, taskCalls,
} from '../../src/core/project';
import { SpliceError, nameRanges, renameObject } from '../../src/core/splice';
import { encodeText, parseTcFile, parseTcText } from '../../src/core/tcfile';
import { folderNameProblem, isInFolder } from '../../src/lang/objects';

const ID = '{aaaaaaaa-0000-4000-8000-000000000001}';
const RUN = '{aaaaaaaa-0000-4000-8000-000000000002}';
const id = (guid: string) => guid.replace(/[{}]/g, '');
const crlf = (s: string) => s.replace(/\n/g, '\r\n');
const parse = (text: string, file = 'X.TcPOU') => parseTcText(file, text);

/** A file as XAE 3.1.4026 writes it (here with LF), with this root element. */
function file(element: string, attrs: string, declaration: string, rest = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.13">
  <${element} ${attrs}>
    <Declaration><![CDATA[${declaration}]]></Declaration>${rest}
  </${element}>
</TcPlcObject>`;
}

/** A function block with a method and LineIds; `self` is the name it uses itself by (a use, not renamed). */
const fb = (name: string, self = 'FB_Pump') => file('POU', `Name="${name}" Id="${ID}" SpecialFunc="None"`, `// FUNCTION_BLOCK FB_Pump, a pump
FUNCTION_BLOCK ${name} EXTENDS FB_Base
VAR
	pNext : POINTER TO ${self};
	sName : STRING := 'FB_Pump';
END_VAR
`, `
    <Implementation>
      <ST><![CDATA[THIS^.Run();]]></ST>
    </Implementation>
    <Method Name="Run" Id="${RUN}">
      <Declaration><![CDATA[METHOD Run : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[Run := TRUE;]]></ST>
      </Implementation>
    </Method>
    <LineIds Name="${name}">
      <LineId Id="9" Count="0" />
    </LineIds>
    <LineIds Name="${name}.Run">
      <LineId Id="2" Count="0" />
    </LineIds>`);

test('a renamed POU: its Name, its header, its LineIds and those of its members; what uses it stays', () => {
  // Not the comment, the string, nor the use of its name in its own declaration.
  assert.equal(renameObject(parse(fb('FB_Pump')), 'FB_Motor'), fb('FB_Motor'));
  assert.deepEqual(nameRanges(parse(fb('FB_Pump')), id(ID)).map(r => [r.section.role, r.section.text.slice(r.start, r.end)]), [['decl', 'FB_Pump']]);
  const renamed = parse(renameObject(parse(fb('FB_Pump')), 'FB_Motor'));
  assert.equal(renamed.objects.get(id(RUN))!.qualifiedName, 'FB_Motor.Run', 'its members follow');
  // CRLF and the BOM stay; a change of case only; the same name.
  const withBom = parseTcFile('FB_Pump.TcPOU', encodeText(crlf(fb('FB_Pump')), true));
  assert.equal(renameObject(withBom, 'FB_Motor'), crlf(fb('FB_Motor')));
  assert.equal(renameObject(parse(fb('FB_Pump')), 'FB_PUMP'), fb('FB_PUMP'));
  assert.equal(renameObject(parse(fb('FB_Pump')), 'FB_Pump'), fb('FB_Pump'));
  // What is refused.
  assert.throws(() => renameObject(parse(fb('FB_Pump')), '1FB'), SpliceError);
  assert.throws(() => renameObject(parse('<TcPlcObject />'), 'FB_X'), SpliceError);
  const other = fb('FB_Pump').replace('FUNCTION_BLOCK FB_Pump EXTENDS', 'FUNCTION_BLOCK FB_Other EXTENDS');
  assert.throws(() => renameObject(parse(other), 'FB_X'), /does not declare FB_Pump/);
});

test("a function's return value follows its name; a DUT, a GVL and an interface", () => {
  const fun = (name: string) => file('POU', `Name="${name}" Id="${ID}" SpecialFunc="None"`, `FUNCTION ${name} : INT
VAR_INPUT
	nA, nB : INT;
END_VAR
`, `
    <Implementation>
      <ST><![CDATA[${name} := nA + nB; // F_Calc
IF ${name} > 100 THEN
	${name} := 100;
END_IF]]></ST>
    </Implementation>`);
  assert.equal(renameObject(parse(fun('F_Calc')), 'F_Sum'), fun('F_Sum'));
  const dut = (name: string) => file('DUT', `Name="${name}" Id="${ID}"`, `TYPE ${name} :
STRUCT
	nId : INT;
END_STRUCT
END_TYPE
`);
  assert.equal(renameObject(parse(dut('ST_Data'), 'ST_Data.TcDUT'), 'ST_Record'), dut('ST_Record'));
  const gvl = (name: string) => file('GVL', `Name="${name}" Id="${ID}"`, `{attribute 'qualified_only'}
VAR_GLOBAL
	nShared : INT;
END_VAR
`);
  assert.equal(renameObject(parse(gvl('GVL_Main'), 'GVL_Main.TcGVL'), 'GVL_App'), gvl('GVL_App'), 'a GVL declares no name');
  const itf = (name: string) => file('Itf', `Name="${name}" Id="${ID}"`, `INTERFACE ${name} EXTENDS I_Base
`, `
    <Method Name="M_Reset" Id="${RUN}">
      <Declaration><![CDATA[METHOD M_Reset : BOOL
VAR_INPUT
END_VAR]]></Declaration>
    </Method>`);
  assert.equal(renameObject(parse(itf('I_Device'), 'I_Device.TcIO'), 'I_Unit'), itf('I_Unit'));
});

/** A .plcproj as XAE 3.1.4026 writes one, with these items. */
function plcproj(compile: string[], folders: string[] = [], eol = '\r\n'): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    '    <Name>Plc</Name>',
    '  </PropertyGroup>',
    '  <ItemGroup>', ...compile.flatMap(c => [`    <Compile Include="${c}">`, '      <SubType>Code</SubType>', '    </Compile>']), '  </ItemGroup>',
    '  <ItemGroup>', ...folders.map(f => `    <Folder Include="${f}" />`), '  </ItemGroup>',
    '</Project>',
  ].join(eol);
}

test('.plcproj: a renamed or moved file keeps its item where it is, with its new path; a deleted one goes', () => {
  for (const eol of ['\r\n', '\n']) {
    const three = plcproj(['POUs\\FB_A.TcPOU', 'POUs\\FB_B.TcPOU', 'POUs\\MAIN.TcPOU'], ['POUs', 'POUs\\Sub'], eol);
    // The Include case aside, as XAE compares paths.
    assert.equal(renameCompileItem(three, 'pous\\fb_a.tcpou', 'POUs\\FB_Z.TcPOU'),
      plcproj(['POUs\\FB_Z.TcPOU', 'POUs\\FB_B.TcPOU', 'POUs\\MAIN.TcPOU'], ['POUs', 'POUs\\Sub'], eol));
    assert.equal(renameCompileItem(three, 'POUs\\FB_A.TcPOU', 'POUs\\Sub\\FB_A.TcPOU'),
      plcproj(['POUs\\Sub\\FB_A.TcPOU', 'POUs\\FB_B.TcPOU', 'POUs\\MAIN.TcPOU'], ['POUs', 'POUs\\Sub'], eol), 'into a folder');
    assert.equal(renameCompileItem(three, 'POUs\\MAIN.TcPOU', 'MAIN.TcPOU'),
      plcproj(['POUs\\FB_A.TcPOU', 'POUs\\FB_B.TcPOU', 'MAIN.TcPOU'], ['POUs', 'POUs\\Sub'], eol), 'to the PLC project itself');
    assert.equal(removeItem(three, 'Compile', 'POUs\\FB_B.TcPOU'), plcproj(['POUs\\FB_A.TcPOU', 'POUs\\MAIN.TcPOU'], ['POUs', 'POUs\\Sub'], eol));
    assert.equal(removeItem(three, 'Folder', 'POUs\\Sub'), plcproj(['POUs\\FB_A.TcPOU', 'POUs\\FB_B.TcPOU', 'POUs\\MAIN.TcPOU'], ['POUs'], eol));
  }
  // What else an item holds stays.
  const linked = plcproj(['POUs\\FB_A.TcPOU', 'POUs\\FB_B.TcPOU']).replace('<SubType>Code</SubType>', '<SubType>Code</SubType>\r\n      <Link>X</Link>');
  assert.equal(renameCompileItem(linked, 'POUs\\FB_A.TcPOU', 'Zone\\FB_A.TcPOU'), linked.replace('"POUs\\FB_A.TcPOU"', '"Zone\\FB_A.TcPOU"'));
  assert.equal(removeItem(plcproj([], ['POUs\\Sub\\']), 'Folder', 'POUs\\Sub'), plcproj([], []), 'a folder item written with a backslash at the end');
  // What is refused.
  const two = plcproj(['POUs\\FB_A.TcPOU', 'POUs\\FB_B.TcPOU']);
  assert.throws(() => renameCompileItem(two, 'POUs\\FB_A.TcPOU', 'pous\\fb_b.TcPOU'), /already has POUs\\FB_B.TcPOU/);
  assert.throws(() => renameCompileItem(two, 'POUs\\FB_X.TcPOU', 'FB_X.TcPOU'), /has no item POUs\\FB_X.TcPOU/);
  assert.throws(() => removeItem(two, 'Folder', 'POUs'), PlcProjectEditError);
});

test('.plcproj: a renamed or moved folder takes everything in it along, each item where it is, as XAE renames a folder', () => {
  // The items TwinCAT 3.1.4026 wrote, and what it made of them when it renamed POUs\Valves to Zvalves.
  const files = ['Area\\FB_Area.TcPOU', 'PlcTask.TcTTO', 'POUs\\FB_A.TcPOU', 'POUs\\MAIN.TcPOU', 'POUs\\Pumps\\FB_P.TcPOU',
    'POUs\\Valves\\Deep\\FB_D.TcPOU', 'POUs\\Valves\\FB_V1.TcPOU', 'POUs\\Valves\\FB_V2.TcPOU'];
  const folders = ['Area', 'DUTs', 'GVLs', 'POUs\\Pumps', 'POUs\\Valves', 'POUs\\Valves\\Deep', 'VISUs', 'POUs'];
  const renamed = (list: string[], from: string, to: string) => list.map(f => (f === from || f.startsWith(`${from}\\`) ? to + f.slice(from.length) : f));
  for (const eol of ['\r\n', '\n']) {
    const text = plcproj(files, folders, eol);
    const expect = (from: string, to: string) => plcproj(renamed(files, from, to), renamed(folders, from, to), eol);
    assert.equal(renameFolderItems(text, 'POUs\\Valves', 'POUs\\Zvalves'), expect('POUs\\Valves', 'POUs\\Zvalves'));
    assert.equal(renameFolderItems(text, 'pous\\valves\\', 'POUs\\VALVES'), expect('POUs\\Valves', 'POUs\\VALVES'), 'a change of case');
    assert.equal(renameFolderItems(text, 'Area', 'POUs\\Pumps\\Area'), expect('Area', 'POUs\\Pumps\\Area'), 'moved into a folder');
    assert.equal(renameFolderItems(text, 'POUs\\Valves\\Deep', 'Deep'), expect('POUs\\Valves\\Deep', 'Deep'), 'moved to the project');
  }
  // A folder that only the paths of its files name, and one with a backslash at the end.
  assert.equal(renameFolderItems(plcproj(['Sub\\FB_X.TcPOU'], []), 'Sub', 'Other'), plcproj(['Other\\FB_X.TcPOU'], []));
  assert.equal(renameFolderItems(plcproj([], ['Sub\\']), 'Sub', 'Other'), plcproj([], ['Other\\']));
  // What is refused: into itself, a path taken, a folder that is not there.
  const text = plcproj(files, folders);
  assert.throws(() => renameFolderItems(text, 'POUs\\Valves', 'POUs\\Valves\\Deep\\Valves'), /cannot go into itself/);
  assert.throws(() => renameFolderItems(text, 'POUs\\Valves', 'POUs\\Pumps'), /already has POUs\\Pumps/);
  assert.throws(() => renameFolderItems(text, 'POUs\\Nothing', 'POUs\\Other'), /has no folder POUs\\Nothing/);
  // The name checks of the commands: the folder itself aside, a change of case allowed.
  const plc = parsePlcProject('Plc.plcproj', text);
  assert.equal(folderNameProblem(plc, 'POUs', 'VALVES', 'POUs\\Valves'), undefined);
  assert.equal(folderNameProblem(plc, 'POUs', 'Pumps', 'POUs\\Valves'), 'Plc already has the folder POUs\\Pumps');
  assert.ok(isInFolder('POUs\\Valves\\Deep', 'pous\\valves') && isInFolder('POUs\\Valves', 'POUs\\Valves'));
  assert.ok(!isInFolder('POUs\\ValvesX', 'POUs\\Valves') && !isInFolder('POUs', 'POUs\\Valves'));
});

test('a task calls a renamed program by its new name', () => {
  const tto = (name: string) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <Task Name="PlcTask" Id="{bbbbbbbb-0000-4000-8000-000000000001}">
    <!--CycleTime in micro seconds.-->
    <CycleTime>10000</CycleTime>
    <Priority>20</Priority>
    <PouCall>
      <Name>${name}</Name>
    </PouCall>
    <PouCall>
      <Name>PRG_Other</Name>
    </PouCall>
  </Task>
</TcPlcObject>`;
  assert.deepEqual(taskCalls(tto('MAIN')), ['MAIN', 'PRG_Other']);
  assert.equal(renameTaskCalls(tto('MAIN'), 'main', 'MAIN_Test'), tto('MAIN_Test'), 'case aside');
  assert.equal(renameTaskCalls(crlf(tto('MAIN')), 'MAIN', 'MAIN_Test'), crlf(tto('MAIN_Test')));
  assert.equal(renameTaskCalls(tto('MAIN'), 'PRG_None', 'PRG_X'), tto('MAIN'), 'a program it does not call');
});

test('the folders to move a file to: those of the items and those of the files, once each, in the order of the items', () => {
  const plc = parsePlcProject('Plc.plcproj', plcproj(['POUs\\Sub\\Deep\\FB_D.TcPOU', 'DUTs\\ST_A.TcDUT', 'pous\\FB_X.TcPOU', 'FB_Root.TcPOU'],
    ['DUTs', 'GVLs', 'VISUs', 'POUs', 'Zone']));
  assert.deepEqual(projectFolderList(plc), ['DUTs', 'GVLs', 'POUs', 'POUs\\Sub', 'POUs\\Sub\\Deep', 'VISUs', 'Zone']);
});

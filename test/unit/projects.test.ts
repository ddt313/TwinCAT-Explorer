import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { onlyTmcHashChanged } from '../../src/core/objectChanges';
import { parseTsProject, parseXtiProject, xtiPathOf } from '../../src/core/project';
import { TcWorkspace, fileKey } from '../../src/core/workspace';

/** The <Project> of a PLC project as TwinCAT 3.1.4026 writes it in a .tsproj, or in an .xti. */
const plcProject = (name: string, prj: string, tmcHash = '') => `<Project GUID="{deba1dd2-802c-4176-8ddd-3ab2adef1f8b}" Name="${name}" PrjFilePath="${prj}" TmcFilePath="${prj.replace('.plcproj', '.tmc')}" ReloadTmc="true" AmsPort="851" FileArchiveSettings="#x000e" SymbolicMapping="true">
		<Instance Id="#x08502000" TcSmClass="TComPlcObjDef" KeepUnrestoredLinks="2"${tmcHash ? ` TmcHash="{${tmcHash}}"` : ''}>
			<Name>${name} Instance</Name>
			<CLSID ClassFactory="TcPlc30">{08500001-0000-0000-F000-000000000064}</CLSID>
		</Instance>
	</Project>`;

const tsproj = (plc: string) => `<?xml version="1.0"?>
<TcSmProject xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" TcSmVersion="1.0" TcVersion="3.1.4026.27">
	<Project ProjectGUID="{aaaaaaaa-0000-4000-8000-000000000001}" ShowHideConfigurations="#x106">
		<System>
			<Tasks>
				<Task Id="3" Priority="20" CycleTime="100000" AmsPort="350" AdtTasks="true">
					<Name>PlcTask</Name>
				</Task>
			</Tasks>
		</System>
		<Plc>
			${plc}
		</Plc>
	</Project>
</TcSmProject>`.replace(/\n/g, '\r\n');

/** An Independent Project File (.xti) of a PLC project, as XAE 3.1.4026 saves it in _Config\PLC. */
const xti = (name: string, tmcHash = '') => `<?xml version="1.0"?>
<TcSmItem xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.beckhoff.com/schemas/2012/07/TcSmProject" TcSmVersion="1.0" TcVersion="3.1.4026.27" ClassName="CNestedPlcProjDef">
	${plcProject(name, `..\\..\\${name}\\${name}.plcproj`, tmcHash)}
</TcSmItem>`.replace(/\n/g, '\r\n');

const plcproj = (name: string, files: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Name>${name}</Name>
  </PropertyGroup>
  <ItemGroup>
${files.map(f => `    <Compile Include="${f}">\r\n      <SubType>Code</SubType>\r\n    </Compile>`).join('\r\n')}
  </ItemGroup>
</Project>`.replace(/\r?\n/g, '\r\n');

const pou = (name: string) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.27">
  <POU Name="${name}" Id="{cccccccc-0000-4000-8000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK ${name}
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

test('a .tsproj names its PLC projects, held in it or in Independent Project Files, in its order', () => {
  const at = path.resolve('S', 'TS.tsproj');
  const ts = parseTsProject(at, tsproj(`<Project File="Plc.xti"/>
			${plcProject('Other', 'Other\\Other.plcproj')}`));
  assert.deepEqual(ts.plcProjects, [
    { name: 'Plc', plcprojPath: '', xtiPath: path.resolve('S', '_Config', 'PLC', 'Plc.xti') },
    { name: 'Other', plcprojPath: path.resolve('S', 'Other', 'Other.plcproj') },
  ]);
  assert.equal(xtiPathOf(at, 'Plc.xti'), path.resolve('S', '_Config', 'PLC', 'Plc.xti'));
  // The .xti holds the <Project>: its PrjFilePath goes from the folder of the .xti.
  const xtiPath = path.resolve('S', '_Config', 'PLC', 'Plc.xti');
  assert.deepEqual(parseXtiProject(xtiPath, xti('Plc')), { name: 'Plc', plcprojPath: path.resolve('S', 'Plc', 'Plc.plcproj'), xtiPath });
  assert.throws(() => parseXtiProject(xtiPath, '<?xml version="1.0"?>\r\n<TcSmItem ClassName="CNestedPlcProjDef"/>'), /no PLC project/);
  // A build rewrites the TmcHash of the instance in the .xti, as in a .tsproj.
  assert.equal(onlyTmcHashChanged(xti('Plc', '3767C23C-F2F3-D01B-CB8F-E4F6371EEFF5'), xti('Plc', 'EB73BC65-46DC-7AEF-25F4-88E7ACE33CAB')), true);
});

test('the workspace reads the PLC projects of .xti files, beside those of the .tsproj; a missing or broken .xti is an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-xti-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    // Only an .xti.
    write('A/A.tsproj', tsproj('<Project File="Plc.xti"/>'));
    write('A/_Config/PLC/Plc.xti', xti('Plc'));
    write('A/Plc/Plc.plcproj', plcproj('Plc', ['POUs\\FB_A.TcPOU']));
    write('A/Plc/POUs/FB_A.TcPOU', pou('FB_A'));
    // Both kinds in one .tsproj.
    write('B/B.tsproj', tsproj(`<Project File="Machine.xti"/>
			${plcProject('Cell', 'Cell\\Cell.plcproj')}`));
    write('B/_Config/PLC/Machine.xti', xti('Machine'));
    write('B/Machine/Machine.plcproj', plcproj('Machine', ['POUs\\FB_M.TcPOU']));
    write('B/Machine/POUs/FB_M.TcPOU', pou('FB_M'));
    write('B/Cell/Cell.plcproj', plcproj('Cell', ['POUs\\FB_C.TcPOU']));
    write('B/Cell/POUs/FB_C.TcPOU', pou('FB_C'));
    // An .xti that is not there, and one that holds no PLC project.
    write('C/C.tsproj', tsproj('<Project File="Missing.xti"/>\r\n\t\t\t<Project File="Broken.xti"/>'));
    write('C/_Config/PLC/Broken.xti', '<?xml version="1.0"?>\r\n<TcSmItem ClassName="CNestedPlcProjDef"/>');

    const ws = new TcWorkspace();
    ws.load(['A/A.tsproj', 'B/B.tsproj', 'C/C.tsproj'].map(p => path.join(root, p)));
    const at = (...p: string[]) => path.join(root, ...p);
    assert.deepEqual(ws.tsProjects.map(t => [t.name, t.plcProjects.map(r => r.name)]), [['A', ['Plc']], ['B', ['Machine', 'Cell']], ['C', ['Missing', 'Broken']]]);
    assert.deepEqual(ws.plcProjects.map(p => p.name), ['Plc', 'Machine', 'Cell']);
    assert.deepEqual(ws.sourceEntries.map(e => path.basename(e.path)).sort(), ['FB_A.TcPOU', 'FB_C.TcPOU', 'FB_M.TcPOU']);
    assert.equal(ws.entry(at('A', 'Plc', 'POUs', 'FB_A.TcPOU'))?.project.name, 'Plc');
    assert.equal(ws.getFile(at('B', 'Machine', 'POUs', 'FB_M.TcPOU'))?.root?.name, 'FB_M');
    // The .xti files are project files, read or not; those that could not be read are errors.
    for (const p of [at('A', '_Config', 'PLC', 'Plc.xti'), at('C', '_Config', 'PLC', 'Missing.xti'), at('A', 'Plc', 'Plc.plcproj'), at('B', 'B.tsproj')]) {
      assert.ok(ws.isProjectFile(p), p);
    }
    assert.ok(!ws.isProjectFile(at('A', 'Plc', 'POUs', 'FB_A.TcPOU')));
    assert.equal(ws.loadErrors.length, 2);
    assert.match(ws.loadErrors[0], /Missing\.xti: The Independent Project File \(\.xti\) is not there$/);
    assert.match(ws.loadErrors[1], /Broken\.xti: The file holds no PLC project/);
    const missing = ws.tsProjects[2].plcProjects[0];
    assert.equal(missing.plcprojPath, at('C', '_Config', 'PLC', 'Missing.xti'), 'the reference points at the .xti');
    assert.equal(ws.failedPlc.get(fileKey(missing.plcprojPath)), 'The Independent Project File (.xti) is not there');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

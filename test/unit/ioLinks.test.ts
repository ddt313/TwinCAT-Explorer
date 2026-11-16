import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { IoLinkIndex, describeTarget, parseIoLinks, parseProcessImage } from '../../src/core/ioLinks';

// Written by hand, after what samples/Add-DemoIo.ps1 makes of samples/Demo: replace with the files XAE saves.

const EL1008 = 'TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)';
const EL2008 = 'TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 3 (EL2008)';
const EL3064 = 'TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 4 (EL3064)';

const vars = (group: string, type: number, list: [string, string][]) => `<Vars VarGrpType="${type}"${type === 2 ? ' AreaNo="1"' : ''}>
						<Name>${group}</Name>
${list.map(([n, t]) => `						<Var>
							<Name>${n}</Name>
							<Type>${t}</Type>
						</Var>`).join('\n')}
					</Vars>`;

const tsproj = `<?xml version="1.0"?>
<TcSmProject xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" TcSmVersion="1.0" TcVersion="3.1.4026.27">
	<Project ProjectGUID="{0791B867-FE30-4C16-923A-21C4FE1FBE2A}" Target64Bit="true" ShowHideConfigurations="#x6">
		<Io>
			<Device File="Device 1 (EtherCAT).xti" Id="1"/>
		</Io>
		<Plc>
			<Project GUID="{8A45A8CD-7F9D-4450-A569-9E2CBD3491A4}" Name="Machine" PrjFilePath="Machine\\Machine.plcproj" TmcFilePath="Machine\\Machine.tmc" ReloadTmc="true" AmsPort="851" SymbolicMapping="true">
				<Instance Id="#x08502000" TcSmClass="TComPlcObjDef" KeepUnrestoredLinks="2">
					<Name>Machine Instance</Name>
					${vars('PlcTask Outputs', 2, [['GVL_IO.bInletOpen', 'BOOL'], ['GVL_IO.bConveyorRun', 'BOOL'], ['GVL_IO.aLamps', 'ARRAY [1..3] OF BOOL'], ['GVL_IO.bSpareOut', 'BOOL']])}
					${vars('PlcTask Inputs', 1, [['GVL_IO.nLevelRaw', 'INT'], ['GVL_IO.bStartButton', 'BOOL'], ['GVL_IO.stDrive', 'ST_DriveIn'], ['MAIN.fbSensorLeft.bSignal', 'BOOL'], ['MAIN.fbSensorRight.bSignal', 'BOOL']])}
				</Instance>
			</Project>
			<Project GUID="{41141F77-B115-4B9A-98A1-E9C57BC21C0F}" Name="DemoLib" PrjFilePath="DemoLib\\DemoLib.plcproj" TmcFilePath="DemoLib\\DemoLib.tmc" ReloadTmc="true" AmsPort="852" SymbolicMapping="true">
				<Instance Id="#x08502040" TcSmClass="TComPlcObjDef" KeepUnrestoredLinks="2">
					<Name>DemoLib Instance</Name>
				</Instance>
			</Project>
		</Plc>
		<Mappings>
			<OwnerA Name="TIPC^Machine^Machine Instance">
				<OwnerB Name="${EL1008}">
					<Link VarA="PlcTask Inputs^GVL_IO.bStartButton" VarB="Channel 1^Input"/>
					<Link VarA="PlcTask Inputs^MAIN.fbSensorLeft.bSignal" VarB="Channel 2^Input"/>
					<Link VarA="PlcTask Inputs^GVL_IO.stDrive.bReady" VarB="Channel 3^Input"/>
					<Link VarA="PlcTask Inputs^GVL_IO.stDrive^bFault" VarB="Channel 4^Input"/>
				</OwnerB>
				<OwnerB Name="${EL2008}">
					<Link VarA="PlcTask Outputs^GVL_IO.bInletOpen" VarB="Channel 1^Output"/>
					<Link VarA="PlcTask Outputs^GVL_IO.bConveyorRun" VarB="Channel 2^Output"/>
					<Link VarA="PlcTask Outputs^GVL_IO.aLamps^GVL_IO.aLamps[1]" VarB="Channel 3^Output"/>
					<Link VarA="PlcTask Outputs^GVL_IO.aLamps[2]" VarB="Channel 4^Output"/>
				</OwnerB>
				<OwnerB Name="TIPC^Other^Other Instance">
					<Link VarA="PlcTask Outputs^GVL_IO.bOldName" VarB="PlcTask Inputs^GVL_In.bFromMachine"/>
				</OwnerB>
			</OwnerA>
			<OwnerA Name="${EL3064}">
				<OwnerB Name="TIPC^Machine^Machine Instance">
					<Link VarA="AI Standard Channel 1^Value" VarB="PlcTask Inputs^GVL_IO.nLevelRaw" Size="12" OffsA="0" OffsB="4"/>
				</OwnerB>
			</OwnerA>
			<OwnerA Name="TINC^NC-Task 1 SAF^Axes^Axis 1">
				<OwnerB Name="TIPC^Machine^Machine Instance">
					<Link VarA="Enc^Inputs^In^nDataIn1" VarB="PlcTask Inputs^MAIN.stAxisIn.nPos"/>
				</OwnerB>
			</OwnerA>
		</Mappings>
	</Project>
</TcSmProject>`.replace(/\n/g, '\r\n');

const links = parseIoLinks(tsproj);
const index = new IoLinkIndex(links, parseProcessImage(tsproj));

test('I/O links: the variable and the other end of each link, whichever owner is the PLC', () => {
  assert.deepEqual(links.map(l => `${l.plc}: ${l.group} ${l.variable} -> ${l.targetKind} ${l.target.split('^').pop()} ${l.targetVar}`), [
    'Machine: PlcTask Inputs GVL_IO.bStartButton -> io Term 2 (EL1008) Channel 1^Input',
    'Machine: PlcTask Inputs MAIN.fbSensorLeft.bSignal -> io Term 2 (EL1008) Channel 2^Input',
    'Machine: PlcTask Inputs GVL_IO.stDrive.bReady -> io Term 2 (EL1008) Channel 3^Input',
    'Machine: PlcTask Inputs GVL_IO.stDrive.bFault -> io Term 2 (EL1008) Channel 4^Input',
    'Machine: PlcTask Outputs GVL_IO.bInletOpen -> io Term 3 (EL2008) Channel 1^Output',
    'Machine: PlcTask Outputs GVL_IO.bConveyorRun -> io Term 3 (EL2008) Channel 2^Output',
    'Machine: PlcTask Outputs GVL_IO.aLamps[1] -> io Term 3 (EL2008) Channel 3^Output',
    'Machine: PlcTask Outputs GVL_IO.aLamps[2] -> io Term 3 (EL2008) Channel 4^Output',
    'Machine: PlcTask Outputs GVL_IO.bOldName -> plc Other Instance PlcTask Inputs^GVL_In.bFromMachine',
    'Other: PlcTask Inputs GVL_In.bFromMachine -> plc Machine Instance PlcTask Outputs^GVL_IO.bOldName',
    'Machine: PlcTask Inputs GVL_IO.nLevelRaw -> io Term 4 (EL3064) AI Standard Channel 1^Value',
    'Machine: PlcTask Inputs MAIN.stAxisIn.nPos -> nc Axis 1 Enc^Inputs^In^nDataIn1',
  ]);
});

test('I/O links: a link of part of a variable has its bits on the side of each', () => {
  const l = index.linksOf('Machine', 'GVL_IO.nLevelRaw').own[0];
  assert.deepEqual([l.size, l.offset, l.targetOffset], [12, 4, 0]);
  assert.equal(describeTarget(l), 'Device 1 (EtherCAT) › Term 1 (EK1100) › Term 4 (EL3064) › AI Standard Channel 1 › Value (12 bits at bit 4)');
});

test('I/O links: looked up by variable, case aside, with the links of its members, elements and FB variables', () => {
  const show = (plc: string, v: string) => {
    const r = index.linksOf(plc, v);
    return { own: r.own.map(l => describeTarget(l)), parts: r.parts.map(l => l.variable) };
  };
  assert.deepEqual(show('machine', 'gvl_io.BSTARTBUTTON'), {
    own: ['Device 1 (EtherCAT) › Term 1 (EK1100) › Term 2 (EL1008) › Channel 1 › Input'], parts: [],
  });
  assert.deepEqual(show('Machine', 'GVL_IO.stDrive'), { own: [], parts: ['GVL_IO.stDrive.bReady', 'GVL_IO.stDrive.bFault'] });
  assert.deepEqual(show('Machine', 'GVL_IO.aLamps'), { own: [], parts: ['GVL_IO.aLamps[1]', 'GVL_IO.aLamps[2]'] });
  assert.deepEqual(show('Machine', 'GVL_IO.aLamps[ 2 ]').own.length, 1);
  assert.deepEqual(show('Machine', 'MAIN.fbSensorLeft'), { own: [], parts: ['MAIN.fbSensorLeft.bSignal'] });
  assert.deepEqual(show('Machine', 'MAIN.fbSensorRight'), { own: [], parts: [] });
  // A name that only starts like another is not part of it.
  assert.deepEqual(show('Machine', 'GVL_IO.bStart'), { own: [], parts: [] });
});

test('I/O links: the process image, with the direction of each group', () => {
  const v = index.imageVar('Machine', 'GVL_IO.aLamps');
  assert.deepEqual(v, { plc: 'Machine', instance: 'Machine Instance', group: 'PlcTask Outputs', direction: 'output', variable: 'GVL_IO.aLamps', type: 'ARRAY [1..3] OF BOOL' });
  assert.equal(index.imageVar('Machine', 'GVL_IO.nLevelRaw')?.direction, 'input');
});

test('I/O links: variables of the process image linked to nothing, not even in part', () => {
  assert.deepEqual(index.unlinked('Machine').map(v => v.variable), ['GVL_IO.bSpareOut', 'MAIN.fbSensorRight.bSignal']);
});

test('I/O links: a PLC project the project links nothing of has no unlinked variable', () => {
  assert.equal(index.hasLinks('DemoLib'), false);
  assert.deepEqual(index.unlinked('DemoLib'), []);
  const noMappings = tsproj.replace(/<Mappings>[\s\S]*<\/Mappings>/, '');
  const bare = new IoLinkIndex(parseIoLinks(noMappings), parseProcessImage(noMappings));
  assert.equal(bare.hasLinks('Machine'), false);
  assert.deepEqual(bare.unlinked('Machine'), []);
});

test('I/O links: links of variables the process image no longer has are stale', () => {
  assert.deepEqual(index.stale('Machine').map(l => l.variable), ['GVL_IO.bOldName', 'MAIN.stAxisIn.nPos']);
  // Without a process image (Other's is in no file here) nothing is known to be stale.
  assert.deepEqual(index.stale('Other'), []);
});

test('I/O links: the process image of a PLC project saved in an Independent Project File', () => {
  const xti = `<?xml version="1.0"?>
<TcSmItem xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" TcSmVersion="1.0" TcVersion="3.1.4026.27" ClassName="CNestedPlcProjDef">
	<Project GUID="{deba1dd2-802c-4176-8ddd-3ab2adef1f8b}" Name="Plc" PrjFilePath="..\\..\\Plc\\Plc.plcproj" TmcFilePath="..\\..\\Plc\\Plc.tmc" ReloadTmc="true" AmsPort="851">
		<Instance Id="#x08502000" TcSmClass="TComPlcObjDef" KeepUnrestoredLinks="2">
			<Name>Plc Instance</Name>
			${vars('PlcTask Inputs', 1, [['GVL.bIn', 'BOOL']])}
		</Instance>
	</Project>
</TcSmItem>`.replace(/\n/g, '\r\n');
  assert.deepEqual(parseProcessImage(xti), [{ plc: 'Plc', instance: 'Plc Instance', group: 'PlcTask Inputs', direction: 'input', variable: 'GVL.bIn', type: 'BOOL' }]);
  assert.deepEqual(parseIoLinks(xti), []);
});

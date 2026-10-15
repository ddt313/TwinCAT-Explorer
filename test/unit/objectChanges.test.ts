import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTcText } from '../../src/core/tcfile';
import { changeKey, objectChanges } from '../../src/core/objectChanges';

const FB = '{11111111-1111-1111-1111-111111111111}';
const RUN = '{22222222-2222-2222-2222-222222222222}';
const STOP = '{33333333-3333-3333-3333-333333333333}';
const PROP = '{44444444-4444-4444-4444-444444444444}';
const GET = '{55555555-5555-5555-5555-555555555555}';
const SET = '{66666666-6666-6666-6666-666666666666}';

const id = (guid: string) => guid.replace(/[{}]/g, '');

function pou(opts: { version?: string; run?: string; runName?: string; stop?: boolean; get?: string; set?: boolean; body?: string } = {}): string {
  const method = (guid: string, name: string, impl: string) => `
    <Method Name="${name}" Id="${guid}">
      <Declaration><![CDATA[METHOD ${name}]]></Declaration>
      <Implementation>
        <ST><![CDATA[${impl}]]></ST>
      </Implementation>
    </Method>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="${opts.version ?? '3.1.4026.13'}">
  <POU Name="FB_Test" Id="${FB}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Test
VAR
	nCount : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[${opts.body ?? ''}]]></ST>
    </Implementation>${method(RUN, opts.runName ?? 'Run', opts.run ?? 'nCount := nCount + 1;')}${opts.stop ? method(STOP, 'Stop', 'nCount := 0;') : ''}
    <Property Name="Count" Id="${PROP}">
      <Declaration><![CDATA[PROPERTY Count : INT]]></Declaration>
      <Get Name="Get" Id="${GET}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[${opts.get ?? 'Count := nCount;'}]]></ST>
        </Implementation>
      </Get>${opts.set ? `
      <Set Name="Set" Id="${SET}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[nCount := Count;]]></ST>
        </Implementation>
      </Set>` : ''}
    </Property>
  </POU>
</TcPlcObject>`;
}

const parse = (text: string) => parseTcText('FB_Test.TcPOU', text);

test('an unchanged file has no object changes, whatever its metadata', () => {
  assert.deepEqual([...objectChanges(parse(pou()), parse(pou({ version: '3.1.4026.21' })))], []);
});

test('a method with other code is modified, the POU itself is not', () => {
  const changes = objectChanges(parse(pou()), parse(pou({ run: 'nCount := nCount + 2;' })));
  assert.deepEqual([...changes], [[id(RUN), 'modified']]);
});

test('a renamed method is modified', () => {
  const changes = objectChanges(parse(pou()), parse(pou({ runName: 'Execute' })));
  assert.equal(changes.get(id(RUN)), 'modified');
});

test('a new method is added', () => {
  const changes = objectChanges(parse(pou()), parse(pou({ stop: true })));
  assert.deepEqual([...changes], [[id(STOP), 'added']]);
});

test('a changed accessor marks the accessor and its property', () => {
  const changes = objectChanges(parse(pou()), parse(pou({ get: 'Count := nCount * 2;' })));
  assert.equal(changes.get(id(PROP)), 'modified');
  assert.equal(changes.get(changeKey(id(PROP), 'Get')), 'modified');
  assert.equal(changes.get(changeKey(id(PROP), 'Set')), undefined);
});

test('a new accessor is added and its property is modified', () => {
  const changes = objectChanges(parse(pou()), parse(pou({ set: true })));
  assert.equal(changes.get(changeKey(id(PROP), 'Set')), 'added');
  assert.equal(changes.get(id(PROP)), 'modified');
  assert.equal(changes.get(changeKey(id(PROP), 'Get')), undefined);
});

test('the POU body counts for the POU only', () => {
  const changes = objectChanges(parse(pou()), parse(pou({ body: 'Run();' })));
  assert.deepEqual([...changes], [[id(FB), 'modified']]);
});

test('every object of a new file is added', () => {
  const changes = objectChanges(undefined, parse(pou({ set: true })));
  assert.equal(changes.get(id(FB)), 'added');
  assert.equal(changes.get(id(RUN)), 'added');
  assert.equal(changes.get(id(PROP)), 'added');
  assert.equal(changes.get(changeKey(id(PROP), 'Get')), 'added');
  assert.equal(changes.get(changeKey(id(PROP), 'Set')), 'added');
});

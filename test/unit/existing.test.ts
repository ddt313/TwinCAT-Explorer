import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { ChosenFile, ProjectState, objectIds, planExistingFiles, withNewIds } from '../../src/core/existing';
import { XAE_FILE_STYLE, newObjectText } from '../../src/core/newObjects';
import { addMember } from '../../src/core/splice';
import { decodeBytes, encodeText, parseTcText } from '../../src/core/tcfile';

const guid = (n: number) => `{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}`;
const plain = (n: number) => guid(n).slice(1, -1);

/** A function block as XAE 3.1.4026 writes it (BOM, CRLF), with a method when `method` is given. */
function fb(name: string, id: number, method?: [string, number]): string {
  const text = newObjectText({ kind: 'fb', name }, XAE_FILE_STYLE, guid(id));
  if (!method) return text;
  const file = parseTcText(`${name}.TcPOU`, text, true);
  return addMember(file, file.root!.id, { kind: 'method', name: method[0], type: 'BOOL' }, () => guid(method[1]));
}

const bytes = (text: string) => encodeText(text, true);
const P = path.resolve('P');
const X = path.resolve('X');

/** A PLC project with FB_A (and its method M_A) in POUs and FB_Here in POUs\Target. */
function project(): ProjectState {
  return {
    dir: P,
    compile: ['PlcTask.TcTTO', 'POUs\\FB_A.TcPOU', 'POUs\\Target\\FB_Here.TcPOU'],
    folders: ['DUTs', 'GVLs', 'POUs', 'POUs\\Target', 'VISUs'],
    names: new Map([['FB_A', 'a POU named FB_A'], ['FB_HERE', 'a POU named FB_Here']]),
    ids: new Set([...objectIds(fb('FB_A', 1, ['M_A', 2])), ...objectIds(fb('FB_Here', 3))]),
  };
}

const ids = () => {
  let n = 100;
  return () => guid(++n);
};

test('existing items: copied into the folder byte for byte, or added where they are; what is skipped and why', () => {
  const chosen: ChosenFile[] = [
    { path: path.join(X, 'FB_Ext.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Ext', 10, ['M_Run', 11])) },
    { path: path.join(P, 'POUs', 'Target', 'FB_Local.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Local', 12)) },
    { path: path.join(X, 'ST_Ext.TcDUT'), subfolder: '', bytes: bytes(newObjectText({ kind: 'struct', name: 'ST_Ext' }, XAE_FILE_STYLE, guid(13))) },
    { path: path.join(X, 'I_Ext.TcIO'), subfolder: '', bytes: bytes(newObjectText({ kind: 'itf', name: 'I_Ext' }, XAE_FILE_STYLE, guid(14))) },
    { path: path.join(X, 'notes.txt'), subfolder: '', bytes: bytes('notes') },
    { path: path.join(X, 'FB_Locked.TcPOU'), subfolder: '', error: 'EBUSY: resource busy or locked' },
    { path: path.join(X, 'FB_Wrong.TcPOU'), subfolder: '', bytes: bytes(newObjectText({ kind: 'gvl', name: 'FB_Wrong' }, XAE_FILE_STYLE, guid(15))) },
    { path: path.join(X, 'FB_A.TcPOU'), subfolder: '', bytes: bytes(fb('fb_a', 16)) },
    { path: path.join(P, 'POUs', 'Target', 'FB_Here.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Here', 3)) },
    { path: path.join(X, 'FB_Busy.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Busy', 17)) },
    { path: path.join(X, 'Again', 'FB_Ext.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Ext', 18)) },
  ];
  const busy = path.join(P, 'POUs', 'Target', 'FB_Busy.TcPOU');
  const plan = planExistingFiles(project(), 'POUs\\Target', chosen, p => p === busy, ids());
  assert.deepEqual(plan.files.map(f => [f.name, f.include, f.copy, f.newIds.length]), [
    ['FB_Ext', 'POUs\\Target\\FB_Ext.TcPOU', true, 0],
    ['FB_Local', 'POUs\\Target\\FB_Local.TcPOU', false, 0],
    ['ST_Ext', 'POUs\\Target\\ST_Ext.TcDUT', true, 0],
    ['I_Ext', 'POUs\\Target\\I_Ext.TcIO', true, 0],
  ]);
  assert.equal(plan.files[0].target, path.join(P, 'POUs', 'Target', 'FB_Ext.TcPOU'));
  assert.deepEqual(plan.files[0].bytes, chosen[0].bytes, 'a copy, byte for byte');
  assert.equal(plan.files[0].objectId, plain(10));
  assert.equal(plan.files[1].bytes, undefined, 'already there: nothing to write');
  assert.deepEqual(plan.folders, []);
  assert.deepEqual(plan.skipped.map(s => [path.basename(s.source), s.reason]), [
    ['notes.txt', 'not a POU, DUT, GVL or interface file'],
    ['FB_Locked.TcPOU', 'cannot be read: EBUSY: resource busy or locked'],
    ['FB_Wrong.TcPOU', 'holds no POU TwinCAT can read'],
    ['FB_A.TcPOU', 'the PLC project has a POU named FB_A already'],
    ['FB_Here.TcPOU', 'in the PLC project already'],
    ['FB_Busy.TcPOU', 'FB_Busy.TcPOU is on disk in POUs\\Target already'],
    ['FB_Ext.TcPOU', 'another file chosen goes there'],
  ]);
});

test('a copy of an object of the project gets new GUIDs for those the project has, only those, as XAE gives them', () => {
  const copy = fb('FB_A', 1, ['M_A', 2]).split('FB_A').join('FB_Copy');
  const rootClash = fb('FB_RootClash', 1, ['M_A', 20]);
  const memberClash = fb('FB_MemberClash', 21, ['M_A', 2]);
  const plan = planExistingFiles(project(), 'POUs', [
    { path: path.join(X, 'FB_Copy.TcPOU'), subfolder: '', bytes: bytes(copy) },
    { path: path.join(X, 'FB_RootClash.TcPOU'), subfolder: '', bytes: bytes(rootClash) },
    { path: path.join(X, 'FB_MemberClash.TcPOU'), subfolder: '', bytes: bytes(memberClash) },
  ], () => false, ids());
  assert.deepEqual(plan.files.map(f => [f.name, f.newIds]), [
    ['FB_Copy', [[guid(1), guid(101)], [guid(2), guid(102)]]],
    ['FB_RootClash', [[guid(1), guid(103)]]],
    ['FB_MemberClash', [[guid(2), guid(104)]]],
  ]);
  // The rest stays byte for byte: BOM, CRLF, everything but the GUIDs.
  const written = decodeBytes(plan.files[0].bytes!);
  assert.equal(written.bom, true);
  assert.equal(written.text, copy.replace(guid(1), guid(101)).replace(guid(2), guid(102)));
  assert.equal(plan.files[0].objectId, plain(101), 'the object is found by its new GUID');
  assert.equal(plan.files[2].objectId, plain(21));
  // GUIDs given in the plan count for the files after them.
  const twice = planExistingFiles(project(), 'POUs', [
    { path: path.join(X, 'FB_One.TcPOU'), subfolder: '', bytes: bytes(fb('FB_One', 30)) },
    { path: path.join(X, 'FB_Two.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Two', 30)) },
  ], () => false, ids());
  assert.deepEqual(twice.files.map(f => f.newIds), [[], [[guid(30), guid(101)]]]);
  // withNewIds and objectIds on their own.
  assert.deepEqual(objectIds(copy), [plain(1), plain(2)]);
  assert.deepEqual(withNewIds(copy, new Set(), ids()), { text: copy, newIds: [] });
});

test('folder content: a sub-folder goes into a sub-folder of the same name, with the <Folder> items it lacks', () => {
  const plan = planExistingFiles(project(), 'POUs\\Target', [
    { path: path.join(X, 'Dir', 'FB_InDir.TcPOU'), subfolder: '', bytes: bytes(fb('FB_InDir', 40)) },
    { path: path.join(X, 'Dir', 'Sub', 'Deep', 'GVL_Deep.TcGVL'), subfolder: 'Sub\\Deep',
      bytes: bytes(newObjectText({ kind: 'gvl', name: 'GVL_Deep' }, XAE_FILE_STYLE, guid(41))) },
    { path: path.join(X, 'Dir', 'Sub', 'notes.txt'), subfolder: 'Sub', bytes: bytes('notes') },
  ], () => false, ids());
  assert.deepEqual(plan.files.map(f => f.include), ['POUs\\Target\\FB_InDir.TcPOU', 'POUs\\Target\\Sub\\Deep\\GVL_Deep.TcGVL']);
  assert.deepEqual(plan.folders, ['POUs\\Target\\Sub', 'POUs\\Target\\Sub\\Deep']);
  // The target folder's own folder on disk, as after a merge: what is not in the project yet is added where it is.
  const merged = planExistingFiles(project(), 'POUs\\Target', [
    { path: path.join(P, 'POUs', 'Target', 'FB_Here.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Here', 3)) },
    { path: path.join(P, 'POUs', 'Target', 'FB_Merged.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Merged', 42)) },
    { path: path.join(P, 'POUs', 'Target', 'Deep', 'FB_Deep.TcPOU'), subfolder: 'Deep', bytes: bytes(fb('FB_Deep', 43)) },
  ], () => true, ids());
  assert.deepEqual(merged.files.map(f => [f.include, f.copy, f.bytes]), [
    ['POUs\\Target\\FB_Merged.TcPOU', false, undefined],
    ['POUs\\Target\\Deep\\FB_Deep.TcPOU', false, undefined],
  ]);
  assert.deepEqual(merged.folders, ['POUs\\Target\\Deep']);
  assert.deepEqual(merged.skipped.map(s => s.reason), ['in the PLC project already']);
  // Into the PLC project itself, and a folder it has already.
  const root = planExistingFiles(project(), '', [
    { path: path.join(X, 'FB_Top.TcPOU'), subfolder: '', bytes: bytes(fb('FB_Top', 44)) },
    { path: path.join(X, 'POUs', 'FB_InPous.TcPOU'), subfolder: 'pous', bytes: bytes(fb('FB_InPous', 45)) },
  ], () => false, ids());
  assert.deepEqual(root.files.map(f => f.include), ['FB_Top.TcPOU', 'pous\\FB_InPous.TcPOU']);
  assert.deepEqual(root.folders, [], 'POUs is there, case aside');
});

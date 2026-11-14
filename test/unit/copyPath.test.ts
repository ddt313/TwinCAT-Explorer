// https://github.com/ddt313/TwinCAT-Explorer/issues/125
// Copy Path and Copy Relative Path beside Copy Name in the TwinCAT tree, for the nodes a file backs.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { relativePathText } from '../../src/core/paths';

interface MenuItem { command: string; when?: string; group?: string }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
const treeMenu: MenuItem[] = manifest.contributes.menus['view/item/context'];
const palette: MenuItem[] = manifest.contributes.menus.commandPalette;

test('copy path: Copy Path and Copy Relative Path are commands, hidden from the Command Palette', () => {
  const titles = new Map<string, string>(manifest.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
  assert.equal(titles.get('twincatExplorer.copyPath'), 'Copy Path');
  assert.equal(titles.get('twincatExplorer.copyRelativePath'), 'Copy Relative Path');
  for (const command of ['twincatExplorer.copyPath', 'twincatExplorer.copyRelativePath']) {
    assert.equal(palette.find(m => m.command === command)?.when, 'false', command);
  }
});

test('copy path: the TwinCAT tree shows them after Copy Name, on the nodes that have a file', () => {
  const item = (command: string) => treeMenu.find(m => m.command === command && m.when?.includes('view == twincatExplorer.tree'));
  const name = item('twincatExplorer.copyName');
  const copyPath = item('twincatExplorer.copyPath');
  const relative = item('twincatExplorer.copyRelativePath');
  assert.ok(name && copyPath && relative);
  assert.equal(copyPath.group, '9_copy@2');
  assert.equal(relative.group, '9_copy@3');
  // Nothing else of the tree's menu comes between them (Open XML used to sit at 9_copy@2).
  const between = treeMenu.filter(m => m.when?.includes('view == twincatExplorer.tree') && /^9_copy@[123]$/.test(m.group ?? ''));
  assert.deepEqual(between.map(m => m.command).sort(),
    ['twincatExplorer.copyName', 'twincatExplorer.copyPath', 'twincatExplorer.copyRelativePath']);
  // The context values of tree.ts: a node with a file (`hasFile`), POU, method, accessor, project, has them; a
  // folder or the References node has not.
  const viewItem = (when: string) => new RegExp(/viewItem =~ \/(.*?)\//.exec(when)![1]);
  for (const m of [copyPath, relative]) {
    const re = viewItem(m.when!);
    assert.ok(re.test('file openable hasFile stFile named objectFile'), 'POU file');
    assert.ok(re.test('object openable hasFile named'), 'method');
    assert.ok(re.test('accessor openable hasFile'), 'Get accessor');
    assert.ok(re.test('plcproj hasFile addObject expandable'), 'PLC project');
    assert.ok(re.test('tsproj hasFile expandable'), 'TwinCAT project');
    assert.ok(!re.test('folder addObject expandable'), 'folder');
    assert.ok(!re.test('references addLibrary expandable'), 'References');
    assert.ok(!re.test('library named'), 'library');
  }
});

test('copy path: the relative path takes the separator of explorer.copyRelativePathSeparator, as VS Code\'s Explorer does', () => {
  // vscode.workspace.asRelativePath gives `/` on every platform.
  const rel = 'Machine/Plc/POUs/MAIN.TcPOU';
  assert.equal(relativePathText(rel, '/', '\\'), rel);
  assert.equal(relativePathText(rel, '\\', '/'), 'Machine\\Plc\\POUs\\MAIN.TcPOU');
  assert.equal(relativePathText(rel, 'auto', '\\'), 'Machine\\Plc\\POUs\\MAIN.TcPOU');
  assert.equal(relativePathText(rel, 'auto', '/'), rel);
  assert.equal(relativePathText(rel, undefined, '\\'), 'Machine\\Plc\\POUs\\MAIN.TcPOU');
  // A file outside the workspace: asRelativePath returns its path, which keeps its own separators.
  assert.equal(relativePathText('C:\\Other\\MAIN.TcPOU', '/', '\\'), 'C:\\Other\\MAIN.TcPOU');
});

// The menu of an editor tab of a TwinCAT object: VS Code's own Copy Path and Copy Relative Path copy the tab's label
// there (`FB_Valve.Open`, the `twincat:` scheme's resourceLabelFormatters), so the extension adds its own.
test('copy path: an object\'s editor tab has Copy File Path, Copy Relative File Path and Copy Qualified Name', () => {
  const titles = new Map<string, string>(manifest.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
  assert.equal(titles.get('twincatExplorer.copyFilePath'), 'Copy File Path');
  assert.equal(titles.get('twincatExplorer.copyRelativeFilePath'), 'Copy Relative File Path');
  assert.equal(titles.get('twincatExplorer.copyQualifiedName'), 'Copy Qualified Name');
  const tab: MenuItem[] = manifest.contributes.menus['editor/title/context'] ?? [];
  for (const command of ['twincatExplorer.copyFilePath', 'twincatExplorer.copyRelativeFilePath', 'twincatExplorer.copyQualifiedName']) {
    const item = tab.find(m => m.command === command);
    assert.ok(item, command);
    assert.equal(item.when, 'resourceScheme == twincat', command);
    // In the Command Palette while such an editor is active.
    assert.equal(palette.find(m => m.command === command)?.when, 'resourceScheme == twincat', command);
  }
});

test('copy path: the tree has Copy Qualified Name after Copy Relative Path, on the nodes of an object', () => {
  const item = treeMenu.find(m => m.command === 'twincatExplorer.copyQualifiedName' && m.when?.includes('view == twincatExplorer.tree'));
  assert.ok(item);
  assert.equal(item.group, '9_copy@4');
  const re = new RegExp(/viewItem =~ \/(.*?)\//.exec(item.when!)![1]);
  assert.ok(re.test('object openable hasFile hasObject named'), 'method');
  assert.ok(re.test('file openable hasFile hasObject stFile named objectFile'), 'POU');
  assert.ok(!re.test('plcproj hasFile addObject expandable'), 'PLC project');
  assert.ok(!re.test('file hasFile named'), 'a file without an object (a task)');
});

test('copy path: the qualified name is the one the MCP server takes, with the PLC project, for a POU, method and accessor', async () => {
  const { TcWorkspace } = await import('../../src/core/workspace');
  const { Session } = await import('../../src/mcp/session');
  const { findFiles } = await import('./helpers');
  const sample = path.join(__dirname, '..', '..', '..', 'samples', 'Demo');
  const ws = new TcWorkspace();
  ws.load(findFiles(sample, '.tsproj'));
  const session = new Session(sample);
  session.refresh();
  const find = (name: string) => {
    for (const e of ws.sourceEntries) {
      for (const o of ws.getFile(e.path)?.ordered ?? []) if (o.qualifiedName === name) return { fsPath: e.path, id: o.id };
    }
    throw new Error(name);
  };
  const cases: [string, 'Get' | 'Set' | undefined, string][] = [
    ['FB_Valve', undefined, 'Machine:FB_Valve'],
    ['FB_Valve.Open', undefined, 'Machine:FB_Valve.Open'],
    ['FB_Conveyor.Speed', 'Set', 'Machine:FB_Conveyor.Speed.Set'],
    ['I_Valve.State', 'Get', 'DemoLib:I_Valve.State.Get'],
  ];
  for (const [name, accessor, expected] of cases) {
    const o = find(name);
    const qualified = ws.qualifiedName(o.fsPath, o.id, accessor);
    assert.equal(qualified, expected);
    const view = session.resolve(qualified!);
    assert.equal(view.obj.id, o.id, expected);
    assert.equal(view.accessor, accessor, expected);
  }
  assert.equal(ws.qualifiedName(find('FB_Valve').fsPath, 'no such id'), undefined);
});

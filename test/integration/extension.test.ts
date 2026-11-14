// The extension in a real VS Code, on a copy of samples/Demo under git (scripts/test-integration.js): activation,
// the TwinCAT tree, the split editor and the notebook, the language features VS Code asks for, saving, changes on
// disk, the TwinCAT Changes view and rename. The tests run in order: the last ones change files.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  EXTENSION_ID, api, childLabels, demoPath, objectId, openSplit, positionOf, test, treeNode, waitFor,
} from './harness';

const MAIN = 'Demo/Machine/POUs/MAIN.TcPOU';
const CONVEYOR = 'Demo/Machine/POUs/Equipment/FB_Conveyor.TcPOU';
const FILL = 'Demo/Machine/POUs/Sequences/FB_FillSequence.TcPOU';

/** Opens an object as a notebook; its cells are the declaration and the implementation. */
async function openNotebook(relative: string, name: string): Promise<vscode.NotebookDocument> {
  const a = await api();
  const fsPath = demoPath(relative);
  const editor = await a.openObject(fsPath, objectId(a, fsPath, name), { preview: false });
  assert.ok(editor, `${name} did not open as a notebook`);
  return editor.notebook;
}

function cellOf(nb: vscode.NotebookDocument, starts: RegExp): vscode.TextDocument {
  const cell = nb.getCells().find(c => starts.test(c.document.getText()));
  assert.ok(cell, `no cell matching ${starts} in ${nb.uri.toString()}`);
  return cell.document;
}

/** The text of the CDATA of an XML element of a file, e.g. the declaration of a POU. */
function cdata(text: string, element: string): string {
  const m = new RegExp(`<${element}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${element}>`).exec(text);
  assert.ok(m, `no <${element}> in the file`);
  return m[1];
}

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

function uriOf(l: vscode.Location | vscode.LocationLink): vscode.Uri {
  return 'targetUri' in l ? l.targetUri : l.uri;
}

/** The label of the object a `twincat:` or `twincat-loc:` URI points into, e.g. `FB_Valve · Declaration`. */
function objectLabel(uri: vscode.Uri): string {
  return JSON.parse(uri.query).label;
}

// ---------------------------------------------------------------------------------------------- activation and tree

test('activates by itself in a folder with a .tsproj, and gives its API', async () => {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension not installed');
  // Never activate() here: VS Code must activate it through its activation events.
  await waitFor(() => ext.isActive, 'activation through the activation events', 20000);
  const a = await api();
  assert.deepStrictEqual(a.workspace.tsProjects.map(p => p.name), ['Demo']);
});

test('TwinCAT tree: TwinCAT project, PLC projects, folders and objects as XAE shows them', async () => {
  const a = await api();
  assert.deepStrictEqual(childLabels(a), ['Demo']);
  assert.deepStrictEqual(childLabels(a, treeNode(a, ['Demo'])), ['Machine', 'DemoLib']);
  assert.deepStrictEqual(childLabels(a, treeNode(a, ['Demo', 'Machine'])), ['References', 'DUTs', 'GVLs', 'POUs', 'VISUs', 'PlcTask']);
  assert.ok(childLabels(a, treeNode(a, ['Demo', 'Machine', 'References'])).includes('DemoLib'));
  assert.deepStrictEqual(childLabels(a, treeNode(a, ['Demo', 'Machine', 'POUs'])), ['Equipment', 'Experimental', 'Sequences', 'MAIN (PRG)', 'PRG_Lamp (PRG)']);
  assert.deepStrictEqual(childLabels(a, treeNode(a, ['Demo', 'Machine', 'POUs', 'Equipment', 'FB_Conveyor (FB)'])), ['Speed', 'Start', 'Stop']);
  assert.deepStrictEqual(childLabels(a, treeNode(a, ['Demo', 'DemoLib', 'POUs', 'Valves', 'I_Valve'])), ['Close', 'Open', 'State']);
});

// ---------------------------------------------------------------------------------------------- editors

test('split editor: a POU opens in the custom editor with its declaration and implementation', async () => {
  const a = await api();
  const doc = await openSplit(a, MAIN, 'MAIN');
  assert.strictEqual(doc.uri.scheme, 'twincat');
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab?.input instanceof vscode.TabInputCustom, 'the active tab is not a custom editor');
  assert.strictEqual(tab.input.viewType, 'twincatExplorer.objectEditor');
  assert.strictEqual(tab.label, 'MAIN');
  const text = doc.getText();
  assert.ok(text.includes('PROGRAM MAIN\nVAR\n\tfbInlet\t\t: FB_Valve;'), 'declaration missing');
  assert.ok(text.includes('fbConveyor.Start();\nEND_IF'), 'implementation missing');
  assert.ok(text.indexOf('PROGRAM MAIN') < text.indexOf('fbConveyor.Start();'), 'implementation before declaration');
});

test('split editor: a method opens on its own, without the rest of its function block', async () => {
  const a = await api();
  const doc = await openSplit(a, CONVEYOR, 'Start');
  assert.ok(doc.getText().includes('METHOD Start'), 'method declaration missing');
  assert.ok(!doc.getText().includes('FUNCTION_BLOCK FB_Conveyor'), 'the function block shows in its method');
  assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'FB_Conveyor.Start');
});

test('notebook: one Structured Text cell per section', async () => {
  const nb = await openNotebook(MAIN, 'MAIN');
  assert.strictEqual(nb.notebookType, 'twincat-object');
  assert.strictEqual(nb.cellCount, 2);
  assert.deepStrictEqual(nb.getCells().map(c => c.document.languageId), ['twincat-st', 'twincat-st']);
  assert.match(nb.cellAt(0).document.getText(), /^PROGRAM MAIN\n/);
  assert.match(nb.cellAt(1).document.getText(), /^uRaw\.nValue := /);
});

// ---------------------------------------------------------------------------------------------- language features

test('go to definition: a function block of the same PLC project', async () => {
  const decl = cellOf(await openNotebook(MAIN, 'MAIN'), /^PROGRAM/);
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', decl.uri, positionOf(decl, 'FB_Valve'));
  assert.strictEqual(defs.length, 1);
  assert.match(objectLabel(uriOf(defs[0])), /^FB_Valve · Declaration/);
});

test('go to definition: a function of a referenced library project (DemoLib)', async () => {
  const impl = cellOf(await openNotebook(MAIN, 'MAIN'), /^uRaw/);
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', impl.uri, positionOf(impl, 'F_Clamp'));
  assert.strictEqual(defs.length, 1);
  assert.match(objectLabel(uriOf(defs[0])), /^F_Clamp · Declaration/);
  assert.ok(uriOf(defs[0]).path.startsWith('/Demo/DemoLib/'), uriOf(defs[0]).path);
});

test('find references: a variable in its declaration and in each use of the implementation', async () => {
  const decl = cellOf(await openNotebook(MAIN, 'MAIN'), /^PROGRAM/);
  const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', decl.uri, positionOf(decl, 'fbConveyor'));
  const labels = refs.map(r => objectLabel(r.uri));
  assert.strictEqual(labels.filter(l => l === 'MAIN · Declaration').length, 1);
  // fbConveyor(...), fbConveyor.bRunning, .Speed, .Start(), .bRunning
  assert.strictEqual(labels.filter(l => l === 'MAIN · Implementation').length, 5);
});

test('hover: the type of a variable and where it is declared', async () => {
  const impl = cellOf(await openNotebook(MAIN, 'MAIN'), /^uRaw/);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', impl.uri, positionOf(impl, 'fbInlet'));
  const text = hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value))).join('\n');
  assert.ok(text.includes('fbInlet : FB_Valve'), text);
  assert.ok(text.includes('VAR of MAIN'), text);
});

test('completion after a dot: the members of the function block, and nothing else', async () => {
  const impl = cellOf(await openNotebook(MAIN, 'MAIN'), /^uRaw/);
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', impl.uri, positionOf(impl, 'fbConveyor.Start', 0, 'fbConveyor.'.length));
  const labels = list.items.map(labelOf);
  for (const member of ['Start', 'Stop', 'Speed', 'bRunning', 'bEnable']) assert.ok(labels.includes(member), `${member} missing: ${labels.join(' ')}`);
  for (const other of ['MAIN', 'FB_Valve', 'END_IF']) assert.ok(!labels.includes(other), `${other} offered after a dot`);
});

test('signature help: the parameters of a function of a library', async () => {
  const impl = cellOf(await openNotebook(MAIN, 'MAIN'), /^uRaw/);
  const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    'vscode.executeSignatureHelpProvider', impl.uri, positionOf(impl, 'F_Clamp(', 0, 'F_Clamp('.length));
  assert.deepStrictEqual(help?.signatures.map(s => s.label), ['F_Clamp(fValue : LREAL, fMin : LREAL, fMax : LREAL) : LREAL']);
  assert.strictEqual(help.activeParameter, 0);
});

test('workspace symbols (Ctrl+T): a POU by part of its name', async () => {
  await api();
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'FB_Con');
  assert.ok(symbols.some(s => s.name === 'FB_Conveyor' && s.kind === vscode.SymbolKind.Class), symbols.map(s => s.name).join(', '));
});

test('Check Workspace: no problems in samples/Demo, not even in its code excluded from the build', async () => {
  await api();
  await vscode.commands.executeCommand('twincatExplorer.checkWorkspace');
  const problems = vscode.languages.getDiagnostics().filter(([, d]) => d.length > 0);
  assert.deepStrictEqual(problems.map(([u, d]) => `${u.toString()}: ${d.map(x => x.message).join('; ')}`), []);
});

test('diagnostics: an unknown name typed in a cell is reported there, and goes when it is removed', async () => {
  const nb = await openNotebook(MAIN, 'MAIN');
  const impl = cellOf(nb, /^uRaw/);
  const problems = () => vscode.languages.getDiagnostics(impl.uri).map(d => d.message);
  const add = new vscode.WorkspaceEdit();
  add.insert(impl.uri, new vscode.Position(0, 0), 'nUnknownThing := 1;\n');
  assert.ok(await vscode.workspace.applyEdit(add));
  await waitFor(() => problems().includes("Unknown identifier 'nUnknownThing'"), 'the problem of the unknown name');
  const remove = new vscode.WorkspaceEdit();
  remove.delete(impl.uri, new vscode.Range(0, 0, 1, 0));
  assert.ok(await vscode.workspace.applyEdit(remove));
  await waitFor(() => problems().length === 0 || undefined, 'no problem once the name is removed');
  // Saved back as it was (no question when the editor closes): the file stays byte for byte as XAE wrote it.
  const fsPath = demoPath(MAIN);
  const before = fs.readFileSync(fsPath);
  assert.ok(await nb.save(), 'save failed');
  assert.ok(fs.readFileSync(fsPath).equals(before), 'saving the text as it was changed the file');
});

test('revert (File: Revert File) in a notebook: the cells show the disk again, with no problem left', async () => {
  const nb = await openNotebook(MAIN, 'MAIN');
  const impl = cellOf(nb, /^uRaw/);
  const disk = impl.getText();
  // The revert may replace the cell: the problems of every cell of the notebook count.
  const problems = () => nb.getCells().flatMap(c => vscode.languages.getDiagnostics(c.document.uri).map(d => d.message));
  const add = new vscode.WorkspaceEdit();
  add.insert(impl.uri, new vscode.Position(0, 0), 'nUnknownThing := 1;\n');
  assert.ok(await vscode.workspace.applyEdit(add));
  assert.ok(nb.isDirty);
  await waitFor(() => problems().includes("Unknown identifier 'nUnknownThing'"), 'the problem of the unknown name');
  await vscode.window.showNotebookDocument(nb);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor(() => !nb.isDirty || undefined, 'the notebook to be clean');
  const text = () => cellOf(nb, /^(uRaw|nUnknownThing)/).getText();
  await waitFor(() => text() === disk || undefined, 'the cell to show the disk text', 5000).catch(() => {
    throw new Error(`the cell kept the discarded text: ${JSON.stringify(text().slice(0, 40))}`);
  });
  await waitFor(() => problems().length === 0 || undefined, 'no problem once reverted');
});

// ---------------------------------------------------------------------------------------------- saving and files

test('save from a notebook: the edited section is written into the .TcPOU, as XAE writes it', async () => {
  const fsPath = demoPath(MAIN);
  const before = fs.readFileSync(fsPath, 'utf8');
  const nb = await openNotebook(MAIN, 'MAIN');
  const impl = cellOf(nb, /^uRaw/);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(impl.uri, new vscode.Position(0, 0), '// Saved by the integration test.\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(nb.isDirty);
  assert.ok(await nb.save(), 'save failed');
  const after = fs.readFileSync(fsPath, 'utf8');
  assert.ok(after.startsWith('﻿<?xml'), 'the BOM is lost');
  assert.ok(after.includes('<ST><![CDATA[// Saved by the integration test.\r\nuRaw.nValue'), 'the edit is not in the file, with CRLF');
  assert.ok(!/[^\r]\n/.test(after), 'a line ends with LF alone');
  assert.strictEqual(cdata(after, 'Declaration'), cdata(before, 'Declaration'), 'the declaration changed');
  assert.strictEqual(after.length, before.length + '// Saved by the integration test.\r\n'.length, 'more than the section changed');
});

test('split editor: an open object takes in a change of its file made outside VS Code', async () => {
  const a = await api();
  const doc = await openSplit(a, FILL, 'FB_FillSequence');
  const fsPath = demoPath(FILL);
  const text = fs.readFileSync(fsPath, 'utf8');
  const changed = text.replace('<ST><![CDATA[', '<ST><![CDATA[// Changed on disk.\r\n');
  assert.notStrictEqual(changed, text);
  fs.writeFileSync(fsPath, changed);
  await waitFor(() => doc.getText().includes('// Changed on disk.\n'), 'the split editor to show the change on disk');
  assert.ok(!doc.isDirty);
});

test('TwinCAT Changes: the files changed since HEAD, under their PLC project', async () => {
  const a = await api();
  await a.changes.refresh();
  const files: string[] = [];
  const walk = (nodes: ReturnType<typeof a.changes.getChildren>) => {
    for (const n of nodes) {
      if (n.type === 'file') files.push(n.label);
      walk(a.changes.getChildren(n));
    }
  };
  walk(a.changes.getChildren());
  assert.deepStrictEqual(files.sort(), ['FB_FillSequence (FB)', 'MAIN (PRG)'], `the view: ${JSON.stringify(files)}`);
});

test('rename (F2): a variable of a POU, in its declaration and each of its uses', async () => {
  const fsPath = demoPath(MAIN);
  const nb = await openNotebook(MAIN, 'MAIN');
  const impl = cellOf(nb, /^\/\/ Saved/);
  const at = positionOf(impl, 'fbFill(');
  const prepared = await vscode.commands.executeCommand<{ range: vscode.Range; placeholder: string }>('vscode.prepareRename', impl.uri, at);
  assert.strictEqual(prepared?.placeholder, 'fbFill');
  await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', impl.uri, at, 'fbFiller');
  // The rename writes the file, then the cells read it again.
  const text = await waitFor(() => {
    const t = fs.readFileSync(fsPath, 'utf8');
    return t.includes('fbFiller') ? t : undefined;
  }, 'the rename to be written');
  assert.strictEqual(text.match(/\bfbFiller\b/g)?.length, 4, 'not every use renamed');
  assert.strictEqual(text.match(/\bfbFill\b/g), null, 'a use left with the old name');
  // The notebook reads the file again: its cells are new documents.
  await waitFor(() => nb.getCells().some(c => c.document.getText().includes('fbFiller(bStart')), 'the cell to show the rename');
  assert.ok(!nb.isDirty);
});

test('Copy Qualified Name: a method from its editor tab', async () => {
  const a = await api();
  await openSplit(a, CONVEYOR, 'Stop');
  await vscode.env.clipboard.writeText('');
  await vscode.commands.executeCommand('twincatExplorer.copyQualifiedName');
  // With its PLC project, as the MCP server's tools take it.
  assert.strictEqual(await vscode.env.clipboard.readText(), 'Machine:FB_Conveyor.Stop');
});

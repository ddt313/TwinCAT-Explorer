// A small test harness for the integration tests: they run inside VS Code's extension host, one after another,
// on the copy of samples/Demo that scripts/test-integration.js opens. No test framework is needed for that.
import * as vscode from 'vscode';
import type { TwinCatExplorerApi } from '../../src/extension';
import type { TreeNode } from '../../src/vscode/tree';

interface Case {
  name: string;
  fn: () => unknown | Promise<unknown>;
}

const cases: Case[] = [];

/** Adds a test. Tests run in the order they are added; a test may build on what the ones before it did. */
export function test(name: string, fn: () => unknown | Promise<unknown>): void {
  cases.push({ name, fn });
}

/** Runs the tests whose name matches TWINCAT_TEST_GREP (all of them without it), and fails when one fails. */
export async function runAll(): Promise<void> {
  const grep = process.env.TWINCAT_TEST_GREP ? new RegExp(process.env.TWINCAT_TEST_GREP, 'i') : undefined;
  const timeout = Number(process.env.TWINCAT_TEST_TIMEOUT ?? 30000);
  let passed = 0;
  const failed: string[] = [];
  for (const c of cases) {
    if (grep && !grep.test(c.name)) continue;
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(c.fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), timeout); }),
      ]);
      passed++;
      console.log(`✔ ${c.name} (${Date.now() - start} ms)`);
    } catch (e) {
      failed.push(c.name);
      console.log(`✖ ${c.name} (${Date.now() - start} ms)`);
      console.log(`  ${((e as Error)?.stack ?? String(e)).split('\n').join('\n  ')}`);
    } finally {
      clearTimeout(timer);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  }
  console.log(`ℹ tests ${passed + failed.length}, pass ${passed}, fail ${failed.length}`);
  if (failed.length) throw new Error(`${failed.length} integration test(s) failed: ${failed.join('; ')}`);
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Waits until check() gives a truthy value, and returns it; fails with the message after the timeout. */
export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, message: string, timeout = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${message}`);
    await sleep(100);
  }
}

export const EXTENSION_ID = 'thanhdang.explorer-for-twincat';

/** The extension's API, once it is active (activated by VS Code itself) and has loaded the projects. */
export async function api(): Promise<TwinCatExplorerApi> {
  const ext = vscode.extensions.getExtension<TwinCatExplorerApi>(EXTENSION_ID);
  if (!ext) throw new Error(`extension ${EXTENSION_ID} not found`);
  await waitFor(() => ext.isActive, 'the extension to be activated', 20000);
  await ext.exports.ready;
  return ext.exports;
}

/** The folder opened: the copy of samples/Demo. */
export function root(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder is open');
  return folder.uri;
}

/** The path of a file of the opened copy of samples/Demo, e.g. `Demo/Machine/POUs/MAIN.TcPOU`. */
export function demoPath(relative: string): string {
  return vscode.Uri.joinPath(root(), ...relative.split('/')).fsPath;
}

/** The node of the TwinCAT tree at the path of labels, e.g. `['Demo', 'Machine', 'POUs', 'MAIN']`. */
export function treeNode(a: TwinCatExplorerApi, labels: string[]): TreeNode {
  let children = a.tree.getChildren();
  let node: TreeNode | undefined;
  const seen: string[] = [];
  for (const label of labels) {
    node = children.find(n => n.label === label);
    seen.push(label);
    if (!node) throw new Error(`no tree node ${seen.join(' › ')}; there: ${children.map(n => n.label).join(', ')}`);
    children = a.tree.getChildren(node);
  }
  return node!;
}

/** The labels of the children of a node of the TwinCAT tree (the top level without one). */
export function childLabels(a: TwinCatExplorerApi, node?: TreeNode): string[] {
  return a.tree.getChildren(node).map(n => n.label);
}

/** The id of the object named so in the file. */
export function objectId(a: TwinCatExplorerApi, fsPath: string, name: string): string {
  const file = a.workspace.getFile(fsPath);
  if (!file) throw new Error(`no TwinCAT file ${fsPath}`);
  for (const o of file.objects.values()) if (o.name === name) return o.id;
  throw new Error(`no object ${name} in ${fsPath}; there: ${[...file.objects.values()].map(o => o.name).join(', ')}`);
}

/** Opens an object in the split editor and returns its `twincat:` document. */
export async function openSplit(a: TwinCatExplorerApi, relative: string, name: string): Promise<vscode.TextDocument> {
  const fsPath = demoPath(relative);
  const doc = await a.openSplit(fsPath, objectId(a, fsPath, name), { preview: false });
  if (!doc) throw new Error(`${name} did not open in the split editor`);
  return doc;
}

/** The position of the nth (0-based) occurrence of the text in the document, plus an offset into it. */
export function positionOf(doc: vscode.TextDocument, text: string, nth = 0, offset = 1): vscode.Position {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = doc.getText().indexOf(text, at + 1);
    if (at < 0) throw new Error(`"${text}" (occurrence ${nth}) not found in ${doc.uri.toString()}`);
  }
  return doc.positionAt(at + offset);
}

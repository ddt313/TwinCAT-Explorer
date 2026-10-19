// Add POU, Add DUT, Add Global Variable List, Add Interface and New Folder: they ask for what the new object
// needs, write its file as XAE 3.1.4026 does (see newObjects.ts) and its item into the .plcproj (see project.ts),
// then open it. Add Existing Item and Add Existing Folder Content add files from disk as XAE does (see existing.ts).
// Rename, Move to Folder and Delete of a POU, DUT, GVL or interface, and of a folder, change the files and the
// items the way XAE does, and close or move the tabs.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileStyle, NewObjectKind, NewObjectSpec, XAE_FILE_STYLE, fileStyleOf, newObjectText, objectExtension } from '../core/newObjects';
import {
  PlcProject, addCompileItem, addFolderItem, itemOrder, removeItem, renameCompileItem, renameFolderItems, renameTaskCalls, taskCalls,
} from '../core/project';
import { ChosenFile, ExistingPlan, objectIds, planExistingFiles } from '../core/existing';
import { SectionRange, addMember, nameRanges, newGuid, renameObject } from '../core/splice';
import { TcObject, decodeBytes, encodeText, fileKindFromPath, parseTcFile, parseTcText } from '../core/tcfile';
import { SourceEntry, TcWorkspace, fileKey } from '../core/workspace';
import { LanguageIndex } from '../lang/index';
import { typeProblem, usesLeftByRename } from '../lang/members';
import {
  BaseProblem, baseProblem, folderNameProblem, isInFolder, newObjectStubs, objectNameProblem, projectFolderList, projectObjectNames,
} from '../lang/objects';
import { Loc } from '../lang/symbols';
import { reportReferences } from './members';
import { hasUnsavedEdits } from './openDocs';
import { ShownTab, closeTabs, shownTabs, tabsOf } from './tabs';

/** Where a new object or folder goes: a PLC project and one of its folders (`POUs\Sub`, empty for the project). */
export interface ObjectTarget {
  plcprojPath: string;
  folder: string;
}

export interface ObjectHooks {
  /** Files were written: the projects are read again, the tree with them. */
  written(): Promise<void>;
  /** Opens a new object. */
  open(fsPath: string, objectId: string): Promise<void>;
  /** Where the language index finds an object used (not declared). */
  references(fsPath: string, objectId: string): Loc[];
  /** Lists places found by references, to open one. */
  showReferences(title: string, locs: Loc[]): Promise<void>;
  /** Opens tabs again in a file, where they were. */
  reopen(fsPath: string, tabs: ShownTab[]): Promise<void>;
  /** Selects an object in the TwinCAT tree. */
  reveal(fsPath: string, objectId: string): Promise<void>;
}

/** A file to write, with its text and BOM. */
interface Written {
  fsPath: string;
  text: string;
  bom: boolean;
}

type Choice<T> = vscode.QuickPickItem & { value: T };

const POU_KINDS: Choice<NewObjectKind>[] = [
  { label: 'Function Block', description: 'FUNCTION_BLOCK', value: 'fb' },
  { label: 'Program', description: 'PROGRAM', value: 'prg' },
  { label: 'Function', description: 'FUNCTION', value: 'fun' },
];

const DUT_KINDS: Choice<NewObjectKind>[] = [
  { label: 'Structure', description: 'STRUCT', value: 'struct' },
  { label: 'Enumeration', description: '( ... )', value: 'enum' },
  { label: 'Union', description: 'UNION', value: 'union' },
  { label: 'Alias', description: 'TYPE T : INT', value: 'alias' },
];

const KIND_WORDS: Record<NewObjectKind, string> = {
  fb: 'function block', prg: 'program', fun: 'function', itf: 'interface', struct: 'structure', enum: 'enumeration',
  union: 'union', alias: 'alias', gvl: 'global variable list',
};

/** Existing Folder Content refuses a folder with more files than this (a whole drive picked by mistake). */
const MAX_FOLDER_FILES = 2000;

/** The files a plan skips and why, the first ten of them. */
function skippedText(plan: ExistingPlan): string {
  const shown = plan.skipped.slice(0, 10).map(s => `${path.basename(s.source)} (${s.reason})`);
  const more = plan.skipped.length > shown.length ? `, and ${plan.skipped.length - shown.length} more` : '';
  return `Skipped ${plan.skipped.length === 1 ? '1 file' : `${plan.skipped.length} files`}: ${shown.join('; ')}${more}.`;
}

/** What a POU, DUT, GVL or interface is, in a question: `function block`, `DUT`, `interface`. */
function objectWord(obj: TcObject): string {
  if (obj.kind === 'pou') return obj.pouKind === 'PRG' ? 'program' : obj.pouKind === 'FUN' ? 'function' : obj.pouKind === 'FB' ? 'function block' : 'POU';
  return obj.kind === 'itf' ? 'interface' : obj.kind.toUpperCase();
}

/** An input box check: a blocking error, or a warning that still lets the value through. */
function asValidation(problem: BaseProblem | undefined): vscode.InputBoxValidationMessage | undefined {
  if (!problem) return undefined;
  return { message: problem.message, severity: problem.blocking ? vscode.InputBoxValidationSeverity.Error : vscode.InputBoxValidationSeverity.Warning };
}

export class ObjectCommands {
  constructor(private readonly ws: TcWorkspace, private readonly index: LanguageIndex, private readonly hooks: ObjectHooks) {}

  private project(target: ObjectTarget): PlcProject | undefined {
    const project = this.ws.plcProject(target.plcprojPath);
    if (!project) void vscode.window.showWarningMessage(`${path.basename(target.plcprojPath)} is not a PLC project of the workspace.`);
    return project;
  }

  /** Refuses, with a message, when an editor holds unsaved edits of the .plcproj: they would be saved over it. */
  private refuseUnsaved(project: PlcProject): boolean {
    if (!hasUnsavedEdits(project.path)) return false;
    void vscode.window.showWarningMessage(`${path.basename(project.path)} has unsaved changes in an editor. Save or revert them first.`);
    return true;
  }

  private title(what: string, project: PlcProject, target: ObjectTarget): string {
    return `${what} to ${[project.name, ...target.folder.split('\\').filter(s => s)].join(' / ')}`;
  }

  private fileOf(project: PlcProject, target: ObjectTarget, name: string, kind: NewObjectKind): { fsPath: string; include: string } {
    const file = `${name}${objectExtension(kind)}`;
    const include = target.folder ? `${target.folder}\\${file}` : file;
    return { fsPath: path.join(project.dir, ...include.split('\\')), include };
  }

  /** The XML header, line breaks and BOM of the first readable source file of the project, else XAE 4026's. */
  private styleOf(project: PlcProject): FileStyle {
    for (const e of this.ws.sourceEntries) {
      if (e.project !== project || !['pou', 'dut', 'gvl', 'itf'].includes(fileKindFromPath(e.path))) continue;
      const file = this.ws.getFile(e.path);
      const style = file && fileStyleOf(file);
      if (style) return style;
    }
    return XAE_FILE_STYLE;
  }

  private async askName(title: string, kind: NewObjectKind, project: PlcProject, target: ObjectTarget): Promise<string | undefined> {
    const names = projectObjectNames(this.ws, project);
    return (await vscode.window.showInputBox({
      title, prompt: `Name of the new ${KIND_WORDS[kind]}`,
      validateInput: v => {
        const name = v.trim();
        const problem = objectNameProblem(this.ws, project, name, names);
        if (problem) return problem;
        const { fsPath } = this.fileOf(project, target, name, kind);
        return fs.existsSync(fsPath) ? `${path.basename(fsPath)} is already on disk in ${path.dirname(fsPath)}` : undefined;
      },
    }))?.trim();
  }

  private askBase(title: string, prompt: string, project: PlcProject, kind: 'FB' | 'ITF' | 'struct', list: boolean): Thenable<string | undefined> {
    return vscode.window.showInputBox({
      title, prompt, placeHolder: 'empty for none',
      validateInput: v => asValidation(baseProblem(this.index, project, v, kind, list)),
    });
  }

  async addPou(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const title = this.title('Add POU', project, target);
    const kind = (await vscode.window.showQuickPick(POU_KINDS, { title, placeHolder: 'Type of the POU' }))?.value;
    if (!kind) return;
    const name = await this.askName(title, kind, project, target);
    if (name === undefined) return;
    const spec: NewObjectSpec = { kind, name };
    if (kind === 'fun') {
      const type = await vscode.window.showInputBox({ title, prompt: `Return type of ${name}`, placeHolder: 'BOOL', validateInput: typeProblem });
      if (type === undefined) return;
      spec.type = type.trim();
    } else if (kind === 'fb') {
      const base = await this.askBase(title, `${name} EXTENDS: the function block it extends`, project, 'FB', false);
      if (base === undefined) return;
      const itfs = await this.askBase(title, `${name} IMPLEMENTS: the interfaces it implements, with commas`, project, 'ITF', true);
      if (itfs === undefined) return;
      spec.extends = base.trim();
      spec.implements = itfs.trim();
    }
    await this.create(project, target, spec);
  }

  async addDut(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const title = this.title('Add DUT', project, target);
    const kind = (await vscode.window.showQuickPick(DUT_KINDS, { title, placeHolder: 'Type of the DUT' }))?.value;
    if (!kind) return;
    const name = await this.askName(title, kind, project, target);
    if (name === undefined) return;
    const spec: NewObjectSpec = { kind, name };
    if (kind === 'struct') {
      const base = await this.askBase(title, `${name} EXTENDS: the structure it extends`, project, 'struct', false);
      if (base === undefined) return;
      spec.extends = base.trim();
    } else if (kind === 'alias') {
      const type = await vscode.window.showInputBox({ title, prompt: `The type ${name} names`, placeHolder: 'INT', validateInput: typeProblem });
      if (type === undefined) return;
      spec.type = type.trim();
    }
    await this.create(project, target, spec);
  }

  async addGvl(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const name = await this.askName(this.title('Add Global Variable List', project, target), 'gvl', project, target);
    if (name !== undefined) await this.create(project, target, { kind: 'gvl', name });
  }

  async addInterface(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const title = this.title('Add Interface', project, target);
    const name = await this.askName(title, 'itf', project, target);
    if (name === undefined) return;
    const bases = await this.askBase(title, `${name} EXTENDS: the interfaces it extends, with commas`, project, 'ITF', true);
    if (bases !== undefined) await this.create(project, target, { kind: 'itf', name, extends: bases.trim() });
  }

  async newFolder(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const name = (await vscode.window.showInputBox({
      title: this.title('New Folder', project, target), prompt: 'Name of the new folder',
      validateInput: v => folderNameProblem(project, target.folder, v.trim()),
    }))?.trim();
    if (name === undefined) return;
    const include = target.folder ? `${target.folder}\\${name}` : name;
    if (this.write(project, text => addFolderItem(text, include), () => fs.mkdirSync(path.join(project.dir, ...include.split('\\')), { recursive: true }))) {
      await this.hooks.written();
    }
  }

  /** The folder of a target on disk. */
  private dirOf(project: PlcProject, target: ObjectTarget): string {
    return path.join(project.dir, ...target.folder.split('\\').filter(s => s));
  }

  /** Add Existing Item...: POU, DUT, GVL and interface files picked on disk go into the folder, as XAE adds them. */
  async addExistingItems(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const uris = await vscode.window.showOpenDialog({
      title: this.title('Add Existing Item', project, target), openLabel: 'Add', canSelectMany: true,
      defaultUri: vscode.Uri.file(this.dirOf(project, target)),
      filters: { 'POUs, DUTs, GVLs and interfaces': ['TcPOU', 'TcDUT', 'TcGVL', 'TcIO'] },
    });
    if (uris?.length) await this.addExisting(project, target, uris.map(u => ({ path: u.fsPath, subfolder: '' })));
  }

  /**
   * Add Existing Folder Content...: the POU, DUT, GVL and interface files of a folder picked on disk, and of its
   * sub-folders, go into the folder, a sub-folder into a sub-folder of the same name, as XAE adds them.
   */
  async addExistingFolderContent(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const uris = await vscode.window.showOpenDialog({
      title: this.title('Add Existing Folder Content', project, target), openLabel: 'Add Its Content',
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(this.dirOf(project, target)),
    });
    const dir = uris?.[0]?.fsPath;
    if (!dir) return;
    const found: { path: string; subfolder: string }[] = [];
    const walk = (d: string, subfolder: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => itemOrder(a.name, b.name))) {
        if (found.length > MAX_FOLDER_FILES) return;
        if (e.isFile()) found.push({ path: path.join(d, e.name), subfolder });
        // Not git's folder and the like.
        else if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(d, e.name), subfolder ? `${subfolder}\\${e.name}` : e.name);
      }
    };
    try {
      walk(dir, '');
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    if (found.length > MAX_FOLDER_FILES) {
      void vscode.window.showWarningMessage(`${dir} holds more than ${MAX_FOLDER_FILES} files: pick the folder of the objects to add.`);
      return;
    }
    if (!found.length) {
      void vscode.window.showInformationMessage(`${dir} holds no files.`);
      return;
    }
    await this.addExisting(project, target, found);
  }

  /** The GUIDs of the objects of a PLC project. */
  private projectIds(project: PlcProject): Set<string> {
    const ids = new Set<string>();
    for (const e of this.ws.sourceEntries) {
      if (e.project !== project) continue;
      for (const id of objectIds(this.ws.getFile(e.path)?.text ?? '')) ids.add(id);
    }
    return ids;
  }

  /** Adds files chosen on disk to a folder of the PLC project (see planExistingFiles), then says what it did. */
  private async addExisting(project: PlcProject, target: ObjectTarget, chosen: { path: string; subfolder: string }[]): Promise<void> {
    const read: ChosenFile[] = chosen.map(c => {
      try {
        return { ...c, bytes: fs.readFileSync(c.path) };
      } catch (e) {
        return { ...c, error: (e as Error).message };
      }
    });
    const plan = planExistingFiles({
      dir: project.dir, compile: project.compile, folders: projectFolderList(project),
      names: projectObjectNames(this.ws, project), ids: this.projectIds(project),
    }, target.folder, read, p => fs.existsSync(p), newGuid);
    const where = [project.name, ...target.folder.split('\\').filter(s => s)].join(' / ');
    if (!plan.files.length) {
      void vscode.window.showWarningMessage(`Nothing added to ${where}. ${skippedText(plan)}`);
      return;
    }
    // A file added where it is and given new GUIDs is written there: not over unsaved edits.
    if (this.refuseUnsavedFiles(plan.files.filter(f => !f.copy && f.bytes).map(f => f.target))) return;
    const written = this.write(project, plcproj => {
      let text = plcproj;
      for (const f of plan.folders) text = addFolderItem(text, f);
      for (const f of [...plan.files].sort((a, b) => itemOrder(a.include, b.include))) text = addCompileItem(text, f.include);
      return text;
    }, () => {
      for (const f of plan.folders) fs.mkdirSync(path.join(project.dir, ...f.split('\\')), { recursive: true });
      for (const f of plan.files) {
        if (!f.bytes) continue;
        fs.mkdirSync(path.dirname(f.target), { recursive: true });
        // A copy never goes over a file.
        fs.writeFileSync(f.target, f.bytes, { flag: f.copy ? 'wx' : 'w' });
      }
    });
    if (!written) return;
    await this.hooks.written();
    const added = plan.files.map(f => `${f.name}${f.copy ? '' : ' (already in the folder)'}`).join(', ');
    const renewed = plan.files.filter(f => f.newIds.length).map(f => f.name);
    void vscode.window.showInformationMessage(`Added to ${where}: ${added}.`
      + (renewed.length ? ` New GUIDs in ${renewed.join(', ')}, which the PLC project had already.` : ''));
    if (plan.skipped.length) void vscode.window.showWarningMessage(skippedText(plan));
    await this.hooks.reveal(plan.files[0].target, plan.files[0].objectId);
  }

  /** The entry and root object of the file of a POU, DUT, GVL or interface of a PLC project, or a message why it is none. */
  private sourceOf(fsPath: string): { entry: SourceEntry; root: TcObject } | undefined {
    const entry = this.ws.entry(fsPath);
    const root = this.ws.getFile(fsPath)?.root;
    if (entry && root && ['pou', 'dut', 'gvl', 'itf'].includes(root.kind)) return { entry, root };
    void vscode.window.showWarningMessage(`${path.basename(fsPath)} is not a POU, DUT, GVL or interface of a PLC project of the workspace.`);
    return undefined;
  }

  /** Refuses, with a message, when an editor holds unsaved edits of one of the files: they would be saved over it. */
  private refuseUnsavedFiles(paths: string[]): boolean {
    const dirty = paths.find(p => hasUnsavedEdits(p));
    if (dirty) void vscode.window.showWarningMessage(`${path.basename(dirty)} has unsaved changes in an editor. Save or revert them first.`);
    return !!dirty;
  }

  /** The tasks (.TcTTO) of the project and what each calls. */
  private tasksOf(project: PlcProject): { fsPath: string; text: string; bom: boolean; calls: string[] }[] {
    return this.ws.sourceEntries.filter(e => e.project === project && fileKindFromPath(e.path) === 'task').flatMap(e => {
      try {
        const { text, bom } = decodeBytes(fs.readFileSync(e.path));
        return [{ fsPath: e.path, text, bom, calls: taskCalls(text) }];
      } catch {
        return [];
      }
    });
  }

  private static taskNames(tasks: { fsPath: string }[]): string {
    return tasks.map(t => path.basename(t.fsPath, path.extname(t.fsPath))).join(', ');
  }

  /**
   * Renames a POU, DUT, GVL or interface as XAE does: its file (`FB_A.TcPOU` to `FB_B.TcPOU`, in its folder), the
   * object in it (see renameObject), its <Compile> item in place, and the calls of the tasks that call a renamed
   * program. Its tabs open again under the new name. What uses it keeps the old name: the message says how many
   * uses the language index finds.
   */
  async rename(fsPath: string): Promise<void> {
    const source = this.sourceOf(fsPath);
    if (!source) return;
    const { entry, root } = source;
    const project = entry.project;
    if (this.refuseUnsavedFiles([fsPath, project.path])) return;
    const slash = entry.include.lastIndexOf('\\');
    const ext = path.extname(entry.include);
    const newPathOf = (name: string) => path.join(path.dirname(fsPath), `${name}${ext}`);
    const names = projectObjectNames(this.ws, project);
    names.delete(root.name.toUpperCase());
    const name = (await vscode.window.showInputBox({
      title: `Rename ${root.name}`, prompt: `New name of the ${objectWord(root)}`,
      value: root.name,
      validateInput: v => {
        const n = v.trim();
        const problem = objectNameProblem(this.ws, project, n, names);
        if (problem) return problem;
        const target = newPathOf(n);
        return fileKey(target) !== fileKey(fsPath) && fs.existsSync(target) ? `${path.basename(target)} is already on disk in ${path.dirname(target)}` : undefined;
      },
    }))?.trim();
    if (!name || name === root.name) return;
    const newPath = newPathOf(name);
    const newInclude = `${entry.include.slice(0, slash + 1)}${name}${ext}`;
    const uses = this.hooks.references(fsPath, root.id);
    let renamed: SectionRange[];
    let tasks: Written[];
    let written: Written[];
    try {
      const file = parseTcFile(fsPath, fs.readFileSync(fsPath));
      renamed = nameRanges(file, root.id);
      const plcproj = decodeBytes(fs.readFileSync(project.path));
      tasks = root.pouKind === 'PRG'
        ? this.tasksOf(project).flatMap(t => {
          const text = renameTaskCalls(t.text, root.name, name);
          return text === t.text ? [] : [{ fsPath: t.fsPath, text, bom: t.bom }];
        })
        : [];
      written = [
        { fsPath: newPath, text: renameObject(file, name), bom: file.bom },
        { fsPath: project.path, text: renameCompileItem(plcproj.text, entry.include, newInclude), bom: plcproj.bom },
        ...tasks,
      ];
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    // An editor may have been edited while the question was asked.
    if (this.refuseUnsavedFiles([fsPath, project.path, ...tasks.map(t => t.fsPath)])) return;
    const tabs = tabsOf(fsPath);
    const shown = shownTabs(tabs);
    await closeTabs(tabs);
    try {
      fs.renameSync(fsPath, newPath);
      for (const w of written) fs.writeFileSync(w.fsPath, encodeText(w.text, w.bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      await this.hooks.written();
      return;
    }
    await this.hooks.written();
    await this.hooks.reopen(newPath, shown);
    // The uses left in the file itself are in the renamed file now.
    const oldKey = fileKey(fsPath);
    const left = usesLeftByRename(uses, oldKey, renamed, name.length - root.name.length)
      .map(u => (u.fileKey === oldKey ? { ...u, fileKey: fileKey(newPath) } : u));
    const calls = tasks.length ? ` ${ObjectCommands.taskNames(tasks)} call${tasks.length === 1 ? 's' : ''} it by its new name.` : '';
    reportReferences(root.name, name, left, this.hooks.showReferences, calls);
  }

  /**
   * Moves the file of a POU, DUT, GVL or interface to another folder of its PLC project (one picked when not
   * given): on disk, and its <Compile> item, in place as XAE changes the path of an item. Its tabs open again there.
   */
  async move(fsPath: string, folder?: string): Promise<void> {
    const source = this.sourceOf(fsPath);
    if (!source) return;
    const { entry, root } = source;
    const project = entry.project;
    if (this.refuseUnsavedFiles([fsPath, project.path])) return;
    const slash = entry.include.lastIndexOf('\\');
    const current = entry.include.slice(0, Math.max(slash, 0));
    const fileName = entry.include.slice(slash + 1);
    if (folder === undefined) {
      const items = [
        { label: `$(root-folder) ${project.name}`, description: 'the PLC project itself', folder: '' },
        ...projectFolderList(project).map(f => ({ label: `$(folder) ${f}`, description: '', folder: f })),
      ].filter(i => itemOrder(i.folder, current) !== 0);
      const pick = await vscode.window.showQuickPick(items, { title: `Move ${root.name} to Folder`, placeHolder: `The folder of ${project.name} to move it to` });
      if (!pick) return;
      folder = pick.folder;
    }
    if (itemOrder(folder, current) === 0) return;
    const newInclude = folder ? `${folder}\\${fileName}` : fileName;
    const newPath = path.join(project.dir, ...newInclude.split('\\'));
    if (fs.existsSync(newPath)) {
      void vscode.window.showWarningMessage(`${fileName} is already on disk in ${path.dirname(newPath)}.`);
      return;
    }
    if (this.refuseUnsavedFiles([fsPath, project.path])) return;
    let plcproj: Written;
    try {
      const read = decodeBytes(fs.readFileSync(project.path));
      plcproj = { fsPath: project.path, text: renameCompileItem(read.text, entry.include, newInclude), bom: read.bom };
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    const tabs = tabsOf(fsPath);
    const shown = shownTabs(tabs);
    await closeTabs(tabs);
    try {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(fsPath, newPath);
      fs.writeFileSync(plcproj.fsPath, encodeText(plcproj.text, plcproj.bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      await this.hooks.written();
      return;
    }
    await this.hooks.written();
    await this.hooks.reopen(newPath, shown);
  }

  /**
   * Deletes a POU, DUT, GVL or interface after a confirmation, as XAE does: its file goes to the Recycle Bin and
   * its <Compile> item out of the .plcproj. What uses it, a task's call too, is not changed. Its tabs close.
   */
  async delete(fsPath: string): Promise<void> {
    const source = this.sourceOf(fsPath);
    if (!source) return;
    const { entry, root } = source;
    const project = entry.project;
    if (this.refuseUnsavedFiles([fsPath, project.path])) return;
    const upper = root.name.toUpperCase();
    const callers = root.pouKind === 'PRG' ? this.tasksOf(project).filter(t => t.calls.some(c => c.toUpperCase() === upper)) : [];
    const choice = await vscode.window.showWarningMessage(`Delete the ${objectWord(root)} ${root.name}?`, {
      modal: true,
      detail: `${path.basename(fsPath)} goes to the Recycle Bin and out of ${path.basename(project.path)}, as when it is deleted in TwinCAT XAE. `
        + `What uses it is not changed${callers.length ? `: ${ObjectCommands.taskNames(callers)} still call${callers.length === 1 ? 's' : ''} it` : ''}.`,
    }, 'Delete');
    if (choice !== 'Delete' || this.refuseUnsavedFiles([fsPath, project.path])) return;
    let plcproj: Written;
    try {
      const read = decodeBytes(fs.readFileSync(project.path));
      plcproj = { fsPath: project.path, text: removeItem(read.text, 'Compile', entry.include), bom: read.bom };
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    await closeTabs(tabsOf(fsPath));
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(fsPath), { useTrash: true });
      fs.writeFileSync(plcproj.fsPath, encodeText(plcproj.text, plcproj.bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
    }
    await this.hooks.written();
  }

  /**
   * Deletes an empty folder of a PLC project after a confirmation: its <Folder> item, and the folder on disk (to the
   * Recycle Bin) unless something the project does not list is in it.
   */
  async deleteFolder(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project || this.refuseUnsaved(project)) return;
    const dir = path.join(project.dir, ...target.folder.split('\\'));
    let inside: string[] = [];
    try {
      inside = fs.readdirSync(dir);
    } catch {
      // Not on disk.
    }
    const choice = await vscode.window.showWarningMessage(`Delete the folder ${target.folder}?`, {
      modal: true,
      detail: `Its item leaves ${path.basename(project.path)}, `
        + (inside.length ? 'and the folder stays on disk, where something the project does not list is in it.' : 'and the empty folder goes to the Recycle Bin.'),
    }, 'Delete');
    if (choice !== 'Delete' || !this.write(project, text => removeItem(text, 'Folder', target.folder), () => undefined)) return;
    if (!inside.length && fs.existsSync(dir)) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: false, useTrash: true });
      } catch (e) {
        void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      }
    }
    await this.hooks.written();
  }

  /** The files of the project in a folder (`POUs\Valves`) or under it. */
  private filesIn(project: PlcProject, folder: string): SourceEntry[] {
    return this.ws.sourceEntries.filter(e => e.project === project && isInFolder(e.include, folder));
  }

  /** Renames a folder of a PLC project as XAE does: on disk, and its item and those of everything in it, in place. */
  async renameFolder(target: ObjectTarget): Promise<void> {
    const project = this.project(target);
    if (!project) return;
    const { folder } = target;
    const slash = folder.lastIndexOf('\\');
    const parent = folder.slice(0, Math.max(slash, 0));
    const old = folder.slice(slash + 1);
    if (this.refuseUnsavedFiles([project.path, ...this.filesIn(project, folder).map(e => e.path)])) return;
    const name = (await vscode.window.showInputBox({
      title: `Rename ${folder}`, prompt: 'New name of the folder', value: old,
      validateInput: v => folderNameProblem(project, parent, v.trim(), folder),
    }))?.trim();
    if (!name || name === old) return;
    await this.changeFolder(project, folder, parent ? `${parent}\\${name}` : name);
  }

  /** Moves a folder of a PLC project, with everything in it, into another of its folders (one picked when not given). */
  async moveFolder(target: ObjectTarget, to?: string): Promise<void> {
    const project = this.project(target);
    if (!project) return;
    const { folder } = target;
    const slash = folder.lastIndexOf('\\');
    const parent = folder.slice(0, Math.max(slash, 0));
    const name = folder.slice(slash + 1);
    if (this.refuseUnsavedFiles([project.path, ...this.filesIn(project, folder).map(e => e.path)])) return;
    if (to === undefined) {
      const items = [
        { label: `$(root-folder) ${project.name}`, description: 'the PLC project itself', folder: '' },
        ...projectFolderList(project).map(f => ({ label: `$(folder) ${f}`, description: '', folder: f })),
      ].filter(i => !isInFolder(i.folder, folder) && itemOrder(i.folder, parent) !== 0);
      const pick = await vscode.window.showQuickPick(items, { title: `Move ${folder} to Folder`, placeHolder: `The folder of ${project.name} to move it into` });
      if (!pick) return;
      to = pick.folder;
    }
    if (itemOrder(to, parent) === 0) return;
    const problem = isInFolder(to, folder) ? `${folder} cannot go into itself.` : folderNameProblem(project, to, name);
    if (problem) {
      void vscode.window.showWarningMessage(problem);
      return;
    }
    await this.changeFolder(project, folder, to ? `${to}\\${name}` : name);
  }

  /**
   * Gives a folder a new path, renamed or moved: the folder on disk, its item and those of everything in it in the
   * .plcproj (see renameFolderItems). The tabs of its files open again at their new paths.
   */
  private async changeFolder(project: PlcProject, folder: string, newFolder: string): Promise<void> {
    const files = this.filesIn(project, folder);
    // An editor may have been edited while the question was asked.
    if (this.refuseUnsavedFiles([project.path, ...files.map(e => e.path)])) return;
    const dir = path.join(project.dir, ...folder.split('\\'));
    const newDir = path.join(project.dir, ...newFolder.split('\\'));
    if (fileKey(dir) !== fileKey(newDir) && fs.existsSync(newDir)) {
      void vscode.window.showWarningMessage(`${path.basename(newDir)} is already on disk in ${path.dirname(newDir)}.`);
      return;
    }
    let plcproj: Written;
    try {
      const read = decodeBytes(fs.readFileSync(project.path));
      plcproj = { fsPath: project.path, text: renameFolderItems(read.text, folder, newFolder), bom: read.bom };
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    const moved = files.map(e => ({ fsPath: path.join(newDir, path.relative(dir, e.path)), tabs: tabsOf(e.path) }));
    const shown = moved.map(m => shownTabs(m.tabs));
    await closeTabs(moved.flatMap(m => m.tabs));
    try {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      if (fs.existsSync(dir)) fs.renameSync(dir, newDir);
      else fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(plcproj.fsPath, encodeText(plcproj.text, plcproj.bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      await this.hooks.written();
      return;
    }
    await this.hooks.written();
    for (let i = 0; i < moved.length; i++) await this.hooks.reopen(moved[i].fsPath, shown[i]);
  }

  /**
   * Writes the file of a new object (with the members of its interfaces for a function block that implements
   * some) and its <Compile> item, then opens it.
   */
  private async create(project: PlcProject, target: ObjectTarget, spec: NewObjectSpec): Promise<void> {
    const { fsPath, include } = this.fileOf(project, target, spec.name, spec.kind);
    const style = this.styleOf(project);
    let text: string;
    try {
      text = newObjectText(spec, style);
      if (spec.kind === 'fb' && spec.implements) {
        const found = newObjectStubs(this.index, project, spec);
        if (found.missing.length) {
          void vscode.window.showWarningMessage(`${spec.name}: not found in the workspace or the library stubs: ${found.missing.join(', ')}. Their methods and properties are not added.`);
        }
        let file = parseTcText(fsPath, text, style.bom);
        for (const stub of found.stubs) file = parseTcText(fsPath, addMember(file, file.root!.id, stub.spec), style.bom);
        text = file.text;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    const written = this.write(project, plcproj => addCompileItem(plcproj, include), () => {
      if (fs.existsSync(fsPath)) throw new Error(`${path.basename(fsPath)} is already on disk in ${path.dirname(fsPath)}`);
      fs.mkdirSync(path.dirname(fsPath), { recursive: true });
      fs.writeFileSync(fsPath, encodeText(text, style.bom));
    });
    if (!written) return;
    await this.hooks.written();
    const id = parseTcText(fsPath, text, style.bom).root?.id;
    if (id) await this.hooks.open(fsPath, id);
  }

  /**
   * Changes the .plcproj as it is on disk (with its BOM) after `before` wrote what goes with it, or shows why it
   * cannot: the new .plcproj text is made first, so nothing is written when it cannot be.
   */
  private write(project: PlcProject, edit: (plcproj: string) => string, before: () => void): boolean {
    // An editor may have been edited while the questions were asked.
    if (this.refuseUnsaved(project)) return false;
    try {
      const { text, bom } = decodeBytes(fs.readFileSync(project.path));
      const changed = edit(text);
      before();
      fs.writeFileSync(project.path, encodeText(changed, bom));
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return false;
    }
  }
}

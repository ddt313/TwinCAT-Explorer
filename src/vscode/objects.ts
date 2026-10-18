// Add POU, Add DUT, Add Global Variable List, Add Interface and New Folder: they ask for what the new object
// needs, write its file as XAE 3.1.4026 does (see newObjects.ts) and its item into the .plcproj (see project.ts),
// then open it.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileStyle, NewObjectKind, NewObjectSpec, XAE_FILE_STYLE, fileStyleOf, newObjectText, objectExtension } from '../core/newObjects';
import { PlcProject, addCompileItem, addFolderItem } from '../core/project';
import { addMember } from '../core/splice';
import { decodeBytes, encodeText, fileKindFromPath, parseTcText } from '../core/tcfile';
import { TcWorkspace } from '../core/workspace';
import { LanguageIndex } from '../lang/index';
import { typeProblem } from '../lang/members';
import { BaseProblem, baseProblem, folderNameProblem, newObjectStubs, objectNameProblem, projectObjectNames } from '../lang/objects';
import { hasUnsavedEdits } from './openDocs';

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

// Add Method, Add Property, Add Action and Implement Interfaces: they ask for what the new member needs, write
// it into the file of its POU or interface (see addMember) and open it, the way XAE adds an object.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Accessor } from '../core/objectText';
import { MemberSpec, addMember, isSpecialMethod } from '../core/splice';
import { TcSourceFile, encodeText, parseTcFile, parseTcText } from '../core/tcfile';
import { TcWorkspace } from '../core/workspace';
import { LanguageIndex } from '../lang/index';
import { interfaceStubs, newMemberNameProblem, typeProblem } from '../lang/members';
import { hasUnsavedEdits } from './openDocs';
import { MemberTarget } from './tree';

export type NewMemberKind = MemberSpec['kind'];

export interface MemberHooks {
  /** The file was written: everything that shows it reads it again, the tree at once. */
  written(fsPath: string): void;
  /** Opens a new member, or an accessor of a new property. */
  open(fsPath: string, objectId: string, accessor?: Accessor): Promise<void>;
}

const TITLE: Record<NewMemberKind, string> = { method: 'Method', property: 'Property', action: 'Action' };

const ACCESSOR_CHOICES: (vscode.QuickPickItem & { accessors: Accessor[] })[] = [
  { label: 'Get and Set', accessors: ['Get', 'Set'] },
  { label: 'Get', description: 'read-only', accessors: ['Get'] },
  { label: 'Set', description: 'write-only', accessors: ['Set'] },
];

export class MemberCommands {
  constructor(private readonly ws: TcWorkspace, private readonly index: LanguageIndex, private readonly hooks: MemberHooks) {}

  /** Refuses, with a message, when an editor holds unsaved edits of the file: they would be saved over it. */
  private refuseUnsaved(fsPath: string): boolean {
    if (!hasUnsavedEdits(fsPath)) return false;
    void vscode.window.showWarningMessage(`${path.basename(fsPath)} has unsaved changes in an editor. Save or revert them first.`);
    return true;
  }

  /** Asks for the name (and type, accessors) of a new member, adds it and opens it. */
  async add(kind: NewMemberKind, target: MemberTarget): Promise<void> {
    const { fsPath } = target;
    if (this.refuseUnsaved(fsPath)) return;
    const owner = this.ws.getFile(fsPath)?.objects.get(target.objectId);
    if (!owner) {
      void vscode.window.showWarningMessage(`TwinCAT object not found in ${path.basename(fsPath)}`);
      return;
    }
    const title = `Add ${TITLE[kind]} to ${[owner.name, ...target.folderPath].join(' / ')}`;
    const name = (await vscode.window.showInputBox({
      title, prompt: `Name of the new ${kind}`, validateInput: v => newMemberNameProblem(owner, v.trim()),
    }))?.trim();
    if (name === undefined) return;
    const spec: MemberSpec = { kind, name, folderPath: target.folderPath };
    if (kind === 'method' && !isSpecialMethod(owner, name)) {
      const type = await vscode.window.showInputBox({
        title, prompt: `Return type of ${name}: empty for none`, placeHolder: 'BOOL',
        validateInput: v => (v.trim() ? typeProblem(v) : undefined),
      });
      if (type === undefined) return;
      spec.type = type.trim();
    } else if (kind === 'property') {
      const type = await vscode.window.showInputBox({ title, prompt: `Type of ${name}`, placeHolder: 'BOOL', validateInput: typeProblem });
      if (type === undefined) return;
      spec.type = type.trim();
      const choice = await vscode.window.showQuickPick(ACCESSOR_CHOICES, { title, placeHolder: `Accessors of ${name}` });
      if (!choice) return;
      spec.accessors = choice.accessors;
    }
    const file = this.write(fsPath, target.objectId, [spec]);
    const added = file?.root?.members.find(m => m.kind === kind && m.name === name);
    if (added) await this.hooks.open(fsPath, added.id, added.accessors[0]?.kind);
  }

  /** Adds to a function block the methods and properties of its interfaces it lacks, those picked. */
  async implementInterfaces(fsPath: string): Promise<void> {
    if (this.refuseUnsaved(fsPath)) return;
    const file = this.ws.getFile(fsPath);
    const root = file?.root;
    if (!file || !root || root.pouKind !== 'FB') {
      void vscode.window.showInformationMessage('Implement Interfaces works on function blocks.');
      return;
    }
    let found;
    try {
      found = interfaceStubs(this.index, file);
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    const { stubs, interfaces, missing } = found;
    const notFound = missing.length ? ` Not found in the workspace or the library stubs: ${missing.join(', ')}.` : '';
    if (stubs.length === 0) {
      void vscode.window.showInformationMessage(interfaces.length
        ? `${root.name} has every method and property of ${interfaces.join(', ')}.${notFound}`
        : `${root.name} implements no interface found in the workspace or the library stubs.${notFound}`);
      return;
    }
    const items = stubs.map(s => ({
      label: `$(symbol-${s.spec.kind}) ${s.spec.name}`,
      description: s.from,
      detail: s.spec.declaration?.split('\n').find(l => /\b(?:METHOD|PROPERTY)\b/i.test(l))?.trim(),
      picked: true,
      spec: s.spec,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Implement Interfaces in ${root.name}`, canPickMany: true, matchOnDescription: true,
      placeHolder: `The methods and properties to add${missing.length ? ` (not found: ${missing.join(', ')})` : ''}`,
    });
    if (!picked?.length) return;
    if (this.write(fsPath, root.id, picked.map(p => p.spec))) {
      void vscode.window.showInformationMessage(`Added to ${root.name}: ${picked.map(p => p.spec.name).join(', ')}.${notFound}`);
    }
  }

  /**
   * Adds the members to the file as it is on disk and writes it back with its BOM, or shows why it cannot.
   * Returns the file as written.
   */
  private write(fsPath: string, ownerId: string, specs: MemberSpec[]): TcSourceFile | undefined {
    // An editor may have been edited while the questions were asked.
    if (this.refuseUnsaved(fsPath)) return undefined;
    let file: TcSourceFile;
    try {
      file = parseTcFile(fsPath, fs.readFileSync(fsPath));
      const bom = file.bom;
      for (const spec of specs) file = parseTcText(fsPath, addMember(file, ownerId, spec), bom);
      fs.writeFileSync(fsPath, encodeText(file.text, bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return undefined;
    }
    this.hooks.written(fsPath);
    return file;
  }
}

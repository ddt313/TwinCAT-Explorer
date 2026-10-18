// Add Method, Add Property, Add Action and Implement Interfaces: they ask for what the new member needs, write
// it into the file of its POU or interface (see addMember) and open it, the way XAE adds an object. Delete and
// Rename of a member (and Delete of an accessor) change the file the way XAE does (see removeMember and
// renameMember) and close or move the tabs of the member.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Accessor } from '../core/objectText';
import { MemberSpec, SectionRange, addMember, isSpecialMethod, nameRanges, removeMember, renameMember } from '../core/splice';
import { TcSourceFile, encodeText, parseTcFile, parseTcText } from '../core/tcfile';
import { TcWorkspace, fileKey } from '../core/workspace';
import { LanguageIndex } from '../lang/index';
import { interfaceStubs, newMemberNameProblem, typeProblem, usesLeftByRename } from '../lang/members';
import { Loc } from '../lang/symbols';
import { hasUnsavedEdits } from './openDocs';
import { ShownTab, closeTabs, shownTabs, tabsOf } from './tabs';
import { KIND_WORD, MemberTarget } from './tree';

export type NewMemberKind = MemberSpec['kind'];

export interface MemberHooks {
  /** The file was written: everything that shows it reads it again, the tree at once. */
  written(fsPath: string): void;
  /** Opens a new member, or an accessor of a new property. */
  open(fsPath: string, objectId: string, accessor?: Accessor): Promise<void>;
  /** Where the language index finds an object or member used (not declared). */
  references(fsPath: string, objectId: string): Loc[];
  /** Lists places found by references, to open one. */
  showReferences(title: string, locs: Loc[]): Promise<void>;
  /** Opens tabs again in a file, where they were. */
  reopen(fsPath: string, tabs: ShownTab[]): Promise<void>;
}

/**
 * The message after a rename that left the uses of the old name as they were: how many the language index
 * finds, and a button that lists them. `note` (a sentence) comes after the first one.
 */
export function reportReferences(oldName: string, newName: string, locs: Loc[], show: (title: string, locs: Loc[]) => Promise<void>, note = ''): void {
  const renamed = `Renamed ${oldName} to ${newName}.${note}`;
  if (locs.length === 0) {
    void vscode.window.showInformationMessage(`${renamed} The language index finds no use of ${oldName}.`);
    return;
  }
  const uses = locs.length === 1 ? '1 use' : `${locs.length} uses`;
  void vscode.window.showInformationMessage(`${renamed} ${uses} of ${oldName} found by the language index still ${locs.length === 1 ? 'has' : 'have'} the old name.`,
    'Show Uses').then(choice => { if (choice) void show(`Uses of ${oldName}, now ${newName}`, locs); });
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
    const file = this.addMembers(fsPath, target.objectId, [spec]);
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
    if (this.addMembers(fsPath, root.id, picked.map(p => p.spec))) {
      void vscode.window.showInformationMessage(`Added to ${root.name}: ${picked.map(p => p.spec.name).join(', ')}.${notFound}`);
    }
  }

  /** Deletes a member, or an accessor of a property, after a confirmation, as XAE does; its tabs close. */
  async delete(fsPath: string, objectId: string, accessor?: Accessor): Promise<void> {
    if (this.refuseUnsaved(fsPath)) return;
    const obj = this.ws.getFile(fsPath)?.objects.get(objectId);
    if (!obj?.parent || (accessor && !obj.accessors.some(a => a.kind === accessor))) {
      void vscode.window.showWarningMessage(`TwinCAT object not found in ${path.basename(fsPath)}`);
      return;
    }
    const what = accessor ? `the ${accessor} accessor of ${obj.qualifiedName}` : `the ${KIND_WORD[obj.kind].toLowerCase()} ${obj.qualifiedName}`;
    const choice = await vscode.window.showWarningMessage(`Delete ${what}?`, {
      modal: true,
      detail: `It is removed from ${path.basename(fsPath)}, as when it is deleted in TwinCAT XAE. What uses it is not changed.`,
    }, 'Delete');
    if (choice !== 'Delete') return;
    if (this.write(fsPath, file => removeMember(file, objectId, accessor))) await closeTabs(tabsOf(fsPath, objectId, accessor));
  }

  /**
   * Renames a member as XAE does (see renameMember); its tabs open again under the new name. What uses it keeps
   * the old name, as after a rename in XAE's tree: the message says how many uses the language index finds.
   */
  async rename(fsPath: string, objectId: string): Promise<void> {
    if (this.refuseUnsaved(fsPath)) return;
    const obj = this.ws.getFile(fsPath)?.objects.get(objectId);
    const owner = obj?.parent;
    if (!obj || !owner) {
      void vscode.window.showWarningMessage(`TwinCAT object not found in ${path.basename(fsPath)}`);
      return;
    }
    const name = (await vscode.window.showInputBox({
      title: `Rename ${obj.qualifiedName}`, prompt: `New name of the ${KIND_WORD[obj.kind].toLowerCase()}`, value: obj.name,
      validateInput: v => newMemberNameProblem(owner, v.trim(), obj),
    }))?.trim();
    if (!name || name === obj.name) return;
    const uses = this.hooks.references(fsPath, objectId);
    const tabs = tabsOf(fsPath, objectId);
    const shown = shownTabs(tabs);
    let renamed: SectionRange[] = [];
    if (!this.write(fsPath, file => {
      renamed = nameRanges(file, objectId);
      return renameMember(file, objectId, name);
    })) return;
    await closeTabs(tabs);
    await this.hooks.reopen(fsPath, shown);
    const left = usesLeftByRename(uses, fileKey(fsPath), renamed, name.length - obj.name.length);
    reportReferences(obj.qualifiedName, `${owner.name}.${name}`, left, this.hooks.showReferences);
  }

  /**
   * Adds the members to the file as it is on disk and writes it back with its BOM, or shows why it cannot.
   * Returns the file as written.
   */
  private addMembers(fsPath: string, ownerId: string, specs: MemberSpec[]): TcSourceFile | undefined {
    return this.write(fsPath, file => {
      let f = file;
      for (const spec of specs) f = parseTcText(fsPath, addMember(f, ownerId, spec), file.bom);
      return f.text;
    });
  }

  /** Changes the file as it is on disk and writes it back with its BOM, or shows why it cannot. Returns the file as written. */
  private write(fsPath: string, change: (file: TcSourceFile) => string): TcSourceFile | undefined {
    // An editor may have been edited while the questions were asked.
    if (this.refuseUnsaved(fsPath)) return undefined;
    let file: TcSourceFile;
    try {
      const read = parseTcFile(fsPath, fs.readFileSync(fsPath));
      file = parseTcText(fsPath, change(read), read.bom);
      fs.writeFileSync(fsPath, encodeText(file.text, read.bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return undefined;
    }
    this.hooks.written(fsPath);
    return file;
  }
}

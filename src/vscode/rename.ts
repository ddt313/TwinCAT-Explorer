// Rename with the uses in VS Code (what changes where is lang/rename.ts'): the question of the methods and
// properties that go with a renamed one, the confirmation of the objects whose code changes (each can keep the
// old name), the refusal of files with unsaved edits, the question when the new name would change what code
// means, the message after it; and F2 (Rename Symbol) in the split editor and in notebook cells.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { positionIn } from '../core/objectText';
import { ObjectKind, TcSourceFile, encodeText, parseTcFile } from '../core/tcfile';
import { fileKey } from '../core/workspace';
import { LanguageIndex, SectionContext } from '../lang/index';
import {
  Analyse, RenameConflict, RenamePlan, changesElsewhere, planFiles, planObjects, planRename, relatedMembers, renameConflicts,
  renameTargetAt, renameTexts, symbolHome, symbolLabel, symbolNameProblem,
} from '../lang/rename';
import { EnumValueSym, Loc, MemberSym, VarSym } from '../lang/symbols';
import { RenameInfo } from '../shared/protocol';
import { LanguageFeatures } from './language';
import { hasUnsavedEdits } from './openDocs';
import { realPathOf } from './uris';

/** Lists places (the uses the index does not resolve, those whose meaning would change), to open one. */
export type ShowPlaces = (title: string, locs: Loc[]) => Promise<void>;

/** A file of the workspace as it is on disk, for renameTexts. */
export function readFromDisk(fsPath: string): TcSourceFile {
  return parseTcFile(fsPath, fs.readFileSync(fsPath));
}

/** Refuses, with a message, when an editor holds unsaved edits of one of the files: the rename writes them. */
export function refuseUnsavedFiles(paths: string[]): boolean {
  const dirty = paths.find(p => hasUnsavedEdits(p));
  if (dirty) void vscode.window.showWarningMessage(`${path.basename(dirty)} has unsaved changes in an editor. Save or revert them first.`);
  return !!dirty;
}

const ICONS: Record<ObjectKind, string> = {
  pou: 'symbol-class', method: 'symbol-method', property: 'symbol-property', action: 'symbol-event', transition: 'symbol-event',
  dut: 'symbol-structure', gvl: 'symbol-variable', itf: 'symbol-interface',
};

/**
 * Asks which methods or properties that implement or override one, or declare it in an interface, are renamed with
 * it (all of them, unless unchecked). Undefined when the rename is cancelled.
 */
export async function chooseRelated(index: LanguageIndex, target: MemberSym, newName: string): Promise<MemberSym[] | undefined> {
  const { members, library } = relatedMembers(index, target);
  if (!members.length) return [];
  const items: (vscode.QuickPickItem & { member?: MemberSym })[] = members.map(m => ({
    label: `$(symbol-${m.kind}) ${symbolLabel(m)}`, description: m.owner.pouKind === 'ITF' ? 'interface' : 'function block', picked: true, member: m,
  }));
  if (library.length) {
    items.push({ label: `Not renamed, in a library: ${library.map(symbolLabel).join(', ')}`, kind: vscode.QuickPickItemKind.Separator });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: `Rename ${symbolLabel(target)} to ${newName}`, canPickMany: true, ignoreFocusOut: true, matchOnDescription: true,
    placeHolder: `They implement or override ${target.name}, or declare it in an interface: rename them too (uncheck those that keep it)`,
  });
  return picked?.flatMap(p => (p.member ? [p.member] : []));
}

/**
 * Asks which objects whose code the rename changes get the new name, when it changes code outside what declares
 * what it renames: all of them, unless unchecked, as in XAE's refactoring dialog. The keys of the objects left out
 * (see objectKey); undefined when the rename is cancelled.
 */
export async function confirmUses(plan: RenamePlan, title: string): Promise<ReadonlySet<string> | undefined> {
  if (!changesElsewhere(plan)) return new Set();
  const objects = planObjects(plan);
  const items: (vscode.QuickPickItem & { key?: string })[] = [];
  let file = '';
  for (const o of objects) {
    if (o.filePath !== file) {
      file = o.filePath;
      items.push({ label: path.basename(file), kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: `$(${ICONS[o.kind]}) ${o.label}`, description: o.changes === 1 ? '1 change' : `${o.changes} changes`, detail: o.line, picked: true, key: o.key,
    });
  }
  const total = objects.reduce((n, o) => n + o.changes, 0);
  const picked = await vscode.window.showQuickPick(items, {
    title: `${title}: ${total} change${total === 1 ? '' : 's'} in ${objects.length} object${objects.length === 1 ? '' : 's'}`,
    canPickMany: true, ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true,
    placeHolder: `Uncheck the objects that keep the name ${plan.oldName}, then press Enter`,
  });
  if (!picked) return undefined;
  const kept = new Set(picked.map(p => p.key));
  return new Set(objects.filter(o => !kept.has(o.key)).map(o => o.key));
}

/** Where a place is, for a message: `MAIN (Implementation), line 4`. */
export function placeOf(index: LanguageIndex, loc: Loc): string {
  const ctx = index.context(loc.fileKey, loc.sectionKey);
  const text = index.sectionText(loc.fileKey, loc.sectionKey) ?? '';
  if (!ctx) return '?';
  return `${ctx.object.qualifiedName}${ctx.accessor ? `.${ctx.accessor}` : ''} (${ctx.label}), line ${positionIn(text, loc.start).line + 1}`;
}

/** Asks whether to rename although the new name would change what some places mean; true when there are none. */
export async function acceptConflicts(index: LanguageIndex, conflicts: RenameConflict[], title: string, show: ShowPlaces): Promise<boolean> {
  if (!conflicts.length) return true;
  const lines = conflicts.slice(0, 8).map(c => `${placeOf(index, c.loc)}: ${c.message}`);
  const more = conflicts.length > lines.length ? `\n... and ${conflicts.length - lines.length} more` : '';
  const places = conflicts.length === 1 ? '1 place means' : `${conflicts.length} places mean`;
  const choice = await vscode.window.showWarningMessage(`${title}: the new name would change what ${places}.`,
    { modal: true, detail: lines.join('\n') + more }, 'Rename Anyway', 'Show Places');
  if (choice === 'Show Places') void show(`${title}: places whose meaning would change`, conflicts.map(c => c.loc));
  return choice === 'Rename Anyway';
}

/**
 * The questions of a rename once its plan is made: the objects that keep the old name, the files with unsaved
 * edits, what the new name would change the meaning of. The objects left out, or undefined when the rename is
 * cancelled or refused (with a message).
 */
export async function askRename(index: LanguageIndex, plan: RenamePlan, title: string, analyse: Analyse, show: ShowPlaces):
  Promise<ReadonlySet<string> | undefined> {
  if (refuseUnsavedFiles(planFiles(plan))) return undefined;
  const leaveOut = await confirmUses(plan, title);
  // An editor may have been edited while the question was asked.
  if (!leaveOut || refuseUnsavedFiles(planFiles(plan, leaveOut))) return undefined;
  let conflicts: RenameConflict[];
  try {
    conflicts = renameConflicts(index, plan, renameTexts(plan, readFromDisk, leaveOut), leaveOut, analyse);
  } catch (e) {
    void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
    return undefined;
  }
  return (await acceptConflicts(index, conflicts, title, show)) ? leaveOut : undefined;
}

/** Names a few of a list, the rest counted: `A, B, C and 2 more`. */
function some(names: string[]): string {
  const shown = names.slice(0, 3);
  return names.length > shown.length ? `${shown.join(', ')} and ${names.length - shown.length} more` : shown.join(', ');
}

/**
 * The message after a rename: the uses it changed, the objects left out, and what keeps the old name because
 * the language index does not follow it: the places it does not resolve (Show Places lists them) and the
 * implementations in other languages and other files it does not read. `note` (a sentence) comes after the first one.
 */
export function reportRename(plan: RenamePlan, leaveOut: ReadonlySet<string>, from: string, to: string, show: ShowPlaces, note = ''): void {
  const objects = planObjects(plan);
  const kept = objects.filter(o => !leaveOut.has(o.key));
  const uses = kept.reduce((n, o) => n + o.changes, 0);
  const parts = [`Renamed ${from} to ${to}${uses ? `, with ${uses} change${uses === 1 ? '' : 's'} in ${kept.length} object${kept.length === 1 ? '' : 's'}` : ''}.${note}`];
  const left = objects.length - kept.length;
  if (left) parts.push(`${left} object${left === 1 ? '' : 's'} left out keep${left === 1 ? 's' : ''} ${plan.oldName}.`);
  const unresolved = plan.unresolved.length;
  if (unresolved) {
    parts.push(`${unresolved === 1 ? '1 place' : `${unresolved} places`} with ${plan.oldName} that the language index does not resolve keep${unresolved === 1 ? 's' : ''} it.`);
  }
  if (plan.unread.length) {
    const unread = plan.unread.map(u => (u.object ? `the ${u.language === 'NWL' ? 'FBD/LD/IL' : u.language} implementation of ${u.object}` : path.basename(u.filePath)));
    parts.push(`${plan.oldName} is also in ${some(unread)}, which the language index does not read: change it there in TwinCAT XAE.`);
  }
  const message = parts.join(' ');
  if (!unresolved && !plan.unread.length && !left) {
    void vscode.window.showInformationMessage(message);
    return;
  }
  const actions = unresolved ? ['Show Places'] : [];
  void vscode.window.showWarningMessage(message, ...actions).then(choice => {
    if (choice) void show(`${plan.oldName}, not resolved by the language index`, plan.unresolved);
  });
}

/** Saves the editors that hold unsaved edits of a file; false when one is not saved. */
async function saveEditorsOf(fsPath: string): Promise<boolean> {
  const key = fileKey(fsPath);
  const of = (uri: vscode.Uri) => {
    const p = realPathOf(uri);
    return !!p && fileKey(p) === key;
  };
  const saved = await Promise.all([
    ...vscode.workspace.textDocuments.filter(d => d.isDirty && of(d.uri)).map(d => d.save()),
    ...vscode.workspace.notebookDocuments.filter(nb => nb.isDirty && of(nb.uri)).map(nb => nb.save()),
  ]);
  return saved.every(s => s);
}

export interface RenameHooks {
  analyse: Analyse;
  /** Files were written: what shows them reads them again. */
  written(paths: string[]): void;
  showPlaces: ShowPlaces;
  /** Renames a POU, DUT, GVL or interface as Rename in the TwinCAT tree does. */
  renameObject(fsPath: string, newName: string): Promise<void>;
  /** Renames a method, property, action or transition as Rename in the TwinCAT tree does. */
  renameMember(fsPath: string, objectId: string, newName: string): Promise<void>;
}

/** F2 (Rename Symbol), in the split editor (see objectEditor.ts) and in notebook cells. */
export class SymbolRename implements vscode.RenameProvider {
  constructor(private readonly index: LanguageIndex, private readonly features: LanguageFeatures, private readonly hooks: RenameHooks) {}

  /** The name to rename at an offset of a section, with its range; or why nothing is renamed there. */
  prepare(ctx: SectionContext, text: string, offset: number): RenameInfo {
    const r = renameTargetAt(this.hooks.analyse(ctx, text), offset);
    return 'problem' in r ? r : { start: r.start, end: r.end, text: text.slice(r.start, r.end) };
  }

  /**
   * Renames what the name at an offset of a section stands for: a POU, DUT, GVL, interface or member as Rename in
   * the TwinCAT tree does, a variable, parameter, field or enum value with its uses. The file of the section is
   * saved first when the user wants it (the rename writes the files). A message says why nothing is renamed.
   */
  async rename(ctx: SectionContext, text: string, offset: number, newName: string): Promise<void> {
    if (hasUnsavedEdits(ctx.filePath)) {
      const choice = await vscode.window.showWarningMessage(
        `${path.basename(ctx.filePath)} has unsaved changes. A rename writes the files: save them first.`, 'Save and Rename');
      if (!choice || !(await saveEditorsOf(ctx.filePath))) return;
    }
    // Saved, the index may have been built again.
    const now = this.index.context(ctx.fileKey, ctx.sectionKey);
    if (!now) return;
    const r = renameTargetAt(this.hooks.analyse(now, text), offset);
    if ('problem' in r) {
      void vscode.window.showWarningMessage(r.problem);
      return;
    }
    const name = newName.trim();
    const sym = r.sym;
    if (name === sym.name) return;
    if (sym.kind === 'var' || sym.kind === 'enumValue') return this.renameSymbol(sym, name);
    const home = symbolHome(this.index, sym);
    if (!home) {
      void vscode.window.showWarningMessage(`${symbolLabel(sym)} is not declared in a file of the workspace.`);
      return;
    }
    if (sym.kind === 'pou' || sym.kind === 'type' || sym.kind === 'gvl') await this.hooks.renameObject(home.filePath, name);
    else await this.hooks.renameMember(home.filePath, home.objectId, name);
  }

  /** Renames a variable, parameter, field or enum value and its uses. */
  private async renameSymbol(sym: VarSym | EnumValueSym, name: string): Promise<void> {
    const problem = symbolNameProblem(this.index, sym, name);
    if (problem) {
      void vscode.window.showWarningMessage(problem);
      return;
    }
    const title = `Rename ${symbolLabel(sym)} to ${name}`;
    let plan: RenamePlan;
    try {
      plan = planRename(this.index, [sym], name, this.hooks.analyse);
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      return;
    }
    const leaveOut = await askRename(this.index, plan, title, this.hooks.analyse, this.hooks.showPlaces);
    if (!leaveOut) return;
    const paths = planFiles(plan, leaveOut);
    // An editor may have been edited while the questions were asked.
    if (refuseUnsavedFiles(paths)) return;
    try {
      for (const f of renameTexts(plan, readFromDisk, leaveOut).values()) fs.writeFileSync(f.filePath, encodeText(f.text, f.bom));
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
      this.hooks.written(paths);
      return;
    }
    this.hooks.written(paths);
    reportRename(plan, leaveOut, symbolLabel(sym), name, this.hooks.showPlaces);
  }

  // ------------------------------------------------------------------ notebook cells

  prepareRename(doc: vscode.TextDocument, pos: vscode.Position): { range: vscode.Range; placeholder: string } {
    const r = this.features.analysisForDocument(doc);
    if (!r?.info.live) throw new Error('Names are renamed in the TwinCAT objects of the working tree.');
    const info = this.prepare(r.ctx, doc.getText(), doc.offsetAt(pos));
    if ('problem' in info) throw new Error(info.problem);
    return { range: new vscode.Range(doc.positionAt(info.start), doc.positionAt(info.end)), placeholder: info.text };
  }

  provideRenameEdits(doc: vscode.TextDocument, pos: vscode.Position, newName: string): vscode.WorkspaceEdit {
    const r = this.features.analysisForDocument(doc);
    // Its questions are asked after VS Code's rename is done: the files are written, and the cells read them again.
    if (r?.info.live) void this.rename(r.ctx, doc.getText(), doc.offsetAt(pos), newName);
    return new vscode.WorkspaceEdit();
  }
}

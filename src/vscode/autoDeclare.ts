// XAE's Auto Declare in the split editor and in notebook cells: the quick fixes of the problems "Unknown
// identifier" (declare the name in a VAR block of the declaration) and "not a member" of a function block, program
// or interface of the workspace (add the method or property), and Auto Declare... (Shift+F2), which asks for the
// scope, name, type, initial value and comment as XAE's dialog does. A declaration is an edit of the declaration
// pane or cell, undone with Ctrl+Z there and written by safe saving. What to write comes from lang/autoDeclare.ts.

import * as vscode from 'vscode';
import { LanguageIndex, SectionContext } from '../lang/index';
import {
  DeclarationEdit, DeclarationTarget, NewVariable, QuickFix, VarScope, autoDeclareStart, declarationEdit, declarationLine,
  initialValueProblem, quickFixes, scopeLabel, variableNameProblem,
} from '../lang/autoDeclare';
import { typeProblem } from '../lang/members';
import { QuickFixResult } from '../shared/protocol';
import { LanguageFeatures, cellInfo } from './language';
import { EditorSession, ObjectEditorProvider } from './objectEditor';
import { cellMeta } from './serializers';

export interface AutoDeclareHooks {
  /** Adds a method or property named by its use to a POU or interface, without asking, and opens it. */
  addMember(fsPath: string, objectId: string, kind: 'method' | 'property', name: string, type: string | undefined): Promise<void>;
  /** Opens an object view in its editor beside the active one, the focus staying where it is. */
  openBeside(fsPath: string, objectId: string): Promise<void>;
}

/** The internal command that makes a quick fix offered in a notebook cell (its argument: the fix's id). */
const RUN_FIX = 'twincatExplorer.runQuickFix';

interface KeptFix {
  fix: QuickFix;
  ctx: SectionContext;
  /** The notebook it was offered in. */
  notebook?: vscode.NotebookDocument;
}

/** Where a declaration is shown: a pane of a split editor, or a notebook cell. */
type Site = { session: EditorSession } | { cell: vscode.TextDocument };

/** The view of a section, as the messages name it: `FB_Valve`, `FB_Valve.P_Pos.Get`. */
function viewName(ctx: SectionContext): string {
  return `${ctx.object.qualifiedName}${ctx.accessor ? `.${ctx.accessor}` : ''}`;
}

export class AutoDeclare implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };
  /** Fixes offered lately, by id: the split editor and the notebook command make them later. */
  private readonly kept = new Map<number, KeptFix>();
  private lastId = 0;

  constructor(private readonly index: LanguageIndex, private readonly features: LanguageFeatures,
    private readonly editors: ObjectEditorProvider, private readonly hooks: AutoDeclareHooks) {}

  register(selector: vscode.DocumentSelector): vscode.Disposable[] {
    return [
      vscode.languages.registerCodeActionsProvider(selector, this, AutoDeclare.metadata),
      vscode.commands.registerCommand('twincatExplorer.autoDeclare', () => this.command()),
      vscode.commands.registerCommand(RUN_FIX, (id: unknown) => (typeof id === 'number' ? this.runFix(undefined, id) : undefined)),
    ];
  }

  private keep(fix: QuickFix, ctx: SectionContext, notebook?: vscode.NotebookDocument): number {
    const id = ++this.lastId;
    this.kept.set(id, { fix, ctx, notebook });
    for (const old of this.kept.keys()) {
      if (this.kept.size <= 200) break;
      this.kept.delete(old);
    }
    return id;
  }

  // ------------------------------------------------------------------ the split editor

  /** The quick fixes of the problems at an offset of a pane, its text as the pane shows it. */
  quickFixes(session: EditorSession, key: string, text: string, offset: number): QuickFixResult[] {
    const ctx = this.index.context(session.fileKey, key);
    if (!ctx) return [];
    const problems = this.features.problemsOf(ctx, text).filter(p => p.start <= offset && offset <= p.end);
    return quickFixes(this.index, ctx, text, problems).map(fix => ({
      id: this.keep(fix, ctx), title: fix.title, start: fix.problem.start, end: fix.problem.end, preferred: fix.preferred,
    }));
  }

  /** Makes a quick fix offered before, in the split editor it came from (`session`) or a notebook. */
  async runFix(session: EditorSession | undefined, id: number): Promise<void> {
    const kept = this.kept.get(id);
    if (!kept) return;
    const { fix, ctx } = kept;
    try {
      if (fix.kind === 'declare') {
        await this.declare(ctx, fix.target, fix.scope, fix.variable, session ?? kept.notebook);
        return;
      }
      const loc = fix.owner.loc;
      const owner = loc && this.index.context(loc.fileKey, loc.sectionKey);
      if (!owner) {
        void vscode.window.showWarningMessage(`${fix.owner.name} is not in the workspace any more.`);
        return;
      }
      await this.hooks.addMember(owner.filePath, owner.object.id, fix.member, fix.name, fix.type);
    } catch (e) {
      void vscode.window.showErrorMessage(`TwinCAT: ${(e as Error).message}`);
    }
  }

  /** Auto Declare... at an offset of a pane (Shift+F2 there). */
  async autoDeclare(session: EditorSession, key: string, text: string, offset: number): Promise<void> {
    const ctx = this.index.context(session.fileKey, key);
    if (ctx) await this.ask(ctx, text, offset, session);
  }

  // ------------------------------------------------------------------ notebook cells

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const diagnostics = context.diagnostics.filter(d => d.source === 'TwinCAT');
    const info = diagnostics.length ? cellInfo(doc) : undefined;
    const ctx = info?.live ? this.index.context(info.fileKey, info.sectionKey) : undefined;
    if (!info || !ctx) return [];
    const text = doc.getText();
    const problems = this.features.problemsOf(ctx, text);
    const out: vscode.CodeAction[] = [];
    for (const d of diagnostics) {
      const offset = doc.offsetAt(d.range.start);
      for (const fix of quickFixes(this.index, ctx, text, problems.filter(p => p.start === offset))) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        action.isPreferred = fix.preferred;
        // A declaration cell of the same notebook gets the edit itself; the rest is done when picked.
        const cell = fix.kind === 'declare' ? this.cellOf(info.notebook, ctx.fileKey, fix.target.key) : undefined;
        const edit = cell && fix.kind === 'declare' ? this.cellEdit(cell, fix.target, fix.scope, fix.variable) : undefined;
        if (edit && !('problem' in edit)) action.edit = edit.edit;
        else action.command = { command: RUN_FIX, title: fix.title, arguments: [this.keep(fix, ctx, info.notebook)] };
        out.push(action);
      }
    }
    return out;
  }

  /** The command: in the split editor at the cursor of the pane edited last, else in the notebook cell. */
  private async command(): Promise<void> {
    const session = this.editors.activeSession();
    if (session) {
      session.post({ type: 'autoDeclare' });
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const info = editor && cellInfo(editor.document);
    const ctx = info?.live ? this.index.context(info.fileKey, info.sectionKey) : undefined;
    if (!editor || !info || !ctx) {
      void vscode.window.showInformationMessage('Auto Declare works in the TwinCAT split editor and in the cells of TwinCAT notebooks.');
      return;
    }
    await this.ask(ctx, editor.document.getText(), editor.document.offsetAt(editor.selection.active), info.notebook);
  }

  // ------------------------------------------------------------------ declaring

  /** Asks for the scope, name, type, initial value and comment, as XAE's Auto Declare dialog, then declares the variable. */
  private async ask(ctx: SectionContext, text: string, offset: number, from: EditorSession | vscode.NotebookDocument): Promise<void> {
    const start = autoDeclareStart(this.index, ctx, text, offset);
    if (!start) {
      void vscode.window.showInformationMessage(`Variables are declared in programs, function blocks, functions, methods, the Get and Set of properties `
        + `and GVLs, not in ${ctx.object.qualifiedName}.`);
      return;
    }
    const title = `Auto Declare in ${viewName(start.target.ctx)}`;
    const declaration = () => this.index.sectionText(ctx.fileKey, start.target.key) ?? '';
    const scope = (await vscode.window.showQuickPick(start.scopes.map(s => ({ label: scopeLabel(s), scope: s })), {
      title, placeHolder: 'Scope of the new variable',
    }))?.scope;
    if (!scope) return;
    const name = (await vscode.window.showInputBox({
      title, prompt: `Name of the new ${scopeLabel(scope)} variable`, value: start.name, validateInput: v => variableNameProblem(declaration(), v.trim()),
    }))?.trim();
    if (!name) return;
    const type = (await vscode.window.showInputBox({ title, prompt: `Type of ${name}`, value: start.type, validateInput: typeProblem }))?.trim();
    if (!type) return;
    const init = await vscode.window.showInputBox({
      title, prompt: `Initial value of ${name}: empty for none`, validateInput: v => (v.trim() ? initialValueProblem(type, v) : undefined),
    });
    if (init === undefined) return;
    const comment = await vscode.window.showInputBox({ title, prompt: `Comment on ${name}: empty for none` });
    if (comment === undefined) return;
    await this.declare(ctx, start.target, scope, { name, type, init, comment }, from);
  }

  /** The edit of a declaration text that declares the variable, or why there is none. */
  private editOf(text: string, target: DeclarationTarget, scope: VarScope, v: NewVariable): DeclarationEdit | { problem: string } {
    const problem = variableNameProblem(text, v.name);
    if (problem) return { problem };
    return declarationEdit(text, scope, declarationLine(v))
      ?? { problem: `The declaration of ${viewName(target.ctx)} has a block without END_VAR. Correct it first.` };
  }

  /** The edit of a declaration cell that declares the variable, or why there is none. */
  private cellEdit(cell: vscode.TextDocument, target: DeclarationTarget, scope: VarScope, v: NewVariable): { edit: vscode.WorkspaceEdit } | { problem: string } {
    const r = this.editOf(cell.getText(), target, scope, v);
    if ('problem' in r) return r;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(cell.uri, cell.positionAt(r.offset), r.text);
    return { edit };
  }

  /** The cell of a notebook that shows a section of the file; none in another file's or a history notebook. */
  private cellOf(notebook: vscode.NotebookDocument, fileKey: string, key: string): vscode.TextDocument | undefined {
    const cell = notebook.getCells().find(c => cellMeta(c)?.key === key && !cellMeta(c)?.header)?.document;
    const info = cell && cellInfo(cell);
    return info?.live && info.fileKey === fileKey ? cell : undefined;
  }

  /** Where a declaration is shown: in the tab the fix came from when it shows it, else in another tab, if any. */
  private siteOf(ctx: SectionContext, key: string, from: EditorSession | vscode.NotebookDocument | undefined): Site | undefined {
    const shows = (s: EditorSession) => s.fileKey === ctx.fileKey && !!s.parse()?.sections.some(x => x.key === key);
    if (from instanceof EditorSession) {
      if (shows(from)) return { session: from };
    } else if (from) {
      const cell = this.cellOf(from, ctx.fileKey, key);
      if (cell) return { cell };
    }
    const sessions = this.editors.allSessions().filter(shows);
    const session = sessions.find(s => s.panel.active) ?? sessions.find(s => s.panel.visible) ?? sessions[0];
    if (session) return { session };
    for (const nb of vscode.workspace.notebookDocuments) {
      const cell = this.cellOf(nb, ctx.fileKey, key);
      if (cell) return { cell };
    }
    return undefined;
  }

  /**
   * Declares a variable in a declaration of the file of `ctx`: in the tab the fix or command came from, or another
   * tab showing it (the POU of an action has its own), opened beside when there is none.
   */
  private async declare(ctx: SectionContext, target: DeclarationTarget, scope: VarScope, v: NewVariable,
    from: EditorSession | vscode.NotebookDocument | undefined): Promise<void> {
    let site = this.siteOf(ctx, target.key, from);
    if (!site) {
      await this.hooks.openBeside(ctx.filePath, target.ctx.object.id);
      // The editor can come a moment after the open resolved.
      for (let i = 0; i < 20 && !site; i++) {
        site = this.siteOf(ctx, target.key, undefined);
        if (!site) await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!site) {
      void vscode.window.showWarningMessage(`The declaration of ${viewName(target.ctx)} could not be opened.`);
      return;
    }
    if ('cell' in site) {
      const r = this.cellEdit(site.cell, target, scope, v);
      if ('problem' in r) void vscode.window.showWarningMessage(r.problem);
      else await vscode.workspace.applyEdit(r.edit);
      return;
    }
    const session = site.session;
    const outcome: { problem?: string; shown?: { end: number; text: string } } = {};
    const made = await session.changeDocument(parsed => {
      const section = parsed.sections.find(s => s.key === target.key);
      if (!section) return undefined;
      const r = this.editOf(section.text, target, scope, v);
      if ('problem' in r) {
        outcome.problem = r.problem;
        return undefined;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.insert(session.document.uri, session.document.positionAt(section.start + r.offset), r.text);
      outcome.shown = { end: r.end, text: section.text.slice(0, r.offset) + r.text + section.text.slice(r.offset) };
      return edit;
    });
    if (outcome.problem) void vscode.window.showWarningMessage(outcome.problem);
    // The pane shows the new declaration, its cursor after it (nothing selected that typing would replace); the
    // focus stays where the fix was made.
    else if (made && outcome.shown) session.reveal({ key: target.key, start: outcome.shown.end, end: outcome.shown.end, text: outcome.shown.text, focus: false });
  }
}

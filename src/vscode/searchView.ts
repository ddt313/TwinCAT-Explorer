// The TwinCAT Search view in the Explorer: the matches of a text or regular expression in the Structured Text of the
// TwinCAT objects as the split editor shows it, unsaved edits included (lang/search.ts), listed per file and section.
// It searches all PLC projects, or the project or folder of the TwinCAT tree it was started from (Find in Folder...),
// which later searches keep until widened. The query is typed in an input box, with Match Case, Whole Word, Regular
// Expression and Skip Comments as its buttons (Alt+C, Alt+W, Alt+R, as in VS Code's find), and runs as it is typed.
// A search runs in steps of a few milliseconds between which the extension host does other work, and runs again when
// the code changes; a click on a match opens the split editor there.

import * as path from 'path';
import * as vscode from 'vscode';
import { Accessor, viewLabel } from '../core/objectText';
import { objectTreeLabel } from '../core/treeLabels';
import { TcWorkspace } from '../core/workspace';
import { LanguageIndex } from '../lang/index';
import {
  Matcher, QueryError, SearchCount, SearchHit, SearchQuery, SearchScope, SearchSource, compileQuery, matchLines, searchSections,
} from '../lang/search';
import { TreeIcon, accessorIcon, objectIcon } from './tree';

export const SEARCH_VIEW = 'twincatExplorer.search';
/** At most this many matches are listed. */
const LIMIT = 10_000;
/** How long one step of a search runs before the extension host gets its turn back. */
const STEP_MS = 15;
/** A search that takes longer shows what it found so far, every half second. */
const PARTIAL_AFTER_MS = 1000;

export type SearchOption = 'matchCase' | 'wholeWord' | 'regex' | 'skipComments';
type SearchOptions = Record<SearchOption, boolean>;

/** The options, with their buttons in the input box and the letter of their key there (Alt+C). */
const OPTIONS: { key: SearchOption; title: string; icon: string; letter: string }[] = [
  { key: 'matchCase', title: 'Match Case', icon: 'case-sensitive', letter: 'C' },
  { key: 'wholeWord', title: 'Match Whole Word', icon: 'whole-word', letter: 'W' },
  { key: 'regex', title: 'Use Regular Expression', icon: 'regex', letter: 'R' },
  { key: 'skipComments', title: 'Skip Comments', icon: 'comment', letter: '' },
];

/** Where a search looks, and its name for the view and the input box: `Machine › POUs › Valves`. */
export interface ScopeChoice {
  scope: SearchScope;
  label: string;
}

const EVERYWHERE: ScopeChoice = { scope: { kind: 'all' }, label: 'all PLC projects' };

/** A match, and where the split editor shows it. */
export interface SearchMatch {
  fsPath: string;
  objectId: string;
  accessor?: Accessor;
  sectionKey: string;
  start: number;
  end: number;
  /** The section text the offsets are in. */
  text: string;
}

export class SearchNode {
  children: SearchNode[] = [];
  description?: string;
  tooltip?: string;
  icon?: TreeIcon;
  /** Where the match label is highlighted. */
  highlight?: [number, number];
  match?: SearchMatch;

  constructor(readonly id: string, readonly type: 'file' | 'section' | 'match', readonly label: string, readonly parent?: SearchNode) {}
}

/** Gives the extension host its turn: other events run before the search goes on. */
function pause(): Promise<void> {
  return new Promise(resolve => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class SearchView implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SearchNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<SearchNode> | undefined;
  private roots: SearchNode[] = [];
  private text = '';
  private options: SearchOptions;
  private scope = EVERYWHERE;
  /** Increased by each search: an older one stops. */
  private generation = 0;
  private running = false;
  private count: SearchCount = { matches: 0, capped: false };
  private files = 0;
  private error: string | undefined;
  /** The code changed while the view was hidden: searched again when it shows. */
  private stale = false;
  private timer: NodeJS.Timeout | undefined;
  private input: vscode.InputBox | undefined;
  private lastClick: { id: string; time: number } | undefined;
  /** Opens the split editor at a match; `pinned` for a double click (not a preview, focus in the editor). */
  openMatch?: (match: SearchMatch, pinned: boolean) => Promise<void>;

  constructor(private readonly ws: TcWorkspace, private readonly index: LanguageIndex, private readonly state: vscode.Memento) {
    const saved = state.get<Partial<SearchOptions>>('twincatExplorer.searchOptions') ?? {};
    this.options = { matchCase: !!saved.matchCase, wholeWord: !!saved.wholeWord, regex: !!saved.regex, skipComments: !!saved.skipComments };
    this.updateContext();
  }

  attach(view: vscode.TreeView<SearchNode>): vscode.Disposable {
    this.view = view;
    return view.onDidChangeVisibility(e => {
      if (e.visible && this.stale) this.schedule(0);
    });
  }

  private get query(): SearchQuery {
    return { text: this.text, ...this.options };
  }

  // ------------------------------------------------------------------ the input box

  /**
   * Asks for the text to search, searching as it is typed. `scope`: where to search from now on (Find in Folder...),
   * else where the last search did; `text`: the text to start with, else the last one.
   */
  async ask(scope?: ScopeChoice, text?: string): Promise<void> {
    if (scope) this.scope = scope;
    if (text) this.text = text;
    // The results are seen as they come.
    await vscode.commands.executeCommand(`${SEARCH_VIEW}.focus`);
    this.input?.dispose();
    const input = vscode.window.createInputBox();
    this.input = input;
    input.value = this.text;
    input.valueSelection = [0, this.text.length];
    this.updateInput();
    input.onDidChangeValue(value => {
      this.text = value;
      this.schedule(this.options.regex ? 250 : 150);
    });
    input.onDidTriggerButton(button => {
      const option = OPTIONS.find(o => o.icon === (button.iconPath as vscode.ThemeIcon).id);
      if (option) this.toggle(option.key);
      else this.widen();
    });
    input.onDidAccept(() => {
      input.hide();
      // From the input box to the results, for the arrow keys.
      void vscode.commands.executeCommand(`${SEARCH_VIEW}.focus`);
    });
    input.onDidHide(() => {
      if (this.timer) this.schedule(0);
      if (this.input === input) this.input = undefined;
      input.dispose();
      void vscode.commands.executeCommand('setContext', 'twincatExplorer.searchInput', false);
    });
    input.show();
    void vscode.commands.executeCommand('setContext', 'twincatExplorer.searchInput', true);
    if (this.text) this.schedule(0);
  }

  private updateInput(): void {
    const input = this.input;
    if (!input) return;
    const mac = process.platform === 'darwin';
    input.title = `TwinCAT Search: ${this.scope.label}`;
    input.placeholder = this.options.regex ? 'Regular expression (RE2 syntax) to find in the Structured Text' : 'Text to find in the Structured Text';
    const on = OPTIONS.filter(o => this.options[o.key]).map(o => o.title);
    input.prompt = on.length ? `On: ${on.join(', ')}.` : 'Upper and lower case alike, as in Structured Text.';
    input.validationMessage = this.error;
    input.buttons = [
      ...OPTIONS.map(o => ({
        iconPath: new vscode.ThemeIcon(o.icon),
        tooltip: `${o.title}${o.letter ? ` (${mac ? '⌥⌘' : 'Alt+'}${o.letter})` : ''}: ${this.options[o.key] ? 'on' : 'off'}`,
      })),
      ...(this.scope === EVERYWHERE ? [] : [{ iconPath: new vscode.ThemeIcon('root-folder'), tooltip: 'Search all PLC projects' }]),
    ];
  }

  /** Turns an option on or off, for the next searches too, and searches again. */
  toggle(option: SearchOption): void {
    this.options[option] = !this.options[option];
    void this.state.update('twincatExplorer.searchOptions', this.options);
    this.updateContext();
    this.updateInput();
    if (this.text) this.schedule(0);
  }

  /** Searches all PLC projects from now on. */
  private widen(): void {
    this.scope = EVERYWHERE;
    this.updateInput();
    if (this.text) this.schedule(0);
  }

  private updateContext(): void {
    for (const o of OPTIONS) void vscode.commands.executeCommand('setContext', `twincatExplorer.search.${o.key}`, this.options[o.key]);
    void vscode.commands.executeCommand('setContext', 'twincatExplorer.searchActive', !!this.text);
  }

  // ------------------------------------------------------------------ searching

  /** The code may have changed: the search runs again, now or once the view shows. */
  changed(): void {
    if (!this.text) return;
    this.stale = true;
    if (this.view?.visible) this.schedule(500);
  }

  /** Runs the search again (Refresh). */
  refresh(): void {
    this.schedule(0);
  }

  /** Forgets the search: its text, results and scope (Clear Search Results). */
  clear(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.text = '';
    this.scope = EVERYWHERE;
    this.roots = [];
    this.error = undefined;
    this.running = false;
    if (this.input) this.input.value = '';
    this.updateInput();
    this.updateContext();
    this.updateTitle();
    this.emitter.fire(undefined);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  private source(): SearchSource {
    return {
      entries: this.ws.sourceEntries,
      file: e => this.ws.getFile(e.path),
      // What the split editors and notebooks show, unsaved edits included.
      text: (e, s) => this.index.overlayText(e.key, s.key),
    };
  }

  private async run(): Promise<void> {
    const generation = ++this.generation;
    this.stale = false;
    this.updateContext();
    this.error = undefined;
    if (!this.text) {
      this.roots = [];
      this.running = false;
      this.updateInput();
      this.updateTitle();
      this.emitter.fire(undefined);
      return;
    }
    let matcher: Matcher;
    try {
      matcher = compileQuery(this.query);
    } catch (e) {
      if (!(e instanceof QueryError)) throw e;
      // The results of the last valid query stay, with what is wrong with this one.
      this.error = e.message;
      this.running = false;
      this.updateInput();
      this.updateTitle();
      return;
    }
    this.updateInput();
    const count: SearchCount = { matches: 0, capped: false };
    const steps = searchSections(this.source(), this.scope.scope, matcher, LIMIT, count);
    const roots: SearchNode[] = [];
    const files = new Map<string, SearchNode>();
    const show = () => {
      this.roots = roots;
      this.count = count;
      this.files = files.size;
      this.updateTitle();
      this.emitter.fire(undefined);
    };
    this.running = true;
    this.updateTitle();
    await vscode.window.withProgress({ location: { viewId: SEARCH_VIEW } }, async () => {
      const started = Date.now();
      let shown = started;
      for (;;) {
        const until = Date.now() + STEP_MS;
        let done = false;
        while (!done && Date.now() < until) {
          const step = steps.next();
          if (step.done) done = true;
          else if (step.value) this.add(step.value, roots, files);
        }
        if (done || generation !== this.generation) return;
        if (Date.now() - started > PARTIAL_AFTER_MS && Date.now() - shown > 500) {
          shown = Date.now();
          show();
        }
        await pause();
        if (generation !== this.generation) return;
      }
    });
    if (generation !== this.generation) return;
    this.running = false;
    show();
  }

  /** The nodes of a section with matches: under its file's node, made with the first match in the file. */
  private add(hit: SearchHit, roots: SearchNode[], files: Map<string, SearchNode>): void {
    const { entry, file, section } = hit;
    let fileNode = files.get(entry.key);
    if (!fileNode) {
      const folder = entry.include.includes('\\') ? entry.include.slice(0, entry.include.lastIndexOf('\\')) : '';
      fileNode = new SearchNode(`sf:${entry.key}`, 'file', file.root ? objectTreeLabel(file.root) : path.basename(entry.path));
      fileNode.description = [this.ws.plcProjects.length > 1 ? entry.project.name : '', folder].filter(s => s).join(' · ');
      fileNode.tooltip = `${entry.include} (${entry.project.name})`;
      fileNode.icon = file.root && objectIcon(file.root);
      files.set(entry.key, fileNode);
      roots.push(fileNode);
    }
    const owner = section.owner;
    const name = owner.parent ? `${owner.name}${section.accessor ? `.${section.accessor}` : ''}` : owner.name;
    const role = section.role === 'decl' ? 'Declaration' : 'Implementation';
    const sectionNode = new SearchNode(`ss:${entry.key}|${section.key}`, 'section', name, fileNode);
    sectionNode.description = role;
    sectionNode.tooltip = `${viewLabel(owner, section.accessor)} · ${role}`;
    sectionNode.icon = section.accessor ? accessorIcon(section.accessor) : objectIcon(owner);
    fileNode.children.push(sectionNode);
    // A match far into a long line is seen in the narrow view: 26 characters before it at most, as VS Code's search.
    const lines = matchLines(hit.text, hit.matches, 250, 26);
    hit.matches.forEach((m, i) => {
      const l = lines[i];
      const node = new SearchNode(`sm:${entry.key}|${section.key}|${m.start}`, 'match', l.preview, sectionNode);
      node.highlight = l.highlight;
      node.tooltip = `${role}, line ${l.line + 1}, column ${l.character + 1}`;
      node.match = {
        fsPath: entry.path, objectId: owner.id, accessor: section.accessor, sectionKey: section.key, start: m.start, end: m.end, text: hit.text,
      };
      sectionNode.children.push(node);
    });
  }

  private updateTitle(): void {
    const view = this.view;
    if (!view) return;
    const on = OPTIONS.filter(o => this.options[o.key]).map(o => o.title);
    view.description = this.text ? `"${this.text}"${on.length ? ` · ${on.join(', ')}` : ''}` : undefined;
    const where = this.scope.label;
    // What was searched, in the message too: the view's description is cut short in a narrow view.
    const what = `"${this.text}"${on.length ? ` (${on.join(', ')})` : ''}`;
    if (!this.text) view.message = undefined;
    else if (this.error) view.message = this.error;
    else if (this.running && !this.roots.length) view.message = `Searching ${where} for ${what}...`;
    else if (!this.count.matches) view.message = `No results for ${what} in ${where}.`;
    else {
      view.message = `${plural(this.count.matches, 'result')} for ${what} in ${plural(this.files, 'file')}, ${where}.`
        + (this.count.capped ? ` Only the first ${LIMIT} are listed: narrow the search.` : '');
    }
  }

  // ------------------------------------------------------------------ opening

  /** Opens the split editor at a match: a preview the first click, kept by a double click. */
  async open(node: SearchNode | undefined): Promise<void> {
    if (!node?.match) return;
    const now = Date.now();
    const pinned = this.lastClick?.id === node.id && now - this.lastClick.time < 500;
    this.lastClick = { id: node.id, time: now };
    await this.openMatch?.(node.match, pinned);
  }

  // ------------------------------------------------------------------ TreeDataProvider

  getTreeItem(node: SearchNode): vscode.TreeItem {
    const collapsed = node.type === 'file' && this.count.matches > 2000;
    const item = new vscode.TreeItem(
      node.highlight && node.highlight[1] > node.highlight[0] ? { label: node.label, highlights: [node.highlight] } : node.label,
      node.type === 'match' ? vscode.TreeItemCollapsibleState.None
        : collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = node.icon;
    item.contextValue = node.type;
    if (node.match) item.command = { command: 'twincatExplorer.search.open', title: 'Open', arguments: [node] };
    return item;
  }

  getChildren(node?: SearchNode): SearchNode[] {
    return node ? node.children : this.roots;
  }

  getParent(node: SearchNode): SearchNode | undefined {
    return node.parent;
  }

  /** The nodes at the top, for the tests. */
  get rootNodes(): SearchNode[] {
    return this.roots;
  }

  dispose(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.input?.dispose();
    this.emitter.dispose();
  }
}

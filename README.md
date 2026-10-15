# TwinCAT Explorer

A VS Code extension that shows the TwinCAT PLC projects of the workspace the way
TwinCAT XAE does, and opens every POU, method, property and accessor as its own editor
with the **Declaration above the Implementation** like XAE, while the code stays in the
`.TcPOU`/`.TcDUT`/`.TcGVL`/`.TcIO` XML files.

## Features

- **TwinCAT tree** in the Explorer (below Outline and Timeline): one root per `.tsproj`,
  then its PLC projects, `References`, and the folders and objects of the `.plcproj`.
  Inside a POU it shows the folders TwinCAT keeps in the XML (`Methods > States`),
  methods, properties with `Get`/`Set`, actions and transitions. Labels follow XAE
  (`FB_X (FB)`, `MAIN (PRG)`), modified files get their git colour.
- **One tab per object**, titled `FB_X`, `FB_X.Method` or `FB_X.Property.Get`, in an
  XAE-like **split editor**: the Declaration in the upper pane, the Implementation in the
  lower one, each with its own scroll bar, both the same height at first. Drag the bar
  between them to change the heights (the tab remembers it); double-click the bar for
  equal halves again. Like XAE, a property tab shows the property declaration, and its
  `Get` and `Set` open in their own tabs; DUTs, GVLs and interfaces have one pane.
  Single click in the tree opens a preview tab, double click (or editing) keeps it.
  Breadcrumbs follow the XAE path. The panes are Monaco editors (the editor VS Code is
  built on) with the VS Code font, tab and theme settings and the same colors.
- The **notebook** (one cell per section) is still available: set
  `twincatExplorer.editor` to `notebook`, or use `Reopen Editor With... > TwinCAT Object
  (Notebook)` on a tab.
- **Safe saving**: only the CDATA of the sections you edited is replaced; BOM, CRLF,
  GUIDs and every other byte of the file stay as they were. Sections you did not touch
  are never written back, so changes made meanwhile in XAE or by git survive. If a
  section you edited was also changed on disk, the save is refused with a message instead
  of overwriting it. Two tabs of the same file can be edited and saved independently.
  Open tabs without unsaved edits reload when the file changes on disk. Undoing back to
  the text on disk makes the tab clean again.
- **Renaming is blocked**: changing the name in a declaration header
  (`METHOD OnEntry` to `METHOD OnEnter`) makes the save fail with a message; rename
  in TwinCAT XAE.
- **Structured Text language features** in both panes (and in notebook cells), from a parser of the TwinCAT
  dialect (`EXTENDS`, `IMPLEMENTS`, `THIS^`, `SUPER^`, properties, `REFERENCE TO`, ...):
  - Go to Definition (F12, Ctrl+click), including members through variable types and
    inheritance (`fbValve.Open()` opens the `Open` method `FB_Valve` inherits, at the
    method name; a local variable moves the cursor to the declaration pane).
  - Hover with the declaration, its comments and where it is declared.
  - Completion after `.` (members, inherited members, enum values) and of names in scope.
  - Find All References (Shift+F12 opens a peek view; other objects are shown read-only
    there, double-click a result to open it).
  - Problems: syntax errors, unknown identifiers, unknown members, unknown named
    parameters, while you type, in the editor and in the Problems panel (a click there
    opens the split editor at the problem).
  - Outline of the declared variables (notebook cells).
- **Ctrl+T** finds POUs, methods, properties, DUTs, GVLs and global variables and opens
  the split editor at the symbol.
  **Ctrl+Alt+T** (`TwinCAT: Go to Object...`) lists all objects of the workspace.
- **Changes vs HEAD** in the tree and the split editor:
  - The TwinCAT tree marks the methods, properties and accessors that differ from `HEAD`
    with `M` (changed) or `A` (new), like the Explorer marks files; the tab of an object
    view has the same mark. Only the Structured Text and the name count, not metadata
    such as `ProductVersion`.
  - Each pane of the split editor marks its changed lines in the gutter (green: added,
    blue: changed, red wedge: removed), unsaved edits included. `Alt+F5` and
    `Shift+Alt+F5` go to the next and previous change.
  - `Show Changes vs HEAD` (editor title button, or a click on a change marker) turns
    both panes into inline diffs against `HEAD`: unchanged lines are folded, the panes
    stay editable, and the `Revert Block` button next to a change puts the `HEAD` text
    back. `Hide Changes vs HEAD` returns to the normal panes. A commit, checkout or
    rebase updates the comparison.
- **TwinCAT Changes** view in the Source Control sidebar:
  - Lists the objects that differ (POU, methods, properties, accessors), grouped by POU and
    marked `M`, `A` or `D`. Two scopes, switched in the view's title bar: uncommitted
    changes (vs `HEAD`), or branch changes since the merge base with another branch, what
    a merge request shows (`origin/develop` by default, `Compare Branch With...` picks
    another one), uncommitted changes included.
  - A click opens the object in the split editor with the diff against that base, at its
    first change. A deleted object opens as read-only text of its old version.
  - `Discard Changes` (uncommitted scope): the code of an object goes back to `HEAD`, a new
    method, property, action or accessor is removed, a whole file goes back to `HEAD` (in
    the working tree and the index). Refused while an editor has unsaved edits of the file.
  - `Build output (no code changes)` gathers files whose change is only XAE metadata: a
    `.tsproj` with only new `TmcHash` values, a source file with only a new
    `ProductVersion`. They can be discarded too. Other `.tsproj`/`.plcproj` changes are
    under `Project files`; a click shows their XML diff.
- **Notebook diff for git**: `Open Changes as TwinCAT Notebook` (tree, Explorer and
  Source Control menus, the `...` menu of a split editor tab) compares a whole file with
  `HEAD` (or, in Staged Changes, HEAD with the index) section by section; unchanged
  sections are folded.
  Staged renames are followed, and an open comparison refreshes after a commit,
  checkout or stage. The Source Control menu cannot filter by file type, so the entry
  shows on every changed file and answers with a message for other files.
  `Compare with Git Ref as TwinCAT Notebook...` compares with any branch or commit,
  for example `origin/develop` when reviewing a merge request.
- `Reopen Editor With... > TwinCAT File (Notebook)` shows a whole `.TcPOU` as one notebook.
- `TwinCAT: Check All Structured Text` analyses every section of every project and
  reports the problems on the XML files.

## Install, update, uninstall

VS Code profiles have their own extensions, and the `code` CLI installs into the
**Default** profile unless told otherwise. A window that uses another profile (see the
gear menu > Profiles) then never loads the extension, or keeps an old version. Always
name the profile:

```bash
npm run package
npm run install:local -- <profile>
```

`install:local` runs `code --install-extension twincat-explorer-<version>.vsix --force --profile <profile>`.
Another way is `Extensions: Install from VSIX...` in the target window, which installs
into that window's profile. Reload the window afterwards. To uninstall:

```bash
code --uninstall-extension thanhdang.twincat-explorer --profile <profile>
```

The `TwinCAT Explorer` output channel logs what was loaded and any project file that
could not be read (for example a `.plcproj` with merge conflict markers, which the tree
marks with a warning).

## Notebook toolbars

VS Code has no per-notebook-type switch for the notebook toolbar (`Run All`,
`Select Kernel`, `+ Code`, `+ Markdown`). The extension hides the cell toolbar of
TwinCAT notebooks only. Run `TwinCAT: Hide Notebook Toolbars (XAE-like Layout)` to
also hide the top toolbar and the insert buttons; it changes `notebook.globalToolbar`
and `notebook.insertToolbarLocation` in the user settings, for every notebook.
The same command can show them again.

## Settings

| Setting | Default | |
|---|---|---|
| `twincatExplorer.autoReveal` | `true` | Select the active object in the tree. |
| `twincatExplorer.foldersFirst` | `true` | Folders before objects in the tree. |
| `twincatExplorer.editor` | `split` | `split`: XAE-like split editor; `notebook`: one cell per section. |
| `twincatExplorer.diagnostics.enabled` | `true` | Report problems in open TwinCAT editors. |
| `twincatExplorer.diagnostics.ignore` | `[]` | Identifiers never reported as unknown. |
| `twincatExplorer.stubFiles` | `[]` | Extra library stub files (see below). |
| `twincatExplorer.exclude` | `**/{node_modules,.git,.claude,_Boot,_CompileInfo,_Libraries}/**` | Ignored when searching `.tsproj` files. Folders whose name starts with a dot (git worktrees in `.claude/worktrees`, ...) are always ignored. |

## Libraries

Beckhoff libraries ship compiled, so their declarations are not in the workspace.
The extension bundles stubs for the parts in common use (Tc2_Standard timers and
triggers, Tc2_System logging and memory functions, Tc2_Utilities `FB_FormatString`,
Tc2_MC2 axis function blocks, Tc2_Math, Tc3_Module, TcUnit). Symbols of other
libraries are reported as unknown; add them to a stub file and list it in
`twincatExplorer.stubFiles`:

```
LIBRARY Tc2_EtherCAT
FUNCTION_BLOCK FB_EcGetSlaveCount
VAR_INPUT
	sNetId : T_AmsNetId;
	bExecute : BOOL;
END_VAR
VAR_OUTPUT
	bBusy : BOOL;
	bError : BOOL;
	nSlaves : UINT;
END_VAR
END_FUNCTION_BLOCK
END_LIBRARY
```

PLC projects of the workspace that other PLC projects reference as libraries are
resolved from their sources.

## Limitations

- Only Structured Text is editable; other implementation languages are shown as
  read-only placeholders.
- Objects are created, renamed, moved and deleted in TwinCAT XAE.
- If TwinCAT XAE has the same project open, it keeps its own copy in memory and can
  overwrite changes saved from VS Code; reload the project in XAE after editing here.
- The tree covers the PLC projects; I/O, motion and task configuration stay in XAE.
- The split editor runs in a webview: extensions that work inside VS Code text editors
  (GitHub Copilot inline suggestions, vim keys, GitLens) do not reach it, and VS Code's
  Outline view stays empty for it. Its change markers are its own and compare with
  `HEAD` only (not with the index). Inside the panes, Monaco's own key bindings
  win: its `Ctrl+K` chords (`Ctrl+K Ctrl+C` comments the line, `Ctrl+K Ctrl+0` folds all)
  work, and so do the common VS Code chords (`Ctrl+K S` save all, `Ctrl+K W` and
  `Ctrl+K Ctrl+W` close editors, `Ctrl+K Ctrl+Left/Right` other group, ...), but your own
  `Ctrl+K` key bindings do not. `F1`, `Ctrl+Shift+P` and `Ctrl+P` open the VS Code pickers.
- The Problems panel lists the problems of open split editors per section
  (`FB_X.Method · Implementation`), with the line numbers of that pane. Its
  `Show Active File Only` filter and the error colour of the tab title do not apply to
  split editors, and `F8` inside a split editor moves between the problems of that object only.
- Opening a problem or symbol briefly opens a read-only copy of the section, which is
  replaced by the split editor. A copy opened pinned (double click, `Ctrl+T`) is closed
  instead, and `Reopen Closed Editor` then brings back the split editor of that object.
- `Reopen Editor With` on a tab with unsaved changes shows the file on disk in the other
  editor; the changes stay in the first one (a warning offers to go back to it).
- `Compare with Saved` on a split editor tab shows the raw text the editor works on
  (sections after marker lines). Closing that comparison while the tab has unsaved
  changes makes VS Code ask whether to save them.
- In VS Code 1.141, `File: Revert File` on a notebook (any notebook, Jupyter too) clears the
  unsaved marker without restoring the cells. To drop the unsaved edits of a TwinCAT
  notebook tab, close it and choose "Don't Save". The split editor reverts normally.

## Development

```bash
npm install
npm run compile
npm run test:unit
npm run package
```

`npm run compile` also type-checks `src/webview` and bundles it (Monaco, vscode-textmate,
oniguruma) with esbuild into `out/webview`.

`node scripts/analyze-all.js <repoDir>` and `node scripts/coverage.js <repoDir>` check
the parser and resolver on a whole TwinCAT repository.

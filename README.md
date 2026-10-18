# Explorer for TwinCAT

TwinCAT 3 PLC projects in VS Code, the way TwinCAT XAE shows them. The extension adds the XAE project
tree, opens every POU, method, property and accessor in its own tab with the **Declaration above the
Implementation**, and brings Structured Text language features and git views that work per object.
The code stays in the `.TcPOU`, `.TcDUT`, `.TcGVL` and `.TcIO` XML files, and saving writes back only
the sections you edited.

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Extension settings](#extension-settings)
- [Library stubs](#library-stubs)
- [Known issues and limitations](#known-issues-and-limitations)
- [Troubleshooting](#troubleshooting)
- [Release notes](#release-notes)
- [Development](#development)
- [License](#license)
- [Trademarks](#trademarks)

## Features

### TwinCAT tree

The **TwinCAT** view in the Explorer, below Outline and Timeline:

- One root per `.tsproj`, then its PLC projects, `References`, and the folders and objects of each
  `.plcproj`.
- Inside a POU: the folders TwinCAT keeps in the XML (`Methods > States`), methods, properties with
  `Get`/`Set`, actions and transitions.
- Labels follow XAE (`FB_X (FB)`, `MAIN (PRG)`), and modified files get their git colour.
- Methods, properties and accessors that differ from `HEAD` are marked `M` (changed) or `A` (new),
  like the Explorer marks files.
- Right-click a POU, an interface or a folder inside a POU to add a method, property or action (see
  [Adding methods, properties and actions](#adding-methods-properties-and-actions)).
- Right-click a method, property, action or transition to rename or delete it (F2, Delete; see
  [Renaming and deleting methods, properties and actions](#renaming-and-deleting-methods-properties-and-actions)).
- Right-click a PLC project or one of its folders to add a POU, DUT, GVL, interface or folder (see
  [Adding POUs, DUTs, GVLs, interfaces and folders](#adding-pous-duts-gvls-interfaces-and-folders)).
- **Ctrl+Alt+T** (`TwinCAT: Go to Object...`) lists every object of the workspace.

### Split editor

- **One tab per object**, titled `FB_X`, `FB_X.Method` or `FB_X.Property.Get`.
- **Two panes, like XAE:**
  - The Declaration is in the upper pane and the Implementation in the lower one. Each pane has its
    own scroll bar, and both start at the same height.
  - Drag the bar between them to change the heights; the tab remembers it. Double-click the bar to
    get equal halves again.
- **Which tab shows what:** a property tab shows the property declaration, and its `Get` and `Set`
  open in their own tabs. DUTs, GVLs and interfaces have a single pane.
- **Opening:** a single click in the tree opens a preview tab; a double click, or an edit, keeps it.
- **Look:**
  - Breadcrumbs follow the XAE path.
  - The panes are Monaco editors (the editor VS Code is built on). They use your VS Code font, tab
    and theme settings and the same colours.
- **Changes vs HEAD:**
  - Each pane marks its changed lines in the gutter (green: added, blue: changed, red wedge:
    removed), unsaved edits included. `Alt+F5` and `Shift+Alt+F5` go to the next and previous
    change.
  - `Show Changes vs HEAD` (editor title button, or a click on a change marker) turns both panes into
    inline diffs against `HEAD`. Unchanged lines are folded, the panes stay editable, and the
    `Revert Block` button next to a change puts the `HEAD` text back.
  - `Hide Changes vs HEAD` returns to the normal panes. A commit, checkout or rebase updates the
    comparison.
- **Line blame**, like GitLens' current line blame:
  - The end of the current line shows who changed it last, when, and the commit message
    (`You, 2 days ago • Fix the purge timer`).
  - The hover adds the date, `Open Changes` and `Show History`. `Open Changes` shows the commit's
    changes of this object in the commit diff panel; a click on the annotation does the same.
  - Lines changed since `HEAD`, saved or not, show `Uncommitted changes`.
  - `TwinCAT: Toggle Line Blame` or `twincatExplorer.blame.currentLine` turns it off.

### Safe saving

- **Edited sections only:** only the CDATA of the sections you edited is replaced. BOM, CRLF, GUIDs
  and every other byte of the file stay as they were.
- **Outside changes survive:** sections you did not touch are never written back, so changes made
  meanwhile in XAE or by git are kept.
- **Conflicts are refused:** if a section you edited was also changed on disk, the save is refused
  with a message instead of overwriting it.
- **Several tabs:** two tabs of the same file can be edited and saved independently.
- **Reloads:** open tabs without unsaved edits reload when the file changes on disk. Undoing back to
  the text on disk makes the tab clean again.
- **Renaming is blocked:** changing the name in a declaration header (`METHOD OnEntry` to
  `METHOD OnEnter`) makes the save fail with a message. Rename methods, properties, actions and
  transitions with Rename... in the TwinCAT tree (see
  [Renaming and deleting methods, properties and actions](#renaming-and-deleting-methods-properties-and-actions)),
  other objects in TwinCAT XAE.

### Adding methods, properties and actions

- **Add Method...**, **Add Property...** and **Add Action...** are in the context menu of a POU or
  interface in the TwinCAT tree, and of a folder inside a POU. From the Command Palette they add to the
  object of the active editor. Actions are for function blocks and programs.
- **What they ask:** the name, checked against the other members (case aside); the return type of a
  method (empty for none) or the type of a property; and whether a property gets `Get` and `Set` or one
  of them.
- **What they write**, as TwinCAT XAE 3.1.4026 does:
  - A new GUID and the declaration XAE gives a new member: `METHOD Start : BOOL` (with an empty
    `VAR_INPUT` in an interface), `PROPERTY PUBLIC Speed : LREAL` (`PROPERTY Speed : LREAL` in an
    interface), an empty `VAR` block in `Get` and `Set`.
  - An empty Structured Text implementation. Members of an interface have none.
  - `FB_init` and `FB_exit` get the inputs the compiler requires (`bInitRetains`, `bInCopyCode`).
  - The new element takes the file's indentation and line breaks, and the file keeps its BOM. The rest
    of the file stays byte-identical.
  - It goes where XAE keeps it: XAE orders the members by name whatever their kind (case aside,
    underscores before digits before letters). In a file whose members are not in that order, it goes
    after the last one.
- **Then:** the tree shows the new member and it opens in the split editor, or the notebook if
  `twincatExplorer.editor` says so. A new property opens at its `Get` (or `Set`).
- **Implement Interfaces...** on a function block with `IMPLEMENTS`: picks from the methods and
  properties of its interfaces, and of the interfaces these extend, that neither the function block
  nor one it extends has yet. Each gets the declaration it has in the interface and an empty
  implementation.
- A file with unsaved changes in an editor is refused: save or revert them first. To take back a new
  member, use Discard Changes in the TwinCAT Changes view.

### Renaming and deleting methods, properties and actions

- **Rename...** (F2) and **Delete** (Delete) are in the context menu of a method, property, action or
  transition in the TwinCAT tree. Delete is also on the `Get` and `Set` of a property.
- **Rename** asks for the new name, checked like the name of a new member. Then, as TwinCAT XAE
  3.1.4026 does, it changes:
  - The name of the member in the file and in its declaration (`METHOD M_Start : BOOL`).
  - The name inside the member where it stands for the member itself: a method's return value
    (`M_Start := TRUE;`), a property's value in its `Get` and `Set`.
  - Its `LineIds` and those of its accessors, in files that have them.
  - Its place: XAE keeps the members in name order, so a renamed member moves to its new place.
- **What uses the member elsewhere keeps the old name.** XAE's rename would change it too. The message
  after the rename says how many uses of the old name the language index finds, and **Show Uses**
  lists them so that you can open and change each one. The function blocks that implement an
  interface keep their method or property under the old name: rename it there too.
- **Delete** asks first. Then it removes the member, or the accessor, from the file with its
  `LineIds`, as XAE does. What uses it is not changed.
- The rest of the file stays byte-identical. Open tabs of the member open again under its new name, or
  close when it is deleted.
- A file with unsaved changes in an editor is refused. To take back a rename or a delete, use Discard
  Changes in the TwinCAT Changes view.

### Adding POUs, DUTs, GVLs, interfaces and folders

- **Add POU...**, **Add DUT...**, **Add Global Variable List...**, **Add Interface...** and **New
  Folder...** are in the context menu of a PLC project and of its folders in the TwinCAT tree. From the
  Command Palette they add to the folder of the active editor's object, or to a PLC project picked.
- **What they ask:**
  - Add POU: function block, program or function; the name; the return type of a function; the
    function block a function block extends and the interfaces it implements (both may stay empty).
  - Add DUT: structure (and the structure it extends), enumeration, union or alias (and its type); the
    name.
  - Add Global Variable List: the name. Add Interface: the name and the interfaces it extends.
  - The name must be an identifier that no POU, DUT, GVL or interface of the PLC project has (case
    aside), with no file of that name in the folder. A base the project does not know only gets a
    warning: it may come from a library without a stub.
- **What they write**, as TwinCAT XAE 3.1.4026 does:
  - The file of the object (`.TcPOU`, `.TcDUT`, `.TcGVL`, `.TcIO`) in the folder, with a new GUID and
    the declaration XAE gives a new object: for example `FUNCTION_BLOCK FB_Pump EXTENDS FB_Base
    IMPLEMENTS I_Pump` with empty `VAR_INPUT`, `VAR_OUTPUT` and `VAR` blocks, `TYPE ST_Data:` with an
    empty `STRUCT`, or `VAR_GLOBAL` and `END_VAR`.
  - The file gets the XML header, line breaks and BOM of the other files of the project.
  - A function block that implements interfaces gets their methods and properties, as with Implement
    Interfaces.
  - The `.plcproj` gets the `<Compile>` item of the file, or the `<Folder>` item of a folder, where XAE
    puts it; the rest of the `.plcproj` stays byte-identical. New Folder also makes the folder on disk.
- **Then:** the tree shows the new object or folder, and a new object opens in the split editor.
- A `.plcproj` with unsaved changes in an editor is refused. A TwinCAT XAE 3.1.4026 that has the
  project open asks whether to reload the changed `.plcproj`: answer Yes.

### Structured Text language features

These work in both panes and in notebook cells. They come from a parser of the TwinCAT dialect
(`EXTENDS`, `IMPLEMENTS`, `THIS^`, `SUPER^`, properties, `REFERENCE TO`, ...).

- **Go to Definition** (F12, Ctrl+click), including members reached through variable types and
  inheritance. `fbValve.Open()` opens the `Open` method of `FB_Valve`, or of the function block it
  extends, at the method name; a local variable moves the cursor to the declaration pane.
- **Hover** with the declaration, its comments and where it is declared.
- **Completion** after `.` (members, inherited members, enum values) and of the names in scope.
- **Find All References**: Shift+F12 opens a peek view. Other objects are shown read-only there;
  double-click a result to open it.
- **Problems**, reported while you type in the editor and in the Problems panel: syntax errors,
  unknown identifiers, unknown members and unknown named parameters. A click in the Problems panel
  opens the split editor at the problem.
- **Ctrl+T** finds POUs, methods, properties, DUTs, GVLs and global variables, and opens the split
  editor at the symbol.
- **Outline** of the declared variables (notebook cells).
- **`TwinCAT: Check All Structured Text`** analyses every section of every project and reports the
  problems on the XML files.

### Source Control views

Three views in the Source Control sidebar.

**TwinCAT Changes** lists the objects that differ (POU, methods, properties, accessors), grouped by POU
and marked `M`, `A` or `D`.

- **Two scopes,** switched in the view's title bar:
  - uncommitted changes (vs `HEAD`);
  - branch changes since the merge base with another branch, what a merge request shows.
    `origin/develop` is the default; `Compare Branch With...` picks another one. Uncommitted changes
    are included.
- **Opening:** a click opens the object in the split editor with the diff against that base, at its
  first change. A deleted object opens as read-only text of its old version.
- **`Discard Changes`** (uncommitted scope only):
  - the code of an object goes back to `HEAD`;
  - a new method, property, action or accessor is removed;
  - a whole file goes back to `HEAD`, in the working tree and the index.

  It is refused while an editor has unsaved edits of the file.
- **`Build output (no code changes)`** gathers files whose change is only XAE metadata: a `.tsproj`
  with only new `TmcHash` values, or a source file with only a new `ProductVersion`. They can be
  discarded too.
- **`Project files`** holds the other `.tsproj`/`.plcproj` changes; a click shows their XML diff.

**TwinCAT Commits** works like the commits view of GitLens.

- **The list:**
  - Every commit of `HEAD`, newest first, as `git log` lists them, 30 at a time
    (`Load more commits...`), with author and age.
  - An arrow marks the commits no remote has yet, and merges have their own icon.
  - Copy the SHA or the message from the context menu.
- **A commit expands to the files it changed:** its POUs first, each expanding to the objects the
  commit changed (`M`, `A`, `D`), then the project files and every other file. A merge lists its
  changes against its first parent, which is what it brought into the branch.
- **Opening a changed object:** a click shows what the commit changed in it, in the split editor's
  layout (Declaration above Implementation). The view is read-only, against the commit's first
  parent, at the first change.
  - The next object replaces it in the same tab.
  - `Open Current Version` (editor title) opens the object as it is now.
- **Opening other files:** any other file (project files, and POU files with only a rename or a
  metadata change) opens in VS Code's diff editor, as in GitLens. An added or deleted file is
  compared with an empty one. A POU's whole file opens as a notebook diff from its inline button.

**TwinCAT History** is like GitLens' file history, but per object.

- **Which commits:**
  - The commits of `HEAD` that changed one method, property, accessor, action, DUT or GVL, newest
    first, 50 at a time, back to the commit that created it.
  - The file is followed through renames and moves (`git log --follow`). Commits that changed only
    other objects of the file, or only metadata, are left out.
  - For a POU with methods or properties, the view lists the commits that changed any of its
    objects, each expanding to them.
- **Which object:**
  - The view shows the object of the active split editor or object notebook; `Pin to This Object`
    (view title) keeps it.
  - `Show History` is in the TwinCAT tree's context menu, in the title bar of the split editor and of
    the commit diff panel, and on the objects of the Changes and Commits views.
- **Opening:**
  - A click on a commit shows what it changed in the object, in the commit diff panel.
  - `Compare with Working Version` opens the object's split editor with its changes since that
    commit.
  - `Uncommitted changes` at the top opens the diff against `HEAD`.

### Notebooks

- **Object notebook:** set `twincatExplorer.editor` to `notebook`, or use
  `Reopen Editor With... > TwinCAT Object (Notebook)` on a tab. Each section is one cell.
- **Whole-file notebook:** `Reopen Editor With... > TwinCAT File (Notebook)` shows a whole `.TcPOU` as
  one notebook.
- **Notebook diff for git:** `Open Changes as TwinCAT Notebook` compares a whole file with `HEAD`
  section by section, folding the unchanged sections. In Staged Changes it compares `HEAD` with the
  index.
  - The command is in the tree, Explorer and Source Control menus, and in the `...` menu of a split
    editor tab.
  - Staged renames are followed, and an open comparison refreshes after a commit, checkout or stage.
  - `Compare with Git Ref as TwinCAT Notebook...` compares with any branch or commit, for example
    `origin/develop` when you review a merge request.
- **Toolbars:** the extension hides the cell toolbar of TwinCAT notebooks. VS Code has no switch per
  notebook type for the rest (`Run All`, `Select Kernel`, `+ Code`, `+ Markdown`), so
  `TwinCAT: Hide Notebook Toolbars (XAE-like Layout)` hides the top toolbar and the insert buttons
  for every notebook. It changes `notebook.globalToolbar` and `notebook.insertToolbarLocation` in the
  user settings, and the same command shows them again.

## Requirements

- **VS Code** 1.95 or later.
- **A workspace with TwinCAT 3 projects:** a `.tsproj` and the `.plcproj` PLC projects it references.
  The extension activates when the workspace contains a `.tsproj`.
- **Git, for the git features.** The extension runs the git that VS Code's Git extension uses (its
  `git.path` setting), otherwise the first `git.exe` (`git` elsewhere) found in a full folder path of
  `PATH`. It never runs a program named git that sits in the workspace.
- **Windows** is the main target, since TwinCAT XAE runs only there. The extension does not depend on
  XAE being installed.
- **No other extension.** The git views are the extension's own, so GitLens is not needed; this
  README names it only to compare. VS Code's built-in Git extension is used when it is enabled: its
  git, its git documents, and its events to refresh open comparisons after a commit or checkout.

## Installation

Install **Explorer for TwinCAT** from the Extensions view (Ctrl+Shift+X), or from the command line:

```bash
code --install-extension thanhdang.explorer-for-twincat
```

VS Code profiles have their own extensions, and the `code` CLI installs into the **Default** profile
unless told otherwise. A window that uses another profile (see the gear menu > Profiles) then never
loads the extension. Add `--profile <profile>` to the command, or install from the Extensions view of
that window.

A `.vsix` file (attached to every [GitHub release](https://github.com/ddt313/TwinCAT-Explorer/releases),
or built as in [Development](#development)) installs with `Extensions: Install from VSIX...` in the
target window, or with:

```bash
code --install-extension explorer-for-twincat-<version>.vsix --profile <profile>
```

Reload the window after installing a new version over an old one.

To uninstall, use the Extensions view, or:

```bash
code --uninstall-extension thanhdang.explorer-for-twincat --profile <profile>
```

## Getting started

1. Open a folder that contains a `.tsproj`. The **TwinCAT** view appears in the Explorer, and
   **TwinCAT Changes**, **TwinCAT Commits** and **TwinCAT History** appear in the Source Control
   sidebar.
2. Click a POU, method or property in the tree. It opens in the split editor, with the Declaration
   above the Implementation.
3. Edit and save with Ctrl+S. Only the sections you changed are written back to the XML file.
4. Use **Ctrl+Alt+T** to jump to any object, **F12** and **Shift+F12** to follow the code, and the
   Source Control views to review what changed.

## Commands

All commands are in the Command Palette under the `TwinCAT` categories. The views add more in their
title bars and context menus, for example Rename..., Delete, Discard Changes, Copy Commit SHA and Copy
Name.

| Command | What it does |
|---|---|
| `TwinCAT: Refresh` | Load the TwinCAT projects of the workspace again. |
| `TwinCAT: Go to Object...` | Pick any object of the workspace and open it (Ctrl+Alt+T). |
| `TwinCAT: Reveal in TwinCAT Explorer` / `TwinCAT: Reveal Active Editor` | Select the object or file in the TwinCAT tree. |
| `TwinCAT: Open XML` | Open the object's file as XML text, at the object. |
| `TwinCAT: Add POU...` / `TwinCAT: Add DUT...` / `TwinCAT: Add Global Variable List...` / `TwinCAT: Add Interface...` | Add an object to a PLC project or one of its folders (see [Adding POUs, DUTs, GVLs, interfaces and folders](#adding-pous-duts-gvls-interfaces-and-folders)). |
| `TwinCAT: New Folder...` | Add a folder to a PLC project or one of its folders, on disk and in the `.plcproj`. |
| `TwinCAT: Add Method...` / `TwinCAT: Add Property...` / `TwinCAT: Add Action...` | Add a member to the POU or interface (see [Adding methods, properties and actions](#adding-methods-properties-and-actions)). |
| `TwinCAT: Implement Interfaces...` | Add to a function block the methods and properties of its interfaces that it lacks. |
| `TwinCAT: Show Changes vs HEAD` / `TwinCAT: Hide Changes vs HEAD` | Show the split editor's panes as inline diffs against `HEAD`, or back as normal panes. |
| `TwinCAT: Open Changes as TwinCAT Notebook` | Compare a whole file with `HEAD` (or the index), section by section. |
| `TwinCAT: Compare with Git Ref as TwinCAT Notebook...` | Compare a whole file with any branch, tag or commit. |
| `TwinCAT: Show History` | Show the commits that changed the object, in the TwinCAT History view. |
| `TwinCAT: Open Current Version` | From the commit diff panel, open the object as it is now. |
| `TwinCAT: Toggle Line Blame` | Turn the current line blame of the split editor on or off. |
| `TwinCAT: Check All Structured Text` | Analyse every section of every project and report the problems. |
| `TwinCAT: Hide Notebook Toolbars (XAE-like Layout)` | Hide (or show again) the notebook toolbars in the user settings. |
| `TwinCAT Changes: Show Uncommitted Changes (vs HEAD)` | Changes view scope: uncommitted changes. |
| `TwinCAT Changes: Show Branch Changes (vs Merge Base)` | Changes view scope: what the branch changed since it left another one. |
| `TwinCAT Changes: Compare Branch With...` | Pick the branch the branch changes are compared with. |
| `TwinCAT History: Pin to This Object` / `TwinCAT History: Unpin (Follow the Active Editor)` | Keep the History view on one object, or let it follow the active editor. |
| `TwinCAT Changes: Refresh` / `TwinCAT Commits: Refresh` / `TwinCAT History: Refresh` | Read the view's git data again. |

## Keyboard shortcuts

| Key | Where | Action |
|---|---|---|
| Ctrl+Alt+T | anywhere, with TwinCAT projects open | Go to Object |
| Ctrl+T | anywhere | Find a POU, method, property, DUT, GVL or global variable |
| F2 | TwinCAT tree | Rename the selected method, property, action or transition |
| Delete | TwinCAT tree | Delete the selected method, property, action, transition, `Get` or `Set` |
| F12, Ctrl+click | split editor, notebook cells | Go to Definition |
| Shift+F12 | split editor, notebook cells | Find All References (peek view) |
| Alt+F5 / Shift+Alt+F5 | split editor | Next / previous change vs `HEAD` |
| F1, Ctrl+Shift+P, Ctrl+P | split editor | The VS Code pickers |
| Ctrl+K S, Ctrl+K W, Ctrl+K Ctrl+W, ... | split editor | The common VS Code `Ctrl+K` chords (see the limitations) |

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `twincatExplorer.editor` | `split` | Editor that objects open in from the tree, Go to Object and go to definition: `split` (XAE-like split editor) or `notebook` (one cell per section). Either can be chosen per tab with Reopen Editor With. |
| `twincatExplorer.autoReveal` | `true` | Select the active object or file in the TwinCAT tree. |
| `twincatExplorer.foldersFirst` | `true` | Sort folders before objects in the TwinCAT tree. |
| `twincatExplorer.diagnostics.enabled` | `true` | Report Structured Text problems in open TwinCAT editors and notebooks. |
| `twincatExplorer.diagnostics.ignore` | `[]` | Identifiers that are never reported as unknown, for example symbols of a library without a stub. |
| `twincatExplorer.blame.currentLine` | `true` | Show at the end of the split editor's current line who last changed it, when, and the commit message. |
| `twincatExplorer.stubFiles` | `[]` | Extra library stub files: absolute paths, or paths relative to the first workspace folder (see [Library stubs](#library-stubs)). |
| `twincatExplorer.exclude` | `**/{node_modules,.git,.claude,_Boot,_CompileInfo,_Libraries}/**` | Folders ignored when searching for `.tsproj` files. Folders whose name starts with a dot (git worktrees in `.claude/worktrees`, ...) are always ignored. |

## Library stubs

Beckhoff libraries ship compiled, so their declarations are not in the workspace. The extension
bundles stubs for the parts in common use:
- Tc2_Standard: timers and triggers;
- Tc2_System: logging and memory functions;
- Tc2_Utilities: `FB_FormatString`;
- Tc2_MC2: axis function blocks;
- Tc2_Math, Tc3_Module and TcUnit.

Symbols of other libraries are reported as unknown. Add them to a stub file and list that file in
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

PLC projects of the workspace that other PLC projects reference as libraries are resolved from their
sources.

## Known issues and limitations

**Editing and projects**
- Only Structured Text is editable; other implementation languages are shown as read-only
  placeholders.
- POUs, DUTs, GVLs, interfaces, folders, methods, properties and actions can be added here, and
  methods, properties, actions and transitions renamed and deleted. Transitions, visualizations and the
  other kinds of objects are created in TwinCAT XAE, and POUs, DUTs, GVLs, interfaces and folders are
  renamed, moved and deleted there.
- Rename changes the member and the code inside it, not what uses it elsewhere, which XAE's rename
  also changes. The uses it counts are those the language index finds: not uses in implementation
  languages other than Structured Text, nor uses it cannot resolve.
- A member added here has no `LineIds` element, the line map for breakpoints that some XAE versions
  keep in the file. TwinCAT 3.1.4026 writes none either in the projects it creates (their option
  `WriteLineIDs` is off).
- If TwinCAT XAE has the same project open (checked with XAE 3.1.4026):
  - XAE reloads a source file changed on disk by itself, within about a second, when the object is not
    open in one of its editors and has no unsaved changes there.
  - When the object is open in an XAE editor, XAE asks "File has been changed outside the environment.
    Reload the new file?". Answer Yes: XAE closes its editor and shows the object as VS Code wrote it.
    With No, XAE keeps its old copy, and the next edit of the object in XAE writes that copy back over
    the changes made here (a renamed or deleted member comes back).
  - XAE asks before it reloads a changed `.plcproj` or `.tsproj`, as after Add POU or New Folder here:
    answer Yes.
  - Unsaved changes in XAE can still overwrite what VS Code saved: save or undo them in XAE before
    editing the same object here.
- The tree covers the PLC projects; I/O, motion and task configuration stay in XAE.
- PLC projects saved as independent project files (`<Project File="X.xti"/>` in the `.tsproj`) are
  not read yet.

**Saving**
- Safe saving applies to object tabs, in the split editor and in the object notebook. The
  `TwinCAT File (Notebook)` editor writes the whole file, so close it before the file changes in XAE
  or git.
- `Reopen Editor With` on a tab with unsaved changes shows the file on disk in the other editor. The
  changes stay in the first one, and a warning offers to go back to it.
- `Compare with Saved` on a split editor tab shows the raw text the editor works on (sections after
  marker lines). Closing that comparison while the tab has unsaved changes makes VS Code ask whether
  to save them.
- In VS Code 1.141, `File: Revert File` on a notebook (any notebook, Jupyter too) clears the unsaved
  marker without restoring the cells. To drop the unsaved edits of a TwinCAT notebook tab, close it
  and choose "Don't Save". The split editor reverts normally.

**The split editor is a webview**
- Extensions that work inside VS Code text editors (GitHub Copilot inline suggestions, vim keys,
  GitLens) do not reach it, and VS Code's Outline view stays empty for it.
- Its change markers are its own and compare with `HEAD` only, not with the index.
- Inside the panes, Monaco's own key bindings win.
  - Its `Ctrl+K` chords work: `Ctrl+K Ctrl+C` comments the line, `Ctrl+K Ctrl+0` folds all.
  - So do the common VS Code chords: `Ctrl+K S` saves all, `Ctrl+K W` and `Ctrl+K Ctrl+W` close
    editors, `Ctrl+K Ctrl+Left/Right` moves to another group, and so on.
  - Your own `Ctrl+K` key bindings do not work there.

**Problems and navigation**
- The Problems panel lists the problems of open split editors per section
  (`FB_X.Method · Implementation`), with the line numbers of that pane.
  - Its `Show Active File Only` filter and the error colour of the tab title do not apply to split
    editors.
  - `F8` inside a split editor moves only between the problems of that object.
- Opening a problem or a symbol briefly opens a read-only copy of the section, which the split editor
  then replaces. A copy opened pinned (double click, `Ctrl+T`) is closed instead, and
  `Reopen Closed Editor` then brings back the split editor of that object.

**Git**
- Line blame is git's, by lines of the XML file. The first and last line of a section share their
  line of the file with the CDATA tags, so a commit that added a line right before or after a
  section's text is also named for its first or last line.
- Merge commits are not listed in the TwinCAT History view; their changes come with the merged
  commits.
- Git compares paths case-sensitively. A file renamed only in case (`FB_motor` to `FB_Motor`) keeps
  its old name in git, so until the new name is committed (`git mv`), its comparison with `HEAD`, its
  history and its blame do not find it.

## Troubleshooting

- **The TwinCAT views do not appear.**
  - The workspace must contain a `.tsproj` outside the folders of `twincatExplorer.exclude` and
    outside hidden folders.
  - Check that the extension is installed in the profile of this window (see
    [Installation](#installation)).
- **A project or file is missing from the tree.** The `Explorer for TwinCAT` output channel logs what was
  loaded, and every project file that could not be read. The tree marks such a project with a
  warning, for example a `.plcproj` with merge conflict markers.
- **The git views say the projects are not in a git repository.** Check that git is installed and on
  `PATH`, or that VS Code's Git extension finds it (`git.path`). Also check that the repository is not
  one git refuses as unsafe. Then run the view's Refresh.
- **Language features miss a library.** Add a [library stub](#library-stubs), or list the
  identifiers in `twincatExplorer.diagnostics.ignore`.

## Release notes

See the [changelog](CHANGELOG.md).

## Development

```bash
npm install
npm run compile
npm run test:unit
npm run package
```

- `npm run compile` also type-checks `src/webview` and bundles it (Monaco, vscode-textmate,
  oniguruma) with esbuild into `out/webview`.
- `npm run package` builds `explorer-for-twincat-<version>.vsix`. `npm run install:local -- <profile>`
  installs it into that VS Code profile (`default` for the Default profile).
- `node scripts/analyze-all.js <repoDir>` and `node scripts/coverage.js <repoDir>` check the parser
  and the resolver on a whole TwinCAT repository.
- `node scripts/third-party-notices.js` writes `ThirdPartyNotices.txt` again after an update of the
  bundled packages.
- A release is a tag: update the version in `package.json` and the changelog, commit, then push a
  tag with that version (`git tag v0.12.0` and `git push origin v0.12.0`). The Release workflow
  (`.github/workflows/release.yml`) builds and tests it, attaches the `.vsix` to a GitHub release
  with the changelog's notes, and publishes it to the Marketplace once the repository variable
  `MARKETPLACE_PUBLISH` is `true`.

## License

Explorer for TwinCAT is released under the [MIT License](LICENSE).

The split editor bundles Monaco Editor, vscode-textmate and vscode-oniguruma. Their licenses are in
[ThirdPartyNotices.txt](ThirdPartyNotices.txt).

## Trademarks

Beckhoff® and TwinCAT® are registered trademarks of Beckhoff Automation GmbH. Explorer for TwinCAT is
an independent project. It is not affiliated with, endorsed by or sponsored by Beckhoff Automation.

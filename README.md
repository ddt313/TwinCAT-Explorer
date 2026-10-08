# TwinCAT Explorer

A VS Code extension that shows the TwinCAT PLC projects of the workspace the way
TwinCAT XAE does, and opens every POU, method and property as its own editor with
the **Declaration above the Implementation**, while the code stays in the
`.TcPOU`/`.TcDUT`/`.TcGVL`/`.TcIO` XML files.

## Features

- **TwinCAT tree** in the Explorer (below Outline and Timeline): one root per `.tsproj`,
  then its PLC projects, `References`, and the folders and objects of the `.plcproj`.
  Inside a POU it shows the folders TwinCAT keeps in the XML (`Methods > States`),
  methods, properties with `Get`/`Set`, actions and transitions. Labels follow XAE
  (`FB_X (FB)`, `MAIN (PRG)`), modified files get their git colour.
- **One tab per object**, titled `FB_X` or `FB_X.Method`, as a notebook: one cell per
  section (`Declaration`, `Implementation`, `Get · Declaration`, ...). Single click opens
  a preview tab, double click (or editing) keeps it. Breadcrumbs follow the XAE path.
- **Safe saving**: only the CDATA of the cells you edited is replaced; BOM, CRLF,
  GUIDs and every other byte of the file stay as they were. Cells you did not touch
  are never written back, so changes made meanwhile in XAE or by git survive. If a
  cell you edited was also changed on disk, the save is refused with a message instead
  of overwriting it. Two tabs of the same file can be edited and saved independently.
  Open tabs without unsaved edits reload when the file changes on disk.
- **Renaming is blocked**: changing the name in a declaration header
  (`METHOD OnEntry` to `METHOD OnEnter`) makes the save fail with a message; rename
  in TwinCAT XAE.
- **Structured Text language features** in the cells, from a parser of the TwinCAT
  dialect (`EXTENDS`, `IMPLEMENTS`, `THIS^`, `SUPER^`, properties, `REFERENCE TO`, ...):
  - Go to Definition (F12, Ctrl+click), including members through variable types and
    inheritance (`fbValve.Open()` jumps to the `Open` method `FB_Valve` inherits).
  - Hover with the declaration, its comments and where it is declared.
  - Completion after `.` (members, inherited members, enum values) and of names in scope.
  - Find All References (Shift+F12) across all objects.
  - Problems: syntax errors, unknown identifiers, unknown members, unknown named
    parameters, while you type.
  - Outline of the declared variables.
- **Ctrl+T** finds POUs, methods, properties, DUTs, GVLs and global variables.
  **Ctrl+Alt+T** (`TwinCAT: Go to Object...`) lists all objects of the workspace.
- **Notebook diff for git**: `Open Changes as TwinCAT Notebook` (tree, Explorer,
  Source Control and editor title menus) compares a file with `HEAD` (or, in Staged
  Changes, HEAD with the index) section by section; unchanged sections are folded.
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
| `twincatExplorer.diagnostics.enabled` | `true` | Report problems in open TwinCAT notebooks. |
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
- In VS Code 1.141, `File: Revert File` on a notebook (any notebook, Jupyter too) clears the
  unsaved marker without restoring the cells. To drop the unsaved edits of a TwinCAT tab,
  close it and choose "Don't Save".

## Development

```bash
npm install
npm run compile
npm run test:unit
npm run package
```

`node scripts/analyze-all.js <repoDir>` and `node scripts/coverage.js <repoDir>` check
the parser and resolver on a whole TwinCAT repository.

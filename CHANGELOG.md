# Changelog

All notable changes to Explorer for TwinCAT. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.17.0 - 2026-10-29

### Added
- Saving an object in the split editor or an object notebook goes through TwinCAT XAE when XAE has the
  project open, on Windows: XAE shows the change at once and saves the object itself, instead of asking to
  reload the file or writing its older copy back over it. Unsaved edits of the object in XAE, which XAE
  would save along or which the save would replace, are asked about first. A save is refused, and the file
  left alone, while a dialog in XAE blocks it, or when XAE's copy of the object lacks a member of the file
  or has one the file has not. With XAE closed the file is written as before. Off by default: setting
  `twincatExplorer.saveThroughXae` turns it on.
- The MCP server's error when TwinCAT XAE does not answer names the dialogs open in every running XAE, also
  while it looks for the XAE that has the project open.
- Highlights at the cursor, in the split editor and in notebook cells: on a keyword, the others of its block
  (`IF`, `THEN`, `ELSIF`, `ELSE`, `END_IF`; `CASE`, `FOR`, `WHILE`, `REPEAT` with a loop's `EXIT` and
  `CONTINUE`; `VAR ... END_VAR`, `STRUCT ... END_STRUCT`, ...); on a name, its uses, those that write it apart
  from those that read it, instead of the same word in any meaning. In the split editor in both panes: on a
  variable in the implementation, its declaration too.
- Folding by the blocks of the code instead of by indentation, in the split editor and in notebook cells:
  `IF ... END_IF` and each of its branches, `CASE`, `FOR`, `WHILE`, `REPEAT`, `VAR ... END_VAR`, `STRUCT`,
  `UNION`, `TYPE`, comments over several lines and `{region}` ... `{endregion}`, also where the indentation is
  off. `editor.foldingStrategy` set to `indentation` folds by indentation instead.
- Go to Symbol (`Ctrl+Shift+O`) in the split editor, and a richer outline of notebook cells: the declarations
  in their `VAR` blocks (`VAR_INPUT`, `VAR CONSTANT`, ...), the branches of each `CASE` with the comment on
  their line (`20 — Wait for the axis`, which Go to Symbol searches too), and `{region}`s.
- Parameter name hints before the arguments passed by position, in the split editor and in notebook cells:
  `LIMIT(min: 0, in: fIn, max: 100)`, `fbAxis.MoveTo(fPos: 10.0, fVelo: 5.0)`. None for the only argument of a
  call, for numbered parameters (`MIN(in1, in2)`), or for a variable named like its parameter.
  `editor.inlayHints.enabled` turns them off.

### Changed
- The line blame of the split editor is off by default: `TwinCAT: Toggle Line Blame` or the setting
  `twincatExplorer.blame.currentLine` turns it on.

### Fixed
- A pane showing changes (a commit's changes from the TwinCAT Commits view, or Show Changes in the split editor)
  fills the pane again when it grows: after the panel below the editor is closed or the splitter between the
  panes is dragged, it kept its earlier height and left an empty gap below.
- The split editor highlights the bracket that matches the one at the cursor, colors bracket pairs and
  shows their guides, as VS Code's editors do (it ignored every bracket).
- A click in the panel of staged changes (or of a commit's changes) puts the cursor where it was clicked again.
  The panel built its panes again behind another tab when the index changed, after staging an object, and the
  panes then placed the cursor columns away from the pointer and cut the line numbers.
- The panel of staged changes (or of a commit's changes) shows the first change of each pane: in a long
  implementation it was scrolled past its changes, near the end.

## 0.16.1 - 2026-10-26

### Fixed
- The changelog of 0.16.0 (the extension's Changelog tab) has one section for that version. It also had the same
  changes under *Unreleased*, written a second time.

## 0.16.0 - 2026-10-25

### Added
- The extension runs in the browser, on vscode.dev and github.dev (for example a GitHub repository opened at
  `vscode.dev/github/<owner>/<repo>`): the TwinCAT tree, the split editor and the object notebooks, the Structured
  Text features, and editing and saving, which write the repository's files as VS Code in the browser does. The
  TwinCAT files are read when the workspace opens. The git views (TwinCAT Changes, Commits, History), blame and
  the comparisons with other refs need git, and the MCP server needs Node: they stay on the desktop and are hidden
  in the browser.
- In the browser, *Open Changes as TwinCAT Notebook* and the split editor's *Show Changes vs HEAD* (and its marks
  of the changed lines) compare with HEAD as GitHub has it: the commit of the branch, tag or pull request open in
  vscode.dev, read through GitHub's API. A private repository asks to sign in with GitHub first.
- In the browser the **TwinCAT Changes** view lists what the branch changed since it left another one, object by
  object, as on the desktop: since the base branch of the pull request open (github.dev opened from a pull request),
  else since the default branch, or since the branch, tag or commit *Compare Branch With* is given. Changes not
  committed are in. GitHub gives the merge base and the files of that commit (two requests); the files of the
  workspace are compared by their blob ids. A click shows an object's changes in the split editor, a deleted object
  as text, a project file as a text diff. Staging, and the list of uncommitted changes against the index, stay on
  the desktop.
- In the browser the **TwinCAT Commits** view lists the commits of HEAD from GitHub (100 a page, *Load more*), each
  with the files and objects it changed against its first parent, opened as on the desktop; and *Compare with Git
  Ref as TwinCAT Notebook* compares a file with a branch, tag or commit of GitHub (the branch the TwinCAT Changes
  view compares with first).
- In the browser the **TwinCAT History** view lists the commits that changed an object, from GitHub's list of the
  commits of its file (renames not followed); a commit opens its changes in the commit diff panel. The line blame of
  the split editor comes from GitHub's GraphQL API, which needs a sign-in even for a public repository: until then
  the Accounts menu has a sign-in request, and the editors get the blame once signed in.
- In the browser the repository is downloaded in one go (GitHub Repositories' tarball) before the TwinCAT files are
  read, instead of one request to GitHub's API per file, and the files left are read 32 at a time. Deleting a POU,
  DUT, GVL or empty folder deletes it there (Source Control can still discard that): GitHub Repositories has no
  Recycle Bin, and the deletion failed.

## 0.15.1 - 2026-10-24

### Fixed
- `TwinCAT: Set Up MCP Server for Claude Code` registers the server where Claude Code looks for it. It ran
  `claude mcp add` in the folder as VS Code spells it, with a lower case drive letter (`c:\repo`), and Claude Code
  keeps the server under exactly that folder, so sessions started there (`C:\repo`) did not get its tools. Setting
  up again removes that registration.
- The MCP server's `add_object`, when TwinCAT XAE does not have the project open, gives the `.plcproj` a `<Folder>`
  item for each folder it makes, where XAE puts it, as XAE does. It wrote only the file's `<Compile>` item.
- The MCP server writes through TwinCAT XAE when XAE has a PLC project open through any `.tsproj` that lists it,
  by that `.tsproj`'s name for it. It looked only at the first one, so with a `.plcproj` in two TwinCAT projects
  (a machine's and a simulation's) and XAE open on the second, it wrote the files behind XAE.
- The MCP server no longer saves the TwinCAT project after `add_member`, `delete_member`, `add_object` and their
  undo through TwinCAT XAE, which rewrote the `.tsproj`, its process image included. XAE saves the POU's file
  itself; a file it leaves unsaved, such as the `.plcproj` of a new object, is now told in the answer.
- The MCP server's `add_object` and its undo through TwinCAT XAE save the PLC project's `.plcproj` alone, through
  XAE's running document table, so the tools see the new object at once. XAE left it unsaved after making or
  deleting the object, without its `<Compile>` and `<Folder>` items. Neither the `.tsproj` nor the unsaved edits in
  the PLC project's editors are saved with it, and a `.plcproj` that already has unsaved changes in XAE is refused
  unless the user agrees (`saveUserEdits: true`).

## 0.15.0 - 2026-10-23

### Added
- An MCP server for AI agents such as Claude Code (`out/mcp/server.js`), as a preview whose tools and their
  parameters may still change. It gives the TwinCAT objects of a folder
  by their XAE names, their declaration and implementation with line numbers, the object and line of code
  at a line of `git diff` or `git blame`, definitions, references, type hierarchies and the Structured
  Text check; edits per section, new members and objects, and deletes, written as the split editor saves,
  refused when the code changed since it was read, and taken back with `undo_last_edit` (with the folders
  a new object made). When TwinCAT XAE has the project open, the server reads and writes the code
  in XAE itself, which shows each change and saves it at once; `check` with `compiler: true` runs XAE's
  Check all objects.
- `TwinCAT: Set Up MCP Server for Claude Code` registers that server with Claude Code for a workspace
  folder (`claude mcp add`, local scope: in `~/.claude.json`, not in the repository), and offers to do it
  again after an update of the extension. It also offers the folder's `.claude/settings.local.json`, which
  git ignores, the rules that let Claude Code run the server's reading tools without asking and keep its
  Edit and Write tools off `.TcPOU`, `.TcDUT`, `.TcGVL` and `.TcIO` files.

## 0.14.2 - 2026-10-23

### Fixed
- The line blame of the split editor no longer shows a wide gap inside a long annotation
  (`Add the conveyor and th      e fill sequence`): the space before it is no longer repeated after every
  50 characters.

## 0.14.1 - 2026-10-22

### Added
- `TwinCAT: Go Back` and `TwinCAT: Go Forward` through the objects shown in split editors and object
  notebooks, as arrows in their title bar and on Alt+Left / Alt+Right (macOS: Ctrl+- / Ctrl+Shift+-)
  there and in the TwinCAT tree. VS Code's own Go Back loses an object once its preview tab is replaced
  by the next one.

### Fixed
- Paste (Ctrl+V) and Cut (Ctrl+X) in the split editor and its diffs, which did nothing.

## 0.14.0 - 2026-10-21

### Added
- `Add Library...` on `References` of a PLC project, like XAE's Library Manager > Add library: it lists
  the libraries installed in the TwinCAT library repository, read without XAE, and writes the reference
  XAE 3.1.4026 writes, a placeholder resolved to the newest version (`*`) or to the one picked.
  `twincatExplorer.libraryRepositories` adds other repositories.
- `Go to Implementation` (Ctrl+F12) in the split editor and in notebook cells: on an interface, the
  function blocks that implement it, directly, through an interface that extends it or by extending one
  that implements it; on a function block, those that extend it; on a method or property, also at a
  call through an interface (`itfValve.Open()`), the methods and properties that implement or override
  it. Other objects show read-only in a peek view. The TwinCAT tree has it on function blocks,
  interfaces, methods and properties.
- `TwinCAT: Show Type Hierarchy` in the TwinCAT tree and the split editor (context menu, editor title):
  the supertypes (`EXTENDS`, `IMPLEMENTS`, up to the roots) and the subtypes of a function block or
  interface, together in VS Code's References view; a click opens the split editor there. Without the
  References view a quick pick lists them. Notebook cells get VS Code's own `Show Type Hierarchy`.
- `Stage Changes` and `Unstage Changes` per object in the TwinCAT Changes view, to commit the change
  of one method, property, accessor, action, DUT or GVL alone. The uncommitted changes are in two
  lists, as in Source Control: `Staged Changes` (`HEAD` ↔ index) and `Changes` (index ↔ working tree).
  New, deleted and renamed files, the build output and the project files are staged whole;
  `Stage All Changes` and `Unstage All Changes` are on the lists. The rest of the index's version of
  the file stays byte for byte, its line endings and `.gitattributes` conversions too.

### Changed
- The annotation of the line blame is no longer a link: the pointer stays the text cursor over it and
  a click opens nothing. `Open Changes` in its hover opens the commit.
- `Discard Changes` in the TwinCAT Changes view puts an object or a file back as the index has it, as
  Source Control does: what is staged stays. It also brings back a deleted method, property, action
  or accessor, and the name of a renamed one.
- A click on an object in `Changes` shows its diff against the index; in `Staged Changes`, `HEAD` ↔
  index, read-only, in the commit diff panel.

## 0.13.0 - 2026-10-20

### Added
- `Add Existing Item...` and `Add Existing Folder Content...` on a PLC project and its folders, as in
  XAE: a file already in the folder on disk is added where it is, others are copied, sub-folders
  become folders, and GUIDs the project has already get new ones. Clashing files are skipped.
- Signature help in the split editor and in notebook cells, after `(` and `,` in a call of a function,
  function block instance, program, method, action or built-in: the inputs as declared, the outputs
  with `=>`, and the declaration and comment of the parameter at the cursor, which follows the
  argument's position or the name being typed. In a declaration it shows the inputs of `FB_init`.
- Completion inserts a call with all its parameters, like XAE's `Insert with arguments`:
  `fbTimer(IN := , PT := , Q => , ET => );`, with a tab stop for each value.
- Snippets for `IF`, `IF ELSE`, `IF ELSIF ELSE`, `ELSIF`, `CASE`, `FOR`, `WHILE`, `REPEAT` and the
  `{region "..."}` and `{endregion}` pragmas, in the split editor and in notebook cells.
- `Rename Symbol` (F2) in the split editor and in notebook cells: variables, inputs and outputs (also
  as named parameters and members), DUT fields and enum values, with their uses; POUs, DUTs, GVLs,
  interfaces and members as the TwinCAT tree renames them.
- `Rename...` in the TwinCAT tree also renames what uses the object or member, as XAE's rename does:
  declarations, `EXTENDS` and `IMPLEMENTS`, calls through instances, `THIS^`, `SUPER^`, interfaces and
  GVLs, properties, and the types in DUTs and GVLs. A list of the objects that change comes first, and
  any can keep the old name; only the changed sections are written. A method or property can take
  those that implement or override it along. The message after it names what keeps the old name.
- Quick fixes on an unknown identifier, as XAE's Auto Declare, in the split editor and in notebook
  cells: `Declare bDone in VAR`, `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` or `VAR_TEMP` (`VAR_GLOBAL` in
  a GVL), with the type its use gives, else `BOOL`. `Ctrl+Z` in the declaration takes it back.
- `Auto Declare...` (`Shift+F2`) asks for the scope, name, type, initial value and comment.
- `Add method` and `Add property` quick fixes on a member that a function block, program or interface
  of the workspace lacks (`fbValve.M_Reset()`): the member is added with the type of its use and opens.

### Changed
- The TwinCAT tree and the git views have icons of their own, in the manner of XAE's tree and in a
  light and a dark variant: each kind of POU, DUT and member has its icon, and folders are yellow.
- DUTs show their kind after the name, like XAE 3.1.4026: `E_State (ENUM)`, `ST_Data (STRUCT)`;
  unions and aliases get `(UNION)` and `(ALIAS)`.

### Fixed
- The minimap of the split editor no longer shows a label for every `IF`, `CASE` and `VAR` line. Code
  folds by its indentation, and `{region "..."}` and `{endregion}` pragmas fold as regions.
- An action called with the inputs and outputs of its function block, as XAE allows
  (`fbValve.A_Close(bForce := TRUE)`), no longer reports unknown parameters.

## 0.12.0 - 2026-10-19

### Added
- `Add Method...`, `Add Property...` and `Add Action...` on a POU, an interface or a folder inside a POU
  in the TwinCAT tree, and `Implement Interfaces...` on a function block with `IMPLEMENTS`. Members are
  written as TwinCAT XAE 3.1.4026 writes them, and the rest of the file stays as it was.
- `Add POU...`, `Add DUT...`, `Add Global Variable List...`, `Add Interface...` and `New Folder...` on a
  PLC project and its folders. The new file and its `.plcproj` item follow XAE 3.1.4026; a function
  block can extend another and gets the methods and properties of its interfaces.
- `Rename...` (F2) and `Delete` on methods, properties, actions and transitions, and `Delete` on a
  property's `Get` or `Set`. Uses in other objects keep the old name: the message says how many the
  language index finds, and Show Uses lists them.
- `Rename...` (F2), `Move to Folder...` and `Delete` on POUs, DUTs, GVLs and interfaces, also by
  dragging onto a folder. Delete moves the file to the Recycle Bin. The tasks that call a renamed
  program call it by its new name; other uses keep the old one, as for members.
- `Rename...`, `Move to Folder...` and dragging for the folders of a PLC project, and `Delete` on an
  empty one.
- PLC projects saved as Independent Project Files (`.xti`) are read: they show in the tree, with the
  language features and the git views, like the others.

### Fixed
- At start-up the TwinCAT view shows the content of every TwinCAT project. With VS Code 1.142, only the
  first one had its PLC projects until Refresh.
- The folders inside a POU without methods or properties show in the TwinCAT tree.
- No syntax error on the access specifier before the `VAR` block of a property's `Get` or `Set`
  (`PUBLIC`, as TwinCAT 3.1.4026 writes it).

## 0.11.0 - 2026-10-17

### Changed
- Renamed from TwinCAT Explorer to Explorer for TwinCAT; the extension ID is now
  `thanhdang.explorer-for-twincat`. Settings, commands and views keep their names. Uninstall
  `thanhdang.twincat-explorer` before installing this version.

### Security
- Git runs by its full path, from VS Code's Git extension (`git.path`) or a full folder path of
  `PATH`. A `git.exe` committed to a repository can no longer run in its place on Windows.

### Fixed
- The TwinCAT History view follows another editor at once after it opened one of its own objects.
- Objects on UNC paths open.
- A file another program holds no longer breaks the tree or the language features.
- Hover, go to definition and references always get an answer. References in a tab whose file
  changed outside VS Code point at the right lines.
- The git views recover once git becomes available.
- Duplicate tree entries no longer hide a folder.
- The commit diff panel shows the object clicked last.
- Signature checks (`log.showSignature`) no longer slow the commit lists down or enter the commit
  messages.
- Project files open from the TwinCAT Changes view without the Git extension's repository.

## 0.10.0 - 2026-10-16

### Changed
- The TwinCAT Commits view lists every commit of `HEAD`, as `git log` does: also the commits that
  change no TwinCAT file, and merges, which have their own icon and are compared with their first
  parent.
- A commit lists its POUs first, then the project files, then every other file it changed, with its
  `M`, `A` or `D` mark. Any file but a POU with object changes opens in VS Code's diff editor, as in
  GitLens; an added or deleted file is compared with an empty one.

## 0.9.0 - 2026-10-16

### Added
- TwinCAT History view in the Source Control sidebar: the commits that changed one method, property,
  accessor, action, DUT or GVL, newest first, followed through renames and moves. It shows the
  object of the active editor unless pinned.
- `Show History` in the TwinCAT tree, the split editor, the commit diff panel and on the objects of
  the Changes and Commits views. `Compare with Working Version` opens the split editor against a
  commit.
- Line blame in the split editor: who changed the current line last, when, and the commit message.
  The hover has `Open Changes` and `Show History`. `twincatExplorer.blame.currentLine` and
  `TwinCAT: Toggle Line Blame` turn it off.

### Fixed
- `HEAD`'s version of a file always matches the commit it is labelled with, also right after a
  commit.

## 0.8.0 - 2026-10-16

### Added
- TwinCAT Commits view in the Source Control sidebar: the commits of `HEAD` that changed TwinCAT
  files, newest first, 30 at a time, with author and age. An arrow marks the commits no remote has
  yet.
- A commit expands to its POUs and other TwinCAT files, and a POU to the objects the commit changed.
  A click shows what the commit changed in the object, read-only, in the split editor's layout.
- `Open Current Version` opens the object as it is now, also when its file moved since.

### Fixed
- Renamed files in long folder paths are read from git on Windows.

## 0.7.0 - 2026-10-15

### Added
- TwinCAT Changes view in the Source Control sidebar: the objects that differ from `HEAD`, or since
  the merge base with another branch (`origin/develop` by default), grouped by POU and marked `M`,
  `A` or `D`. Files with only XAE metadata changes go to `Build output (no code changes)`, other
  project file changes to `Project files`.
- A click opens the split editor with the diff against that base, at the first change.
- `Discard Changes` puts the code of an object back, removes a new member or accessor, or restores a
  whole file.

## 0.6.0 - 2026-10-15

### Added
- `M` and `A` marks on the methods, properties and accessors that differ from `HEAD`, in the TwinCAT
  tree and on their tabs.
- Change markers in the gutter of the split editor, unsaved edits included. `Alt+F5` and
  `Shift+Alt+F5` move between changes.
- `Show Changes vs HEAD` turns the panes into inline diffs, with the unchanged lines folded and
  `Revert Block`.

## 0.5.1 - 2026-10-09

### Fixed
- Undoing back to the text on disk no longer stalls saving for 1.5 seconds, after which VS Code
  turned off the extension's save handling.
- Long reference lists keep their previews.
- Go to definition from a notebook cell, Ctrl+T and the Problems panel give the split editor the
  focus.
- `Open to the Side` opens the object beside the current one.
- The indentation left on an empty line is no longer trimmed when the pane takes in a change of the
  document.

## 0.5.0 - 2026-10-09

### Added
- The XAE-like split editor: the Declaration above the Implementation, each with its own scroll bar,
  and a bar between them to drag. `Get` and `Set` open in their own tabs, as in XAE.
- Syntax colours of the active theme, and hover, completion, definition, references and problems in
  both panes.

### Changed
- Objects open in the split editor. Set `twincatExplorer.editor` to `notebook`, or use
  `Reopen Editor With`, for the object notebook.

## 0.4.0 - 2026-10-08

### Fixed
- Reopening a tab after discarding its edits shows the text on disk.
- A tab in the background reloads after the file changed outside VS Code.
- After a save, the language features see the outside changes to the sections you did not edit.

## 0.3.0 - 2026-10-08

### Fixed
- Find All References opens one document per object.
- A closed tab no longer feeds its unsaved text to the other tabs.
- Notebook diffs pair an unstaged rename with the old file through the object's GUID, and compare
  staged deletions.
- Git output is read in English, whatever the system language.
- The extension stays idle in windows without TwinCAT projects.

## 0.2.0 - 2026-10-08

### Changed
- Saving writes only the sections you edited, so changes made meanwhile in XAE or by git survive. If
  a section you edited was also changed on disk, the save is refused with a message.

### Added
- The `TwinCAT Explorer` output channel logs what was loaded and every project file that could not be
  read.
- Notebook diffs follow staged renames and refresh after a commit, checkout or stage.

### Fixed
- The `TwinCAT File (Notebook)` editor saves.
- Unsaved declarations are seen by the other tabs.

## 0.1.0 - 2026-10-08

### Added
- TwinCAT tree in the Explorer: TwinCAT projects, PLC projects, folders and objects, with the folders,
  methods, properties, actions and transitions inside a POU and XAE's labels.
- Object notebooks, one tab per object and one cell per section, and the `TwinCAT File (Notebook)`
  editor for a whole file.
- Saving that replaces only the CDATA of the changed sections, and refuses renames in declaration
  headers.
- Structured Text language features: go to definition, hover, completion, references, problems,
  Ctrl+T, outline and `TwinCAT: Check All Structured Text`.
- Library stubs for common Beckhoff libraries, and `twincatExplorer.stubFiles` for others.
- `Open Changes as TwinCAT Notebook` and `Compare with Git Ref as TwinCAT Notebook...`.
- `TwinCAT: Hide Notebook Toolbars (XAE-like Layout)`.

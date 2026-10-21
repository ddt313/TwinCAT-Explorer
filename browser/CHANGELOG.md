# Changelog: browser extension

All notable changes to the Explorer for TwinCAT browser extension (Chrome, Edge). It is released apart from the
VS Code extension: its versions are `browser-v*` tags, each a zip to load unpacked (see `SPIKE.md`, *Releases*).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- A **Unified | Split** switch at the top of each TwinCAT view: *Split* shows the Declaration and Implementation diffs
  side by side, the base on the left and the head on the right, as GitHub's split view and GitLab's side-by-side view
  do; a deleted line beside the line added in its place, with the changed words marked. The choice goes for all the
  views of the page and is remembered.

## 0.1.2 - 2026-10-21

### Fixed
- On a GitLab merge request's *Changes* tab showing one commit (or one version, or a comparison of versions), the
  TwinCAT tab lists the files of that commit only, not all the merge request's, and their changes are those of the
  commit: a file the merge request changed in another commit is no longer there, shown as deleted, doing nothing
  when clicked.
- The same on a GitHub pull request's *Files changed* of one commit or a range of commits (`/files/<sha>`,
  `/changes/<from>..<to>`): the TwinCAT tab reads that commit's or range's diff, not the pull request's. When the page
  does not name the commits it compares, those of its URL are taken (public repositories), not the pull request's.
- A click on an object in the TwinCAT tab, when its file's view is on already, scrolls straight to the object, no
  longer to the top of the file first.

### Changed
- The TwinCAT tab puts the folders and files in the order of the page's diffs: on GitLab a folder before the files
  beside it, names compared case by case (`ModuleTests` before `Modules`); on GitHub git's order of the whole paths.
  The objects in a file keep XAE's order.

## 0.1.1 - 2026-10-21

### Fixed
- Large files no longer freeze the TwinCAT views and the tree: the view of a 1 MB `.TcPOU` took 2.5 seconds, with
  all the extension's frames stopped meanwhile, and now takes a few tens of milliseconds.
- A big review page no longer freezes when the commits it compares are not found (not in the page, and a private
  repository's REST API wants a token). They are looked for once a page, then again only when a view or the
  TwinCAT tab is turned on, at most every few seconds; on GitHub in the diff URLs and the JSON the page embeds,
  not in its whole markup. Found that way, they replace the messages that said they were not found.

## 0.1.0 - 2026-10-21

### Added
- On a GitHub pull request's *Files changed*, a **TwinCAT view** toggle on each `.TcPOU`, `.TcDUT`, `.TcGVL` and
  `.TcIO` file: its changed objects (POU, DUT, GVL, method, property and its Get/Set, action, transition) with an
  M, A or D badge and the old name of a renamed one, each with its Declaration diff above its Implementation diff,
  the unchanged objects folded, Structured Text highlighted, and on each changed line a link to its XML line in the
  host's own diff. A file without code changes says what changed (`ProductVersion`, a rename). A project file
  (`.tsproj`, `.xti`) keeps the host's diff.
- Above the host's file tree, a **TwinCAT** tab: the change as XAE's Solution Explorer shows a project, the changed
  members under their POU; a click opens the object's view. Project files are there too, labelled when their only
  change is the TmcHash a build rewrites.
- The same on a GitLab merge request's *Changes* tab, in both of GitLab's diff pages (Rapid Diffs and the classic
  one): on gitlab.com, and on a self-managed instance once its toolbar button has turned it on for the site. The tabs,
  toggles and buttons take GitLab's colors, light or dark.
- A fixed extension ID (the manifest's `key`): the sites turned on stay on through updates, wherever the
  extension's folder is.
- The review threads of a GitLab merge request (and of a public GitHub pull request) in the TwinCAT view, read-only:
  each under the section line its XML line is on, with its author, time, text, replies and whether it is resolved,
  and a link to it in the host's diff; the comments on lines in no declaration or implementation, and the outdated
  ones, in lists at the end of the file's view; the number of threads of each object in its header and in the
  TwinCAT tree. A private GitHub repository needs a token for them, which this version does not take: the view says so.
- On unchanged lines too, a link to the XML line in the host's diff, to comment on it there.
- After a jump to the host's diff (an XML line, a thread), **↩ Back to the TwinCAT view** beside the toggle: the view
  again, at the line or the thread it was left at.
- A link to a comment or a line in the diff of a file shown as its TwinCAT view (and the browser's back and forward
  to one) turns that view off, so that the target shows.

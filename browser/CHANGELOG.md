# Changelog: browser extension

All notable changes to the Explorer for TwinCAT browser extension (Chrome, Edge). It is released apart from the
VS Code extension: its versions are `browser-v*` tags, each a zip to load unpacked (see `SPIKE.md`, *Releases*).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
  one): on gitlab.com, and on a self-managed instance once its toolbar button has turned it on for the site.
- A fixed extension ID (the manifest's `key`): the sites turned on stay on through updates, wherever the
  extension's folder is.

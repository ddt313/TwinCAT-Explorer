# Changelog: browser extension

All notable changes to the Explorer for TwinCAT browser extension (Chrome, Edge, Firefox). It is released apart from
the VS Code extension: its versions are `browser-v*` tags, each a zip to load unpacked and, for Firefox, a version on
addons.mozilla.org (see `SPIKE.md`, *Releases*).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.4.2 - 2026-10-27

### Fixed
- **Firefox**: the toolbar button's popup showed only its title (since 0.4.1); it shows the site's state and its
  buttons again.

## 0.4.1 - 2026-10-26

### Changed
- **Firefox**: the extension is listed on addons.mozilla.org, where Firefox installs and updates it; a release
  submits its build there, with the source its reviewers build it from (`browser/amo/`), instead of attaching a signed
  `.xpi`. In Firefox it no longer looks on GitHub for a newer version: no badge, no *Look for new versions on GitHub*
  in the popup, and no `alarms` permission.
- The extension's name is **Explorer for TwinCAT** (it was *Explorer for TwinCAT: review view (spike)*), with a
  shorter description.

### Fixed
- **Firefox, on a self-managed GitLab**: the views said *This view did not get the file to show* and the TwinCAT tab
  *The tree did not get the change to show*. Firefox gives the extension's frames inside a page no `permissions` API,
  which they asked whether the extension works on the site; they ask the extension's background now. gitlab.com,
  github.com and bitbucket.org were not affected.

## 0.4.0 - 2026-10-26

### Added
- **Firefox** (140 or later): the build makes `browser/dist-firefox` beside `browser/dist`, the same extension with
  Firefox's manifest (a background script instead of a service worker, an add-on ID of its own). Everything works
  there as in Chrome and Edge: the views, the TwinCAT tab, review threads, GitHub, GitLab and Bitbucket, a repository's
  files, the sites turned on from the popup, the look for new versions. A release attaches it as an `.xpi` signed
  by Mozilla (unlisted on addons.mozilla.org), which Firefox installs with a click; a new version installs over it.

### Changed
- On github.com, gitlab.com or bitbucket.org, when the browser does not let the extension read the site (Firefox
  lets the user take that permission back, Chrome's site access *On click* too), the popup says so and its *Allow
  this site* asks for it again, instead of saying the extension is on.
- In Firefox, the popup's note on a newer version says to install its `.xpi` instead of unzipping it over a folder.

## 0.3.0 - 2026-10-26

### Added
- The extension tells of its new versions: once a day it looks on GitHub for a newer `browser-v*` release (drafts and
  pre-releases left out), and when there is one a **NEW** badge shows on its icon, until its popup is opened. The popup
  says which version is out, links to its release, and tells how to update: unzip it over the extension's folder, then
  reload the extension. A look that fails (offline, GitHub blocked, its rate limit) shows nothing and is tried again an
  hour later. The popup's *Look for new versions on GitHub* turns it off. The extension asks for the `alarms`
  permission (the browser does not ask to allow it), to look in a browser left open for days.

## 0.2.1 - 2026-10-26

### Changed
- On a repository's pages (GitHub, GitLab, Bitbucket), a file's **TwinCAT view** stays on from file to file: with the
  view on, the next file shown (from the host's tree, a link, the TwinCAT tab, the browser's Back) opens in its view
  too, until its toggle turns it off. The tab remembers it while it is open, across a page loaded too.
- A click in the TwinCAT tab no longer loads the file's page when the host's tree does not show its row: on GitHub
  and GitLab the file's folders are opened in the host's tree (hidden under the tab) down to its row, which shows the
  file in the app; on Bitbucket the app's router is told the file's URL. The page, the TwinCAT tab and its tree stay;
  a page is loaded only when none of these shows the file within some seconds.
- The files read at a commit are kept by the extension (its Cache Storage, 3000 files at most): a view or the TwinCAT
  tab that reads one again (another view of the same file, the same page loaded again) has it at once, without asking
  the host. A file at a commit never changes; the files of a branch's new commit are read anew.

## 0.2.0 - 2026-10-26

### Added
- Bitbucket Cloud: on a pull request's *Files changed* tab (bitbucket.org), the **TwinCAT view** toggles on the
  TwinCAT files, the **TwinCAT** tab beside Bitbucket's file tree, and the review threads under their lines, resolved
  or not, as on GitHub and GitLab. The commits, files and comments come from Bitbucket's REST API with the session
  (a private repository needs no token), else from its public API. The extension asks for bitbucket.org and
  api.bitbucket.org: the browser may ask again to allow it after the update.
- GitLab's pages of a repository's files (`/-/tree/<ref>/…`, `/-/blob/<ref>/…`), on gitlab.com and the self-managed
  instances turned on:
  - a **TwinCAT view** toggle in a `.TcPOU`, `.TcDUT`, `.TcGVL` or `.TcIO` file's header, which shows the file's
    objects as they are at that ref: each with its Declaration above its Implementation, Structured Text highlighted,
    each line with a link to its line of the file (`L12`) and the way back to the view;
  - **Files | TwinCAT** tabs above GitLab's file tree: *TwinCAT* lists the repository's TwinCAT files at that ref as
    XAE's Solution Explorer does, each file with all its methods, properties, actions and transitions; a click on an
    object opens its file's view at that object.
- The same on GitHub's pages of a repository's files (`/<owner>/<repo>/tree/<ref>/…`, `…/blob/<ref>/…`), the tabs above
  GitHub's file tree, and on Bitbucket's (`/<workspace>/<repo>/src/<ref>/…`), where the tabs float at the bottom left
  (Bitbucket's source pages have no file tree). A line's link goes to the host's own line (`#L12`, `#lines-12`).

### Fixed
- An object revealed from the TwinCAT tab is scrolled to also when its file is the last of the page: the page could
  not scroll that far before the view's new height was known.
- The extension builds again: the core's `textHash` (Node's `crypto`), which the extension does not call, is stubbed
  out of its bundles.

## 0.1.4 - 2026-10-22

### Fixed
- A TwinCAT view lists its objects in the order of the TwinCAT tab's tree beside it (the folders inside the POU
  first, then by name, as XAE), not in the order of the file: a method no longer shows below a property that the tree
  lists after it.

## 0.1.3 - 2026-10-21

### Added
- A **Unified | Split** switch at the top of each TwinCAT view: *Split* shows the Declaration and Implementation diffs
  side by side, the base on the left and the head on the right, as GitHub's split view and GitLab's side-by-side view
  do; a deleted line beside the line added in its place, with the changed words marked.
- The views follow the layout of the host's own diffs: GitHub's *Layout* setting (Unified, Split), GitLab's *Compare
  changes* (Inline, Side-by-side), when the page opens and when it is changed there. The switch changes the views of
  the page until then; on a page that does not show its layout, the last choice of the switch is kept.
- In the popup, on github.com, gitlab.com and the sites turned on: *Add the toggles and the TwinCAT tab to its review
  pages on its own* (on by default). Unchecked, the site's pages show nothing of the extension until *Start in this
  tab*, which adds them to the page open without a reload.

### Changed
- The commits a review page compares are looked for once a TwinCAT view or the TwinCAT tab is turned on, no longer
  when the page opens: a page where the extension is not used makes no request to GitHub's API (whose limit without
  a token, 60 requests an hour, the review comments need too).
- The TwinCAT tab lists all the change's files, as the host's own tree does: the files that are not TwinCAT's
  (`.md`, `.java`, …) by their names, with their A, M, D or R badge and their comment threads, in the same folders
  and order. A click on one shows the host's diff of the file.

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

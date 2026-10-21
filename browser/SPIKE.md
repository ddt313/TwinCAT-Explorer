# Spike: TwinCAT objects in GitHub's and GitLab's diffs

A read-only browser extension (Chromium, Manifest V3) that shows a changed `.TcPOU`, `.TcDUT`, `.TcGVL` or
`.TcIO` file of a GitHub pull request or a GitLab merge request as TwinCAT objects instead of XML, in the layout of
the VS Code extension's commit diff (`src/vscode/commitDiff.ts`): each changed object with its Declaration diff
above its Implementation diff. This document answers the spike's questions (asked for GitHub), then tells how GitLab
was added ([GitLab](#gitlab)) and how the review threads show in the view ([Review comments](#review-comments)).
Tested on 2026-10-20 and 2026-10-21 with Edge 155 and Chrome 155.

**Live test on a signed-in browser (React "Files changed" page, private repository): pending.** The answers
below marked *pending* are filled in from it.

## Build, load, use

```bash
npm run build:browser
```

This type-checks `browser/` and bundles it into `browser/dist`. In Chrome or Edge, open `chrome://extensions`
(or `edge://extensions`), turn on developer mode, *Load unpacked*, and pick `browser/dist`. On a pull request's
*Files changed* tab each TwinCAT source file (`.TcPOU`, `.TcDUT`, `.TcGVL`, `.TcIO`) gets a **TwinCAT view**
toggle in its header (Alt+click toggles all of them). When it is on, the file's diff is replaced by the object view;
off brings GitHub's diff back. A project file (`.tsproj`, `.xti`) has no toggle: it keeps GitHub's diff, and the tree
says when its only change is the TmcHash a build rewrites.

The view of a file:

- a summary line: how many objects were modified, added, deleted, unchanged; new, deleted or renamed file;
  the two commits compared;
- each changed object (POU, DUT, GVL, method, property, property Get/Set, action, transition), in the order of
  the file, deleted ones last, with an **M**, **A** or **D** badge and, when renamed, its old name;
- below it, its Declaration diff, then its Implementation diff: unified, or split (the base beside the head) with
  the **Unified | Split** switch of the summary line (remembered, for all the views), with 3 lines of context and
  the longer runs of unchanged lines folded (click to unfold), word-level highlights, Structured Text highlighting;
- runs of unchanged objects folded into one row (click to list them, click one to see its code);
- a file without code changes says what changed instead: `ProductVersion 3.1.4024.12 → 3.1.4026.13`,
  `XML only, no code`, `Renamed, content unchanged`;
- on every changed line, the XML line it is on (`L123` on the base side, `R124` on the head side), a link
  to that line in GitHub's own diff; on unchanged lines too, dimmed, to comment on them there; after the jump,
  **↩ Back to the TwinCAT view** beside the toggle brings the view back at that line;
- the review threads on the file under the lines they are on, the comments on the XML and the outdated ones at
  the end, the number of threads of each object in its header (see [Review comments](#review-comments));
- a *Diagnostics* block: the commits and where they came from, how each file was read, the comments read,
  whether WebAssembly runs in the frame, and a button that tries every way of reading the file.

Above GitHub's file tree, **Files | TwinCAT** tabs (the choice is remembered): *TwinCAT* shows the pull
request's changes as XAE's Solution Explorer shows a project (see [The tree of the changes](#the-tree-of-the-changes)).
A click on an object opens its file's TwinCAT view at that object.

The same on a GitLab merge request's *Changes* tab: on gitlab.com right away; on a self-managed instance once the
extension's popup (its toolbar button, on a page of the instance) has turned it on for that site.

Read-only: the review threads show in the view; they are written, answered and resolved in the host's own diff.

## Releases

The browser extension is released on its own, from the same repository as the VS Code extension:

| | VS Code extension | Browser extension |
| --- | --- | --- |
| Version | `package.json` | `browser/static/manifest.json` |
| Changes | `CHANGELOG.md` | `browser/CHANGELOG.md` |
| Tags | `v0.13.0` | `browser-v0.1.0` |
| Workflow | `.github/workflows/release.yml` | `.github/workflows/release-browser.yml` |
| Release | a `.vsix` on GitHub, and the Marketplace | a zip on GitHub, never marked as the latest release |

- **To release**: set the manifest's `version` (and `version_name` for a pre-release such as `0.2.0-beta.1`), turn
  the changelog's *Unreleased* into `## 0.1.0 - <date>`, merge, then tag that commit `browser-v0.1.0` and push the
  tag. The workflow tests, builds, checks the tag against the manifest, and attaches
  `explorer-for-twincat-browser-0.1.0.zip` with the changelog's section and how to install as its notes.
- **To install**: the zip holds one folder, loaded unpacked (*Developer mode*, *Load unpacked*); an update replaces
  that folder, then the extension is reloaded. The manifest's `key` gives the extension one ID wherever its folder
  is (`lhebeklloefnhcpmnolimpcnljneeijp`), so the sites turned on stay on. There is no private key: nothing is signed
  outside a store, and a store listing would get the store's ID (the sites would be turned on again). A build of
  `browser/dist` has the same ID: a browser holds either it or a release.
- **Checks** (`.github/workflows/ci.yml`), on a pull request and on develop and master: the VS Code extension
  (tests, a `.vsix` without `browser/`) when a file outside the browser extension's changed; the browser extension
  (tests, build) when `browser/`, the core it is built on (`src/core`, `src/lang`), its tests or the build's setup
  changed. Both packages are artifacts of the run, for trying a pull request out.

## How it is built

| File | Role |
| --- | --- |
| `src/content.ts` | Content script, for any host: finds the TwinCAT files' blocks, adds the toggle, puts the viewer frame in place of the diff, passes the change's coordinates and review threads, scrolls to a line or a thread, offers the way back, turns a view off for an anchor in its hidden diff; adds the tabs and the tree's frame above the host's file tree, takes the tree's clicks to the files. |
| `src/host.ts`, `hostGithub.ts`, `hostGitlab.ts` | The host adapters, the only code that knows a host's DOM: the blocks and their paths, the header, where the viewer goes, the commits, the file list, the review threads, the line and thread anchors, the file tree's panel, the theme. |
| `src/viewer.ts` + `static/viewer.html`, `viewer.css` | The viewer, an extension page in an iframe (`web_accessible_resources`): reads the two versions, builds the model, renders it with the threads, opens an object, a line or a thread asked for. |
| `src/tree.ts` + `static/tree.html`, `tree.css` | The tree panel, another extension page in an iframe: lists the pull request's TwinCAT files, reads them all, renders the tree with the number of threads. |
| `src/model.ts` | Platform-free model of one file: object views, section line diffs, XML line of each section line, XML lines of each object and section. |
| `src/comments.ts` | Platform-free review threads: one shape for both hosts, and where each goes in a file's view (a section line, a graphical section, the comments on the XML, the outdated ones). |
| `src/navigation.ts` | Platform-free rule for a navigation to an anchor: which view goes off, and where its way back goes. |
| `src/treeModel.ts` | Platform-free tree of the changes: folders, files as their objects, changed members, groups for build output and project files. |
| `src/github.ts`, `src/gitlab.ts` | Platform-free host knowledge: URLs, the commits in GitHub's markup, the files of a git diff, the threads of GitHub's review comments; GitLab's merge request URLs, REST API, `data-file-data`, line anchors, the threads of its discussions. |
| `src/params.ts` | The frames' parameters, for any host: the page's origin, a raw-file URL template, the ways to read in order, the commits, the file. |
| `src/lookup.ts` | Platform-free: the commits of a page looked for once and kept for all who ask, nothing found included; looked for again on a user's action only, some seconds apart at most. |
| `src/reader.ts` | Reading a file in a frame, the three ways of question 1, in the order the host's adapter gives. |
| `src/sites.ts`, `src/popup.ts` + `static/popup.html` | The sites the extension works on: github.com, gitlab.com, and the self-managed GitLab instances turned on from the popup. |
| `src/lineDiff.ts` | Myers line diff (as git's default) with deletions before additions in each block, and the changed middle of a line. |
| `src/highlight.ts` | Structured Text highlighting from `src/lang/lexer.ts`. |
| `src/background.ts` | Service worker: one of the ways to read a file (see question 1); registers the content script on the sites turned on. |
| `build.js`, `tsconfig.json` | esbuild bundles (content 29 KB, viewer 37 KB, tree 28 KB, popup 3 KB, worker 2 KB, minified) and the tree's icons (`media/icons`); `tsc` checks with the DOM library and without Node's types. |

The core is used as it is, without a fork: `parseTcText` (`src/core/tcfile.ts`) parses both versions,
`viewChanges` (`objectChanges.ts`) says which object views changed (and their old names), `viewSections` and
`viewLabel` (`objectText.ts`) give the sections of a view, `sectionFileLines` the XML line of each section line,
`metadataChange` and `onlyTmcHashChanged` the label of a file without code changes. One change, for the tree: XAE's
labels, sort order and icon names moved from `src/vscode/tree.ts` (which imports `vscode`) to
`src/core/treeLabels.ts`, which both extensions use; the VS Code extension behaves as before.
`tcfile.ts` mentions Node's `Buffer` in `decodeBytes`/`encodeText`; the extension decodes with `TextDecoder`
instead, esbuild drops both functions, and `build.js` fails if a bundle mentions `Buffer`.

The model adds two things on top of `viewChanges`: unchanged objects are listed too (to fold them), and an
object whose graphical implementation (CFC, SFC, FBD/LD) changed is *modified* even though its Structured Text
did not (`viewChanges` compares ST only; its XML is compared here). Graphical code itself is not drawn.

Unit tests: `test/unit/browserView.test.ts` (30 tests, part of `npm test`) on made-up files: a modified method,
an added and a deleted method, a changed property Get, a deleted accessor and property, a renamed method, a
metadata-only change, project files, a new, deleted and renamed file, CRLF files, a changed CFC action, a broken
file, the line diff (checked against an LCS on random inputs), the GitHub helpers, the frames' parameters, the tree
of a change, the files of a git diff, and the GitLab helpers (URLs, REST API answers, `data-file-data`, line
anchors, color mode). On made-up comments: a note's XML line to its section line on both sides (`old_line` in the
base file, `new_line` in the head file, an unchanged line by either), notes on LineIds, the XML declaration, the
whole file and graphical code, an outdated note and one GitLab carried to the merge ref, GitLab's two formats
(`discussions.json`, the REST API) and GitHub's review comments, the rule for a navigation to an anchor, and the
threads in the tree. And how often a page's commits are looked for: one attempt for all who ask, its result kept,
another only on demand and some seconds after.

## The tree of the changes

Built after the spike's questions: the pull request's TwinCAT changes as XAE's Solution Explorer shows a
project, in a panel that takes the place of GitHub's file tree when its *TwinCAT* tab is on.

- **Content.** The folders of the changed files (a chain of single folders on one row, as GitHub does); each
  file as its object, labelled and drawn as XAE does (`FB_Valve (FB)`, `E_Mode (ENUM)`, the VS Code extension's
  icons); under it the methods, properties, Get/Set, actions and transitions that changed, in the folders
  TwinCAT keeps inside a POU, with an A/M/D/R letter and *renamed from …* / *moved from …*. A property whose
  accessor changed is in the tree, dimmed, to hold it. Folders first, then by name, like `src/vscode/tree.ts`.
  Files without code changes go to *Build output (no code changes)* with their label (ProductVersion, TmcHash),
  as in the VS Code extension's TwinCAT Changes view; other project files to *Project files*.
- **The list of files** comes from the pull request's diff, `github.com/{owner}/{repo}/pull/{n}.diff`, read with
  the session like the raw files: it answers `302` to `patch-diff.githubusercontent.com`, which sends no CORS
  header, so only the frame or the service worker can read it (with a host permission), not the page. Its headers
  give every file with its old path and whether it was added or deleted (`filesInDiff`), without the DOM, and
  also the files whose diff GitHub has not loaded yet. When the diff cannot be read, the tree takes the page's
  list: the rows of GitHub's file tree (`[role="treeitem"] a[href^="#diff-…"]`, the path being a text of the row
  whose sha256 is the anchor, like the blocks' headers) and the blocks themselves (old paths of renamed files).
  On pcdshub/lcls-twincat-motion#249 both give the same 31 files and 125 changed objects.
- **Reading.** Every file at the merge base and at the head (one side only for an added or deleted file), four
  at a time, the tree filling in as they come: #249 (18 files added, 3 deleted, 1 renamed, 9 modified) means 41
  reads, a few seconds in the background. The views then read the same URLs, mostly from the browser's cache.
- **A click** on an object: the content script clicks GitHub's own tree link for the file (or sets the
  location's hash), which makes GitHub scroll to it and load its diff if needed; then turns the file's TwinCAT
  view on and asks the viewer for the object. The viewer opens it (out of its folded group of unchanged objects if
  it is in one), marks it, and says where it is; the page scrolls it to just below GitHub's sticky bars. On #249,
  `StateMachine` of `FB_MotionStageE727` lands 150 px from the top of the window.
- **Hooks it adds**: the panel of GitHub's file tree (classic: `<file-tree>` and its filter field; React:
  `[role="tree"][aria-label*="file"]` and its filter field, *pending*), medium brittleness; without it the tabs
  and the tree float at the bottom left of the window. The tree rows, only when the diff cannot be read. GitHub's
  link to a file, which is its public anchor format.

## GitLab

Added after GitHub, with the same viewer, tree and model. What knows GitHub moved behind a host adapter
(`src/host.ts`), one per host (`hostGithub.ts`, `hostGitlab.ts`); the frames get the page's origin, a raw-file URL
template and the order of the ways to read, and know no host.

- **Pages.** A merge request's *Changes* tab (`/<project>/-/merge_requests/<iid>/diffs`), known by its URL and
  `<body data-page="projects:merge_requests:…">`, on gitlab.com and on the self-managed instances turned on. GitLab
  has two diff pages, both handled:
  - *Rapid Diffs*, gitlab.com's default in October 2026: one `<diff-file id="<sha1 of the path>">` per file, all
    in the page (streamed in), whose `data-file-data` JSON has `old_path`, `new_path` and the `diff_refs` compared;
  - the classic Vue app (`?rapid_diffs_disabled=true` on gitlab.com, and likely what an older instance serves):
    `div.diff-file.file-holder` with the sha1 as id and `data-path`, rendered as the page scrolls (about 6 of 31
    blocks at a time). This page scrolls in a panel, not in the window.
- **Commits.** Rapid Diffs: a block's `data-file-data`. Classic: the page's own `diffs_batch.json`, with the version,
  commit and comparison parameters of its URL (`diff_head=true` by default), whose files carry `diff_refs`; the URL
  is built, since the app's mount point loses the endpoint's attribute when it starts. Else the REST API's
  `diff_refs`. GitLab's REST API takes the session cookie on its own origin: a private project needs no token. On
  MR !4 of the project below all three give `0717d44 → d0d506d`.
- **Files.** The REST API: `…/merge_requests/:iid/diffs`, page by page (GitLab 15.7+; `…/changes` before). Paths,
  old paths, added and deleted files: the tree's list, and what a block lacks (a classic block has its new path only).
- **Reading.** `/<project>/-/raw/<sha>/<path>` answers `200` directly, with no CORS header: from the page first (same
  origin, the session goes with it), then the frame, then the service worker. On gitlab.com the session cookie is
  `SameSite=None`, so the frame's requests carry it too, as long as the browser lets third-party cookies through.
- **Line links.** Rapid Diffs: computed, `#line_<first 9 characters of the file's hash>_<old line>` for a removed
  line and `…_A<new line>` for an added one. Classic: the row whose `data-interop-old-line` or `data-interop-new-line`
  is that line; its id (`<hash>_<old>_<new>`) becomes the location's hash.
- **Tree.** Above GitLab's file browser (`[data-testid="file-browser-tree"]`), covering it rather than hiding it:
  GitLab's list renders only the rows it shows (none when hidden), and a click in the TwinCAT tree clicks GitLab's row
  of the file, which makes the classic page render its block.
- **Colors.** What the content script adds to the page (the *Files | TwinCAT* tabs, the toggles, the back button,
  its notes) takes GitHub's Primer variables, else GitLab's design tokens (`--gl-background-color-subtle`,
  `--gl-text-color-subtle`, `--gl-button-default-primary-*`, …, set on `<html>` and switched by its `gl-dark`), else
  GitHub's light colors. Before, GitLab got those light colors in its dark mode too.
- **Self-managed instances.** The popup's *Turn on for this site* asks the browser for that origin
  (`optional_host_permissions`). The browser's permissions are the list of sites: the service worker keeps the
  content script registered on the granted ones (`chrome.scripting.registerContentScripts`, on
  `permissions.onAdded` and `onRemoved`, after an update or a restart), and starts it at once in the tab the site
  was turned on in, since the browser may close the popup while it asks. The frames work only in a page of
  github.com, gitlab.com or a site turned on, and only in the page that made them (`location.ancestorOrigins`). An
  instance served under a path (`https://example.com/gitlab`) works: the page names its project
  (`data-project-full-path`), and what comes before it in the URL is the instance's path.
- **Hooks**, and how brittle: `body[data-page]`, `data-project-full-path`, `data-project-id` (low: GitLab's own page
  bundles rely on them); Rapid Diffs' `<diff-file>`, `data-file-data`, `rd-diff-file-*` classes and `line_…` anchors
  (medium: a new page that may still change); the classic `.diff-file.file-holder[data-path]`, `.js-file-title`,
  `.diff-content`, `data-interop-*-line` and `diffs_batch.json` (medium); `[data-testid="file-browser-tree"]` and
  `[data-file-row]` (medium, test ids change seldom). What scrolls is found by its style, not by a class.
- **Checked**, headless Edge signed out, on gitlab.com's public `mobile-crane/mobile-crane-twincat3` merge requests !4
  (24 TwinCAT files: added, deleted, renamed and moved, modified POUs, DUTs, interfaces) and !8, in both pages, in
  light and dark mode: toggles, views, files read from the page, line links (Rapid `#line_da56bf7eb_A4`, classic
  `#2f0d2bc…_10_10`), the tree in GitLab's sidebar (24 files, 44 objects), a click on `CheckEndStop` that shows it
  just below GitLab's sticky file header. The popup, and the frames refusing to work outside a known page, too.
- **GitLab 19.4** (September 2026), from its source (`v19.4.2-ee`): Rapid Diffs is the default *Changes* page there
  too (`rapid_diffs_on_mr_show` and `rapid_diffs_default_on_mr_show` are on by default; `?rapid_diffs_disabled=true`
  or a `rapid_diffs_enabled=false` cookie bring the classic page back). Its Rapid Diffs templates are gitlab.com's
  of October 2026 but for one CSS class; `data-file-data` has `old_path`, `new_path` and `diff_refs`; a line's id
  is `line_<hash>_<old line>` or `line_<hash>_A<new line>`. The classic page has the same hooks as on gitlab.com.
  A merge request is compared with its merge ref (on the target branch's head) only when it can be merged; one with
  conflicts shows its latest version, from its merge base: the page's `diff_refs` say which, either way.
- **Checked live** by the user on a self-managed GitLab 19.4, signed in, in Edge: off until the popup's *Turn on for
  this site*, then the toggles, the views and the tree on its merge requests, without a reload.
- **Not tried**: a merge request compared with its merge ref after its target branch moved on; the frame's reads on
  a self-managed instance (its session cookie's `SameSite` matters there; the page reads first).

## Review comments

Added after GitLab, read-only, GitLab first: the review threads of the merge request (or pull request) show in the
TwinCAT view under the lines they are on. Writing, answering and resolving them stays in the host's diff, which the
view's links go to and come back from.

- **Reading them** (`threads()` of the adapters). GitLab: the discussions the page itself reads,
  `/<project>/-/merge_requests/<iid>/discussions.json?notes_filter=0&persist_filter=false`, page by page
  (`per_page`, `cursor`, `x-next-page-cursor`), with the session; else the REST API's
  `…/merge_requests/:iid/discussions` (`x-next-page`). The page's endpoint comes first for three reasons: it is what
  the page shows; its discussions have the positions GitLab carried to the merge ref (`positions`), which the page
  compares when the merge request can be merged and which the REST API does not give; and it answers signed out on
  a public project, where gitlab.com's REST API answers 401 for notes (its `…/diffs` and the merge request itself
  answer 200). `notes_filter=0` asks for every note whatever filter the user chose on the Overview tab, and
  `persist_filter=false` leaves that filter as it is. GitHub: the REST API without a token,
  `GET /repos/{owner}/{repo}/pulls/{n}/comments` (`per_page=100`, `Link`), so public repositories only: a private
  one answers 404, and the view and the tree say that its comments need a token, which this version does not take.
  The content script reads them once a frame wants them, and again when a view is turned on, at most every 5 s on
  GitLab and every minute on GitHub (60 requests an hour without a token): a comment just written in the host's diff
  shows when coming back. Each viewer gets the threads of its file (by its path at the head or at the base), the
  tree all of them.
- **Where a thread goes** (`comments.ts`). A position is on the diff of two commits: the one on the commits the page
  compares counts (GitLab's own rule in its diff page, base and head; GitHub: a comment with a `line` on the head,
  `commit_id`). Its `old_line` is a line of the base file, its `new_line` one of the head file (an unchanged line has
  both: the head's first). The view knows the XML line of every section line on each side (`sectionFileLines`, as
  for its line links), and the thread goes under that line. A line of graphical code goes under its section. A line
  in no section (LineIds, the XML around the code, the XML declaration) and a comment on the whole file go to
  *Comments on the XML* at the end of the file's view, with the object whose XML the line is in. A thread with no
  position on the page's commits goes to *Outdated comments*, with the line and commit of its latest position and a
  link to the thread on the site, in a new tab. A line with a thread is never folded, nor is its section; an
  unchanged object with a thread is shown open, out of its group.
- **What a thread shows**: author, time, the text as written (Markdown shown as text, escaped: no HTML from the
  host goes into the extension's page), resolved or unresolved (GitLab; GitHub's REST API does not say), its replies
  (folded, with their number), and *Show in the diff*. A resolved thread is folded to its first line. An object's
  header has its number of threads (orange while one is unresolved); the tree has it on each object and file, and
  the change's total in its title; the view's summary line has the file's.
- **Show in the diff** turns the view off and shows the thread in the host's diff: GitLab's note `#note_<id>` (both
  pages), else its discussion's `[data-discussion-id]` (a collapsed one); GitHub's `#discussion_r<id>`, else
  `#r<id>` (the classic page's); else the line it is on, with a note beside the toggle when that is not in the page
  either (GitHub renders a resolved thread folded, without its comments).
- **Lines.** An unchanged line has its XML link too, dimmed, to comment on it in the host's diff. Rapid Diffs knows
  an unchanged line by its line at the base (`line_<hash>_<old line>`; `_A<new line>` is for added lines only),
  GitHub and GitLab's classic page by either, so the link carries both and the adapter tries the head's first.
- **Coming back.** A jump to the host's diff (an XML line, a thread) leaves **↩ Back to the TwinCAT view** beside the
  toggle: the view again, at that line or thread (its object opened, its fold unfolded), scrolled to just below the
  host's sticky bars. A frame shown again is laid out late (1.4 s on GitHub, seen): the viewer measures the target
  once it has a box, else the page would scroll to the frame's top.
- **The buttons' clicks** are taken on the document, in the capture phase, not on the buttons: GitLab's classic page
  renders a block again from a copy of its markup as it scrolls, and the copied toggle had no listener (its view could
  not be turned on any more); this also keeps the host's own click handlers away from them.
- **A navigation to an anchor** in the diff a view hides turns that view off (`navigation.ts`, `checkHash` in the
  content script), with the same way back. The target is the element the hash names when it is in the page: in the
  diff of a file whose view is on, not its header or block (a link to the file keeps the view). Else, a comment of
  the known threads (`note_<id>`, `discussion_r<id>`, `r<id>`, replies included) on a file whose view is on: it is
  shown once the view is off. Else, a line anchor of such a file (GitHub's `diff-<sha256>R12`, Rapid Diffs'
  `line_<hash>_A12`, the classic page's `<sha1>_11_12`). The hash is looked at on `hashchange`, on `popstate`, and
  with the page's next DOM change (a hash set by `history.pushState`). GitLab's *next* and *previous unresolved
  thread* (in 19.4 as on gitlab.com, `notes/mixins/discussion_navigation.js`) set no hash: they scroll to the next
  thread that is visible (`checkVisibility()`), so they skip the threads of a file shown as its TwinCAT view, as
  they skip a collapsed file's, and go to the Overview tab when no visible one is left. The view lists those threads
  itself; following GitLab's navigation into a hidden diff would mean showing every hidden diff while GitLab looks,
  not cheap.
- **Hooks**, and how brittle: `discussions.json` and its fields (`diff_discussion`, `position`, `original_position`,
  `positions`, `notes[].note`) (medium: internal, but what the merge request page has read for years; the REST API
  is the fallback); `note_<id>` and `data-discussion-id` (low); GitHub's `r<id>` (medium); line ids as above.
- **Checked**, headless Edge signed out:
  - gitlab.com, `mobile-crane/mobile-crane-twincat3` !4 (no threads): the discussions read from `discussions.json`
    signed out (none on its files). Rapid Diffs: the dimmed link of an unchanged line of `MAIN.TcPOU` (`R85`, to
    `#line_0a39cded9_A85`), back to the view at that line, 195 px from the window's top, just below GitLab's sticky
    file header; a hash set to a line of the hidden diff (`#line_0a39cded9_3`) turns the view off and shows the line,
    with the way back. The classic page: the same link to `#0a39cded…_102_85`, and back.
  - GitHub, pcdshub/lcls-twincat-motion#249 (classic page, 75 review comments): 46 threads on its files read without
    a token; `FB_MCS2Calibrate.TcPOU` with 4 under their lines and 1 outdated (*R36 at a967135*, its link to the
    conversation), 4 in its object's header; `FB_MotionStageMCS2.TcPOU` with 6 under their lines in 4 objects and 5
    outdated; *Show in the diff* (to the line: GitHub had folded that thread; in the big file, whose diff GitHub had
    not loaded, a note), back to the thread 150 px from the top; the tree with 44 threads on its TwinCAT files, on
    21 rows.
  - By the user, live on a self-managed GitLab 19.4, signed in, in dark mode: the threads of a merge request under
    their lines, resolved and with replies, the outdated ones listed, the counts in the TwinCAT tree. The tabs above
    the tree were still in light colors there; they now take GitLab's (see *Colors* under [GitLab](#gitlab)).
  - *Not tried*: a merge request with threads on gitlab.com in the headless browser.

## 1. Can both versions be fetched with the session, private repositories and renames included?

The view needs the file at the **merge base** (the page shows a three-dot diff) and at the **head**:

- **The commits.** The page's markup has them. On the classic page, in the URLs it loads its diffs from:
  `/{owner}/{repo}/diffs/{base}..{head}` and `show_partial_comparison?base_commit_oid=…&end_commit_oid=…`.
  On TcUnit#274 the page compares `d447f95`, the merge base, while `master` is at `425c629` by now. For the React
  page, `commitsInPage` looks for JSON keys naming a merge base or comparison start and a head (*pending*: which
  keys it really has). It never takes `baseRefOid` for the base: that is the base branch's tip (`425c629` here),
  which would show the base branch's own changes as reverted. Without commits in the page, the content script
  asks the REST API without a token (`/pulls/{n}`, then `/compare/{base}...{head}` for the merge base): this works
  for public repositories only. It reads the elements that can name them (those URLs' `data-url`, the JSON
  scripts), not the whole markup, and looks once a page, keeping what it found, nothing included; it looks again
  only when a view or the TwinCAT tab is turned on, 5 s after the last attempt at the soonest, and the views and
  the tree that said the commits were not found show once they are. Reading the whole markup of a 330-file page
  (11.6 MB) took 0.7 s; with nothing found, it was read again for each view turned on and, with the TwinCAT tab
  on, at each change of the page.
- **The files.** `https://github.com/{owner}/{repo}/raw/{sha}/{path}` with the session: it answers `302` to
  `raw.githubusercontent.com/…` (for a private repository with a short-lived `?token=` in that URL), which sends
  `Access-Control-Allow-Origin: *`. A fork's head commit is served from the base repository's URL too
  (TcUnit#274 comes from a fork).
- **Renames.** The old path is in the file's header (classic: `title="old → new"`); the base version is read at
  the old path. TcUnit#274 has two renamed files; their old names show as *Renamed from …* and the renamed POU
  as *renamed from FB_…253CharLength…*.
- **Added and deleted files.** No status is needed from the page: a 404 from the way that reads this repository
  means the file is not in that version (TcUnit#268's new `FB_XmlFileStream.TcPOU`: *New file*, 7 objects added).

There are three ways to read a file, tried in this order until one works, and each attempt is listed under
*Diagnostics*:

1. **frame**: `fetch(url, { credentials: 'include' })` from the viewer, an extension page with host permissions
   for `github.com` and `raw.githubusercontent.com` (no CORS limits);
2. **worker**: the same from the service worker;
3. **page**: the content script fetches it on the frame's behalf, from the page's own origin, where the user's
   github.com cookies certainly go.

Public repository (TcUnit#274, #268): *frame* reads both versions (`200 from raw.githubusercontent.com`, about
0.5 to 2 s cold per version).

Private repository: *pending*. The doubt is the frame: an extension frame inside github.com is a third-party
context, so the `SameSite=Lax` session cookie may not go with its requests; then *worker* or *page* has to.

Where a token is needed: the REST API for a private repository (the commits when the page does not give them,
`/contents` for files, any write such as review comments). A token is a personal access token or an OAuth app;
the spike has none.

## 2. Does the iframe approach work under GitHub's CSP? And wasm?

Yes. GitHub's CSP has `frame-src viewscreen.githubusercontent.com notebooks.githubusercontent.com` and no
`chrome-extension:`, yet the viewer frame loads: Chromium does not apply a page's CSP to a web-accessible
extension resource. Inside the frame the extension's own CSP applies, and none of GitHub's CSS reaches it: the
viewer sets its own colors, following GitHub's color mode (`<html data-color-mode>`, `auto` → the system's).
The frame has no scroll bar of its own; it posts its height to the content script, which sizes it.

WebAssembly: **blocked** under Manifest V3's default CSP for extension pages (`script-src 'self'`; the probe in
*Diagnostics* gets "neither 'wasm-eval' nor 'unsafe-eval' is an allowed source of script"), **allowed** once the
manifest declares `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`
(checked with a copy of the extension). GitHub's CSP plays no part. So the TextMate grammar with oniguruma (as in
`src/webview/textmate.ts`) would run in the frame; the spike highlights with `src/lang/lexer.ts` instead, which
needs no WebAssembly.

## 3. Which DOM hooks did the current "Files changed" page need, and how brittle do they look?

Everything DOM-related is in `content.ts`. It does not parse the page's file list: it starts from GitHub's anchor
of a file, which links to files depend on.

| Hook | Classic page (verified) | React page | Brittleness |
| --- | --- | --- | --- |
| A file's block | `div` with `id="diff-<sha256 of the path>"` | same, per Refined GitHub's selectors (*pending*) | Low: the anchor is GitHub's public link format. |
| The file's path | any text or attribute of the header whose sha256 is the anchor's hash (`data-path`, `title`, …) | same (*pending*) | Low: the hash check makes any markup that shows the path work, and rules out a wrong guess. |
| Old path of a renamed file | `title="old → new"` | `old renamed to new` / two texts (*pending*) | Medium: a rename's wording or layout can change; a wrong old path shows as an added file. |
| The header (toggle's place) | `.file-header`, toggle in `.file-info` | `[class*="diff-file-header"]`, toggle in `[class*="file-path-section"]` (*pending*) | Medium: class names; CSS-module names keep their readable part. |
| The diff to hide | the header's siblings in the block (`.js-file-content`) | same rule (*pending*) | Low to medium: structural, no class name. |
| Deleted file | `data-file-deleted="true"` | none needed (a 404 tells) | Low. |
| The commits | `/diffs/{base}..{head}` in `deferred-diff-lines[data-url]`, `show_partial_comparison?…` in a `div[data-url]` | JSON keys (*pending*) | **High**: internal URLs and JSON. The REST API is the stable source, but needs a token for a private repository. |
| Line links | `#diff-<hash>L<n>` / `R<n>` (cells with that id) | same format (*pending*) | Low: GitHub's public line-link format. |
| Theme | `<html data-color-mode>` | same | Low. |

Other behavior: GitHub loads the diffs of a big pull request as one scrolls; a `MutationObserver` adds the
toggles as the blocks come (TcUnit#274: 2 TwinCAT files at load, 17 after scrolling). A block GitHub renders
again gets its toggle back, and the viewer if it was on (a remounted frame reads the files again).

## 4. Does the section line → XML line link work?

Yes, on the classic page. Each changed line shows the XML line it is on, computed with `sectionFileLines` on that
side's file (`L` + line in the base file, `R` + line in the head file). A click turns the view off for that file,
sets `location.hash` to `diff-<sha256 of the path>L<n>`/`R<n>`, and GitHub scrolls to the line and highlights it,
as for its own line links. Checked on TcUnit#274: `L4` lands on the XML line
`<Declaration><![CDATA[(* This testsuite tests the function block …`, `L22` on the declaration line of the changed
variable. A changed section line is a changed XML line, so it is in a hunk of GitHub's diff; when the file's
diff is not loaded yet (GitHub's *Load diff* for big files), the anchor does not exist and a note beside the
toggle says so. The coupling is GitHub's public line-link format only. React page: *pending*.

## 5. Rough effort, and what I would do differently

**MVP on GitHub, about 3 weeks for one developer:**

- the React page made solid, with a test fixture of its markup (the React page is the default since January
  2026; Refined GitHub marks its classic-page selectors for removal on 2027-01-01): 3 to 4 days;
- the commits from a stable source: the REST API with an optional token (OAuth device flow or a pasted token, in
  `chrome.storage`), the page's markup as the first try: 2 days;
- reading files: keep the way the private-repository test shows works, drop the others: 1 day;
- the viewer: TextMate highlighting with the extension's grammar (wasm, see 2), better pairing of changed lines,
  keyboard navigation, the commit ranges a review can select: 3 to 4 days;
- the tree (working here): a filter field, keyboard navigation, the row of the file in view marked, GitHub's
  *Viewed* state, one cache for the tree's and the views' reads: 2 to 3 days;
- labels on the file headers without opening the view (metadata only, objects changed), from the tree's reads:
  1 day;
- packaging for the Chrome Web Store and Edge Add-ons, a privacy note, a CI build, an end-to-end smoke test with
  a headless browser: 3 days.

**GitLab, about 1 more week**: its adapter is here (see [GitLab](#gitlab)); left for an MVP are a test fixture of
both diff pages' markup, the check on the self-managed versions in use (an older one may mark its lines
differently) and on a private project, and the page's choice of versions and comparison checked against what the
views show. The viewer, the tree and the packaging are GitHub's. Bitbucket would be another adapter, 1 to 2 weeks.

**What I would do differently:**

- Make the host adapter an interface from the start (find blocks, path, commits, line anchor), with the viewer
  and model knowing nothing of GitHub: adding GitLab began by moving GitHub's parts behind one (`src/host.ts`).
- Take the commits from an API rather than the markup: the markup is the most brittle hook (see 3).
- Read files in one place (service worker or page) instead of three, once the private test settles which.
- Use Monaco's `linesDiffComputers` (as `src/webview/main.ts` does) if the Myers diff's alignments bother
  reviewers: Monaco's heuristics (indentation, moved blocks) read better on large rewrites.
- Review comments are read-only in the view ([Review comments](#review-comments)). Writing them from it would go
  through the host's API: GitLab's with the session and the page's CSRF token, GitHub's with a token.

## How it was tested

- `npm test`: 146 tests, the 28 above included.
- Headless Edge 155 with the unpacked extension (`--load-extension`, which Chrome 137+ ignores) in a throwaway
  profile, driven over the DevTools protocol, signed out (so GitHub serves the classic page), in light and dark
  mode: toggle on and off, viewer contents, frame size, diagnostics, a line link and where it lands, screenshots.
  On public pull requests:
  - tcunit/TcUnit#274: a renamed and modified POU, methods, a file loaded on scroll;
  - tcunit/TcUnit#268: a new POU with a property;
  - pcdshub/lcls-twincat-motion#249: a deleted DUT, a renamed DUT, new DUTs, a POU with 5 methods modified,
    4 deleted and 16 unchanged;
  - pcdshub/lcls-twincat-motion#248: 20 methods, properties and accessors added; a `.xti` whose only change is
    the TmcHash;
  - pcdshub/lcls-twincat-motion#245: files moved without changes (*Renamed, content unchanged*), a deleted POU
    with properties, 53 TwinCAT files loaded as the page scrolls;
  - pcdshub/lcls-twincat-motion#240: 8 property accessors modified, a POU renamed with its file, an interface
    (`.TcIO`) with deleted methods;
  - pcdshub/lcls-twincat-general#74: about 60 files whose only change is the removal of `ProductVersion`. They
    show *No code changed: XML only, no code*: `metadataChange` names a ProductVersion change only when the
    attribute is in both versions (its removal leaves a space behind in what it compares). Teaching it the
    removal would change the label in the VS Code extension too, so the spike leaves it.
- The tree, the same way on pcdshub/lcls-twincat-motion#249, in light and dark mode: the tabs above GitHub's
  file tree, the tree read from the pull request's diff and, with a copy of the extension that cannot read the
  diff, from the page's list (the same 31 files and 125 changed objects); a click on `StateMachine` opens
  `FB_MotionStageE727`'s view at that method, 150 px from the top of the window.
- GitLab, the same way on gitlab.com: see *Checked* under [GitLab](#gitlab). After the move to host adapters,
  pcdshub/lcls-twincat-motion#249 again: the toggles, a line link (`L7`), the tree (31 files, 125 changed objects),
  the click on `StateMachine` (150 px from the top).
- A self-managed GitLab 19.4, by the user in a signed-in Edge: see *Checked live* under [GitLab](#gitlab).
- *Pending:* a signed-in Chrome or Edge on GitHub's React page, with a private repository.

# Spike: TwinCAT objects in GitHub's pull request diff

A read-only browser extension (Chromium, Manifest V3) that shows a changed `.TcPOU`, `.TcDUT`, `.TcGVL` or
`.TcIO` file of a GitHub pull request as TwinCAT objects instead of XML, in the layout of the VS Code extension's
commit diff (`src/vscode/commitDiff.ts`): each changed object with its Declaration diff above its Implementation
diff. This document answers the spike's questions. Tested on 2026-10-20 with Edge 155 and Chrome 155.

**Live test on a signed-in browser (React "Files changed" page, private repository): pending.** The answers
below marked *pending* are filled in from it.

## Build, load, use

```bash
npm run build:browser
```

This type-checks `browser/` and bundles it into `browser/dist`. In Chrome or Edge, open `chrome://extensions`
(or `edge://extensions`), turn on developer mode, *Load unpacked*, and pick `browser/dist`. On a pull request's
*Files changed* tab each TwinCAT file gets a **TwinCAT view** toggle in its header (Alt+click toggles all of
them). When it is on, the file's diff is replaced by the object view; off brings GitHub's diff back.

The view of a file:

- a summary line: how many objects were modified, added, deleted, unchanged; new, deleted or renamed file;
  the two commits compared;
- each changed object (POU, DUT, GVL, method, property, property Get/Set, action, transition), in the order of
  the file, deleted ones last, with an **M**, **A** or **D** badge and, when renamed, its old name;
- below it, its Declaration diff, then its Implementation diff: inline, with 3 lines of context and the longer
  runs of unchanged lines folded (click to unfold), word-level highlights, Structured Text highlighting;
- runs of unchanged objects folded into one row (click to list them, click one to see its code);
- a file without code changes says what changed instead: `ProductVersion 3.1.4024.12 → 3.1.4026.13`,
  `XML only, no code`, `Renamed, content unchanged`; a `.tsproj`/`.xti` whose only change is the TmcHash a
  build rewrites says so;
- on every changed line, the XML line it is on (`L123` on the base side, `R124` on the head side), a link
  to that line in GitHub's own diff;
- a *Diagnostics* block: the commits and where they came from, how each file was read, whether WebAssembly
  runs in the frame, and a button that tries every way of reading the file.

Read-only: no commenting.

## How it is built

| File | Role |
| --- | --- |
| `src/content.ts` | Content script, the only code that knows GitHub's DOM: finds the TwinCAT files' blocks, adds the toggle, puts the viewer frame in place of the diff, passes the pull request's coordinates, scrolls to a line. |
| `src/viewer.ts` + `static/viewer.html`, `viewer.css` | The viewer, an extension page in an iframe (`web_accessible_resources`): reads the two versions, builds the model, renders it. |
| `src/model.ts` | Platform-free model of one file: object views, section line diffs, XML line of each section line. |
| `src/github.ts` | Platform-free GitHub knowledge: URLs, the commits in a page's markup, the frame's parameters. |
| `src/lineDiff.ts` | Myers line diff (as git's default) with deletions before additions in each block, and the changed middle of a line. |
| `src/highlight.ts` | Structured Text highlighting from `src/lang/lexer.ts`. |
| `src/background.ts` | Service worker: one of the ways to read a file (see question 1). |
| `build.js`, `tsconfig.json` | esbuild bundles (content 8 KB, viewer 28 KB, worker 1 KB, minified); `tsc` checks with the DOM library and without Node's types. |

The core is used as it is, without a fork and without changes: `parseTcText` (`src/core/tcfile.ts`) parses both
versions, `viewChanges` (`objectChanges.ts`) says which object views changed (and their old names),
`viewSections` and `viewLabel` (`objectText.ts`) give the sections of a view, `sectionFileLines` the XML line of
each section line, `metadataChange` and `onlyTmcHashChanged` the label of a file without code changes.
`tcfile.ts` mentions Node's `Buffer` in `decodeBytes`/`encodeText`; the extension decodes with `TextDecoder`
instead, esbuild drops both functions, and `build.js` fails if a bundle mentions `Buffer`.

The model adds two things on top of `viewChanges`: unchanged objects are listed too (to fold them), and an
object whose graphical implementation (CFC, SFC, FBD/LD) changed is *modified* even though its Structured Text
did not (`viewChanges` compares ST only; its XML is compared here). Graphical code itself is not drawn.

Unit tests: `test/unit/browserView.test.ts` (16 tests, part of `npm test`) on made-up files: a modified method,
an added and a deleted method, a changed property Get, a deleted accessor and property, a renamed method, a
metadata-only change, project files, a new, deleted and renamed file, CRLF files, a changed CFC action, a broken
file, the line diff (checked against an LCS on random inputs), and the GitHub helpers.

## 1. Can both versions be fetched with the session, private repositories and renames included?

The view needs the file at the **merge base** (the page shows a three-dot diff) and at the **head**:

- **The commits.** The page's markup has them. On the classic page, in the URLs it loads its diffs from:
  `/{owner}/{repo}/diffs/{base}..{head}` and `show_partial_comparison?base_commit_oid=…&end_commit_oid=…`.
  On TcUnit#274 the page compares `d447f95`, the merge base, while `master` is at `425c629` by now. For the React
  page, `commitsInPage` looks for JSON keys naming a merge base or comparison start and a head (*pending*: which
  keys it really has). It never takes `baseRefOid` for the base: that is the base branch's tip (`425c629` here),
  which would show the base branch's own changes as reverted. Without commits in the page, the content script
  asks the REST API without a token (`/pulls/{n}`, then `/compare/{base}...{head}` for the merge base): this works
  for public repositories only.
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
| The commits | `/diffs/{base}..{head}` in `deferred-diff-lines[data-url]` | JSON keys (*pending*) | **High**: internal URLs and JSON. The REST API is the stable source, but needs a token for a private repository. |
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
- labels on the file headers without opening the view (metadata only, objects changed), cached reads: 2 days;
- packaging for the Chrome Web Store and Edge Add-ons, a privacy note, a CI build, an end-to-end smoke test with
  a headless browser: 3 days.

**GitLab, about 2 more weeks** once the model and viewer are shared (not tried in this spike): an adapter for
the merge request diff page (file blocks with `data-path`, line anchors `<sha1 of the path>_<old>_<new>`), the
commits from the merge request's `diff_refs` (`base_sha`, `start_sha`, `head_sha`; GitLab's API takes the
session cookie on its own origin, so no token is needed), files from `/-/raw/{sha}/{path}`, and host permissions
requested at run time for self-managed GitLab instances. Bitbucket would be another adapter of the same size.

**What I would do differently:**

- Make the host adapter an interface from the start (find blocks, path, commits, line anchor), with the viewer
  and model knowing nothing of GitHub; the spike has the GitHub parts in `content.ts` and `github.ts` only, which
  is close.
- Take the commits from an API rather than the markup: the markup is the most brittle hook (see 3).
- Read files in one place (service worker or page) instead of three, once the private test settles which.
- Use Monaco's `linesDiffComputers` (as `src/webview/main.ts` does) if the Myers diff's alignments bother
  reviewers: Monaco's heuristics (indentation, moved blocks) read better on large rewrites.
- Show the review comments read-only in the view: a comment is on an XML line, and the line mapping goes both
  ways. Writing comments would need the REST API and a token.

## How it was tested

- `npm test`: 108 tests, the 16 above included.
- Headless Edge 155 with the unpacked extension (`--load-extension`, which Chrome 137+ ignores) in a throwaway
  profile, driven over the DevTools protocol, signed out (so GitHub serves the classic page), on public TcUnit
  pull requests: #274 (a renamed and modified POU, methods, a file loaded on scroll) and #268 (a new POU with a
  property), in light and dark mode; toggle on and off, viewer contents, frame size, diagnostics, a line link and
  where it lands, screenshots.
- *Pending:* a signed-in Chrome or Edge on the React page, with a private repository.

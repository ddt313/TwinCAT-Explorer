# Explorer for TwinCAT on addons.mozilla.org

The browser extension is listed on addons.mozilla.org (AMO) for Firefox, as
[explorer-for-twincat](https://addons.mozilla.org/firefox/addon/explorer-for-twincat/), add-on ID
`explorer-for-twincat@ddt313.github.io`. This folder holds what AMO is given besides the extension: the listing
(`metadata.json`), the build instructions for its reviewers (below), and the notes to them.

## For AMO's reviewers: building the submitted files

The submitted files are bundled and minified by esbuild from TypeScript. This archive is the repository at the
release's tag (`git archive`); the extension is `browser/`, built on the platform-free core of the VS Code extension
(`src/core`, `src/lang`).

Requirements: Node.js 22 (checked with 22.22.0) and npm 10, on Linux, macOS or Windows. Nothing else is
downloaded but the npm packages of `package-lock.json`.

```bash
npm ci
npm run build:browser
```

`browser/dist-firefox` is then the submitted add-on, file for file (the build is reproducible: built twice from
clean archives, the files are the same, byte for byte). `browser/build.js` is the build: esbuild bundles
`browser/src/{content,viewer,tree,popup,background}.ts`, copies `browser/static` and the icons of `media/`, and
writes Firefox's `manifest.json` from `browser/static/manifest.json` (`firefoxManifest`). `browser/dist` is the
Chrome build of the same files.

## Notes to the reviewers

Pasted into *Notes to Reviewer* with each version:

> The source code archive is the repository at the release's tag; build with `npm ci && npm run build:browser`
> (Node 22), as `browser/amo/README.md` says. The output is `browser/dist-firefox`.
>
> Permissions:
> - Host permissions for github.com, gitlab.com, bitbucket.org and their API and raw-file hosts: the content script
>   adds the TwinCAT view to their review pages and reads, with the user's session, the two versions of each TwinCAT
>   file and the review comments of the pull request the page shows.
> - Optional host permissions `https://*/*` and `http://*/*`: a self-managed GitLab instance, asked for one origin at
>   a time from the toolbar popup when the user clicks *Turn on for this site*, then
>   `scripting.registerContentScripts` on that origin.
> - `scripting` and `activeTab`: to start the content script in the open tab from the popup, without a reload.
> - `storage`: the user's settings (the tree tab on or off, the diff layout, the sites started by hand).
>
> `innerHTML` is set with markup built from the extension's own constants and from text escaped first (`esc()` in
> `viewer.ts`, `tree.ts`, `popup.ts`); the viewer and tree frames are extension pages under the default extension CSP.
>
> To try it, signed out: https://github.com/tcunit/TcUnit/pull/274/files, then click *TwinCAT view* on a `.TcPOU`
> file, or the *TwinCAT* tab above the file tree.

## Releasing a version

Each `browser-v*` release submits `browser/dist-firefox` to AMO's *listed* channel with the source archive, with
`web-ext sign --channel listed` (`.github/workflows/release-browser.yml`, or the `release` skill by hand). AMO
signs a version once, and a listed version may wait for a review before Firefox updates to it.

**The first version** creates the listing. Either on the web (addons.mozilla.org > Developer Hub > *Submit a New
Add-on* > *On this site*: upload a zip of `browser/dist-firefox`, then the source archive, then the listing from
`metadata.json`), or from the command line, with the AMO API key in the environment:

```bash
npm run build:browser
git archive --format=zip -o explorer-for-twincat-browser-<version>-source.zip HEAD
npx --yes web-ext@10.8.0 sign --source-dir browser/dist-firefox --channel listed --approval-timeout 0 \
  --amo-metadata browser/amo/metadata.json --upload-source-code explorer-for-twincat-browser-<version>-source.zip \
  --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

Then, on the listing's page in the Developer Hub: the screenshots (`docs/images/browser-object-view.png`,
`docs/images/browser-split-view.png`), the support site (`https://github.com/ddt313/TwinCAT-Explorer/issues`), and
the notes above. Later versions are submitted without `--amo-metadata`: the listing is edited on AMO, not here.

---
name: release
description: Release a version of Explorer for TwinCAT, the VS Code extension (tag v0.16.1, a .vsix) or the browser extension (tag browser-v0.1.4, a zip for Chrome and Edge, and Firefox's build submitted to its addons.mozilla.org listing). Turns the changelog's Unreleased section into the version's, bumps the version, merges release/x.y.z into develop and develop into master, tags master's merge commit, then builds, tests, packages (submits Firefox's build to addons.mozilla.org) and creates the GitHub release by hand when GitHub Actions does not run. Use whenever the user wants to release, ship, tag or publish a version, bump the version, or fix a release that went out wrong.
---

# Release

Two products, released apart from the same repository (`browser/SPIKE.md`, *Releases*):

| | VS Code extension | Browser extension |
| --- | --- | --- |
| Version | `package.json` (and `package-lock.json`) | `browser/static/manifest.json`: `version`, and `version_name` for a pre-release |
| Changes | `CHANGELOG.md` | `browser/CHANGELOG.md` |
| Tag | `v0.16.1` | `browser-v0.1.4` |
| Workflow | `.github/workflows/release.yml` | `.github/workflows/release-browser.yml` |
| Asset | `explorer-for-twincat-<version>.vsix` | `explorer-for-twincat-browser-<version>.zip` (Chrome, Edge); Firefox's on addons.mozilla.org (`browser/amo/`) |
| GitHub release | title `v0.16.1`, the latest release | title `Browser extension 0.1.4`, `--latest=false` |

The workflows are the reference: when a step below and a workflow differ, do what the workflow does.

## 1. What is there to release

```bash
git fetch --all --tags -q
git switch develop && git pull --ff-only     # pull BEFORE reading the changelog
git tag --sort=-v:refname | head -5
gh release list -L 5
git log --oneline v<last>..origin/develop    # or browser-v<last>; -- browser for the browser extension
```

- If the last tag already has its GitHub release and develop has nothing new, there is nothing to release: say so.
- Pick the version from the changes: a fix only → patch, anything *Added* → minor. A version with a `-`
  (`1.0.0-pre.1`) is a pre-release.

## 2. Changelog

Read the changelog **after** the pull, from the top.

- When it has a `## Unreleased` section, rename that heading to `## <version> - <YYYY-MM-DD>` (today's date) and keep
  its text. Never write a second section for the same changes.
- When the changes have no entry yet, write one from the commits' messages, in the changelog's own style: `### Added`,
  `### Changed`, `### Fixed`; each entry says what the user sees now, and for a fix what happened before.
- Leave no `## Unreleased` behind: the release notes and the extension's Changelog tab are taken from this file.

## 3. Version and branch

VS Code extension:

```bash
git switch -c release/<version>
npm version <version> --no-git-tag-version   # package.json and package-lock.json
```

Browser extension: set `version` (and `version_name` for a pre-release, with a `version` of up to four numbers such
as `0.2.0.1`) in `browser/static/manifest.json`, on a branch `release/browser-<version>`.

Commit as `Version <version>` (browser: `Browser extension <version>`) with the attribution trailer this project uses.

## 4. Check

```bash
npm ci
npm run compile
npm run test:unit            # all must pass
npm run build:browser        # browser extension only: browser/dist (Chrome, Edge) and browser/dist-firefox
npx --yes web-ext@10.8.0 lint --source-dir browser/dist-firefox   # browser extension only: no errors
```

## 5. Merge: release branch → develop → master

```bash
git push -u origin release/<version>
gh pr create --base develop --title "Version <version>" --body "Version <version>: package.json and the changelog's section. ..."
gh pr merge release/<version> --merge
git switch develop && git pull --ff-only
gh pr create --base master --head develop --title "Release <version>" --body "Release <version> (PRs #a, #b). ..."
gh pr merge <number> --merge
```

PR bodies end with the attribution line this project uses. The user has said to do the whole release (merge, tag,
release) without asking each time.

## 6. Tag

Tag master's merge commit, a lightweight tag as the earlier ones:

```bash
git fetch -q origin
git tag v<version> origin/master            # browser-v<version> for the browser extension
git push origin v<version>
```

**Never move or re-push a tag that is already pushed.** A release that went out wrong gets a new patch release
(as 0.16.1 fixed 0.16.0's changelog); its GitHub release notes may be edited with `gh release edit`.

## 7. GitHub release

Check whether the workflow ran for the tag:

```bash
gh run list -L 3
```

GitHub Actions on this repository has been locked for billing since 2026-10-21: no run starts. When no run started
for the tag (or it failed in seconds on billing), do the workflow's steps by hand **at the tag**:

```bash
git switch --detach v<version>
test "v$(node -p "require('./package.json').version")" = "v<version>"
npm run compile && npm run test:unit
npm run package -- --out explorer-for-twincat-<version>.vsix
unzip -p explorer-for-twincat-<version>.vsix extension/changelog.md | grep -n '^## ' | head -3   # no Unreleased
```

Release notes: the changelog's section, then how to install (as `release.yml` writes them):

```bash
version=<version>
notes="$(awk -v head="## $version" '
  index($0, head " ") == 1 || $0 == head { found = 1; next }
  found && /^## / { exit }
  found { print }
' CHANGELOG.md | sed '/./,$!d')"
printf '%s\n\n%s, or from the Marketplace.\n' "$notes" \
  "Install the attached file with \`code --install-extension explorer-for-twincat-$version.vsix\`" > <scratchpad>/notes.md
gh release create v$version explorer-for-twincat-$version.vsix --verify-tag --title v$version \
  --notes-file <scratchpad>/notes.md --prerelease=false     # true for a version with a -
git switch develop
```

A pre-release's notes end instead with how to go back (see `release.yml`).

### Browser extension by hand

One release for both browsers, the tag `browser-v<version>`: the zip for Chrome and Edge on GitHub, and Firefox's
build submitted to its listing on addons.mozilla.org (AMO), as `release-browser.yml` does.

```bash
git switch --detach browser-v<version>
test "$(node -p "const m = require('./browser/static/manifest.json'); m.version_name || m.version")" = "<version>"
npm run compile && npm run test:unit
npm run build:browser
npx --yes web-ext@10.8.0 lint --source-dir browser/dist-firefox
```

1. **Zip** `browser/dist` as the one folder `explorer-for-twincat-browser`: `cp -r browser/dist
   out/release/explorer-for-twincat-browser`, then Windows' own `/c/Windows/System32/tar.exe -a -c -f
   explorer-for-twincat-browser-<version>.zip -C out/release explorer-for-twincat-browser` (on Linux:
   `cd out/release && zip -qr ../../explorer-for-twincat-browser-<version>.zip explorer-for-twincat-browser`).
2. **Notes**: the section of `browser/CHANGELOG.md` (the same `awk`, on that file), then the *Install* text of
   `release-browser.yml`, Firefox's paragraph included.
3. **Release**:

   ```bash
   gh release create browser-v<version> explorer-for-twincat-browser-<version>.zip --verify-tag \
     --title "Browser extension <version>" --notes-file <scratchpad>/notes.md \
     --prerelease=false --latest=false     # true for a version with a -
   ```

4. **Submit Firefox's build to AMO**, last, once all of the above passed: AMO takes a version **once**, so a version
   that has to change after it is a new version. The source archive is the repository at the tag; its reviewers build
   from it as `browser/amo/README.md` says.

   ```bash
   test -n "$AMO_JWT_ISSUER" && test -n "$AMO_JWT_SECRET"
   git archive --format=zip -o <scratchpad>/explorer-for-twincat-browser-<version>-source.zip HEAD
   npx --yes web-ext@10.8.0 sign --source-dir browser/dist-firefox --channel listed --approval-timeout 0 \
     --upload-source-code <scratchpad>/explorer-for-twincat-browser-<version>-source.zip \
     --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
   git switch develop
   ```

   The key is the AMO account's (Developer Hub, *Manage API Keys*): the repository's secrets of the same names for
   the workflow, the session's or shell's environment by hand. Never write it into a file, a command's text or the
   repository. Without it, tell the user to submit `browser/dist-firefox` and the source archive on AMO themselves
   (Developer Hub, the listing, *Upload New Version*), with the *Notes to the reviewers* of `browser/amo/README.md`.
   The first version creates the listing: `--amo-metadata browser/amo/metadata.json` added, once (see
   `browser/amo/README.md`); a later one never passes it, as the listing is edited on AMO. A version may wait for a
   review there before Firefox updates to it; the release does not wait for it.

The Marketplace is not published by hand.

## 8. Report

Tell the user the version, the PRs, the tag and the release's link, that the tests passed, and that the Marketplace
was not updated (when the workflow did not run). For the browser extension, say whether Firefox's build went to AMO
(and that it may wait for a review there), and when not, why (no AMO key, an error of AMO's) and what the user does.

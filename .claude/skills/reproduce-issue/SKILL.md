---
name: reproduce-issue
description: Reproduce a reported problem of Explorer for TwinCAT (the VS Code extension, its MCP server or the browser extension) before fixing it, on samples/Demo (a TwinCAT solution saved by TwinCAT XAE) or in a minimal test of its own, then fix it with a test that failed first. Use whenever the user points at a GitHub issue, pastes a bug report, a wrong diagnostic, an MCP tool's answer or a TwinCAT file the extension reads or writes wrongly, or asks to reproduce, debug or fix a bug, even without naming this skill.
---

# Reproduce an issue

A fix starts from a reproduction: a test that fails for the reason the report gives, and passes once the code is
fixed. It stays as the issue's regression test.

## 1. Read the report

- The issue and its comments (`gh issue view <n> --comments`, or the GitHub MCP tools): the extension's version, the
  TwinCAT XAE version, the steps, what was expected.
- Which part it is: files and projects (`src/core`), Structured Text features (`src/lang`), the VS Code views and
  editors (`src/vscode`, `src/webview`), the MCP server (`src/mcp`), the browser extension (`browser/`), XAE
  (`xae/XaeBridge.cs`, `src/core/xae.ts`).
- **A reporter's project, file or code is theirs, often their customer's. Never commit it, not even a part of it:**
  rebuild the case with made-up names (`FB_Valve`, `MAIN`) in the smallest code that still shows the problem. The
  repository is public.

## 2. Build

Cloud sessions run `.claude/hooks/session-start.sh` when they start: `node_modules` and `out/` are there. Elsewhere,
or after a change:

```bash
npm ci            # once
npm run compile   # after any change of src/, test/ or scripts/: the scripts and tests run from out/
```

## 3. Try it on samples/Demo

`samples/Demo` is a TwinCAT solution saved by TwinCAT XAE 3.1.4026 (its README lists what it holds): the PLC project
DemoLib, also saved as a library, and Machine, which references it. XAE builds it with no error and no warning, so
the extension must find no problem there but the one in `FB_Prototype`, which is in a folder excluded from the build
(`test/unit/sample.test.ts`).

```bash
node scripts/parse-all.js samples/Demo              # syntax errors of every section
node scripts/analyze-all.js samples/Demo --list 20  # problems (unknown names, ...), grouped by message
node scripts/coverage.js samples/Demo               # names neither resolved nor reported
node scripts/mcp-call.js samples/Demo               # the MCP server's tools and their arguments
node scripts/mcp-call.js samples/Demo check read '{"object":"FB_Valve.Open"}'
node scripts/mcp-call.js --copy samples/Demo edit_section '{"object":"MAIN","part":"impl","oldText":"...","newText":"..."}'
```

`mcp-call.js` runs the bundled server as an MCP client does, without XAE; with `--copy` it works on a copy in the
temp folder and prints where, so a tool that writes leaves the sample as it is.

The views and editors run in VS Code for the Web, with the extension as built (`out/web/extension.js`). Start it in
the background and drive it with Playwright, whose Chromium cloud sessions have (`require('playwright')`):

```bash
npx vscode-test-web --browser=none --quality=stable --extensionDevelopmentPath=. --port 3123 \
  --testRunnerDataDir "${TMPDIR:-/tmp}/vscode-test-web" samples/Demo
```

```js
// A .js file in the session's scratch folder, run with node.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://localhost:3123/');
  await page.locator('.monaco-list-row', { hasText: 'Machine' }).first().waitFor({ timeout: 120000 }); // the TwinCAT tree
  await page.screenshot({ path: 'tree.png' });
  await browser.close();
})();
```

The TwinCAT container opens by itself with the Solution tree. The folder is mounted read-only (a save stays in the
browser), and the git views find no repository there.

## 4. Put the case where it belongs

- **An everyday TwinCAT case the sample lacks** (a kind of object, a construct, a library): it belongs in the
  sample, made in XAE and never by hand (`samples/Demo/README.md`). XAE runs on Windows only: ask the user to add it,
  saying exactly what (object, kind, code). Until it is there, test it as below.
- **A narrow case:** a test in the test file of that part (`test/unit/<part>.test.ts`), with the XML written in the
  test as its neighbours do (their `pou`, `plcproj`, `project` helpers), in a temporary folder.
- **A case that needs the bytes of a real file** (encoding, line breaks, the layout of an XAE version):
  `test/fixtures/issue-<n>-<slug>/`, made-up content only. `.gitattributes` keeps those bytes as they are.
- Above the test, the issue: `// https://github.com/ddt313/TwinCAT-Explorer/issues/<n>`.

## 5. Fix it with a test that failed first

1. Write the test and run it: `npm run compile && node --test --test-reporter=spec out/test/unit/<file>.test.js`.
   It must fail, and for the reason of the report, not another.
2. Fix the code: the test passes. Then `npm run test:unit`: all pass.
3. When the fix changes what the extension finds in the sample, update the expected problems in
   `test/unit/sample.test.ts`, saying why.

## 6. What a cloud session cannot run

- TwinCAT XAE, on Windows: Save through XAE, Open in XAE, the MCP tools with XAE open, `check` with
  `compiler: true`. Test the extension's side against a fake XAE, as `test/unit/xaeSave.test.ts` and
  `test/unit/mcp.test.ts` (`fakeXae`) do, and ask the user to check it in XAE on samples/Demo, with the XAE version.
- The libraries installed with TwinCAT, the licenses, Windows paths.

In the pull request, say what was reproduced and how, and what was not.

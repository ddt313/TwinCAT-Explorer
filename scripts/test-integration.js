// Runs the integration tests (test/integration) in a real VS Code: a copy of samples/Demo is opened, put under git
// with one commit, so the tests may change its files and the git views have a repository to read.
// Usage: npm run test:integration   (compile first: npm run compile)
// Environment:
//   VSCODE_VERSION            the VS Code to download: 'stable' (default), 'insiders' or a version such as 1.95.0
//   VSCODE_EXECUTABLE         a VS Code already installed, used instead of a download
//   TWINCAT_TEST_GREP         runs only the tests whose name matches this regular expression
//   TWINCAT_TEST_TIMEOUT      the time a test may take, in ms (default 30000)
// On Linux without a display, run it under xvfb-run.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const repo = path.resolve(__dirname, '..');
const tests = path.join(repo, 'out', 'test', 'integration', 'index.js');

(async () => {
  if (!fs.existsSync(tests)) throw new Error(`${path.relative(repo, tests)} is missing: run npm run compile first`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-for-twincat-it-'));
  const workspace = path.join(root, 'Demo');
  try {
    fs.cpSync(path.join(repo, 'samples', 'Demo'), workspace, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    git('add', '-A');
    git('-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'samples/Demo');

    const executable = process.env.VSCODE_EXECUTABLE;
    await runTests({
      version: executable ? undefined : process.env.VSCODE_VERSION || 'stable',
      vscodeExecutablePath: executable || undefined,
      extensionDevelopmentPath: repo,
      extensionTestsPath: tests,
      extensionTestsEnv: {
        TWINCAT_TEST_GREP: process.env.TWINCAT_TEST_GREP ?? '',
        TWINCAT_TEST_TIMEOUT: process.env.TWINCAT_TEST_TIMEOUT ?? '',
      },
      launchArgs: [
        workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--disable-gpu', `--user-data-dir=${path.join(root, 'user-data')}`, `--extensions-dir=${path.join(root, 'extensions')}`,
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch(e => {
  console.error(String(e));
  process.exit(1);
});

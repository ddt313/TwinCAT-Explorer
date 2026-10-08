// Opens a folder in a separate VS Code instance and reports whether the
// extension activates through its activation events alone.
// Usage: node scripts/check-activation.js <folder>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const folder = path.resolve(process.argv[2] || '.');
const code = process.env.VSCODE_EXECUTABLE || path.join(os.homedir(), 'AppData/Local/Programs/Microsoft VS Code/Code.exe');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-explorer-act-'));
  try {
    await runTests({
      vscodeExecutablePath: fs.existsSync(code) ? code : undefined,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../out/test/integration/activation'),
      launchArgs: [
        folder, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        `--user-data-dir=${path.join(root, 'user-data')}`, `--extensions-dir=${path.join(root, 'extensions')}`,
      ],
    });
  } finally {
    const logs = path.join(root, 'user-data', 'logs');
    if (fs.existsSync(logs)) {
      for (const f of fs.readdirSync(logs, { recursive: true })) {
        if (String(f).endsWith('exthost.log')) {
          const text = fs.readFileSync(path.join(logs, String(f)), 'utf8');
          for (const line of text.split('\n')) if (/twincat|workspaceContains|Timed out/i.test(line)) console.log(`EXTHOST: ${line}`);
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch(e => {
  console.error(String(e));
  process.exit(1);
});

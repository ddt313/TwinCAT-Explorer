// Installs the packaged vsix into a VS Code profile (default: the profile named in
// TWINCAT_PROFILE, or the Default profile). Without --profile the CLI installs into the Default
// profile, and a window that uses another profile never loads the extension.
// Usage: node scripts/install.js [profile]
const cp = require('child_process');
const path = require('path');
const { version, name } = require('../package.json');

const profile = process.argv[2] || process.env.TWINCAT_PROFILE || 'default';
const vsix = path.join(__dirname, '..', `${name}-${version}.vsix`);
const args = ['--install-extension', vsix, '--force'];
if (profile.toLowerCase() !== 'default') args.push('--profile', profile);
console.log(`code ${args.join(' ')}`);
cp.execFileSync(process.platform === 'win32' ? 'code.cmd' : 'code', args, { stdio: 'inherit', shell: process.platform === 'win32' });
console.log('Reload the VS Code window to load the new version.');

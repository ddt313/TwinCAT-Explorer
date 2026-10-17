// Writes ThirdPartyNotices.txt: the licenses of the code bundled into out/webview, whose license comments
// scripts/build-webview.js leaves out. Run it again after updating these packages.
// Usage: node scripts/third-party-notices.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const modules = path.join(root, 'node_modules');
const read = file => fs.readFileSync(path.join(modules, file), 'utf8').replace(/\r\n?/g, '\n').trimEnd();
const version = pkg => require(path.join(modules, pkg, 'package.json')).version;

const components = [
  { pkg: 'monaco-editor', url: 'https://github.com/microsoft/monaco-editor', license: 'MIT',
    files: ['monaco-editor/LICENSE', 'monaco-editor/ThirdPartyNotices.txt'] },
  // Monaco includes its own copy of DOMPurify, which its notices do not list.
  { pkg: 'dompurify', url: 'https://github.com/cure53/DOMPurify', license: 'MPL-2.0 OR Apache-2.0', note: 'as included in monaco-editor',
    files: ['dompurify/LICENSE'] },
  { pkg: 'vscode-textmate', url: 'https://github.com/microsoft/vscode-textmate', license: 'MIT',
    files: ['vscode-textmate/LICENSE.md'] },
  { pkg: 'vscode-oniguruma', url: 'https://github.com/microsoft/vscode-oniguruma', license: 'MIT', note: 'with Oniguruma, BSD-2-Clause',
    files: ['vscode-oniguruma/LICENSE.txt', 'vscode-oniguruma/NOTICES.txt'] },
];

const rule = '='.repeat(78);
const lines = [
  'TwinCAT Explorer: third-party software notices',
  '',
  "The split editor's webview (out/webview) includes the components below. Their copyright notices and",
  'licenses follow.',
  '',
  ...components.map(c => `- ${c.pkg} ${version(c.pkg)} (${c.license}${c.note ? `; ${c.note}` : ''}): ${c.url}`),
];
for (const c of components) {
  lines.push('', '', rule, `${c.pkg} ${version(c.pkg)}`, rule);
  for (const file of c.files) lines.push('', read(file));
}
fs.writeFileSync(path.join(root, 'ThirdPartyNotices.txt'), lines.join('\n') + '\n');
console.log(`ThirdPartyNotices.txt: ${components.map(c => c.pkg).join(', ')}`);

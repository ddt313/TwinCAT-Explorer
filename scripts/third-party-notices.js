// Writes ThirdPartyNotices.txt: the licenses of the code bundled into out/webview, out/mcp and out/web, whose license
// comments scripts/build-webview.js and scripts/build-mcp.js leave out. Run it again after updating these packages.
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

// The MCP server (out/mcp/server.js): the MCP SDK and what it bundles of its dependencies.
const mcpComponents = [
  { pkg: '@modelcontextprotocol/sdk', url: 'https://github.com/modelcontextprotocol/typescript-sdk', license: 'MIT' },
  { pkg: 'zod', url: 'https://github.com/colinhacks/zod', license: 'MIT' },
  { pkg: 'zod-to-json-schema', url: 'https://github.com/StefanTerdell/zod-to-json-schema', license: 'ISC' },
  { pkg: 'ajv', url: 'https://github.com/ajv-validator/ajv', license: 'MIT' },
  { pkg: 'ajv-formats', url: 'https://github.com/ajv-validator/ajv-formats', license: 'MIT' },
  { pkg: 'fast-uri', url: 'https://github.com/fastify/fast-uri', license: 'BSD-3-Clause' },
  { pkg: 'fast-deep-equal', url: 'https://github.com/epoberezkin/fast-deep-equal', license: 'MIT' },
  { pkg: 'json-schema-traverse', url: 'https://github.com/epoberezkin/json-schema-traverse', license: 'MIT' },
].map(c => ({ ...c, files: [`${c.pkg}/LICENSE`] }));

// The browser build (out/web/extension.js): Node's Buffer and path for the browser.
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const webComponents = [
  { pkg: 'buffer', url: 'https://github.com/feross/buffer', license: 'MIT', files: ['buffer/LICENSE'] },
  { pkg: 'base64-js', url: 'https://github.com/beatgammit/base64-js', license: 'MIT', files: ['base64-js/LICENSE'] },
  { pkg: 'ieee754', url: 'https://github.com/feross/ieee754', license: 'BSD-3-Clause', files: ['ieee754/LICENSE'] },
  // Its package has no license file: MIT in its package.json, and it is Node's own path module.
  { pkg: 'path-unified', url: 'https://github.com/jorenbroekema/path-unified', license: 'MIT', note: "Node.js's path module",
    text: `MIT License (package.json of path-unified)\n\nCopyright Node.js contributors. All rights reserved.\nCopyright Joyent, Inc. and other Node contributors.\n\n${MIT}` },
];

const rule = '='.repeat(78);
const lines = [
  'Explorer for TwinCAT: third-party software notices',
  '',
  "The split editor's webview (out/webview) includes the components below. Their copyright notices and",
  'licenses follow.',
  '',
  ...components.map(c => `- ${c.pkg} ${version(c.pkg)} (${c.license}${c.note ? `; ${c.note}` : ''}): ${c.url}`),
  '',
  'The MCP server (out/mcp/server.js) includes these:',
  '',
  ...mcpComponents.map(c => `- ${c.pkg} ${version(c.pkg)} (${c.license}): ${c.url}`),
  '',
  'The browser build (out/web/extension.js) includes these:',
  '',
  ...webComponents.map(c => `- ${c.pkg} ${version(c.pkg)} (${c.license}${c.note ? `; ${c.note}` : ''}): ${c.url}`),
];
for (const c of [...components, ...mcpComponents, ...webComponents]) {
  lines.push('', '', rule, `${c.pkg} ${version(c.pkg)}`, rule);
  for (const file of c.files ?? []) lines.push('', read(file));
  if (c.text) lines.push('', c.text);
}
fs.writeFileSync(path.join(root, 'ThirdPartyNotices.txt'), lines.join('\n') + '\n');
console.log(`ThirdPartyNotices.txt: ${[...components, ...mcpComponents, ...webComponents].map(c => c.pkg).join(', ')}`);

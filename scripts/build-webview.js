// Bundles the split editor's webview (Monaco, vscode-textmate, oniguruma) into
// out/webview: editor.js, editor.css (+ the codicon font), editor.worker.js and
// onig.wasm. Usage: node scripts/build-webview.js [--dev]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out', 'webview');
const dev = process.argv.includes('--dev');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    target: 'chrome120',
    platform: 'browser',
    logLevel: 'warning',
    legalComments: 'none',
  };
  await esbuild.build({
    ...common,
    entryPoints: { editor: path.join(root, 'src', 'webview', 'main.ts') },
    outdir: out,
    format: 'iife',
    loader: { '.ttf': 'file' },
    assetNames: '[name]',
    // vscode-oniguruma's Emscripten loader mentions Node modules it never loads in a browser.
    external: ['fs', 'path', 'crypto'],
  });
  await esbuild.build({
    ...common,
    entryPoints: { 'editor.worker': require.resolve('monaco-editor/esm/vs/editor/editor.worker.js') },
    outdir: out,
    format: 'iife',
  });
  fs.copyFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'), path.join(out, 'onig.wasm'));
  const size = f => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
  console.log(`webview: editor.js ${size('editor.js')}, editor.css ${size('editor.css')}, editor.worker.js ${size('editor.worker.js')}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

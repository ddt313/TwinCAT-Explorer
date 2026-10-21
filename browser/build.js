// Builds the browser extension (a spike, see browser/SPIKE.md) into browser/dist, the folder to load as an
// unpacked extension in Chrome or Edge: content.js, viewer.js, tree.js, popup.js and background.js bundled from
// browser/src with the platform-free core of the VS Code extension, beside the static files and the tree's icons
// (media/icons). Usage: node browser/build.js [--dev]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const here = __dirname;
const out = path.join(here, 'dist');
const dev = process.argv.includes('--dev');
const bundles = ['content', 'viewer', 'tree', 'popup', 'background'];

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: Object.fromEntries(bundles.map(b => [b, path.join(here, 'src', `${b}.ts`)])),
    outdir: out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  for (const f of fs.readdirSync(path.join(here, 'static'))) fs.copyFileSync(path.join(here, 'static', f), path.join(out, f));
  fs.copyFileSync(path.join(here, '..', 'media', 'icon.png'), path.join(out, 'icon.png'));
  fs.cpSync(path.join(here, '..', 'media', 'icons'), path.join(out, 'icons'), { recursive: true });
  // The core's decodeBytes and encodeText use Node's Buffer: no bundle may keep them.
  for (const b of bundles) {
    if (/\bBuffer\b/.test(fs.readFileSync(path.join(out, `${b}.js`), 'utf8'))) throw new Error(`${b}.js uses Node's Buffer`);
  }
  const size = f => `${f} ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
  console.log(`browser extension in ${path.relative(process.cwd(), out) || '.'}: ${bundles.map(b => size(`${b}.js`)).join(', ')}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

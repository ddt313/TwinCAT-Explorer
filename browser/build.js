// Builds the browser extension (a spike, see browser/SPIKE.md) into browser/dist, the folder to load as an
// unpacked extension in Chrome or Edge: content.js, viewer.js, tree.js, popup.js and background.js bundled from
// browser/src with the platform-free core of the VS Code extension, beside the static files and the tree's icons
// (media/icons). The same files with Firefox's manifest go to browser/dist-firefox (see firefoxManifest).
// Usage: node browser/build.js [--dev]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const here = __dirname;
const out = path.join(here, 'dist');
const outFirefox = path.join(here, 'dist-firefox');
const dev = process.argv.includes('--dev');
const bundles = ['content', 'viewer', 'tree', 'popup', 'background'];

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(outFirefox, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: Object.fromEntries(bundles.map(b => [b, path.join(here, 'src', `${b}.ts`)])),
    outdir: out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'firefox140'],
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
    legalComments: 'none',
    // The core's textHash uses Node's crypto, which the extension never calls: a stub, and no bundle may keep it.
    plugins: [{
      name: 'no-node-crypto',
      setup(build) {
        build.onResolve({ filter: /^crypto$/ }, () => ({ path: 'crypto', namespace: 'tcx-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'tcx-stub' }, () => ({ contents: 'export function createHash() { throw new Error("no crypto"); }', loader: 'js' }));
      },
    }],
  });
  for (const f of fs.readdirSync(path.join(here, 'static'))) fs.copyFileSync(path.join(here, 'static', f), path.join(out, f));
  fs.copyFileSync(path.join(here, '..', 'media', 'icon.png'), path.join(out, 'icon.png'));
  fs.cpSync(path.join(here, '..', 'media', 'icons'), path.join(out, 'icons'), { recursive: true });
  // The core's decodeBytes and encodeText use Node's Buffer, its textHash Node's crypto: no bundle may keep them.
  for (const b of bundles) {
    const code = fs.readFileSync(path.join(out, `${b}.js`), 'utf8');
    if (/\bBuffer\b/.test(code)) throw new Error(`${b}.js uses Node's Buffer`);
    if (code.includes('no crypto')) throw new Error(`${b}.js uses Node's crypto`);
  }
  fs.cpSync(out, outFirefox, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(outFirefox, 'manifest.json'), JSON.stringify(firefoxManifest(manifest), null, 2) + '\n');
  const size = f => `${f} ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
  console.log(`browser extension in ${path.relative(process.cwd(), out) || '.'} and ${path.relative(process.cwd(), outFirefox)}: ${bundles.map(b => size(`${b}.js`)).join(', ')}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

/**
 * Chrome's manifest made Firefox's: Firefox runs the background as an event page (`scripts`), not a service worker;
 * it needs an add-on ID of its own (its `key` is Chrome's) and, to be signed by addons.mozilla.org, says what data
 * the extension collects (none). 140, Firefox's ESR, is the first to know data_collection_permissions. No `alarms`:
 * addons.mozilla.org updates the extension, which never looks for a newer release there (src/updates.ts).
 */
function firefoxManifest(chrome) {
  const { key, background, permissions, ...rest } = chrome;
  return {
    ...rest,
    permissions: permissions.filter(p => p !== 'alarms'),
    background: { scripts: [background.service_worker] },
    browser_specific_settings: {
      gecko: {
        id: 'explorer-for-twincat@ddt313.github.io',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}

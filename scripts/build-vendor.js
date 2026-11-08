// Bundles the third-party code that modules of the desktop build require. tsc compiles src into out/src one module
// per file, and the .vsix has no node_modules (see .vscodeignore): a module that imports a package is written again
// over tsc's output, bundled with that package. Run after tsc. The browser build and the MCP server bundle these
// packages themselves. Usage: node scripts/build-vendor.js [--dev]
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const dev = process.argv.includes('--dev');

const modules = [
  // re2js: the linear-time regular expressions of the TwinCAT search.
  'src/lang/re2.ts',
];

(async () => {
  for (const m of modules) {
    await esbuild.build({
      entryPoints: [path.join(root, m)],
      outfile: path.join(root, 'out', m.replace(/\.ts$/, '.js')),
      bundle: true,
      minify: !dev,
      sourcemap: dev ? 'inline' : false,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      logLevel: 'warning',
      // The licenses are in ThirdPartyNotices.txt (scripts/third-party-notices.js).
      legalComments: 'none',
    });
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});

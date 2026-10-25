// Bundles the extension for the browser (vscode.dev, github.dev) into out/web/extension.js: src/web/extension.ts
// with the rest of the extension, Node's modules replaced by those of src/web (fs, crypto, child_process), and
// path by path-unified (Node's own, both win32 and posix). `process` and `Buffer` are injected; `__dirname`
// points into the folder that src/web/extension.ts mounts as the extension's.
// Usage: node scripts/build-web.js [--dev]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'src', 'web');
const outfile = path.join(root, 'out', 'web', 'extension.js');
const dev = process.argv.includes('--dev');

(async () => {
  await esbuild.build({
    entryPoints: [path.join(web, 'extension.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
    legalComments: 'none',
    external: ['vscode'],
    alias: {
      fs: path.join(web, 'fs.ts'),
      crypto: path.join(web, 'crypto.ts'),
      child_process: path.join(web, 'childProcess.ts'),
      path: 'path-unified',
    },
    inject: [path.join(web, 'process.ts'), path.join(web, 'buffer.ts')],
    define: { __dirname: JSON.stringify('/__twincat_explorer__/out/src/vscode') },
    // The MCP server runs in Node: its modules must not reach the browser bundle.
    plugins: [{
      name: 'no-node',
      setup(build) {
        build.onResolve({ filter: /^(node:|os$|net$|http$|https$|stream$|zlib$|worker_threads$|readline$)/ }, args => ({
          errors: [{ text: `${args.path} (imported by ${path.relative(root, args.importer)}) is not available in the browser` }],
        }));
      },
    }],
  });
  const kb = (fs.statSync(outfile).size / 1024).toFixed(0);
  console.log(`web: extension.js ${kb} KB`);
})().catch(e => {
  console.error(e.message ?? e);
  process.exit(1);
});

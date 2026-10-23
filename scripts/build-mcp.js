// Bundles the MCP server (src/mcp/server.ts with the MCP SDK and zod) into one file, out/mcp/server.js, so the
// .vsix needs no node_modules, and copies the source of its XAE bridge (compiled on the user's machine) to
// out/xae. Usage: node scripts/build-mcp.js [--dev]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out', 'mcp');
const dev = process.argv.includes('--dev');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: { server: path.join(root, 'src', 'mcp', 'server.ts') },
    outdir: out,
    bundle: true,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    logLevel: 'warning',
    legalComments: 'none',
  });
  fs.mkdirSync(path.join(root, 'out', 'xae'), { recursive: true });
  fs.copyFileSync(path.join(root, 'xae', 'XaeBridge.cs'), path.join(root, 'out', 'xae', 'XaeBridge.cs'));
  console.log(`mcp: server.js ${(fs.statSync(path.join(out, 'server.js')).size / 1024).toFixed(0)} KB`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

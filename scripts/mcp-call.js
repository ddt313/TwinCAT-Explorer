// Calls tools of the MCP server (out/mcp/server.js, npm run compile) on a TwinCAT folder, as an MCP client does, and
// prints their answers: to reproduce an issue of the server without an MCP client. Without XAE unless --xae.
// Usage: node scripts/mcp-call.js [--copy] [--xae] <folder> [<tool> [<json arguments>]]...
//   node scripts/mcp-call.js samples/Demo check read '{"object":"FB_Valve.Open"}'
//   node scripts/mcp-call.js --copy samples/Demo edit_section '{...}'   (on a copy in the temp folder: the folder is left as it is)
//   node scripts/mcp-call.js samples/Demo                                (the tools and their arguments)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const args = process.argv.slice(2);
const flag = name => args.includes(name) && args.splice(args.indexOf(name), 1).length > 0;
const copy = flag('--copy');
const xae = flag('--xae');
const [folder, ...rest] = args;
if (!folder) {
  console.error('Usage: node scripts/mcp-call.js [--copy] [--xae] <folder> [<tool> [<json arguments>]]...');
  process.exit(2);
}
const calls = [];
for (const a of rest) {
  if (a.trim().startsWith('{')) {
    if (!calls.length) throw new Error(`Arguments without a tool: ${a}`);
    calls[calls.length - 1].arguments = JSON.parse(a);
  } else {
    calls.push({ name: a, arguments: {} });
  }
}

async function main() {
  let root = path.resolve(folder);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-mcp-call-'));
  if (copy) {
    root = path.join(home, path.basename(root));
    fs.cpSync(path.resolve(folder), root, { recursive: true });
  }
  const server = path.join(__dirname, '..', 'out', 'mcp', 'server.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, '--root', root, ...(xae ? [] : ['--no-xae'])],
    // Without XAE, the undo log of these calls stays in the temp folder, apart from the user's own MCP client's. With
    // XAE, LOCALAPPDATA is left as it is: the XAE bridge compiled there is used again.
    env: xae ? process.env : { ...process.env, LOCALAPPDATA: home },
  });
  const client = new Client({ name: 'mcp-call', version: '1.0.0' });
  await client.connect(transport);
  try {
    if (!calls.length) {
      for (const t of (await client.listTools()).tools) {
        console.log(`${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(', ')})\n  ${t.description}`);
      }
      return;
    }
    for (const call of calls) {
      const r = await client.callTool(call);
      console.log(`--- ${call.name} ${JSON.stringify(call.arguments)}${r.isError ? ' (error)' : ''}`);
      console.log(r.content.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n'));
    }
  } finally {
    await client.close();
    if (copy) console.log(`--- the copy: ${root}`);
    else fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

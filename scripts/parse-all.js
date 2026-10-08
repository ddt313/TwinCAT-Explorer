// Parses every Structured Text section of a TwinCAT repository and prints the
// syntax errors with context. Usage: node scripts/parse-all.js [repoDir] [maxErrors]
const path = require('path');
const { TcWorkspace } = require('../out/src/core/workspace');
const { parseDeclaration, parseBody } = require('../out/src/lang/parser');
const { findFiles } = require('../out/test/unit/helpers');

const repo = process.argv[2] || '.';
const max = Number(process.argv[3] || 40);
const ws = new TcWorkspace();
ws.load(findFiles(repo, '.tsproj'));
let sections = 0;
let errors = 0;
const t0 = Date.now();
for (const e of ws.sourceEntries) {
  const f = ws.getFile(e.path);
  if (!f) continue;
  for (const s of f.sections.values()) {
    if (!s.editable) continue;
    sections++;
    const r = s.role === 'decl' ? parseDeclaration(s.text) : parseBody(s.text);
    for (const err of r.errors) {
      errors++;
      if (errors <= max) {
        const lineStart = s.text.lastIndexOf('\n', err.start - 1) + 1;
        const lineEnd = s.text.indexOf('\n', err.start);
        const line = s.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        console.log(`${path.basename(f.path)} ${s.owner.qualifiedName} [${s.label}] ${err.message}\n    ${line.trim()}\n    at col ${err.start - lineStart}`);
      }
    }
  }
}
console.log(`${sections} sections, ${errors} errors, ${Date.now() - t0} ms`);

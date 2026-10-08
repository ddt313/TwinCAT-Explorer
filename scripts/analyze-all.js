// Analyzes every Structured Text section of a TwinCAT repository and prints a
// summary of the problems (grouped by message) plus resolution statistics.
// Usage: node scripts/analyze-all.js [repoDir] [--list N] [--stubs file]
const fs = require('fs');
const path = require('path');
const { TcWorkspace } = require('../out/src/core/workspace');
const { LanguageIndex } = require('../out/src/lang/index');
const { analyze } = require('../out/src/lang/analyzer');
const { findFiles } = require('../out/test/unit/helpers');
const { BUNDLED_STUBS } = require('../out/src/lang/stubs');

const args = process.argv.slice(2);
const repo = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--list') || '.';
const listIdx = args.indexOf('--list');
const listN = listIdx >= 0 ? Number(args[listIdx + 1]) : 0;
const ws = new TcWorkspace();
ws.load(findFiles(repo, '.tsproj'));
const index = new LanguageIndex(ws);
index.setStubs(BUNDLED_STUBS);
const t0 = Date.now();
index.ensure();
const t1 = Date.now();
const byMessage = new Map();
let occ = 0;
let problems = 0;
const samples = [];
for (const ctx of index.allContexts()) {
  const text = index.sectionText(ctx.fileKey, ctx.sectionKey);
  const a = analyze(index, ctx, text);
  occ += a.occurrences.length;
  for (const p of a.problems) {
    problems++;
    const key = p.message;
    byMessage.set(key, (byMessage.get(key) || 0) + 1);
    if (samples.length < listN) {
      const ls = text.lastIndexOf('\n', p.start - 1) + 1;
      const le = text.indexOf('\n', p.start);
      samples.push(`${ctx.object.qualifiedName} [${ctx.label}] ${p.message}\n    ${text.slice(ls, le < 0 ? undefined : le).trim()}`);
    }
  }
}
const t2 = Date.now();
const sorted = [...byMessage.entries()].sort((a, b) => b[1] - a[1]);
for (const [m, c] of sorted) console.log(`${String(c).padStart(5)}  ${m}`);
if (samples.length) console.log('\n' + samples.join('\n'));
console.log(`\n${index.allContexts().length} sections, ${occ} resolved occurrences, ${problems} problems; index ${t1 - t0} ms, analysis ${t2 - t1} ms`);

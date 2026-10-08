// Counts identifiers that are neither resolved nor reported (silently unknown),
// grouped by name, to find gaps in name/member resolution.
// Usage: node scripts/coverage.js [repoDir] [top]
const { TcWorkspace } = require('../out/src/core/workspace');
const { LanguageIndex } = require('../out/src/lang/index');
const { analyze } = require('../out/src/lang/analyzer');
const { lex } = require('../out/src/lang/lexer');
const { RESERVED } = require('../out/src/lang/parser');
const { findFiles } = require('../out/test/unit/helpers');
const { BUNDLED_STUBS } = require('../out/src/lang/stubs');

const repo = process.argv[2] || '.';
const top = Number(process.argv[3] || 40);
const ws = new TcWorkspace();
ws.load(findFiles(repo, '.tsproj'));
const index = new LanguageIndex(ws);
index.setStubs(BUNDLED_STUBS);
const SKIP = new Set(['TRUE', 'FALSE', 'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL', 'FINAL', 'ABSTRACT', 'CONSTANT',
  'RETAIN', 'PERSISTENT', 'NON_RETAIN', 'STRING', 'WSTRING', 'S', 'R', 'REF', 'ACTION']);
let total = 0;
let resolved = 0;
const missing = new Map();
const examples = new Map();
for (const ctx of index.allContexts()) {
  const text = index.sectionText(ctx.fileKey, ctx.sectionKey);
  const a = analyze(index, ctx, text);
  const covered = new Set(a.occurrences.map(o => o.start));
  for (const p of a.problems) covered.add(p.start);
  for (const t of lex(text).tokens) {
    if (t.kind !== 0 /* Ident */ || RESERVED.has(t.upper) || SKIP.has(t.upper)) continue;
    total++;
    if (covered.has(t.start)) { resolved++; continue; }
    missing.set(t.text, (missing.get(t.text) || 0) + 1);
    if (!examples.has(t.text)) {
      const ls = text.lastIndexOf('\n', t.start - 1) + 1;
      const le = text.indexOf('\n', t.start);
      examples.set(t.text, `${ctx.object.qualifiedName} [${ctx.label}]: ${text.slice(ls, le < 0 ? undefined : le).trim()}`);
    }
  }
}
const sorted = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
for (const [name, c] of sorted) console.log(`${String(c).padStart(5)}  ${name.padEnd(30)} ${examples.get(name).slice(0, 140)}`);
console.log(`\n${resolved}/${total} identifiers resolved (${(100 * resolved / total).toFixed(2)}%), ${total - resolved} silent`);

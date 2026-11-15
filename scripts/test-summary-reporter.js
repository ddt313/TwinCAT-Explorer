// A reporter of node:test (npm run test:unit) beside `spec`: it prints nothing, and writes the results to the Summary
// of the GitHub Actions step (scripts/test-summary.js), when there is one.
const path = require('path');
const { appendSummary, summaryMarkdown } = require('./test-summary');

const repo = path.resolve(__dirname, '..');

/** The message of a failure (node:test wraps the error of the test in its own, `cause`), without Node's own frames. */
function message(error) {
  const e = error?.cause ?? error;
  if (!e) return '';
  return String(e.stack ?? e.message ?? e)
    .split('\n').filter(line => !/^\s+at .*\(?node:/.test(line)).join('\n')
    .split(repo + path.sep).join('');
}

function fileOf(file) {
  if (!file) return '';
  // out/test/unit/x.test.js: the source is test/unit/x.test.ts.
  return path.relative(repo, file).replace(/\\/g, '/').replace(/^out\//, '').replace(/\.js$/, '.ts');
}

module.exports = async function* summaryReporter(source) {
  const results = [];
  const problems = [];
  const start = Date.now();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { data } = event;
    if (data.details?.type === 'suite') continue;
    const ok = event.type === 'test:pass';
    // Only the top-level tests (subtests fold into theirs), and a failure at any level.
    if (data.nesting > 0 && ok) continue;
    // A test file that fails as a whole (it does not load, or exits early) comes as a test named after the file,
    // with no more than "test failed": what the file wrote is in the log of the step.
    const wholeFile = !!data.file && path.resolve(data.name) === path.resolve(data.file);
    if (!ok && wholeFile) problems.push(`${fileOf(data.file)} did not run to its end: see its output in the log of the step.`);
    results.push({
      name: wholeFile ? `${fileOf(data.file)} (the whole file)` : data.name, ok, ms: data.details?.duration_ms ?? 0, file: fileOf(data.file),
      error: ok ? undefined : wholeFile ? 'The file did not run to its end (an error when it loads, or a process that exits): see its output in the log of the step.' : message(data.details?.error),
    });
  }
  appendSummary(summaryMarkdown('Unit tests', results, { ms: Date.now() - start, byFile: true, problem: problems.join(' ') || undefined }));
};

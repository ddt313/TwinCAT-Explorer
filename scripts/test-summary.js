// The results of a test run as Markdown for the Summary tab of a GitHub Actions run ($GITHUB_STEP_SUMMARY): the
// counts, each failure with its message, then a table of the tests. Used by scripts/test-summary-reporter.js (the unit
// tests) and scripts/test-integration.js. Outside GitHub Actions it writes nothing, unless TWINCAT_TEST_SUMMARY names
// a file to write it to (to look at it locally).
const fs = require('fs');
const path = require('path');

/**
 * @typedef {{ name: string, ok: boolean, ms: number, file?: string, error?: string }} Result
 */

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
const time = ms => (ms >= 1000 ? seconds(ms) : `${Math.round(ms)} ms`);
// A code block that the message cannot end early.
const fence = text => {
  const ticks = '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks}\n${text}\n${ticks}`;
};
const MAX_ERROR = 4000;

/**
 * @param {string} title e.g. `Unit tests`
 * @param {Result[]} results
 * @param {{ ms?: number, problem?: string, byFile?: boolean }} options `problem`: why the run itself failed (VS Code
 *   did not start, a test file did not load); `byFile`: a table of the files first, the tests folded below it.
 */
function summaryMarkdown(title, results, options = {}) {
  const failed = results.filter(r => !r.ok);
  const passed = results.length - failed.length;
  const ok = failed.length === 0 && !options.problem && results.length > 0;
  const counts = [failed.length ? `${failed.length} failed` : '', `${passed} passed`].filter(Boolean).join(', ');
  const lines = [`## ${ok ? '✅' : '❌'} ${title}: ${counts}${options.ms === undefined ? '' : ` · ${seconds(options.ms)}`}`, ''];
  if (options.problem) lines.push(`> [!CAUTION]`, `> ${cell(options.problem)}`, '');
  if (results.length === 0) lines.push('No test ran.', '');

  if (failed.length) {
    lines.push('### Failed', '');
    for (const r of failed) {
      const error = (r.error ?? '').trim();
      lines.push(`<details><summary>✖ ${escapeHtml(r.name)}${r.file ? ` <sub>${escapeHtml(r.file)}</sub>` : ''}</summary>`, '');
      lines.push(fence(error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR)}\n…` : error || '(no message)'), '', '</details>', '');
    }
  }

  const testTable = list => [
    '| | Test | Time |', '|:-:|---|--:|',
    ...list.map(r => `| ${r.ok ? '✅' : '❌'} | ${cell(r.name)} | ${time(r.ms)} |`),
  ];
  if (options.byFile && results.length) {
    const files = new Map();
    for (const r of results) {
      const f = files.get(r.file ?? '') ?? { file: r.file ?? '', results: [] };
      f.results.push(r);
      files.set(f.file, f);
    }
    lines.push('| | File | Tests | Failed | Time |', '|:-:|---|--:|--:|--:|');
    for (const f of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      const bad = f.results.filter(r => !r.ok).length;
      const ms = f.results.reduce((n, r) => n + r.ms, 0);
      lines.push(`| ${bad ? '❌' : '✅'} | ${cell(f.file)} | ${f.results.length} | ${bad || ''} | ${time(ms)} |`);
    }
    lines.push('', `<details><summary>All ${results.length} tests</summary>`, '');
    for (const f of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`#### ${cell(f.file)}`, '', ...testTable(f.results), '');
    }
    lines.push('</details>', '');
  } else if (results.length) {
    lines.push(...testTable(results), '');
  }
  return lines.join('\n');
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Appends to the Summary of the GitHub Actions step (or TWINCAT_TEST_SUMMARY); does nothing without either. */
function appendSummary(markdown) {
  const target = process.env.TWINCAT_TEST_SUMMARY || process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.appendFileSync(target, `${markdown}\n`);
}

module.exports = { summaryMarkdown, appendSummary };

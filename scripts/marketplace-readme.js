// Writes the README the .vsix carries (the Marketplace's and the Extensions view's page): README.md without
// what concerns the browser extension, the lines from `<!-- browser-only:start -->` to
// `<!-- browser-only:end -->` and each line that ends with `<!-- browser-only -->` (an item of a list, which
// a block marker would split in two), so GitHub shows both extensions and the Marketplace only the VS Code one.
// `npm run package` runs it and passes the result to vsce with --readme-path.
// Usage: node scripts/marketplace-readme.js [out file, default out/README.marketplace.md]
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.resolve(root, process.argv[2] || 'out/README.marketplace.md');
const START = '<!-- browser-only:start -->';
const END = '<!-- browser-only:end -->';
const LINE = '<!-- browser-only -->';

const lines = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split(/\r?\n/);
const kept = [];
let start = 0;
lines.forEach((line, i) => {
  const marker = line.trim();
  if (marker === START) {
    if (start) throw new Error(`README.md:${i + 1}: ${START} inside the block opened on line ${start}`);
    start = i + 1;
  } else if (marker === END) {
    if (!start) throw new Error(`README.md:${i + 1}: ${END} without ${START}`);
    start = 0;
  } else if (!start && !line.trimEnd().endsWith(LINE)) {
    kept.push(line);
  }
});
if (start) throw new Error(`README.md:${start}: ${START} is never closed`);

// A removed block between two paragraphs leaves two blank lines: keep one.
const text = kept.join('\n').replace(/\n{3,}/g, '\n\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log(`${path.relative(root, out)}: ${lines.length - kept.length} lines of the browser extension left out`);

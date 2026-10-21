// Line diff of two texts (Myers' O(ND) algorithm, like git's default), for the inline diffs of the browser
// extension, and the changed middle of a line for the word highlight. Platform-free.

export type EditKind = 'same' | 'del' | 'add';

export interface Edit {
  kind: EditKind;
  /** Index of the line in the old lines (same, del). */
  a?: number;
  /** Index of the line in the new lines (same, add). */
  b?: number;
}

/**
 * The edits that turn `a` into `b`, in order; in each changed block the deleted lines come before the added
 * ones. A middle part that needs more than `maxCost` edits is replaced as a whole.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxCost = 1000): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: Edit[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', a: i, b: i });
  out.push(...groupBlocks(middle(a, b, start, endA, start, endB, maxCost)));
  for (let i = 0; i < a.length - endA; i++) out.push({ kind: 'same', a: endA + i, b: endB + i });
  return out;
}

/** Myers' greedy forward search on a[a0, a1) and b[b0, b1), with the furthest x of each diagonal kept per step. */
function middle(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, maxCost: number): Edit[] {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0) return replace(a0, a1, b0, b1);
  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d][k + d]: furthest x on diagonal k after step d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return replace(a0, a1, b0, b1);
  const reversed: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      reversed.push({ kind: 'same', a: a0 + x, b: b0 + y });
    }
    if (x === prevX) reversed.push({ kind: 'add', b: b0 + y - 1 });
    else reversed.push({ kind: 'del', a: a0 + x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    reversed.push({ kind: 'same', a: a0 + x, b: b0 + y });
  }
  return reversed.reverse();
}

function replace(a0: number, a1: number, b0: number, b1: number): Edit[] {
  const out: Edit[] = [];
  for (let i = a0; i < a1; i++) out.push({ kind: 'del', a: i });
  for (let i = b0; i < b1; i++) out.push({ kind: 'add', b: i });
  return out;
}

/** Puts the deleted lines of each run of changes before its added lines, as a unified diff shows them. */
function groupBlocks(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  let dels: Edit[] = [];
  let adds: Edit[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const e of edits) {
    if (e.kind === 'same') {
      flush();
      out.push(e);
    } else (e.kind === 'del' ? dels : adds).push(e);
  }
  flush();
  return out;
}

/** The changed middle of two versions of a line: `a.slice(start, endA)` became `b.slice(start, endB)`. */
export function lineChange(a: string, b: string): { start: number; endA: number; endB: number } {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let suffix = 0;
  while (suffix < max - start && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  return { start, endA: a.length - suffix, endB: b.length - suffix };
}

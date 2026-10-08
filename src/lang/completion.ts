// Helpers for completion that do not depend on the VS Code API.

/** Text of the expression before the dot that precedes `offset` (for `a.b[i]^.c.|`). */
export function expressionBeforeDot(text: string, offset: number): string | undefined {
  let p = offset;
  while (p > 0 && /\w/.test(text[p - 1])) p--;
  while (p > 0 && /[ \t]/.test(text[p - 1])) p--;
  if (text[p - 1] !== '.') return undefined;
  const end = p - 1;
  p = end;
  for (;;) {
    while (p > 0 && /\s/.test(text[p - 1])) p--;
    const c = text[p - 1];
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      while (p > 0) {
        const ch = text[p - 1];
        if (ch === c) depth++;
        else if (ch === open) {
          depth--;
          if (depth === 0) {
            p--;
            break;
          }
        }
        p--;
      }
      continue;
    }
    if (c === '^') {
      p--;
      continue;
    }
    if (c !== undefined && /\w/.test(c)) {
      while (p > 0 && /\w/.test(text[p - 1])) p--;
      let q = p;
      while (q > 0 && /\s/.test(text[q - 1])) q--;
      if (text[q - 1] === '.' && !(q >= 2 && text[q - 2] === '.')) {
        p = q - 1;
        continue;
      }
      break;
    }
    break;
  }
  const expr = text.slice(p, end).trim();
  return expr.length > 0 ? expr : undefined;
}

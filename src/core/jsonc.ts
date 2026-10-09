// JSON with comments and trailing commas, as used by VS Code themes and
// language configuration files.

/** Removes comments and trailing commas, keeping strings untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas: a comma followed only by white space before a closing bracket (strings are kept as is).
  let result = '';
  i = 0;
  const m = out.length;
  while (i < m) {
    const c = out[i];
    if (c === '"') {
      const start = i++;
      while (i < m && out[i] !== '"') i += out[i] === '\\' ? 2 : 1;
      result += out.slice(start, ++i);
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < m && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') {
        i++;
        continue;
      }
    }
    result += c;
    i++;
  }
  return result;
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)) as T;
}

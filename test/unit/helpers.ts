import * as fs from 'fs';
import * as path from 'path';

export function findFiles(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith('_') || e.name === '.git' || e.name === 'node_modules') continue;
      findFiles(path.join(dir, e.name), ext, out);
    } else if (e.name.toLowerCase().endsWith(ext.toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

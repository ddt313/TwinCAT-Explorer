// Path helpers that do not depend on the VS Code API.

import * as fs from 'fs';
import * as path from 'path';

/**
 * True when a workspace-relative path lies inside a folder whose name starts with a dot
 * (`.claude/worktrees/x/PLC/A.tsproj`, `.git/...`). Accepts both separators.
 */
export function isInHiddenFolder(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).slice(0, -1).some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/**
 * Full path of a program in the folders of a PATH value (`git.exe` for `git` on Windows), or undefined.
 * Only full folder paths count: an empty or relative entry is resolved against the current folder, which
 * could be a repository holding a file named like the program.
 */
export function findOnPath(name: string, pathValue = process.env.PATH ?? ''): string | undefined {
  const windows = process.platform === 'win32';
  const file = windows ? `${name}.exe` : name;
  for (const entry of pathValue.split(path.delimiter)) {
    // Windows allows quoted entries ("C:\Program Files\Git\cmd").
    const dir = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    // On Windows `\Git\cmd` follows the drive of the current folder and `C:Git` its folder on that drive.
    if (!(windows ? /^([a-z]:[\\/]|[\\/]{2})/i.test(dir) : dir.startsWith('/'))) continue;
    const candidate = path.join(dir, file);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not there, or not executable
    }
  }
  return undefined;
}

// Path helpers that do not depend on the VS Code API.

/**
 * True when a workspace-relative path lies inside a folder whose name starts with a dot
 * (`.claude/worktrees/x/PLC/A.tsproj`, `.git/...`). Accepts both separators.
 */
export function isInHiddenFolder(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).slice(0, -1).some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

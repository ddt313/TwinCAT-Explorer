// The `process` global of the browser build (injected by scripts/build-web.js into the modules that use it).
// The platform follows VS Code's own guess in the browser (vs/base/common/platform.ts): on Windows the
// fsPath of every URI has backslashes, so paths are handled the Windows way there, as on the desktop.

const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';

export const process = {
  platform: userAgent.includes('Windows') ? 'win32' : 'linux',
  env: {} as Record<string, string | undefined>,
  cwd: () => '/',
  argv: [] as string[],
  versions: {} as Record<string, string>,
};

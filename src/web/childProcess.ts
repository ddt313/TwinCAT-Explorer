// `child_process` in the browser: no program runs there (git, the MCP server's setup).

const unavailable = () => Object.assign(new Error('Programs cannot run in the browser'), { code: 'ENOENT' });

export function execFile(...args: unknown[]): void {
  const callback = args.find(a => typeof a === 'function') as ((err: Error, stdout: string, stderr: string) => void) | undefined;
  setTimeout(() => callback?.(unavailable(), '', ''), 0);
}

export function execFileSync(): never {
  throw unavailable();
}

export function spawnSync(): never {
  throw unavailable();
}

export function spawn(): never {
  throw unavailable();
}

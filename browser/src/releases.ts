// Platform-free: the browser extension's releases on GitHub (tags `browser-v0.2.1`, each a zip), among the VS Code
// extension's (`v0.16.1`) in the same repository, and whether one is newer than the version installed.

export const RELEASES_API = 'https://api.github.com/repos/ddt313/TwinCAT-Explorer/releases?per_page=100';

/** A release of the browser extension: its version and its page on GitHub (the zip and how to install it). */
export interface BrowserRelease {
  version: string;
  url: string;
}

/** The parts of a version (`0.2.1` → [0, 2, 1]), or undefined when it is not one. */
function parts(version: string): number[] | undefined {
  return /^\d+(\.\d+){0,3}$/.test(version) ? version.split('.').map(Number) : undefined;
}

/** Whether version a is newer than b (`0.10.0` than `0.9.3`; `0.2` is `0.2.0`). */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * The newest release of the browser extension in GitHub's list of the repository's releases: drafts, pre-releases
 * (`browser-v0.2.0-beta.1`) and the VS Code extension's left out.
 */
export function latestBrowserRelease(releases: unknown): BrowserRelease | undefined {
  if (!Array.isArray(releases)) return undefined;
  let latest: BrowserRelease | undefined;
  for (const r of releases as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }[]) {
    if (r?.draft || r?.prerelease || typeof r?.tag_name !== 'string' || typeof r.html_url !== 'string') continue;
    const version = /^browser-v(\d+\.\d+\.\d+)$/.exec(r.tag_name)?.[1];
    if (version && (!latest || isNewer(version, latest.version))) latest = { version, url: r.html_url };
  }
  return latest;
}

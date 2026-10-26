// Chrome and Edge load the extension unpacked, from a release's zip, so the browser never updates it: once a day at
// most (the browser started, the extension installed or reloaded, the popup opened, an hourly alarm) it looks on
// GitHub for a newer release. A newer one puts a badge on the extension's icon, until the popup that tells of it is
// opened. Turned off from the popup; when GitHub cannot be reached (offline, a network that blocks it, its rate
// limit), nothing shows and it is looked for again an hour later. Firefox installs it from addons.mozilla.org, which
// updates it: there it never looks.

import { BrowserRelease, RELEASES_API, isNewer, latestBrowserRelease } from './releases';

/** What the last look found: when, GitHub's ETag of the list (a 304 does not count against its rate limit), the newest release. */
const STATE_KEY = 'tcxUpdate';
/** The version whose badge the popup took off. */
const SEEN_KEY = 'tcxUpdateSeen';
/** False when the user turned the looks off. */
const ON_KEY = 'tcxUpdateCheck';
export const UPDATE_ALARM = 'tcxUpdate';
/** Firefox, where addons.mozilla.org updates the extension (its manifest has no `alarms` permission). */
export const UPDATED_BY_STORE = chrome.runtime.getURL('').startsWith('moz-extension:');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface State {
  checkedAt: number;
  etag?: string;
  latest?: BrowserRelease;
}

export async function checksForUpdates(): Promise<boolean> {
  if (UPDATED_BY_STORE) return false;
  return (await chrome.storage.local.get(ON_KEY))[ON_KEY] !== false;
}

export async function setChecksForUpdates(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [ON_KEY]: on });
  if (!on) await showBadge(undefined);
}

let looking: Promise<BrowserRelease | undefined> | undefined;

/** The release newer than the version installed, looked for on GitHub when the last look is a day old. */
export function checkForUpdate(): Promise<BrowserRelease | undefined> {
  // The browser started and the extension installed come together: one look for both.
  looking ??= look().finally(() => {
    looking = undefined;
  });
  return looking;
}

async function look(): Promise<BrowserRelease | undefined> {
  if (!(await checksForUpdates())) return undefined;
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as State | undefined;
  let state: State = stored && typeof stored.checkedAt === 'number' ? stored : { checkedAt: 0 };
  if (Date.now() - state.checkedAt >= DAY) {
    // A look that failed (offline, a network that blocks GitHub, its rate limit) is tried again in an hour.
    const failed: State = { ...state, checkedAt: Date.now() - DAY + HOUR };
    try {
      const response = await fetch(RELEASES_API, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', ...(state.etag ? { 'If-None-Match': state.etag } : {}) },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        state = { checkedAt: Date.now(), etag: response.headers.get('etag') ?? undefined, latest: latestBrowserRelease(await response.json()) };
      } else {
        state = response.status === 304 ? { ...state, checkedAt: Date.now() } : failed;
      }
    } catch {
      state = failed;
    }
    await chrome.storage.local.set({ [STATE_KEY]: state });
  }
  const newer = state.latest && isNewer(state.latest.version, chrome.runtime.getManifest().version) ? state.latest : undefined;
  await showBadge(newer);
  return newer;
}

/** The badge on the extension's icon for a newer release, until the popup told of it. */
async function showBadge(newer: BrowserRelease | undefined): Promise<void> {
  const seen = (await chrome.storage.local.get(SEEN_KEY))[SEEN_KEY];
  const on = newer !== undefined && seen !== newer.version;
  await chrome.action.setBadgeText({ text: on ? 'NEW' : '' });
  if (on) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
    await chrome.action.setTitle({ title: `Explorer for TwinCAT: version ${newer.version} is out` });
  } else {
    await chrome.action.setTitle({ title: 'Explorer for TwinCAT' });
  }
}

/** The popup told of a newer release: its badge goes. */
export async function markSeen(release: BrowserRelease): Promise<void> {
  await chrome.storage.local.set({ [SEEN_KEY]: release.version });
  await showBadge(release);
}

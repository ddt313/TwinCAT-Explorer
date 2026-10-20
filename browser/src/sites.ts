// The sites the extension works on: github.com and gitlab.com always (the manifest's host permissions), and the
// sites the user lets it read at run time (its optional host permissions: self-managed GitLab instances), granted
// from its popup or from the browser's own settings of the extension. The browser's permissions are the list: the
// service worker keeps the content script registered on those sites.

export const BUILT_IN_SITES = ['https://github.com', 'https://gitlab.com'];
const SCRIPT_ID = 'tcx-sites';

/** The match patterns the user granted, beyond the manifest's (`https://gitlab.example.com/*`). */
export async function grantedPatterns(): Promise<string[]> {
  const fixed = new Set(chrome.runtime.getManifest().host_permissions ?? []);
  const { origins = [] } = await chrome.permissions.getAll();
  return origins.filter(o => !fixed.has(o));
}

/** Whether the extension works on the pages of an origin (`https://gitlab.example.com`). */
export async function isKnownSite(origin: string): Promise<boolean> {
  if (BUILT_IN_SITES.includes(origin)) return true;
  if (!/^https?:\/\/[^/?#*]+$/.test(origin)) return false;
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

/** Starts the content script in a tab of a granted site, unless it runs there already: true when it started it. */
export async function startInTab(tabId: number): Promise<boolean> {
  const target = { tabId };
  const [probe] = await chrome.scripting.executeScript({ target, func: () => (globalThis as { tcxContent?: boolean }).tcxContent === true });
  if (probe?.result) return false;
  await chrome.scripting.insertCSS({ target, files: ['content.css'] });
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  return true;
}

/** Registers the content script on the granted sites, or updates or removes its registration, as they are now. */
export async function syncContentScripts(): Promise<void> {
  const matches = await grantedPatterns();
  const registered = (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id);
  // Registrations of earlier versions (one per site), and this one once no site is left.
  const stale = registered.filter(id => id.startsWith('tcx-') && (id !== SCRIPT_ID || matches.length === 0));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  if (matches.length === 0) return;
  const script = { id: SCRIPT_ID, matches, js: ['content.js'], css: ['content.css'], runAt: 'document_idle' as const };
  if (registered.includes(SCRIPT_ID)) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

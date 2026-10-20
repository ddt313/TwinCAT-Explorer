// The sites the extension works on: github.com and gitlab.com always, and the self-managed GitLab instances the user
// turned it on for (their origins in chrome.storage, each with the content script registered for it at run time,
// under a host permission asked for then).

const KEY = 'tcxSites';
export const BUILT_IN_SITES = ['https://github.com', 'https://gitlab.com'];

export async function enabledSites(): Promise<string[]> {
  try {
    const v = (await chrome.storage.local.get(KEY))[KEY];
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function isKnownSite(origin: string): Promise<boolean> {
  return BUILT_IN_SITES.includes(origin) || (await enabledSites()).includes(origin);
}

const scriptId = (origin: string) => `tcx-${origin.replace(/[^a-z0-9]/gi, '_')}`;

/** Registers the content script of each enabled site that has none (after an install, an update, a restart). */
export async function syncContentScripts(): Promise<void> {
  const sites = await enabledSites();
  const registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map(s => s.id));
  const missing = sites.filter(o => !registered.has(scriptId(o)));
  if (missing.length === 0) return;
  await chrome.scripting.registerContentScripts(missing.map(o => ({
    id: scriptId(o), matches: [`${o}/*`], js: ['content.js'], css: ['content.css'], runAt: 'document_idle' as const,
  })));
}

/** Turns the extension on for a site: its host permission (asked in the click that calls this), its content script. */
export async function enableSite(origin: string): Promise<boolean> {
  // First, while the click still counts: the browser asks the user.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return false;
  const sites = await enabledSites();
  if (!sites.includes(origin)) await chrome.storage.local.set({ [KEY]: [...sites, origin] });
  await syncContentScripts();
  return true;
}

export async function disableSite(origin: string): Promise<void> {
  await chrome.storage.local.set({ [KEY]: (await enabledSites()).filter(o => o !== origin) });
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] });
  } catch {
    // It was not registered.
  }
  await chrome.permissions.remove({ origins: [`${origin}/*`] });
}

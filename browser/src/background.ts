// Service worker: fetches a file for a frame with the user's session (the extension has host permissions for the
// sites it works on, so its requests carry their cookies), one of the ways the frames try; and keeps the content
// script registered on the sites the user granted, starting it at once in the tab a site was turned on in.

import { fetchText } from './fetchText';
import { WorkerRequest, fetchAllowed } from './protocol';
import { BUILT_IN_SITES, isKnownSite, syncContentScripts } from './sites';

const warn = (e: unknown) => console.warn('[TwinCAT view]', e);

async function allowed(url: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return fetchAllowed(url, (await isKnownSite(origin)) ? [origin] : []);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as WorkerRequest;
  if (m?.tcx !== 'fetch' || sender.id !== chrome.runtime.id) return false;
  void allowed(m.url)
    .then(ok => (ok ? fetchText(m.url, 'include') : { ok: false, status: 0, error: 'not a site of the extension' }))
    .then(sendResponse);
  return true;
});

/**
 * The tab the user turned a site on in works at once, without a reload. (The popup that asked may be gone by then:
 * the browser can close it while it asks.)
 */
async function startInActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // The tab's URL shows only when the extension may read the page.
  if (tab?.id === undefined || !tab.url) return;
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  if (BUILT_IN_SITES.includes(origin) || !(await isKnownSite(origin))) return;
  const target = { tabId: tab.id };
  const [probe] = await chrome.scripting.executeScript({ target, func: () => (globalThis as { tcxContent?: boolean }).tcxContent === true });
  if (probe?.result) return;
  await chrome.scripting.insertCSS({ target, files: ['content.css'] });
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
}

const sync = () => void syncContentScripts().catch(warn);
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener(() => void syncContentScripts().then(startInActiveTab).catch(warn));
chrome.permissions.onRemoved.addListener(sync);

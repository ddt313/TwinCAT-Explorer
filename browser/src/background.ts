// Service worker: fetches a file for a frame with the user's session (the extension has host permissions for the
// sites it works on, so its requests carry their cookies), one of the ways the frames try; and keeps the content
// script registered on the self-managed GitLab instances the user turned the extension on for.

import { fetchText } from './fetchText';
import { WorkerRequest, fetchAllowed } from './protocol';
import { enabledSites, syncContentScripts } from './sites';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as WorkerRequest;
  if (m?.tcx !== 'fetch' || sender.id !== chrome.runtime.id) return false;
  void enabledSites()
    .then(sites => (fetchAllowed(m.url, sites) ? fetchText(m.url, 'include') : { ok: false, status: 0, error: 'not a site of the extension' }))
    .then(sendResponse);
  return true;
});

const sync = () => void syncContentScripts().catch(e => console.warn('[TwinCAT view] content scripts:', e));
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);

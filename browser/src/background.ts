// Service worker: fetches a file for a viewer frame with the user's github.com session (the extension has host
// permissions for GitHub, so its requests carry the github.com cookies), one of the ways the spike tries.

import { fetchText } from './fetchText';
import { WorkerRequest, fetchAllowed } from './protocol';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as WorkerRequest;
  if (m?.tcx !== 'fetch' || sender.id !== chrome.runtime.id || !fetchAllowed(m.url)) return false;
  void fetchText(m.url, 'include').then(sendResponse);
  return true;
});

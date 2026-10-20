// The extension's popup: on a self-managed GitLab instance, turns the extension on or off for that site. On asks
// the browser for the permission to read the site; the service worker does the rest (the browser may close the popup
// while it asks), and the popup does it again whenever it opens on a site turned on: the content script registered
// there, and running in the tab. github.com and gitlab.com need nothing.

import { BUILT_IN_SITES, grantedPatterns, isKnownSite, startInTab, syncContentScripts } from './sites';

const root = document.getElementById('root')!;
document.getElementById('version')!.textContent = chrome.runtime.getManifest().version;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const problem = (e: unknown) => esc(e instanceof Error ? e.message : String(e));

async function render(note = ''): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin: string | undefined;
  try {
    origin = tab?.url ? new URL(tab.url).origin : undefined;
  } catch {
    origin = undefined;
  }
  let notes = note ? `<p class="muted">${note}</p>` : '';
  try {
    await syncContentScripts();
  } catch (e) {
    notes += `<p class="muted">The content script could not be registered: ${problem(e)}</p>`;
  }
  const patterns = await grantedPatterns();
  const others = patterns.length ? `<p class="muted">On for: ${patterns.map(p => `<code>${esc(p.replace(/\/\*$/, ''))}</code>`).join(', ')}</p>` : '';
  if (!origin || !/^https?:\/\//.test(origin)) {
    root.innerHTML = `<p>Open a GitHub pull request or a GitLab merge request, at its changes.</p>${notes}${others}`;
    return;
  }
  if (BUILT_IN_SITES.includes(origin)) {
    root.innerHTML = `<p>On for <code>${esc(origin)}</code>: open a pull or merge request's changes, and use the
      <b>TwinCAT view</b> toggles and the <b>TwinCAT</b> tab.</p>${notes}${others}`;
    return;
  }
  const on = await isKnownSite(origin);
  let state = on ? 'TwinCAT files of its merge requests show as objects.' : 'For a self-managed GitLab: the browser asks to let the extension read this site.';
  if (on && tab?.id !== undefined) {
    // A page opened before the site was turned on, or a turn-on the service worker did not finish.
    try {
      state = (await startInTab(tab.id)) ? 'Started in this tab.' : 'Running in this tab.';
    } catch (e) {
      state = `Could not start in this tab: ${problem(e)}`;
    }
  }
  root.innerHTML = `<p>${on ? 'On' : 'Off'} for <code>${esc(origin)}</code>.</p>
    <p class="muted">${state}</p>
    <button type="button">${on ? 'Turn off for this site' : 'Turn on for this site'}</button>${notes}${others}`;
  root.querySelector('button')!.addEventListener('click', () => {
    const origins = [`${origin}/*`];
    // In the click itself, which lets the browser ask the user.
    const change: Promise<string> = on
      ? chrome.permissions.remove({ origins }).then(async () => {
        // The page's toggles and tab go with a reload.
        if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
        return '';
      })
      : chrome.permissions.request({ origins }).then(granted => (granted ? '' : 'The browser did not allow it.'));
    void change.then(render, e => render(`It did not work: ${problem(e)}`));
  });
}

void render().catch(e => {
  root.innerHTML = `<p class="muted">${problem(e)}</p>`;
});

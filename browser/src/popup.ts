// The extension's popup: on a self-managed GitLab instance, turns the extension on or off for that site. On asks
// the browser for the permission to read the site; the service worker does the rest (the browser may close the popup
// while it asks). github.com and gitlab.com need nothing.

import { BUILT_IN_SITES, grantedPatterns, isKnownSite } from './sites';

const root = document.getElementById('root')!;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin: string | undefined;
  try {
    origin = tab?.url ? new URL(tab.url).origin : undefined;
  } catch {
    origin = undefined;
  }
  const patterns = await grantedPatterns();
  const others = patterns.length ? `<p class="muted">On for: ${patterns.map(p => `<code>${esc(p.replace(/\/\*$/, ''))}</code>`).join(', ')}</p>` : '';
  if (!origin || !/^https?:\/\//.test(origin)) {
    root.innerHTML = `<p>Open a GitHub pull request or a GitLab merge request, at its changes.</p>${others}`;
    return;
  }
  if (BUILT_IN_SITES.includes(origin)) {
    root.innerHTML = `<p>On for <code>${esc(origin)}</code>: open a pull or merge request's changes, and use the
      <b>TwinCAT view</b> toggles and the <b>TwinCAT</b> tab.</p>${others}`;
    return;
  }
  const on = await isKnownSite(origin);
  root.innerHTML = `<p>${on ? 'On' : 'Off'} for <code>${esc(origin)}</code>.</p>
    <p class="muted">${on ? 'TwinCAT files of its merge requests show as objects.' : 'For a self-managed GitLab: the browser asks to let the extension read this site.'}</p>
    <button type="button">${on ? 'Turn off for this site' : 'Turn on for this site'}</button>${others}`;
  root.querySelector('button')!.addEventListener('click', () => {
    const origins = [`${origin}/*`];
    // In the click itself, which lets the browser ask the user.
    const change = on
      ? chrome.permissions.remove({ origins }).then(async () => {
        // The page's toggles and tab go with a reload.
        if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
      })
      : chrome.permissions.request({ origins });
    void change.then(render, e => root.insertAdjacentHTML('beforeend', `<p class="muted">${esc(String(e))}</p>`));
  });
}

void render();

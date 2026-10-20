// The extension's popup: on a self-managed GitLab instance, turns the extension on or off for that site (the
// browser asks for the permission to read it). github.com and gitlab.com need nothing.

import { BUILT_IN_SITES, disableSite, enableSite, enabledSites } from './sites';

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
  const sites = await enabledSites();
  const others = sites.length ? `<p class="muted">On for: ${sites.map(s => `<code>${esc(s)}</code>`).join(', ')}</p>` : '';
  if (!origin || !/^https?:\/\//.test(origin)) {
    root.innerHTML = `<p>Open a GitHub pull request or a GitLab merge request, at its changes.</p>${others}`;
    return;
  }
  if (BUILT_IN_SITES.includes(origin)) {
    root.innerHTML = `<p>On for <code>${esc(origin)}</code>: open a pull or merge request's changes, and use the
      <b>TwinCAT view</b> toggles and the <b>TwinCAT</b> tab.</p>${others}`;
    return;
  }
  const on = sites.includes(origin);
  root.innerHTML = `<p>${on ? 'On' : 'Off'} for <code>${esc(origin)}</code>.</p>
    <p class="muted">${on ? 'TwinCAT files of its merge requests show as objects.' : 'For a self-managed GitLab: the browser asks to let the extension read this site.'}</p>
    <button type="button">${on ? 'Turn off for this site' : 'Turn on for this site'}</button>${others}`;
  root.querySelector('button')!.addEventListener('click', () => {
    // enableSite asks for the permission first, while this click still counts.
    void (on ? disableSite(origin!).then(() => true) : enableSite(origin!)).then(async changed => {
      if (changed && tab?.id !== undefined) await chrome.tabs.reload(tab.id);
      await render();
    });
  });
}

void render();

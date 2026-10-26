// The extension's popup: on a self-managed GitLab instance, turns the extension on or off for that site. On asks
// the browser for the permission to read the site; the service worker does the rest (the browser may close the popup
// while it asks), and the popup does it again whenever it opens on a site turned on: the content script registered
// there, and running in the tab. github.com, gitlab.com and bitbucket.org need nothing. On any site it works on, it sets whether
// the extension adds its toggles and tab to the review pages on its own, or only once started in a tab from here
// (without a reload); on a built-in site whose permission the user took back (Firefox lets them), allows it again. On
// top, a newer release of the extension, when GitHub has one (updates.ts).

import { BUILT_IN_SITES, grantedPatterns, isKnownSite, runsInTab, setStartsOnItsOwn, startInTab, startsOnItsOwn, syncContentScripts } from './sites';
import { UPDATED_BY_STORE, checkForUpdate, checksForUpdates, markSeen, setChecksForUpdates } from './updates';

const root = document.getElementById('root')!;
document.getElementById('version')!.textContent = chrome.runtime.getManifest().version;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const problem = (e: unknown) => esc(e instanceof Error ? e.message : String(e));

/** On its own or by hand, on a site the extension works on; by hand, how to start it in this tab. */
async function startHtml(origin: string, tabId: number | undefined): Promise<string> {
  const auto = await startsOnItsOwn(origin);
  const running = tabId !== undefined && await runsInTab(tabId).catch(() => false);
  const here = auto ? '' : running
    ? '<p class="muted">Started in this tab: it goes with a reload of the page.</p>'
    : '<button type="button" class="start">Start in this tab</button><p class="muted">The toggles and the TwinCAT tab come without a reload.</p>';
  return `<label class="auto"><input type="checkbox"${auto ? ' checked' : ''}> Add the toggles and the TwinCAT tab to its review pages on its own</label>${here}`;
}

function bindStart(origin: string, tabId: number | undefined): void {
  const start = async (): Promise<string> => {
    if (tabId === undefined) return '';
    await startInTab(tabId, true);
    return '';
  };
  root.querySelector<HTMLInputElement>('.auto input')?.addEventListener('change', e => {
    const on = (e.target as HTMLInputElement).checked;
    // On: in this tab too, at once. Off: the page keeps what it shows until it is reloaded.
    void setStartsOnItsOwn(origin, on).then(() => (on ? start() : 'The toggles stay in the pages open now, until they are reloaded.'))
      .then(render, err => render(`It did not work: ${problem(err)}`));
  });
  root.querySelector('button.start')?.addEventListener('click', () => {
    void start().then(render, err => render(`It did not work: ${problem(err)}`));
  });
}

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
    root.innerHTML = `<p>Open a GitHub or Bitbucket pull request or a GitLab merge request, at its changes.</p>${notes}${others}`;
    return;
  }
  if (BUILT_IN_SITES.includes(origin)) {
    // Firefox lets the user take the manifest's host permissions back (Chrome's "on click" site access too).
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      root.innerHTML = `<p>Off for <code>${esc(origin)}</code>: the browser does not let the extension read this site.</p>
        <button type="button" class="site">Allow this site</button>${notes}${others}`;
      root.querySelector('button.site')!.addEventListener('click', () => {
        // In the click itself, which lets the browser ask the user; then the page needs a reload.
        void chrome.permissions.request({ origins: [`${origin}/*`] })
          .then(async granted => {
            if (granted && tab?.id !== undefined) await chrome.tabs.reload(tab.id);
            return granted ? '' : 'The browser did not allow it.';
          })
          .then(render, e => render(`It did not work: ${problem(e)}`));
      });
      return;
    }
    root.innerHTML = `<p>On for <code>${esc(origin)}</code>: open a pull or merge request's changes, and use the
      <b>TwinCAT view</b> toggles and the <b>TwinCAT</b> tab.</p>${await startHtml(origin, tab?.id)}${notes}${others}`;
    bindStart(origin, tab?.id);
    return;
  }
  const on = await isKnownSite(origin);
  let state = on ? 'TwinCAT files of its merge requests show as objects.' : 'For a self-managed GitLab: the browser asks to let the extension read this site.';
  if (on && tab?.id !== undefined && await startsOnItsOwn(origin)) {
    // A page opened before the site was turned on, or a turn-on the service worker did not finish.
    try {
      state = (await startInTab(tab.id)) ? 'Started in this tab.' : 'Running in this tab.';
    } catch (e) {
      state = `Could not start in this tab: ${problem(e)}`;
    }
  }
  root.innerHTML = `<p>${on ? 'On' : 'Off'} for <code>${esc(origin)}</code>.</p>
    <p class="muted">${state}</p>
    <button type="button" class="site">${on ? 'Turn off for this site' : 'Turn on for this site'}</button>${on ? await startHtml(origin, tab?.id) : ''}${notes}${others}`;
  if (on) bindStart(origin, tab?.id);
  root.querySelector('button.site')!.addEventListener('click', () => {
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

/** A newer release: where to get it, and how an unpacked extension is updated. */
async function renderUpdate(): Promise<void> {
  const box = document.getElementById('update')!;
  const newer = await checkForUpdate();
  if (!newer) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<p><b>Version ${esc(newer.version)} is out.</b> <a href="${esc(newer.url)}" target="_blank" rel="noopener">Download it</a></p>
    <p class="muted">Unzip it over this extension's folder, then click <b>Reload</b> on the extension in the browser's
    Extensions page: the sites turned on stay on.</p>`;
  await markSeen(newer);
}

// Firefox: addons.mozilla.org updates the extension.
if (UPDATED_BY_STORE) document.querySelector('footer')!.remove();
const updates = document.getElementById('updates') as HTMLInputElement;
void checksForUpdates().then(on => {
  updates.checked = on;
});
updates.addEventListener('change', () => {
  void setChecksForUpdates(updates.checked).then(() => renderUpdate()).catch(() => undefined);
});
void renderUpdate().catch(() => undefined);

void render().catch(e => {
  root.innerHTML = `<p class="muted">${problem(e)}</p>`;
});

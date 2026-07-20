// Shadman's API Recorder — background service worker.
// Holds the recording session (which tab, collected steps) in chrome.storage.session
// so it survives service-worker sleep, and uploads finished recordings to the platform.

async function getState() {
  const d = await chrome.storage.session.get('rec');
  return d.rec || { recording: false, tabId: null, steps: [] };
}
async function setState(rec) { await chrome.storage.session.set({ rec }); }

function badge(n) {
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// Many sites (Daraz, Rokomari, etc.) require a logged-in session for real actions like Add to
// Cart or Buy Now. The recording ran in the user's own logged-in browser, so we carry that
// session over: grab cookies for every site visited, in Puppeteer's page.setCookie() shape.
//
// Marketplace brands are very often white-labels of a larger group (Daraz is Lazada, itself
// Alibaba-owned) and their real login session can live on a shared cross-brand domain — one you
// never navigate to directly, so querying only the recorded hostnames can miss the one cookie
// that actually proves you're logged in (confirmed: Daraz sets lzd_*/cna/cbc/_tb_token_-style
// cookies, some scoped to alibaba.com, not daraz.com.bd). Rather than enumerate every possible
// sibling domain, read the whole cookie jar once (the extension's <all_urls>+cookies permission
// already grants this) and keep anything whose registrable domain plausibly relates to a site we
// visited — filtering happens entirely in-memory before anything is ever sent to the server.
function registrableDomains(hostname) {
  const parts = hostname.split('.');
  const out = new Set([hostname]);
  for (let n = 2; n <= Math.min(4, parts.length); n++) out.add(parts.slice(-n).join('.'));
  return out;
}

// Third-party identity providers a login popup might briefly pass through (Google, Facebook,
// Apple...) — their OWN session cookies (a full separate account login, not the site's) must
// never be swept up just because the recording visited them mid-OAuth-handshake. We only want
// whatever first-party cookie the SITE set once the handshake completed.
//
// Matched by WHOLE dot-separated label, not domain suffix — Google alone serves accounts.google.com
// AND dozens of country variants (google.com.bd, google.co.uk, google.de...) that are each their
// OWN registrable domain, not a subdomain of google.com, so a suffix check misses them entirely.
const IDENTITY_PROVIDER_LABELS = ['google', 'facebook', 'apple', 'microsoft', 'microsoftonline'];
const isIdentityProviderHost = (h) => h.toLowerCase().split('.').some(label => IDENTITY_PROVIDER_LABELS.includes(label));

async function collectSessionCookies(steps) {
  const roots = new Set();
  for (const s of steps) {
    if (s.type !== 'navigate' || !s.url) continue;
    try {
      const h = new URL(s.url).hostname;
      if (isIdentityProviderHost(h)) continue;
      // The real "brand root" is usually the label right before the TLD suffix (e.g. "daraz" in
      // www.daraz.com.bd) — match cookie domains containing that word, which catches sibling
      // group domains too when they share the brand name, and always keep the exact visited
      // hostname's own registrable-domain variants as a baseline.
      for (const d of registrableDomains(h)) roots.add(d);
      const labels = h.split('.').filter(l => l.length > 2 && !['www', 'com', 'net', 'org', 'co'].includes(l));
      if (labels.length) roots.add(labels[0]); // e.g. "daraz" — used as a substring match below
    } catch (_) {}
  }
  // Known cross-brand parents for common regional marketplaces — extend as new sites come up.
  ['lazada.com', 'alibaba.com', 'aliexpress.com'].forEach(d => roots.add(d));

  let all;
  try { all = await chrome.cookies.getAll({}); } catch (_) { all = []; }
  const rootList = [...roots];
  const relevant = all.filter(c => {
    const d = c.domain.replace(/^\./, '');
    if (isIdentityProviderHost(d)) return false;
    return rootList.some(r => d === r || d.endsWith('.' + r) || (r.length > 3 && d.includes(r)));
  });

  const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
  const seen = new Map();
  for (const c of relevant) {
    const out = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly };
    if (!c.session && c.expirationDate) out.expires = c.expirationDate;
    const ss = sameSiteMap[c.sameSite];
    if (ss) out.sameSite = ss;
    seen.set(c.domain + '|' + c.path + '|' + c.name, out);
  }
  return [...seen.values()];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const st = await getState();

    if (msg.kind === 'getState') {
      // Content scripts ask on every page load whether their tab is the one being recorded
      sendResponse({ active: st.recording && sender.tab && sender.tab.id === st.tabId });

    } else if (msg.kind === 'action') {
      if (st.recording && sender.tab && sender.tab.id === st.tabId) {
        st.steps.push({ ...msg.action, timestamp: Date.now() });
        await setState(st);
        badge(st.steps.length);
      }
      sendResponse({ ok: true });

    } else if (msg.kind === 'start') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return sendResponse({ error: 'No active tab found.' });
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        return sendResponse({ error: 'Open the website you want to record first, then press Start.' });
      }
      const steps = [{ type: 'navigate', url: tab.url, timestamp: Date.now() }];
      await setState({ recording: true, tabId: tab.id, steps });
      badge(steps.length);
      try { await chrome.tabs.sendMessage(tab.id, { kind: 'activate' }); } catch (_) {}
      sendResponse({ ok: true });

    } else if (msg.kind === 'stop') {
      const cfg = await chrome.storage.local.get(['serverUrl', 'token']);
      const steps = st.steps || [];
      await setState({ recording: false, tabId: null, steps: [] });
      badge(0);
      if (st.tabId) { try { await chrome.tabs.sendMessage(st.tabId, { kind: 'deactivate' }); } catch (_) {} }
      if (!steps.length) return sendResponse({ error: 'Nothing was recorded.' });
      if (!cfg.token) return sendResponse({ error: 'Not logged in — open the extension popup and sign in first.' });
      const serverUrl = (cfg.serverUrl || 'http://localhost:3000').replace(/\/+$/, '');
      const cookies = await collectSessionCookies(steps);
      try {
        const r = await fetch(serverUrl + '/api/recording/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
          body: JSON.stringify({ steps, cookies }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return sendResponse({ error: data.error || 'Upload failed (' + r.status + ')' });
        sendResponse({ ok: true, stepCount: data.stepCount, reviewUrl: serverUrl + '/#recorder' });
      } catch (e) {
        sendResponse({ error: 'Could not reach the server: ' + e.message });
      }

    } else if (msg.kind === 'status') {
      sendResponse({ recording: st.recording, count: (st.steps || []).length });
    }
  })();
  return true; // keep sendResponse alive across the async work
});

// Track navigations in the recorded tab, and re-arm the content script after each page load
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const st = await getState();
  if (!st.recording || tabId !== st.tabId) return;
  if (changeInfo.url && !changeInfo.url.startsWith('chrome')) {
    st.steps.push({ type: 'navigate', url: changeInfo.url, timestamp: Date.now() });
    await setState(st);
    badge(st.steps.length);
  }
  if (changeInfo.status === 'complete') {
    try { await chrome.tabs.sendMessage(tabId, { kind: 'activate' }); } catch (_) {}
  }
});

// If the recorded tab is closed, end the session (steps are kept until Stop is pressed)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (st.recording && tabId === st.tabId) {
    st.recording = false;
    await setState(st);
  }
});

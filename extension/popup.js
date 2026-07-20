// Shadman's API Recorder — popup UI
const $ = id => document.getElementById(id);

function msg(el, text, cls) {
  el.className = 'msg ' + cls;
  el.textContent = text;
}
function clearMsg(el) { el.className = 'msg'; el.textContent = ''; }

async function getCfg() {
  return await chrome.storage.local.get(['serverUrl', 'token', 'userName']);
}

async function refresh() {
  const cfg = await getCfg();
  const loggedIn = !!cfg.token;
  $('login-view').style.display = loggedIn ? 'none' : 'block';
  $('main-view').style.display = loggedIn ? 'block' : 'none';
  if (!loggedIn) {
    $('server-url').value = cfg.serverUrl || 'http://localhost:3000';
    return;
  }
  $('user-name').textContent = cfg.userName || 'user';
  chrome.runtime.sendMessage({ kind: 'status' }, (st) => {
    if (chrome.runtime.lastError || !st) return;
    const rec = st.recording;
    $('dot').className = 'dot' + (rec ? ' rec' : '');
    $('status-text').textContent = rec ? 'Recording…' : 'Not recording';
    $('count').textContent = rec ? st.count + ' actions' : '';
    $('start-btn').style.display = rec ? 'none' : 'block';
    $('stop-btn').style.display = rec ? 'block' : 'none';
  });
}

$('login-btn').addEventListener('click', async () => {
  clearMsg($('login-msg'));
  const serverUrl = ($('server-url').value.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) return msg($('login-msg'), 'Enter your email and password.', 'err');
  try {
    const r = await fetch(serverUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return msg($('login-msg'), data.error || 'Login failed.', 'err');
    await chrome.storage.local.set({ serverUrl, token: data.token, userName: data.user?.name || email });
    refresh();
  } catch (e) {
    msg($('login-msg'), 'Cannot reach the platform at ' + serverUrl + ' — is it running?', 'err');
  }
});

$('token-btn').addEventListener('click', async () => {
  clearMsg($('login-msg'));
  const serverUrl = ($('server-url').value.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const token = $('token-input').value.trim();
  if (!token) return msg($('login-msg'), 'Paste a token first.', 'err');
  try {
    const r = await fetch(serverUrl + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return msg($('login-msg'), 'Token rejected — copy a fresh one from the website.', 'err');
    await chrome.storage.local.set({ serverUrl, token, userName: data.name || 'user' });
    refresh();
  } catch (e) {
    msg($('login-msg'), 'Cannot reach the platform at ' + serverUrl, 'err');
  }
});

$('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove(['token', 'userName']);
  refresh();
});

$('start-btn').addEventListener('click', () => {
  clearMsg($('main-msg'));
  chrome.runtime.sendMessage({ kind: 'start' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp?.error) return msg($('main-msg'), resp.error, 'err');
    msg($('main-msg'), 'Recording! Do your task on the page, then come back here and press Stop.', 'ok');
    refresh();
  });
});

$('stop-btn').addEventListener('click', () => {
  clearMsg($('main-msg'));
  $('stop-btn').disabled = true;
  chrome.runtime.sendMessage({ kind: 'stop' }, async (resp) => {
    $('stop-btn').disabled = false;
    if (chrome.runtime.lastError) return;
    if (resp?.error) { msg($('main-msg'), resp.error, 'err'); refresh(); return; }
    msg($('main-msg'), 'Uploaded ' + resp.stepCount + ' steps! Opening the review page…', 'ok');
    refresh();
    if (resp.reviewUrl) chrome.tabs.create({ url: resp.reviewUrl });
  });
});

$('dash-btn').addEventListener('click', async () => {
  const cfg = await getCfg();
  chrome.tabs.create({ url: (cfg.serverUrl || 'http://localhost:3000') });
});

refresh();
setInterval(refresh, 900);

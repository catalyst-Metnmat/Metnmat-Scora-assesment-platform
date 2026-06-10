/* Standalone /admin page — sign-in gate, then mounts the shared Designer module
 * (designer.js) into the page. The dashboard mounts the same module in its tab. */
const app = document.getElementById('app');
const AUTH_STORE = 'scora-auth';   // shared with the HR/Director dashboard
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.body.classList.add('embed');

let AUTH = loadAuth();
function loadAuth() { try { return JSON.parse(sessionStorage.getItem(AUTH_STORE) || localStorage.getItem(AUTH_STORE) || 'null'); } catch { return null; } }
function saveAuth(a, remember) { AUTH = a; (remember ? localStorage : sessionStorage).setItem(AUTH_STORE, JSON.stringify(a)); }
function clearAuth() { AUTH = null; sessionStorage.removeItem(AUTH_STORE); localStorage.removeItem(AUTH_STORE); }
function authHeaders() { if (!AUTH) return {}; return AUTH.mode === 'token' ? { Authorization: 'Bearer ' + AUTH.value } : { 'X-Admin-Key': AUTH.value }; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

function mountDesigner(role) {
  Designer.mount(app, {
    role, toast, authHeaders,
    onError: () => { clearAuth(); renderLogin('Your session expired. Please sign in again.'); },
    onKeyChange: (r, key) => { if (r === 'admin' && AUTH && AUTH.mode === 'key') saveAuth({ ...AUTH, value: key }, !!localStorage.getItem(AUTH_STORE)); }
  });
}

async function whoamiAndMount() {
  const res = await fetch('/api/hr/whoami', { headers: authHeaders() });
  if (!res.ok) { clearAuth(); renderLogin(res.status === 401 ? '' : 'Access denied.'); return; }
  const who = await res.json();
  if (AUTH) { AUTH.role = who.role; AUTH.name = who.name; }
  mountDesigner(who.role);
}

/* ===================== sign-in (named user OR access key) ===================== */
function renderLogin(msg) {
  app.innerHTML = `
    <div class="card login-card">
      <div class="login-brand"><span class="wm"><span class="wm-red">SC</span><span class="wm-dark">ORA</span></span>
        <div class="muted" style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase">Assessment Designer</div></div>
      <div id="loginForms">
        <label for="uIn">Username</label>
        <input type="text" id="uIn" autocomplete="username">
        <label for="pIn" style="margin-top:10px">Password</label>
        <input type="password" id="pIn" autocomplete="current-password">
        <label class="agree-row"><input type="checkbox" id="remember"> Keep me signed in on this device</label>
        ${msg ? `<div class="error-msg">${esc(msg)}</div>` : ''}
        <div class="actions mt"><button class="btn" id="goUser">Sign in</button></div>
        <p class="muted mt" style="text-align:center"><a href="#" id="toKey">Use an access key instead</a></p>
      </div>
      <div id="keyForm" hidden>
        <label for="keyIn">HR or Director access key</label>
        <input type="password" id="keyIn" autocomplete="off">
        <label class="agree-row"><input type="checkbox" id="rememberKey"> Keep me signed in on this device</label>
        <div class="error-msg" id="keyErr" hidden></div>
        <div class="actions mt"><button class="btn" id="goKey">Open Designer</button></div>
        <p class="muted mt" style="text-align:center"><a href="#" id="toUser">Back to username sign-in</a></p>
      </div>
    </div>`;
  const loginUser = async () => {
    const username = document.getElementById('uIn').value.trim(), password = document.getElementById('pIn').value;
    if (!username || !password) return renderLogin('Enter your username and password.');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Sign-in failed.');
      saveAuth({ mode: 'token', value: j.token, name: j.name, role: j.role }, document.getElementById('remember').checked);
      mountDesigner(j.role);
    } catch (e) { renderLogin(e.message); }
  };
  const loginKey = async () => {
    const key = document.getElementById('keyIn').value.trim();
    if (!key) return;
    const remember = document.getElementById('rememberKey').checked;
    saveAuth({ mode: 'key', value: key, name: '', role: 'hr' }, remember);
    const res = await fetch('/api/hr/whoami', { headers: authHeaders() });
    if (!res.ok) { clearAuth(); const el = document.getElementById('keyErr'); if (el) { el.hidden = false; el.textContent = 'Invalid access key.'; } return; }
    const who = await res.json();
    saveAuth({ mode: 'key', value: key, name: who.name, role: who.role }, remember);
    mountDesigner(who.role);
  };
  document.getElementById('goUser').onclick = loginUser;
  document.getElementById('pIn').addEventListener('keydown', e => { if (e.key === 'Enter') loginUser(); });
  document.getElementById('goKey').onclick = loginKey;
  document.getElementById('keyIn').addEventListener('keydown', e => { if (e.key === 'Enter') loginKey(); });
  document.getElementById('toKey').onclick = e => { e.preventDefault(); document.getElementById('loginForms').hidden = true; document.getElementById('keyForm').hidden = false; document.getElementById('keyIn').focus(); };
  document.getElementById('toUser').onclick = e => { e.preventDefault(); document.getElementById('keyForm').hidden = true; document.getElementById('loginForms').hidden = false; };
  document.getElementById('uIn').focus();
}

window.addEventListener('beforeunload', e => { if (!EMBED && Designer.isDirty()) { e.preventDefault(); e.returnValue = ''; } });

if (AUTH) whoamiAndMount(); else renderLogin();

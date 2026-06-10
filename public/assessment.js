/* Employee self-assessment wizard with server-side sessions.
 *
 * - The employee fills their profile once; the server issues a session token
 *   (kept in localStorage) and stores the draft centrally.
 * - Every rating autosaves to the server (debounced), so the employee can
 *   close the browser and resume exactly where they left off — no re-login.
 * - The assessment is live only inside the cycle's configured window; a
 *   countdown is shown and the wizard locks itself when the deadline passes.
 * - Employees with an HR-granted exception can work after the deadline.
 */
const app = document.getElementById('app');
const TOKEN_KEY = 'metnmat-session-token';
let DATA = null;            // framework
let CYCLE = null;           // { id, name, opensAt, closesAt, durationMinutes, isLive, mode }
let DEADLINE = null;        // effective hard-stop ISO string for this employee (or null)
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let state = { step: -1, profile: {}, ratings: {} };
let pendingSave = {};       // ratings changed since last save
let saveTimer = null, saveStatus = 'idle', lastSavedAt = null, countdownTimer = null, locked = false;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scaleShort = ['None', 'Aware', 'Basic', 'Skilled', 'Advanced', 'Expert'];

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------------- autosave ---------------- */
function queueSave(extra = {}) {
  if (!TOKEN || locked) return;
  Object.assign(pendingSave, extra.ratings || {});
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(extra), 1200);
  setSaveStatus('pending');
}

async function flushSave(extra = {}) {
  if (!TOKEN || locked) return;
  clearTimeout(saveTimer);
  const ratings = pendingSave; pendingSave = {};
  const body = { ratings, step: Math.max(0, state.step) };
  if (extra.profile) body.profile = state.profile;
  setSaveStatus('saving');
  try {
    const res = await fetch('/api/session/' + TOKEN, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (res.status === 423) { const j = await res.json(); return lockWizard(j.error); }
    if (res.status === 404) { localStorage.removeItem(TOKEN_KEY); TOKEN = ''; return; }
    if (!res.ok) throw new Error('save failed');
    lastSavedAt = new Date();
    setSaveStatus('saved');
  } catch {
    Object.assign(pendingSave, ratings); // keep changes, retry on next edit
    setSaveStatus('error');
    setTimeout(() => { if (Object.keys(pendingSave).length) flushSave(); }, 5000);
  }
}

function setSaveStatus(s) {
  saveStatus = s;
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.textContent = s === 'saving' || s === 'pending' ? 'Saving…'
    : s === 'saved' ? `Saved ${lastSavedAt ? lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`
    : s === 'error' ? 'Offline — retrying' : '';
  el.className = 'save-status' + (s === 'error' ? ' err' : '');
}

window.addEventListener('pagehide', () => {
  if (!TOKEN || locked || !Object.keys(pendingSave).length) return;
  navigator.sendBeacon('/api/session/' + TOKEN,
    new Blob([JSON.stringify({ ratings: pendingSave, step: Math.max(0, state.step) })], { type: 'application/json' }));
});

/* ---------------- deadline countdown (window + HR-set per-attempt timer) ---------------- */
// DEADLINE is the server-computed effective hard stop for this employee:
// the soonest of the cycle close time and (start + HR time limit). Null = no limit.
function timeLeftText(deadline) {
  const ms = Date.parse(deadline) - Date.now();
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (ms >= 3600e3) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`; // under an hour → live mm:ss
}

function updateCountdown() {
  const el = document.getElementById('deadlineChip');
  if (!el || !CYCLE) return;
  if (CYCLE.mode === 'exception') { el.innerHTML = '<span class="badge band">Exception access granted by HR</span>'; return; }
  if (!DEADLINE) { el.textContent = ''; return; }
  const ms = Date.parse(DEADLINE) - Date.now();
  if (ms <= 0) {
    flushSave();
    const timed = CYCLE.durationMinutes && (!CYCLE.closesAt || Date.parse(CYCLE.closesAt) > Date.parse(DEADLINE) + 1000);
    lockWizard(timed
      ? 'Your time limit for this assessment has elapsed. Your progress is saved — contact HR if you need more time.'
      : 'The assessment window has closed. Your progress is saved — contact HR if you need an exception.');
    return;
  }
  const urgent = ms < 5 * 60e3;
  const label = (CYCLE.durationMinutes && ms < 3600e3) ? 'Time left' : 'Closes in';
  el.innerHTML = `<span class="badge ${urgent ? 'fail' : 'pending'}">⏱ ${label} ${timeLeftText(DEADLINE)}</span>`;
}

function startCountdown() {
  clearInterval(countdownTimer);
  updateCountdown();
  // tick every second when under an hour (live mm:ss), else every 30s
  const ms = DEADLINE ? Date.parse(DEADLINE) - Date.now() : Infinity;
  countdownTimer = setInterval(updateCountdown, ms < 3600e3 ? 1000 : 30000);
}

function lockWizard(message) {
  if (locked) return;
  locked = true;
  clearInterval(countdownTimer);
  app.innerHTML = `
    <div class="card done-box">
      <h1>Assessment window closed</h1>
      <p class="sub" style="margin:10px auto 8px">${esc(message || 'The assessment window has closed.')}</p>
      <p class="muted" style="margin-bottom:22px">Everything you entered is safely saved. If HR grants you an exception, come back to this page and continue from where you left off.</p>
      <a class="btn ghost" href="/">Back to Home</a>
    </div>`;
  window.scrollTo(0, 0);
}

/* ---------------- progress shell ---------------- */
// a question is "answered" according to its type; optional questions don't count
function answered(sk) {
  const r = state.ratings[sk.id];
  if (!r) return false;
  const type = sk.type || 'rating';
  if (type === 'rating') return r.self != null;
  if (type === 'mcq') return r.answer != null && r.answer !== '';
  if (type === 'text') return !!String(r.answer || '').trim();
  return false;
}
const requiredSkills = d => d.skills.filter(sk => sk.required !== false);
function totalRated() {
  return DATA.domains.flatMap(requiredSkills).filter(answered).length;
}
function totalRequired() {
  return DATA.domains.reduce((s, d) => s + requiredSkills(d).length, 0);
}
function domainRated(d) {
  return requiredSkills(d).filter(answered).length;
}

function progressShell(inner) {
  const total = totalRequired();
  const rated = totalRated();
  const pct = Math.round((rated / Math.max(1, total)) * 100);
  const stepLabel = state.step === -1 ? 'Employee Profile'
    : state.step >= DATA.domains.length ? 'Review & Submit'
    : `Domain ${DATA.domains[state.step].code} of ${DATA.domains[DATA.domains.length - 1].code}`;
  const dots = DATA.domains.map((d, i) => {
    const done = domainRated(d) === requiredSkills(d).length;
    return `<button class="ddot ${i === state.step ? 'cur' : done ? 'done' : ''}" data-goto="${i}" title="${esc(d.name)}" aria-label="Go to domain ${d.code}: ${esc(d.name)}">${d.code}</button>`;
  }).join('');
  return `
    <div class="progress-shell">
      <div class="progress-head">
        <b>${stepLabel}</b>
        <span style="display:flex;gap:10px;align-items:center">
          <span id="deadlineChip"></span>
          <span id="saveStatus" class="save-status"></span>
          <span>${rated} / ${total} rated (${pct}%)</span>
        </span>
      </div>
      <div class="pbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
      <div class="domain-dots">${dots}</div>
    </div>${inner}`;
}

/* ---------------- entry: register / log in with SCORA code ---------------- */
async function startSession(code) {
  const res = await fetch('/api/session/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'Could not start the assessment.');
  TOKEN = j.token;
  localStorage.setItem(TOKEN_KEY, TOKEN);
  CYCLE = j.cycle; DEADLINE = j.deadlineAt || null;
  state.profile = j.draft.profile || {};
  state.ratings = j.draft.ratings || {};
  state.step = j.resumed ? (j.draft.step ?? 0) : 0;
  if (j.resumed) toast('Welcome back — your earlier progress was restored.');
  else if (CYCLE.durationMinutes) toast(`You have ${CYCLE.durationMinutes} minutes to complete the assessment once you begin.`);
  if (CYCLE.mode === 'exception') toast('Exception access granted by HR — you can complete your assessment now.');
  render(); window.scrollTo(0, 0);
}

function renderProfile() {
  app.innerHTML = `
    <div class="card login-card">
      <div class="login-brand"><span class="wm"><span class="wm-red">SC</span><span class="wm-dark">ORA</span></span>
        <div class="muted" style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase">Employee Assessment</div></div>

      <div id="loginForm">
        <h2 style="font-size:18px;margin-bottom:4px">Log in</h2>
        <p class="muted" style="margin-bottom:12px">Enter your name and your 4-digit SCORA code.</p>
        <label for="lName">Full name</label>
        <input type="text" id="lName" autocomplete="name">
        <label for="lCode" style="margin-top:10px">SCORA code (4 digits)</label>
        <input type="text" id="lCode" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">
        <div class="error-msg" id="lErr" hidden></div>
        <div class="actions mt"><button class="btn" id="loginBtn">Log in &amp; start</button></div>
        <p class="muted mt" style="text-align:center">First time here? <a href="#" id="toReg">Register to get your SCORA code</a></p>
      </div>

      <div id="regForm" hidden>
        <h2 style="font-size:18px;margin-bottom:4px">Register</h2>
        <p class="muted" style="margin-bottom:12px">All fields are required. You'll get a 4-digit SCORA code — that's your password.</p>
        <label for="rName">Full name *</label>
        <input type="text" id="rName" autocomplete="name">
        <label for="rMobile" style="margin-top:10px">Mobile number *</label>
        <input type="text" id="rMobile" inputmode="tel" autocomplete="tel">
        <label for="rEmail" style="margin-top:10px">Email *</label>
        <input type="text" id="rEmail" inputmode="email" autocomplete="email">
        <label for="rDoj" style="margin-top:10px">Joining month &amp; year *</label>
        <input type="month" id="rDoj">
        <div class="error-msg" id="rErr" hidden></div>
        <div class="actions mt"><button class="btn" id="regBtn">Create my SCORA code</button></div>
        <p class="muted mt" style="text-align:center">Already have a code? <a href="#" id="toLogin">Back to log in</a></p>
      </div>
    </div>`;

  const show = which => { document.getElementById('loginForm').hidden = which !== 'login'; document.getElementById('regForm').hidden = which !== 'reg'; };
  document.getElementById('toReg').onclick = e => { e.preventDefault(); show('reg'); document.getElementById('rName').focus(); };
  document.getElementById('toLogin').onclick = e => { e.preventDefault(); show('login'); document.getElementById('lName').focus(); };

  const login = async () => {
    const lErr = document.getElementById('lErr'); lErr.hidden = true;
    const name = document.getElementById('lName').value.trim();
    const code = document.getElementById('lCode').value.trim();
    if (!name || !/^\d{4}$/.test(code)) { lErr.hidden = false; lErr.textContent = 'Enter your name and your 4-digit SCORA code.'; return; }
    const btn = document.getElementById('loginBtn'); btn.disabled = true; btn.textContent = 'Logging in…';
    try {
      const r = await fetch('/api/employee/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Login failed.');
      await startSession(j.code);
    } catch (e) { lErr.hidden = false; lErr.textContent = e.message; btn.disabled = false; btn.textContent = 'Log in & start'; }
  };
  const register = async () => {
    const rErr = document.getElementById('rErr'); rErr.hidden = true;
    const name = document.getElementById('rName').value.trim();
    const mobile = document.getElementById('rMobile').value.trim();
    const email = document.getElementById('rEmail').value.trim();
    const doj = document.getElementById('rDoj').value;
    if (!name || !mobile || !email || !doj) { rErr.hidden = false; rErr.textContent = 'All fields are required.'; return; }
    const btn = document.getElementById('regBtn'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await fetch('/api/employee/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mobile, email, doj }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Registration failed.');
      showCode(j.code, j.name);
    } catch (e) { rErr.hidden = false; rErr.textContent = e.message; btn.disabled = false; btn.textContent = 'Create my SCORA code'; }
  };
  document.getElementById('loginBtn').onclick = login;
  document.getElementById('regBtn').onclick = register;
  document.getElementById('lCode').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  document.getElementById('rEmail').addEventListener('keydown', e => { if (e.key === 'Enter') register(); });

  // after registration, show the generated SCORA code once, then continue
  function showCode(code, name) {
    app.innerHTML = `
      <div class="card login-card" style="text-align:center">
        <div class="login-brand"><span class="wm"><span class="wm-red">SC</span><span class="wm-dark">ORA</span></span></div>
        <h2 style="font-size:18px">Welcome, ${esc(name)}</h2>
        <p class="muted" style="margin-bottom:14px">This is your SCORA code — it is your <b>password</b>. Save it; you'll need it to log in and to view your results later.</p>
        <div class="scora-code">${esc(code)}</div>
        <div class="actions mt" style="justify-content:center">
          <button class="btn ghost small" id="copyCode">Copy code</button>
          <button class="btn" id="startNow">Start assessment &rarr;</button>
        </div>
        <div class="error-msg" id="sErr" hidden></div>
      </div>`;
    document.getElementById('copyCode').onclick = () => { navigator.clipboard.writeText(code); toast('SCORA code copied.'); };
    document.getElementById('startNow').onclick = async () => {
      const btn = document.getElementById('startNow'); btn.disabled = true; btn.textContent = 'Starting…';
      try { await startSession(code); }
      catch (e) { const s = document.getElementById('sErr'); s.hidden = false; s.textContent = e.message; btn.disabled = false; btn.textContent = 'Start assessment →'; }
    };
  }
}

/* ---------------- domain step ---------------- */
function renderDomain() {
  const d = DATA.domains[state.step];
  const cards = d.skills.map(sk => {
    const r = state.ratings[sk.id] || {};
    const type = sk.type || 'rating';
    const meta = `${sk.required === false ? '<span class="badge neutral" style="font-size:10.5px">Optional</span>' : ''}${sk.difficulty ? ` <span class="badge pending" style="font-size:10.5px">${esc(sk.difficulty)}</span>` : ''}`;
    let body;
    if (type === 'mcq') {
      body = `<div role="group" aria-label="${esc(sk.name)} options">` + (sk.options || []).map((o, i) => `
        <label class="choice ${Number(r.answer) === i ? 'selected' : ''}">
          <input type="radio" name="mcq-${sk.id}" data-mcq="${sk.id}" value="${i}" ${Number(r.answer) === i ? 'checked' : ''}>
          <span>${esc(o)}</span></label>`).join('') + '</div>';
    } else if (type === 'text') {
      body = `<textarea data-txt="${sk.id}" maxlength="2000" rows="3" placeholder="Write your answer…">${esc(r.answer || '')}</textarea>`;
    } else {
      body = `<div class="rate-row" role="group" aria-label="${esc(sk.name)} rating">` +
        [0, 1, 2, 3, 4, 5].map(n =>
          `<button class="rate-btn ${r.self === n ? 'on' : ''}" data-sk="${sk.id}" data-v="${n}"
            aria-pressed="${r.self === n}" aria-label="Rate ${n} — ${scaleShort[n]}">${n}<small>${scaleShort[n]}</small></button>`).join('') + '</div>';
    }
    return `
      <div class="card skill-card" id="card-${sk.id}">
        <div class="sname"><span class="sno">${sk.sno}.</span>${esc(sk.name)} ${meta}</div>
        ${body}
        <div class="evidence"><input type="text" data-ev="${sk.id}" maxlength="500"
          placeholder="Evidence — projects, tools, certifications or examples (optional)" value="${esc(r.evidence || '')}"></div>
      </div>`;
  }).join('');

  app.innerHTML = progressShell(`
    <div class="domain-head">
      <div class="domain-chip">${d.code}</div>
      <div><div class="dn">${esc(d.name)}</div><div class="dc">${d.skills.length} skills — rate every one (0 = no exposure)</div></div>
    </div>
    ${cards}
    <div class="error-msg" id="err" hidden></div>
    <div class="wiz-nav">
      <button class="btn ghost" id="back">&larr; Back</button>
      <button class="btn" id="next">${state.step === DATA.domains.length - 1 ? 'Review & Submit' : 'Next Domain'} &rarr;</button>
    </div>
  `);
  startCountdown();
  setSaveStatus(saveStatus);

  app.querySelectorAll('.rate-btn').forEach(b => b.onclick = () => {
    const id = b.dataset.sk, v = Number(b.dataset.v);
    state.ratings[id] = { ...(state.ratings[id] || {}), self: v };
    queueSave({ ratings: { [id]: state.ratings[id] } });
    document.querySelectorAll(`#card-${CSS.escape(id)} .rate-btn`).forEach(x => {
      const on = Number(x.dataset.v) === v;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on);
    });
    const shell = document.querySelector('.progress-shell');
    const tmp = document.createElement('div'); tmp.innerHTML = progressShell('');
    shell.replaceWith(tmp.querySelector('.progress-shell'));
    bindDots(); startCountdown(); setSaveStatus(saveStatus);
  });
  app.querySelectorAll('[data-mcq]').forEach(el => el.addEventListener('change', () => {
    const id = el.dataset.mcq;
    state.ratings[id] = { ...(state.ratings[id] || {}), answer: Number(el.value) };
    queueSave({ ratings: { [id]: state.ratings[id] } });
    document.querySelectorAll(`#card-${CSS.escape(id)} .choice`).forEach(c => c.classList.toggle('selected', c.querySelector('input').checked));
  }));
  app.querySelectorAll('[data-txt]').forEach(el => el.addEventListener('input', () => {
    const id = el.dataset.txt;
    state.ratings[id] = { ...(state.ratings[id] || {}), answer: el.value };
    queueSave({ ratings: { [id]: state.ratings[id] } });
  }));
  app.querySelectorAll('[data-ev]').forEach(el => el.addEventListener('input', () => {
    const id = el.dataset.ev;
    state.ratings[id] = { ...(state.ratings[id] || {}), evidence: el.value };
    queueSave({ ratings: { [id]: state.ratings[id] } });
  }));
  document.getElementById('back').onclick = () => { state.step--; if (state.step >= 0) queueSave(); render(); window.scrollTo(0, 0); };
  document.getElementById('next').onclick = () => {
    const un = requiredSkills(d).filter(sk => !answered(sk));
    if (un.length) {
      const err = document.getElementById('err');
      err.hidden = false;
      err.textContent = `${un.length} skill(s) not rated in this domain. Enter 0 where there is no exposure.`;
      document.getElementById('card-' + un[0].id).scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    state.step++; queueSave(); render(); window.scrollTo(0, 0);
  };
  bindDots();
}

/* ---------------- review step ---------------- */
function renderReview() {
  const total = totalRequired();
  const rated = totalRated();
  const rows = DATA.domains.map(d => {
    const n = domainRated(d);
    const selfScored = d.skills.filter(sk => state.ratings[sk.id] && state.ratings[sk.id].self != null);
    const avg = selfScored.length ? (selfScored.reduce((s, sk) => s + (state.ratings[sk.id].self || 0), 0) / selfScored.length).toFixed(2) : '—';
    const ok = n === requiredSkills(d).length;
    return `<tr class="clickable" data-goto-row="${DATA.domains.indexOf(d)}">
      <td><span class="lvl lvl-domain">${d.code}</span></td>
      <td>${esc(d.name)}</td><td>${n}/${requiredSkills(d).length}</td><td>${ok ? avg : '<span class="badge pending">incomplete</span>'}</td></tr>`;
  }).join('');

  app.innerHTML = progressShell(`
    <h1>Review &amp; Submit</h1>
    <p class="sub">${CYCLE ? `Cycle: <b>${esc(CYCLE.name)}</b>. ` : ''}Check your domain summary below — click a row to revisit that domain. Once submitted, your assessment goes to HR for the validation interview.</p>
    <div class="card">
      <table class="scale-table">
        <thead><tr><th></th><th>Domain</th><th>Rated</th><th>Self Avg</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card">
      <h3>Declaration</h3>
      <p style="font-size:14px;margin-top:6px">I confirm these ratings honestly reflect my current proficiency. I understand every rating is validated in a follow-up interview and over-claiming counts against the review.</p>
      <label class="agree-row"><input type="checkbox" id="agree"> I agree</label>
    </div>
    <div class="error-msg" id="err" hidden></div>
    <div class="wiz-nav">
      <button class="btn ghost" id="back">&larr; Back</button>
      <button class="btn" id="submit" ${rated < total ? 'disabled' : ''}>Submit Assessment</button>
    </div>
  `);
  startCountdown();
  setSaveStatus(saveStatus);

  app.querySelectorAll('[data-goto-row]').forEach(tr => tr.onclick = () => {
    state.step = Number(tr.dataset.gotoRow); queueSave(); render(); window.scrollTo(0, 0);
  });
  document.getElementById('back').onclick = () => { state.step--; queueSave(); render(); window.scrollTo(0, 0); };
  document.getElementById('submit').onclick = async () => {
    const err = document.getElementById('err'); err.hidden = true;
    if (!document.getElementById('agree').checked) { err.hidden = false; err.textContent = 'Please tick the declaration before submitting.'; return; }
    const btn = document.getElementById('submit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await flushSave(); // make sure the server draft is complete
      const res = await fetch('/api/submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Submission failed');
      localStorage.removeItem(TOKEN_KEY); TOKEN = '';
      clearInterval(countdownTimer);
      const colors = ['#c01d22', '#e2474b', '#16304a', '#1e8e5a', '#8f1014'];
      const confetti = Array.from({ length: 18 }, (_, i) =>
        `<i style="--x:${(i * 137) % 100};--d:${(i % 9) * 0.22};--c:${colors[i % colors.length]}"></i>`).join('');
      app.innerHTML = `
        <div class="card done-box">
          <div class="confetti" aria-hidden="true">${confetti}</div>
          <div class="tick"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 25 L21 34 L37 15"/></svg></div>
          <h1>Assessment Submitted</h1>
          <p class="sub" style="margin:10px auto 22px">Thank you, ${esc(state.profile.name || '')}. Your self-assessment for <b>${esc(j.cycle || '')}</b> has been recorded.<br>
          HR will schedule a validation interview to confirm your ratings. Your completed assessment is confidential to you, your reporting manager, and the HR team.</p>
          <a class="btn ghost" href="/">Back to Home</a>
        </div>`;
      window.scrollTo(0, 0);
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Submit Assessment';
    }
  };
  bindDots();
}

function bindDots() {
  document.querySelectorAll('.ddot').forEach(b => b.onclick = () => {
    state.step = Number(b.dataset.goto); queueSave(); render(); window.scrollTo(0, 0);
  });
}

function render() {
  if (locked) return;
  if (state.step === -1) renderProfile();
  else if (state.step >= DATA.domains.length) renderReview();
  else renderDomain();
}

/* ---------------- boot ---------------- */
(async () => {
  try {
    DATA = await (await fetch('/api/skills')).json();
  } catch {
    app.innerHTML = '<div class="empty">Could not reach the server. Please refresh the page.</div>';
    return;
  }
  if (TOKEN) {
    try {
      const res = await fetch('/api/session/' + TOKEN);
      if (res.ok) {
        const j = await res.json();
        CYCLE = j.cycle; DEADLINE = j.deadlineAt || null;
        state.profile = j.draft.profile || {};
        state.ratings = j.draft.ratings || {};
        state.step = Math.min(j.draft.step ?? 0, DATA.domains.length);
        if (!j.accessible) return lockWizard(j.expired
          ? 'Your time limit for this assessment has elapsed. Your progress is saved — contact HR if you need more time.'
          : 'The assessment window has closed. Your progress is saved — contact HR if you need an exception.');
        render();
        if (totalRated() > 0) toast('Welcome back — continuing from where you left off.');
        return;
      }
      localStorage.removeItem(TOKEN_KEY); TOKEN = '';
    } catch { /* fall through to fresh start */ }
  }
  state.step = -1;
  render();
})();

/* Employee self-assessment wizard: profile -> 16 domain steps -> review & submit
 * Drafts are saved per assessment cycle in localStorage so a new annual cycle
 * always starts clean. */
const app = document.getElementById('app');
let DATA = null;
let DRAFT_KEY = null;
let state = { step: -1, profile: {}, ratings: {} }; // step -1 = profile, 0..n-1 = domains, n = review

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scaleShort = ['None', 'Aware', 'Basic', 'Skilled', 'Advanced', 'Expert'];

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch {}
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (d && typeof d === 'object') state = { step: -1, profile: {}, ratings: {}, ...d };
  } catch {}
}

function totalRated() {
  return DATA.domains.flatMap(d => d.skills).filter(sk => state.ratings[sk.id] && state.ratings[sk.id].self != null).length;
}
function domainRated(d) {
  return d.skills.filter(sk => state.ratings[sk.id] && state.ratings[sk.id].self != null).length;
}

function progressShell(inner) {
  const total = DATA.domains.reduce((s, d) => s + d.skills.length, 0);
  const rated = totalRated();
  const pct = Math.round((rated / total) * 100);
  const stepLabel = state.step === -1 ? 'Employee Profile'
    : state.step >= DATA.domains.length ? 'Review & Submit'
    : `Domain ${DATA.domains[state.step].code} of ${DATA.domains[DATA.domains.length - 1].code}`;
  const dots = DATA.domains.map((d, i) => {
    const done = domainRated(d) === d.skills.length;
    return `<button class="ddot ${i === state.step ? 'cur' : done ? 'done' : ''}" data-goto="${i}" title="${esc(d.name)}" aria-label="Go to domain ${d.code}: ${esc(d.name)}">${d.code}</button>`;
  }).join('');
  return `
    <div class="progress-shell">
      <div class="progress-head"><b>${stepLabel}</b><span>${rated} / ${total} skills rated (${pct}%)</span></div>
      <div class="pbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
      <div class="domain-dots">${dots}</div>
    </div>${inner}`;
}

/* ---------- closed window ---------- */
function renderClosed() {
  app.innerHTML = `
    <div class="card done-box">
      <h1>Assessment window closed</h1>
      <p class="sub" style="margin:10px auto 22px">There is no open assessment cycle right now. Please wait for HR to announce the next cycle.</p>
      <a class="btn ghost" href="/">Back to Home</a>
    </div>`;
}

/* ---------- profile step ---------- */
function renderProfile() {
  const fields = DATA.profileFields.map(f => {
    const v = esc(state.profile[f.id] || '');
    let input;
    if (f.options) {
      input = `<select data-pf="${f.id}"><option value="">Select…</option>${f.options.map(o =>
        `<option ${state.profile[f.id] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea data-pf="${f.id}">${v}</textarea>`;
    } else {
      input = `<input type="${f.type || 'text'}" data-pf="${f.id}" value="${v}" maxlength="300">`;
    }
    return `<div class="${f.type === 'textarea' ? 'full' : ''}"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}</div>`;
  }).join('');

  app.innerHTML = progressShell(`
    <h1>Employee Profile</h1>
    <p class="sub">Cycle: <b>${esc(DATA.cycle.name)}</b>. Fill every field — the HR team uses this to match the assessment to the right role.</p>
    <div class="card"><div class="grid2">${fields}</div>
      <div class="error-msg" id="err" hidden></div>
    </div>
    <div class="wiz-nav"><span></span><button class="btn" id="next">Continue to Skills &rarr;</button></div>
  `);

  app.querySelectorAll('[data-pf]').forEach(el => el.addEventListener('input', () => {
    state.profile[el.dataset.pf] = el.value; saveDraft();
  }));
  document.getElementById('next').onclick = () => {
    const missing = DATA.profileFields.filter(f => f.required && !(state.profile[f.id] || '').trim());
    const err = document.getElementById('err');
    if (missing.length) { err.hidden = false; err.textContent = 'Please fill: ' + missing.map(f => f.label).join(', '); return; }
    state.step = 0; saveDraft(); render(); window.scrollTo(0, 0);
  };
  bindDots();
}

/* ---------- domain step ---------- */
function renderDomain() {
  const d = DATA.domains[state.step];
  const cards = d.skills.map(sk => {
    const r = state.ratings[sk.id] || {};
    const btns = [0, 1, 2, 3, 4, 5].map(n =>
      `<button class="rate-btn ${r.self === n ? 'on' : ''}" data-sk="${sk.id}" data-v="${n}"
        aria-pressed="${r.self === n}" aria-label="Rate ${n} — ${scaleShort[n]}">${n}<small>${scaleShort[n]}</small></button>`).join('');
    return `
      <div class="card skill-card" id="card-${sk.id}">
        <div class="sname"><span class="sno">${sk.sno}.</span>${esc(sk.name)}</div>
        <div class="rate-row" role="group" aria-label="${esc(sk.name)} rating">${btns}</div>
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

  app.querySelectorAll('.rate-btn').forEach(b => b.onclick = () => {
    const id = b.dataset.sk, v = Number(b.dataset.v);
    state.ratings[id] = { ...(state.ratings[id] || {}), self: v };
    saveDraft();
    document.querySelectorAll(`#card-${CSS.escape(id)} .rate-btn`).forEach(x => {
      const on = Number(x.dataset.v) === v;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on);
    });
    // refresh the progress bar without re-rendering inputs
    const shell = document.querySelector('.progress-shell');
    const tmp = document.createElement('div'); tmp.innerHTML = progressShell('');
    shell.replaceWith(tmp.querySelector('.progress-shell'));
    bindDots();
  });
  app.querySelectorAll('[data-ev]').forEach(el => el.addEventListener('input', () => {
    const id = el.dataset.ev;
    state.ratings[id] = { ...(state.ratings[id] || {}), evidence: el.value };
    saveDraft();
  }));
  document.getElementById('back').onclick = () => { state.step--; saveDraft(); render(); window.scrollTo(0, 0); };
  document.getElementById('next').onclick = () => {
    const un = d.skills.filter(sk => !(state.ratings[sk.id] && state.ratings[sk.id].self != null));
    if (un.length) {
      const err = document.getElementById('err');
      err.hidden = false;
      err.textContent = `${un.length} skill(s) not rated in this domain. Enter 0 where there is no exposure.`;
      document.getElementById('card-' + un[0].id).scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    state.step++; saveDraft(); render(); window.scrollTo(0, 0);
  };
  bindDots();
}

/* ---------- review step ---------- */
function renderReview() {
  const total = DATA.domains.reduce((s, d) => s + d.skills.length, 0);
  const rated = totalRated();
  const rows = DATA.domains.map(d => {
    const n = domainRated(d);
    const avg = n ? (d.skills.reduce((s, sk) => s + (state.ratings[sk.id]?.self || 0), 0) / d.skills.length).toFixed(2) : '—';
    const ok = n === d.skills.length;
    return `<tr class="clickable" data-goto-row="${DATA.domains.indexOf(d)}">
      <td><span class="lvl lvl-domain">${d.code}</span></td>
      <td>${esc(d.name)}</td><td>${n}/${d.skills.length}</td><td>${ok ? avg : '<span class="badge pending">incomplete</span>'}</td></tr>`;
  }).join('');

  app.innerHTML = progressShell(`
    <h1>Review &amp; Submit</h1>
    <p class="sub">Cycle: <b>${esc(DATA.cycle.name)}</b>. Check your domain summary below — click a row to revisit that domain. Once submitted, your assessment goes to HR for the validation interview.</p>
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

  app.querySelectorAll('[data-goto-row]').forEach(tr => tr.onclick = () => {
    state.step = Number(tr.dataset.gotoRow); saveDraft(); render(); window.scrollTo(0, 0);
  });
  document.getElementById('back').onclick = () => { state.step--; saveDraft(); render(); window.scrollTo(0, 0); };
  document.getElementById('submit').onclick = async () => {
    const err = document.getElementById('err'); err.hidden = true;
    if (!document.getElementById('agree').checked) { err.hidden = false; err.textContent = 'Please tick the declaration before submitting.'; return; }
    const btn = document.getElementById('submit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: state.profile, ratings: state.ratings })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Submission failed. Please try again.');
      localStorage.removeItem(DRAFT_KEY);
      const colors = ['#c47b3f', '#d99a63', '#16304a', '#1e8e5a', '#a35f2a'];
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
    state.step = Number(b.dataset.goto); saveDraft(); render(); window.scrollTo(0, 0);
  });
}

function render() {
  if (state.step === -1) renderProfile();
  else if (state.step >= DATA.domains.length) renderReview();
  else renderDomain();
}

fetch('/api/skills').then(r => r.json()).then(d => {
  DATA = d;
  if (!DATA.cycle) return renderClosed();
  DRAFT_KEY = 'metnmat-assessment-draft-' + DATA.cycle.id;
  loadDraft();
  if (state.step > DATA.domains.length) state.step = DATA.domains.length;
  render();
  if (totalRated() > 0) toast('Draft restored — your progress was saved on this device.');
}).catch(() => {
  app.innerHTML = '<div class="empty">Could not reach the server. Please refresh the page.</div>';
});

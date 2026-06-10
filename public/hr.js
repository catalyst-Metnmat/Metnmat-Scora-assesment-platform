/* HR dashboard: key gate -> cycles + submissions + analytics -> validation detail.
 * The access key is sent via the X-HR-Key header (never in URLs). */
const app = document.getElementById('app');
const KEY_STORE = 'metnmat-hr-key';
let hrKey = sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE) || '';
let SKILLS = null;          // framework cache
let CYCLES = [];
let currentCycleFilter = ''; // '' = all

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const fmtNum = v => v == null ? '—' : Number(v).toFixed(2);

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-HR-Key': hrKey, ...(opts.headers || {}) }
  });
  if (res.status === 403) {
    sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); hrKey = '';
    renderLogin('Invalid access key.');
    throw new Error('forbidden');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

async function downloadCsv(path, filename) {
  const res = await fetch(path, { headers: { 'X-HR-Key': hrKey } });
  if (!res.ok) { toast('Export failed'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadFramework() {
  if (!SKILLS) SKILLS = await (await fetch('/api/skills')).json();
  return SKILLS;
}

/* ================= key gate ================= */
function renderLogin(msg) {
  app.innerHTML = `
    <div class="card login-card">
      <h2>HR Access</h2>
      <p class="muted" style="margin-bottom:14px">Enter the HR access key. It is printed in the server console when the portal starts (also in <code>data/config.json</code>).</p>
      <label for="keyIn">Access key</label>
      <input type="password" id="keyIn" autocomplete="off">
      <label class="agree-row"><input type="checkbox" id="rememberKey"> Remember on this device</label>
      ${msg ? `<div class="error-msg">${esc(msg)}</div>` : ''}
      <div class="actions mt"><button class="btn" id="go">Open Dashboard</button></div>
    </div>`;
  const tryKey = async () => {
    hrKey = document.getElementById('keyIn').value.trim();
    if (!hrKey) return;
    try {
      await api('/api/hr/cycles');
      (document.getElementById('rememberKey').checked ? localStorage : sessionStorage).setItem(KEY_STORE, hrKey);
      renderList();
    } catch (e) {
      if (e.message !== 'forbidden') renderLogin(e.message);
    }
  };
  document.getElementById('go').onclick = tryKey;
  document.getElementById('keyIn').addEventListener('keydown', e => { if (e.key === 'Enter') tryKey(); });
  document.getElementById('keyIn').focus();
}

/* ================= main list ================= */
async function renderList() {
  let subs, drafts;
  try {
    [CYCLES, subs, drafts] = await Promise.all([api('/api/hr/cycles'), api('/api/hr/submissions'), api('/api/hr/drafts')]);
    await loadFramework();
  } catch { return; }

  const open = CYCLES.find(c => c.status === 'open');
  const openIsLive = open && (!open.opensAt || Date.now() >= Date.parse(open.opensAt)) && (!open.closesAt || Date.now() <= Date.parse(open.closesAt));
  const shownDrafts = currentCycleFilter ? drafts.filter(d => d.cycleId === currentCycleFilter) : drafts;
  if (currentCycleFilter && !CYCLES.some(c => c.id === currentCycleFilter)) currentCycleFilter = '';
  const shown = currentCycleFilter ? subs.filter(s => s.cycleId === currentCycleFilter) : subs;
  const validated = shown.filter(s => s.status === 'validated').length;
  const cycName = id => (CYCLES.find(c => c.id === id) || {}).name || '—';

  const tabs = [`<button class="tab ${currentCycleFilter === '' ? 'on' : ''}" data-cyc="">All cycles</button>`]
    .concat([...CYCLES].reverse().map(c =>
      `<button class="tab ${currentCycleFilter === c.id ? 'on' : ''}" data-cyc="${c.id}">${esc(c.name)}${c.status === 'open' ? ' <span class="dot-open" title="open"></span>' : ''}</button>`))
    .join('');

  const rows = shown.length === 0
    ? `<tr><td colspan="8" class="empty">No submissions${currentCycleFilter ? ' in this cycle' : ''} yet.</td></tr>`
    : [...shown].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map(s => `
      <tr class="clickable" data-id="${s.id}">
        <td><b>${esc(s.profile.name)}</b><div class="muted">${esc(s.profile.employeeId || '')} · ${esc(s.profile.designation || '')}</div></td>
        <td>${esc(s.profile.department || '—')}</td>
        <td>${esc(cycName(s.cycleId))}</td>
        <td>${fmtDate(s.submittedAt)}</td>
        <td>${fmtNum(s.weightedSelf)}</td>
        <td>${s.status === 'validated'
          ? `<b>${fmtNum(s.weightedValidated)}</b><div><span class="badge band">${esc(s.band)}</span></div>`
          : `<span class="muted">${s.validatedCount}/${s.totalSkills} validated</span>`}</td>
        <td><span class="badge ${s.status === 'validated' ? 'validated' : 'pending'}">${s.status === 'validated' ? 'Validated' : 'Pending'}</span></td>
      </tr>`).join('');

  app.innerHTML = `
    <div class="list-head">
      <div>
        <h1>Assessment Submissions</h1>
        <p class="sub" style="margin-bottom:0">${open
          ? (openIsLive
            ? `Active cycle: <b>${esc(open.name)}</b> — live${open.closesAt ? ', closes ' + fmtWhen(open.closesAt) : ''}.`
            : `Cycle <b>${esc(open.name)}</b> — ${open.opensAt && Date.now() < Date.parse(open.opensAt) ? 'scheduled to open ' + fmtWhen(open.opensAt) : 'deadline passed (' + fmtWhen(open.closesAt) + ') — employees are locked out'}.`)
          : '<b>No open cycle</b> — the employee portal is closed.'}</p>
      </div>
      <div class="actions">
        <button class="btn small" id="cycleBtn">Manage cycles</button>
        <button class="btn ghost small" id="weightsBtn">Domain weights</button>
        <button class="btn ghost small" id="auditBtn">Audit log</button>
        <button class="btn ghost small" id="lockBtn" title="Forget the key on this device">Lock</button>
      </div>
    </div>

    <div class="tabs">${tabs}</div>

    <div class="stat-grid">
      <div class="stat"><div class="v">${shown.length}</div><div class="l">Submissions</div></div>
      <div class="stat"><div class="v">${shown.length - validated}</div><div class="l">Pending validation</div></div>
      <div class="stat"><div class="v">${validated}</div><div class="l">Validated</div></div>
      <div class="stat"><div class="v">${shownDrafts.length}</div><div class="l">In progress now</div></div>
    </div>

    ${shownDrafts.length ? `
    <div class="card">
      <h2>In progress <span class="muted" style="font-weight:400;font-size:13px">— employees currently working (auto-saved drafts)</span></h2>
      ${shownDrafts.map(dr => `
        <div class="podium-row">
          <span class="badge pending">${Math.round((dr.ratedCount / dr.totalSkills) * 100)}%</span>
          <div><b>${esc(dr.name)}</b><div class="muted">${esc(dr.employeeId)} · ${esc(dr.department)} · last activity ${new Date(dr.updatedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>
          <span class="p-score">${dr.ratedCount}/${dr.totalSkills}</span>
          <button class="iconbtn danger" data-discard="${dr.id}" title="Discard this draft">✕</button>
        </div>`).join('')}
    </div>` : ''}

    <div class="card" style="overflow-x:auto">
      <table class="list">
        <thead><tr><th>Employee</th><th>Department</th><th>Cycle</th><th>Submitted</th><th>Self (wtd)</th><th>Validated (wtd)</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="actions mt">
        <button class="btn small" id="analyticsBtn">Open analytics dashboard</button>
        <button class="btn ghost small" id="exportXlsx">Export Excel (all data)</button>
        <button class="btn ghost small" id="exportAll">Export ${currentCycleFilter ? 'cycle' : 'all'} to CSV</button>
      </div>
    </div>
    <div id="panel"></div>`;

  app.querySelectorAll('.tab').forEach(t => t.onclick = () => { currentCycleFilter = t.dataset.cyc; renderList(); });
  app.querySelectorAll('tr.clickable').forEach(tr => tr.onclick = () => renderDetail(tr.dataset.id));
  app.querySelectorAll('[data-discard]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (!confirm('Discard this in-progress draft? The employee will have to start over.')) return;
    await api('/api/hr/drafts/' + b.dataset.discard, { method: 'DELETE' });
    toast('Draft discarded.');
    renderList();
  });
  document.getElementById('lockBtn').onclick = () => { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); hrKey = ''; renderLogin(); };
  document.getElementById('cycleBtn').onclick = renderCyclesPanel;
  document.getElementById('weightsBtn').onclick = renderWeightsPanel;
  document.getElementById('auditBtn').onclick = renderAuditPanel;
  document.getElementById('analyticsBtn').onclick = renderDashboard;
  document.getElementById('exportAll').onclick = () =>
    downloadCsv('/api/hr/export.csv' + (currentCycleFilter ? `?cycleId=${currentCycleFilter}` : ''),
      `METNMAT_assessments_${currentCycleFilter ? cycName(currentCycleFilter).replace(/[^\w]+/g, '_') : 'all'}.csv`);
  document.getElementById('exportXlsx').onclick = () =>
    downloadCsv('/api/hr/export.xlsx' + (currentCycleFilter ? `?cycleId=${currentCycleFilter}` : ''), 'METNMAT_assessment_data.xlsx');
}

/* ================= cycles panel (windows + exceptions) ================= */
const fmtWhen = iso => iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
const toLocalInput = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = v => v ? new Date(v).toISOString() : null;

function cycleStatusBadge(c) {
  const now = Date.now();
  if (c.status !== 'open') return '<span class="badge neutral">Closed</span>';
  if (c.opensAt && now < Date.parse(c.opensAt)) return '<span class="badge pending">Scheduled</span>';
  if (c.closesAt && now > Date.parse(c.closesAt)) return '<span class="badge fail">Deadline passed</span>';
  return '<span class="badge validated">Live</span>';
}

function renderCyclesPanel() {
  const rows = [...CYCLES].reverse().map(c => {
    const win = (c.opensAt || c.closesAt)
      ? `${c.opensAt ? fmtWhen(c.opensAt) : 'immediately'} &rarr; ${c.closesAt ? fmtWhen(c.closesAt) : 'no deadline'}`
      : 'No time limit';
    const exCount = (c.exceptions || []).length;
    return `
    <tr><td><b>${esc(c.name)}</b><div class="muted">${win}</div></td>
      <td>${cycleStatusBadge(c)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn ghost small" data-window="${c.id}">Window</button>
        <button class="btn ghost small" data-except="${c.id}">Exceptions${exCount ? ' (' + exCount + ')' : ''}</button>
        ${c.status === 'open'
          ? `<button class="btn ghost small" data-close="${c.id}">Close</button>`
          : `<button class="btn ghost small" data-reopen="${c.id}">Reopen</button>`}
      </td></tr>
    <tr hidden id="cycsub-${c.id}"><td colspan="3" style="background:var(--bg);border-radius:10px"></td></tr>`;
  }).join('') || '<tr><td colspan="3" class="empty">No cycles yet.</td></tr>';

  document.getElementById('panel').innerHTML = `
    <div class="card mt">
      <h2>Assessment cycles &amp; windows</h2>
      <p class="muted" style="margin-bottom:12px">Employees can only work while a cycle is <b>Live</b>. Set an optional open/close time to run the assessment for a fixed window (e.g. 48 hours or a specific day) — it locks automatically at the deadline. Use <b>Exceptions</b> to reopen a closed assessment for specific employees.</p>
      <div class="actions" style="margin-bottom:6px">
        <input type="text" id="cycName" placeholder='New cycle name, e.g. "FY 2027-28"' maxlength="80" style="max-width:240px">
        <label class="muted" style="margin:0">Opens</label><input type="datetime-local" id="cycOpens" style="max-width:200px">
        <label class="muted" style="margin:0">Closes</label><input type="datetime-local" id="cycCloses" style="max-width:200px">
        <button class="btn small" id="cycCreate">Open new cycle</button>
      </div>
      <p class="muted" style="margin-bottom:14px">Leave the times empty for an always-open cycle. Quick deadline: <a href="#" id="q48">48 hours</a> · <a href="#" id="q7d">1 week</a> · <a href="#" id="qToday">today until midnight</a></p>
      <table class="list"><thead><tr><th>Cycle &amp; window</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="error-msg" id="cycErr" hidden></div>
    </div>`;

  const showErr = m => { const e = document.getElementById('cycErr'); e.hidden = false; e.textContent = m; };
  const refresh = () => renderList().then(renderCyclesPanel);

  // quick deadline presets
  const setQuick = (fromNowMs, endOfDay) => e => {
    e.preventDefault();
    const now = new Date();
    document.getElementById('cycOpens').value = toLocalInput(now.toISOString());
    const end = endOfDay ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59) : new Date(Date.now() + fromNowMs);
    document.getElementById('cycCloses').value = toLocalInput(end.toISOString());
  };
  document.getElementById('q48').onclick = setQuick(48 * 3600e3);
  document.getElementById('q7d').onclick = setQuick(7 * 86400e3);
  document.getElementById('qToday').onclick = setQuick(0, true);

  document.getElementById('cycCreate').onclick = async () => {
    document.getElementById('cycErr').hidden = true;
    try {
      await api('/api/hr/cycles', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('cycName').value,
        opensAt: fromLocalInput(document.getElementById('cycOpens').value),
        closesAt: fromLocalInput(document.getElementById('cycCloses').value)
      }) });
      toast('Cycle opened.');
      refresh();
    } catch (e) { if (e.message !== 'forbidden') showErr(e.message); }
  };
  document.getElementById('panel').querySelectorAll('[data-close]').forEach(b => b.onclick = async () => {
    if (!confirm('Close this cycle? Employees will no longer be able to submit (exceptions still work).')) return;
    await api(`/api/hr/cycles/${b.dataset.close}`, { method: 'PUT', body: JSON.stringify({ action: 'close' }) });
    toast('Cycle closed.'); refresh();
  });
  document.getElementById('panel').querySelectorAll('[data-reopen]').forEach(b => b.onclick = async () => {
    await api(`/api/hr/cycles/${b.dataset.reopen}`, { method: 'PUT', body: JSON.stringify({ action: 'reopen' }) });
    toast('Cycle reopened.'); refresh();
  });

  // edit window inline
  document.getElementById('panel').querySelectorAll('[data-window]').forEach(b => b.onclick = () => {
    const c = CYCLES.find(x => x.id === b.dataset.window);
    const sub = document.getElementById('cycsub-' + c.id);
    sub.hidden = !sub.hidden;
    if (sub.hidden) return;
    sub.firstElementChild.innerHTML = `
      <div class="actions" style="padding:12px">
        <label class="muted" style="margin:0">Opens</label><input type="datetime-local" id="wOpens" value="${toLocalInput(c.opensAt)}" style="max-width:200px">
        <label class="muted" style="margin:0">Closes</label><input type="datetime-local" id="wCloses" value="${toLocalInput(c.closesAt)}" style="max-width:200px">
        <button class="btn small" id="wSave">Save window</button>
        <button class="btn ghost small" id="wClear">Remove time limit</button>
      </div>`;
    sub.querySelector('#wSave').onclick = async () => {
      try {
        await api(`/api/hr/cycles/${c.id}`, { method: 'PUT', body: JSON.stringify({ action: 'schedule', opensAt: fromLocalInput(sub.querySelector('#wOpens').value), closesAt: fromLocalInput(sub.querySelector('#wCloses').value) }) });
        toast('Window updated.'); refresh();
      } catch (e) { if (e.message !== 'forbidden') showErr(e.message); }
    };
    sub.querySelector('#wClear').onclick = async () => {
      await api(`/api/hr/cycles/${c.id}`, { method: 'PUT', body: JSON.stringify({ action: 'schedule', opensAt: null, closesAt: null }) });
      toast('Time limit removed.'); refresh();
    };
  });

  // exceptions inline
  document.getElementById('panel').querySelectorAll('[data-except]').forEach(b => b.onclick = () => {
    const c = CYCLES.find(x => x.id === b.dataset.except);
    const sub = document.getElementById('cycsub-' + c.id);
    sub.hidden = !sub.hidden;
    if (sub.hidden) return;
    const exRows = (c.exceptions || []).map(e => `
      <div class="podium-row">
        <span class="badge band">Exception</span>
        <div><b>${esc(e.name || e.employeeId)}</b><div class="muted">ID ${esc(e.employeeId)} · granted ${fmtWhen(e.grantedAt)} · ${e.expiresAt ? 'expires ' + fmtWhen(e.expiresAt) : 'until removed'}</div></div>
        <button class="btn ghost small" style="margin-left:auto" data-exdel="${esc(e.employeeId)}">Remove</button>
      </div>`).join('') || '<div class="empty" style="padding:10px 0">No exceptions granted for this cycle.</div>';
    sub.firstElementChild.innerHTML = `
      <div style="padding:12px">
        <p class="muted" style="margin-bottom:10px">An exception lets one employee start/continue/submit even though the window is closed. It is removed automatically when they submit. If they already submitted and need a redo, delete their submission first.</p>
        <div class="actions" style="margin-bottom:8px">
          <input type="text" id="exEid" placeholder="Employee ID" style="max-width:160px">
          <input type="text" id="exName" placeholder="Name (optional)" style="max-width:180px">
          <input type="number" id="exHours" placeholder="Valid hours" value="48" min="1" max="720" style="max-width:110px">
          <button class="btn small" id="exAdd">Grant exception</button>
        </div>
        ${exRows}
      </div>`;
    sub.querySelector('#exAdd').onclick = async () => {
      try {
        await api(`/api/hr/cycles/${c.id}/exceptions`, { method: 'POST', body: JSON.stringify({
          employeeId: sub.querySelector('#exEid').value, name: sub.querySelector('#exName').value, hours: sub.querySelector('#exHours').value }) });
        toast('Exception granted — the employee can now complete the assessment.');
        refresh();
      } catch (e) { if (e.message !== 'forbidden') showErr(e.message); }
    };
    sub.querySelectorAll('[data-exdel]').forEach(db => db.onclick = async () => {
      await api(`/api/hr/cycles/${c.id}/exceptions/${encodeURIComponent(db.dataset.exdel)}`, { method: 'DELETE' });
      toast('Exception removed — access closed again.');
      refresh();
    });
  });

  document.getElementById('panel').scrollIntoView({ behavior: 'smooth' });
}

/* ================= weights panel ================= */
async function renderWeightsPanel() {
  const { weights, defaults } = await api('/api/hr/weights');
  const rows = SKILLS.domains.map(d => `
    <tr><td><b>${d.code}</b></td><td>${esc(d.name)}</td>
    <td style="width:110px"><input type="number" min="0" max="100" step="1" data-w="${d.code}" value="${weights[d.code]}" aria-label="Weight for domain ${d.code}"></td></tr>`).join('');
  document.getElementById('panel').innerHTML = `
    <div class="card mt">
      <h2>Domain weights (%)</h2>
      <p class="muted" style="margin-bottom:10px">Weights drive the weighted validated score and the band. For role-specific banding set irrelevant domains to 0 — scores are normalized over the total, and changing weights recalculates every score, including past cycles.</p>
      <table class="list"><tbody>${rows}</tbody></table>
      <div class="actions mt">
        <button class="btn small" id="saveW">Save weights</button>
        <button class="btn ghost small" id="resetW">Reset to company defaults</button>
        <span class="muted" id="wTotal"></span>
      </div>
      <div class="error-msg" id="wErr" hidden></div>
    </div>`;
  const updateTotal = () => {
    const t = [...document.querySelectorAll('[data-w]')].reduce((s, i) => s + (Number(i.value) || 0), 0);
    document.getElementById('wTotal').textContent = `Total: ${t}%`;
  };
  updateTotal();
  document.querySelectorAll('[data-w]').forEach(i => i.addEventListener('input', updateTotal));
  document.getElementById('saveW').onclick = async () => {
    const err = document.getElementById('wErr'); err.hidden = true;
    const w = {};
    document.querySelectorAll('[data-w]').forEach(i => w[i.dataset.w] = Number(i.value) || 0);
    try {
      await api('/api/hr/weights', { method: 'PUT', body: JSON.stringify({ weights: w }) });
      toast('Weights saved — all scores recalculated.');
      renderList();
    } catch (e) { if (e.message !== 'forbidden') { err.hidden = false; err.textContent = e.message; } }
  };
  document.getElementById('resetW').onclick = async () => {
    await api('/api/hr/weights', { method: 'PUT', body: JSON.stringify({ weights: defaults }) });
    toast('Weights reset to company defaults.');
    renderList();
  };
  document.getElementById('panel').scrollIntoView({ behavior: 'smooth' });
}

/* ================= full analytics dashboard ================= */
const heatCell = v => v == null ? '' : `background:rgba(196,123,63,${(v / 5) * 0.85 + 0.05});color:${v >= 2.5 ? '#fff' : 'inherit'}`;
const rankChip = r => `<span class="rank-chip ${r <= 3 ? 'r' + r : ''}">${r}</span>`;
const deltaChip = (d, suffix = '') => d == null ? '—'
  : `<span class="delta-chip ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d).toFixed(2)}${suffix}</span>`;

async function renderDashboard() {
  let dash;
  try {
    dash = await api('/api/hr/dashboard' + (currentCycleFilter ? `?cycleId=${currentCycleFilter}` : ''));
    if (!CYCLES.length) CYCLES = await api('/api/hr/cycles');
  } catch (e) { if (e.message !== 'forbidden') toast(e.message); return; }
  const t = dash.totals;

  const tabs = [`<button class="tab ${currentCycleFilter === '' ? 'on' : ''}" data-cyc="">All cycles</button>`]
    .concat([...CYCLES].reverse().map(c =>
      `<button class="tab ${currentCycleFilter === c.id ? 'on' : ''}" data-cyc="${c.id}">${esc(c.name)}${c.status === 'open' ? ' <span class="dot-open"></span>' : ''}</button>`)).join('');

  const stat = (v, l, sub) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="muted" style="margin-top:3px">${sub}</div>` : ''}</div>`;

  /* band distribution */
  const maxBand = Math.max(1, ...Object.values(dash.bandDist));
  const bandRows = Object.entries(dash.bandDist).map(([name, n]) => `
    <div class="bar-row"><span class="bar-label">${esc(name)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(n / maxBand) * 100}%"></div></div>
      <span class="bar-val">${n}</span></div>`).join('');

  /* overall leaderboard */
  const leadRows = dash.leaderboard.length ? dash.leaderboard.map(p => `
    <tr class="clickable" data-id="${p.id}">
      <td>${rankChip(p.rank)}</td>
      <td><b>${esc(p.name)}</b><div class="muted">${esc(p.employeeId)} · ${esc(p.designation)}</div></td>
      <td>${esc(p.department)}</td>
      <td><b style="font-family:var(--font-head)">${fmtNum(p.rankScore)}</b>${p.provisional ? ' <span class="badge pending">self only</span>' : ''}</td>
      <td>${p.band ? `<span class="badge band">${esc(p.band)}</span>` : `<span class="badge neutral">${esc(p.provisionalBand)}</span>`}</td>
      <td>${p.claimDelta == null ? '—' : deltaChip(p.claimDelta)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No submissions yet.</td></tr>';

  /* per-domain rankings (toppers) */
  const domainCards = dash.domainBoards.map(b => {
    const podium = b.ranking.slice(0, 3).map((r, i) => `
      <div class="podium-row">
        ${rankChip(i + 1)}
        <div><b>${esc(r.name)}</b><div class="muted">${esc(r.department)}</div></div>
        <span class="p-score">${fmtNum(r.score)}${r.validated ? '' : '<small class="muted" style="font-weight:500"> self</small>'}</span>
      </div>`).join('') || '<div class="empty" style="padding:14px 0">No data</div>';
    const fullRows = b.ranking.map((r, i) => `
      <tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.department)}</td>
      <td style="text-align:right"><b>${fmtNum(r.score)}</b>${r.validated ? '' : ' <span class="muted">(self)</span>'}</td></tr>`).join('');
    return `
      <div class="domain-rank-card">
        <div class="drc-head">
          <span class="domain-chip chip-sm">${b.code}</span>
          <div class="drc-title"><b>${esc(b.name)}</b>
            <div class="muted">${b.skillCount} skills · weight ${b.weight}% · avg ${fmtNum(b.avgValidated != null ? b.avgValidated : b.avgSelf)} ${b.delta != null ? deltaChip(b.delta, ' vs self') : ''}</div>
          </div>
        </div>
        ${podium}
        ${b.ranking.length > 3 ? `<details class="drc-more"><summary>Full ranking (${b.ranking.length})</summary>
          <table class="list"><tbody>${fullRows}</tbody></table></details>` : ''}
      </div>`;
  }).join('');

  /* departments */
  const maxDept = Math.max(0.01, ...dash.departments.map(d => d.avg || 0));
  const deptRows = dash.departments.map(d => `
    <div class="bar-row"><span class="bar-label">${esc(d.name)} <span class="muted">(${d.count})</span></span>
      <div class="bar-track"><div class="bar-fill" style="width:${((d.avg || 0) / maxDept) * 100}%"></div></div>
      <span class="bar-val">${fmtNum(d.avg)}</span></div>`).join('') || '<div class="empty">No data yet.</div>';

  /* histogram */
  const maxHist = Math.max(1, ...dash.histogram.map(h => h.count));
  const histRows = dash.histogram.map(h => `
    <div class="bar-row"><span class="bar-label">${h.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(h.count / maxHist) * 100}%"></div></div>
      <span class="bar-val">${h.count}</span></div>`).join('');

  /* gaps & strengths */
  const skillRows = list => list.map(g => `<tr><td>${g.sno}. ${esc(g.name)}</td><td><b>${g.domain}</b></td><td style="text-align:right">${fmtNum(g.avg)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">No data yet.</td></tr>';

  /* proficiency matrix (employees × domains) */
  const matrixPeople = dash.leaderboard.slice(0, 40);
  const matrixHead = dash.domainBoards.map(b => `<th style="text-align:center;padding:8px 6px" title="${esc(b.name)}">${b.code}</th>`).join('');
  const matrixRows = matrixPeople.map(p => `
    <tr class="clickable" data-id="${p.id}">
      <td style="white-space:nowrap"><b>${esc(p.name)}</b></td>
      ${dash.domainBoards.map(b => { const v = p.domains[b.code]; return `<td style="text-align:center;padding:8px 6px;${heatCell(v)}">${v == null ? '—' : v.toFixed(1)}</td>`; }).join('')}
    </tr>`).join('');
  const matrixHtml = dash.leaderboard.length ? `
    <div class="card">
      <h2>Proficiency matrix</h2>
      <p class="muted" style="margin-bottom:10px">Every employee × every domain (validated where available, else self). Darker = stronger. Click a row to open the submission.${dash.leaderboard.length > 40 ? ' Showing first 40 of ' + dash.leaderboard.length + '.' : ''}</p>
      <div style="overflow-x:auto"><table class="list matrix"><thead><tr><th>Employee</th>${matrixHead}</tr></thead><tbody>${matrixRows}</tbody></table></div>
    </div>` : '';

  /* attention flags */
  const now = Date.now();
  const flags = [];
  for (const p of dash.leaderboard) {
    if (p.claimDelta != null && p.claimDelta >= 0.4) flags.push({ p, type: 'Over-claiming', cls: 'fail', note: `self-rated ${p.claimDelta.toFixed(2)} above validated` });
    if (p.evidencePct != null && p.evidencePct < 15) flags.push({ p, type: 'Low evidence', cls: 'pending', note: `only ${p.evidencePct}% of skills have evidence` });
    if (p.provisional && (now - new Date(p.submittedAt)) / 86400000 > 7) flags.push({ p, type: 'Validation overdue', cls: 'review', note: `pending for ${Math.floor((now - new Date(p.submittedAt)) / 86400000)} days` });
  }
  const flagsHtml = `
    <div class="card">
      <h2>Attention flags</h2>
      <p class="muted" style="margin-bottom:10px">Items that may need HR follow-up.</p>
      ${flags.length ? flags.map(f => `
        <div class="podium-row clickable" data-id="${f.p.id}">
          <span class="badge ${f.cls}">${f.type}</span>
          <div><b>${esc(f.p.name)}</b><div class="muted">${esc(f.p.department)} · ${f.note}</div></div>
        </div>`).join('') : '<div class="empty" style="padding:14px 0">No flags — everything looks healthy.</div>'}
    </div>`;

  /* claim accuracy */
  const claimList = (list, cls) => list.map(p => `
    <div class="podium-row"><div><b>${esc(p.name)}</b><div class="muted">${esc(p.department)}</div></div>
      <span class="p-score"><span class="delta-chip ${cls}">${cls === 'up' ? '▲' : '▼'} ${Math.abs(p.claimDelta).toFixed(2)}</span></span></div>`).join('')
    || '<div class="empty" style="padding:14px 0">None — ratings match well.</div>';

  app.innerHTML = `
    <div class="actions" style="margin-bottom:14px">
      <button class="btn ghost small" id="backBtn">&larr; Submissions</button>
      <button class="btn ghost small" id="exportXlsxDash">Export Excel</button>
      <button class="btn ghost small" id="exportAll">Export CSV</button>
    </div>
    <div class="section-head" style="margin-top:0">
      <div class="kicker">Workforce intelligence</div>
      <h1>Analytics Dashboard <span class="muted" style="font-size:15px;font-family:var(--font-body);font-weight:500">· ${esc(dash.cycleName)}</span></h1>
    </div>
    <div class="tabs">${tabs}</div>

    <div class="stat-grid">
      ${stat(t.submissions, 'Submissions')}
      ${stat(t.validated, 'Validated', t.pending + ' pending')}
      ${stat(fmtNum(t.avgWeightedValidated), 'Avg validated score')}
      ${stat(fmtNum(t.avgWeightedSelf), 'Avg self score')}
      ${stat(t.avgClaimDelta == null ? '—' : (t.avgClaimDelta > 0 ? '+' : '') + t.avgClaimDelta.toFixed(2), 'Self-inflation', 'self minus validated')}
      ${stat(t.avgEvidencePct == null ? '—' : Math.round(t.avgEvidencePct) + '%', 'Evidence coverage')}
      ${stat(t.avgValidationDays == null ? '—' : t.avgValidationDays + 'd', 'Validation turnaround')}
      ${stat(t.departments, 'Departments')}
    </div>

    <div class="two-col">
      <div class="card"><h2>Band distribution</h2>${bandRows}</div>
      <div class="card"><h2>Score distribution</h2>${histRows}
        <div class="muted mt">Weighted score (validated where available, else self).</div></div>
    </div>

    <div class="card">
      <h2>Overall leaderboard</h2>
      <p class="muted" style="margin-bottom:10px">Ranked by weighted validated score (self score until validated). Δ = self minus validated — high positive values suggest over-claiming. Click a row to open the submission.</p>
      <div style="overflow-x:auto"><table class="list">
        <thead><tr><th>#</th><th>Employee</th><th>Department</th><th>Score</th><th>Band</th><th>Δ self</th></tr></thead>
        <tbody>${leadRows}</tbody></table></div>
    </div>

    ${matrixHtml}
    ${flagsHtml}

    <div class="section-head"><div class="kicker">Domain rankings</div><h2>Toppers in every domain</h2></div>
    <div class="domain-rank-grid">${domainCards}</div>

    <div class="two-col mt">
      <div class="card"><h2>Department comparison</h2>${deptRows}
        <div class="muted mt">Average weighted score per department.</div></div>
      <div class="card"><h2>Claim accuracy</h2>
        <h3 style="margin-bottom:6px">Over-claimed <span class="muted" style="font-weight:400">(self &gt; validated)</span></h3>${claimList(dash.overClaim, 'up')}
        <h3 style="margin:14px 0 6px">Under-claimed <span class="muted" style="font-weight:400">(validated &gt; self)</span></h3>${claimList(dash.underClaim, 'down')}
      </div>
    </div>

    <div class="two-col mt">
      <div class="card"><h2>Top skill gaps</h2>
        <p class="muted" style="margin-bottom:8px">Lowest company-wide averages — training priorities.</p>
        <table class="list"><tbody>${skillRows(dash.gaps)}</tbody></table></div>
      <div class="card"><h2>Top strengths</h2>
        <p class="muted" style="margin-bottom:8px">Highest company-wide averages — core capabilities.</p>
        <table class="list"><tbody>${skillRows(dash.strengths)}</tbody></table></div>
    </div>`;

  document.getElementById('backBtn').onclick = renderList;
  document.getElementById('exportAll').onclick = () =>
    downloadCsv('/api/hr/export.csv' + (currentCycleFilter ? `?cycleId=${currentCycleFilter}` : ''), 'METNMAT_assessments.csv');
  document.getElementById('exportXlsxDash').onclick = () =>
    downloadCsv('/api/hr/export.xlsx' + (currentCycleFilter ? `?cycleId=${currentCycleFilter}` : ''), 'METNMAT_assessment_data.xlsx');
  app.querySelectorAll('.tab').forEach(b => b.onclick = () => { currentCycleFilter = b.dataset.cyc; renderDashboard(); });
  app.querySelectorAll('tr.clickable, .podium-row.clickable').forEach(el => el.onclick = () => renderDetail(el.dataset.id));
  window.scrollTo(0, 0);
}

/* ================= audit panel ================= */
async function renderAuditPanel() {
  const events = await api('/api/hr/audit');
  const rows = events.map(e => `
    <tr><td style="white-space:nowrap">${new Date(e.ts).toLocaleString('en-IN')}</td>
      <td><b>${esc(e.event)}</b></td>
      <td class="muted">${esc(Object.entries(e).filter(([k]) => !['ts', 'event', 'ip'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · '))}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">No events recorded yet.</td></tr>';
  document.getElementById('panel').innerHTML = `
    <div class="card mt">
      <h2>Audit log <span class="muted" style="font-weight:400;font-size:13px">(last 100 events, newest first)</span></h2>
      <div style="overflow-x:auto"><table class="list mt"><tbody>${rows}</tbody></table></div>
    </div>`;
  document.getElementById('panel').scrollIntoView({ behavior: 'smooth' });
}

/* ================= validation detail ================= */
async function renderDetail(id) {
  let data;
  try { data = await api(`/api/hr/submissions/${id}`); await loadFramework(); } catch (e) { if (e.message !== 'forbidden') toast(e.message); return; }
  const { submission: sub, cycleName, history, analysis } = data;
  let scores = data.scores;
  const pending = {}; // unsaved edits

  /* ---- performance analysis block ---- */
  const maxBar = 5;
  const cmpRows = scores.domains.map(d => {
    const mine = d.validatedAvg != null ? d.validatedAvg : d.selfAvg;
    const comp = analysis.companyDomainAvgs[d.code];
    const dd = analysis.domainDeltas.find(x => x.code === d.code);
    return `
      <div class="cmp-row">
        <span class="cmp-label"><b>${d.code}</b> ${esc(d.name)}</span>
        <div class="cmp-bars">
          <div class="cmp-track"><i class="cmp-me" style="width:${(mine / maxBar) * 100}%"></i></div>
          <div class="cmp-track co"><i class="cmp-co" style="width:${((comp || 0) / maxBar) * 100}%"></i></div>
        </div>
        <span class="cmp-vals">${fmtNum(mine)} <span class="muted">vs ${fmtNum(comp)}</span></span>
        <span>${dd && dd.delta != null ? deltaChip(dd.delta) : ''}</span>
      </div>`;
  }).join('');
  const skillMini = list => list.map(s => `<tr><td>${s.sno}. ${esc(s.name)}</td><td><b>${s.domain}</b></td><td style="text-align:right"><b>${fmtNum(s.score)}</b></td></tr>`).join('');
  const analysisHtml = `
    <div class="card">
      <h2>Performance analysis <span class="muted" style="font-weight:400;font-size:13px">· ${esc(cycleName)}</span></h2>
      <div class="actions" style="margin:6px 0 14px">
        <span class="badge band">Rank #${analysis.rank} of ${analysis.totalInCycle}</span>
        ${analysis.totalInCycle > 1 ? `<span class="badge neutral">Top ${100 - analysis.percentile}%</span>` : ''}
        ${analysis.nextBand ? `<span class="badge pending">Next band: ${esc(analysis.nextBand.name)} — needs +${analysis.nextBand.needed}</span>` : '<span class="badge validated">Highest band reached</span>'}
      </div>
      <h3 style="margin-bottom:8px">Domain proficiency vs company average <span class="muted" style="font-weight:400">(red = employee, grey = company · Δ = self minus validated)</span></h3>
      ${cmpRows}
      <div class="two-col mt">
        <div><h3>Strongest skills</h3><table class="list mt"><tbody>${skillMini(analysis.topSkills)}</tbody></table></div>
        <div><h3>Development areas</h3><table class="list mt"><tbody>${skillMini(analysis.weakSkills)}</tbody></table></div>
      </div>
    </div>`;

  const profileRows = SKILLS.profileFields.map(f =>
    `<tr><td style="color:var(--muted);width:240px">${esc(f.label)}</td><td><b>${esc(sub.profile[f.id] || '—')}</b></td></tr>`).join('');

  const historyBlock = history.length ? `
    <details class="domain-block"><summary>Previous cycles — year-over-year (${history.length})</summary>
      <div class="inner"><table class="list">
        <thead><tr><th>Cycle</th><th>Submitted</th><th>Weighted self</th><th>Weighted validated</th><th>Band</th></tr></thead>
        <tbody>${history.map(h => `
          <tr><td><b>${esc(h.cycleName)}</b></td><td>${fmtDate(h.submittedAt)}</td>
          <td>${fmtNum(h.weightedSelf)}</td><td>${fmtNum(h.weightedValidated)}</td>
          <td>${h.band ? `<span class="badge band">${esc(h.band)}</span>` : '—'}</td></tr>`).join('')}</tbody>
      </table>
      <p class="muted mt">Growth vs latest previous cycle is shown per domain inside each domain block below.</p>
      </div>
    </details>` : '';

  const prev = history.length ? history[history.length - 1] : null;

  const domainBlocks = SKILLS.domains.map(d => {
    const ds = scores.domains.find(x => x.code === d.code);
    const prevD = prev ? prev.domains.find(x => x.code === d.code) : null;
    const delta = prevD && prevD.validatedAvg != null && ds.validatedAvg != null
      ? (ds.validatedAvg - prevD.validatedAvg) : null;
    const deltaTag = delta == null ? '' :
      `<span class="badge ${delta > 0 ? 'validated' : delta < 0 ? 'fail' : 'neutral'}" title="vs ${esc(prev.cycleName)}">${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} ${Math.abs(delta).toFixed(2)}</span>`;
    const inner = d.skills.map(sk => {
      const r = sub.ratings[sk.id] || {};
      const opts = ['<option value="">—</option>']
        .concat([0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${r.hr === n ? 'selected' : ''}>${n}</option>`)).join('');
      return `
        <div class="hr-skill">
          <div><div class="sname">${sk.sno}. ${esc(sk.name)}</div>
            ${r.evidence ? `<div class="ev">Evidence: ${esc(r.evidence)}</div>` : ''}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="self-pill" title="Self rating">${r.self}</span>
            <select data-hr="${sk.id}" aria-label="HR validated rating for ${esc(sk.name)}">${opts}</select>
          </div>
          <input type="text" data-rm="${sk.id}" placeholder="HR remarks" maxlength="500" value="${esc(r.remark || '')}">
        </div>`;
    }).join('');
    return `
      <details class="domain-block" id="dom-${d.code}">
        <summary><span class="domain-chip chip-sm">${d.code}</span> ${esc(d.name)} ${deltaTag}
          <span class="right-info" id="dominfo-${d.code}">self ${ds.selfAvg}${ds.validatedAvg != null ? ` · validated ${ds.validatedAvg}` : ` · ${ds.validatedCount}/${ds.skillCount} validated`}</span>
        </summary>
        <div class="inner">${inner}
          <div class="actions mt"><button class="btn ghost small" data-copy="${d.code}">Accept self ratings for unvalidated skills in ${d.code}</button></div>
        </div>
      </details>`;
  }).join('');

  function scoreboardHtml() {
    return `
      <div class="stat-grid">
        <div class="stat"><div class="v">${scores.overallSelf}</div><div class="l">Overall self (0–5)</div></div>
        <div class="stat"><div class="v">${scores.overallValidated ?? '—'}</div><div class="l">Overall validated</div></div>
        <div class="stat"><div class="v">${scores.weightedSelf}</div><div class="l">Weighted self</div></div>
        <div class="stat"><div class="v">${scores.weightedValidated ?? '—'}</div><div class="l">Weighted validated</div></div>
        <div class="stat"><div class="v" style="font-size:15px;line-height:1.3;padding-top:5px">${scores.band ? `<span class="badge band">${esc(scores.band)}</span>` : `<span class="badge neutral">${esc(scores.provisionalBand)}</span><div class="muted" style="margin-top:4px">provisional (from self)</div>`}</div><div class="l">Band</div></div>
      </div>`;
  }

  app.innerHTML = `
    <div class="actions" style="margin-bottom:14px">
      <button class="btn ghost small" id="backBtn">&larr; All submissions</button>
      <span class="badge neutral">${esc(cycleName)}</span>
      <span class="badge ${sub.status === 'validated' ? 'validated' : 'pending'}">${sub.status === 'validated' ? 'Validated ' + fmtDate(sub.validatedAt) : 'Pending validation'}</span>
      <button class="btn ghost small" id="printBtn" style="margin-left:auto">Print report</button>
    </div>
    <h1>${esc(sub.profile.name)}</h1>
    <p class="sub">${esc(sub.profile.employeeId || '')} · ${esc(sub.profile.designation || '')} · ${esc(sub.profile.department || '')} · Submitted ${fmtDate(sub.submittedAt)}</p>
    <div id="scoreboard">${scoreboardHtml()}</div>
    ${analysisHtml}
    <details class="domain-block"><summary>Employee profile</summary>
      <div class="inner"><table class="list"><tbody>${profileRows}</tbody></table></div>
    </details>
    ${historyBlock}
    <h2 class="mt">Validation — confirm or adjust each rating</h2>
    <p class="muted" style="margin-bottom:12px">Set the HR validated rating per skill during the validation interview. "Accept self ratings" copies the employee's value for any skill you haven't set yet. Changes apply when you click <b>Save validation</b>.</p>
    ${domainBlocks}
    <div class="card mt save-bar">
      <div class="actions">
        <button class="btn" id="saveBtn">Save validation</button>
        <button class="btn secondary" id="finalizeBtn">Save &amp; finalize (assign band)</button>
        <button class="btn ghost" id="csvBtn">Export CSV</button>
        <button class="btn danger small" id="delBtn" style="margin-left:auto">Delete</button>
      </div>
      <div class="error-msg" id="err" hidden></div>
    </div>`;

  document.getElementById('backBtn').onclick = renderList;
  document.getElementById('printBtn').onclick = () => window.print();
  document.getElementById('csvBtn').onclick = () =>
    downloadCsv(`/api/hr/submissions/${sub.id}/export.csv`, `METNMAT_assessment_${(sub.profile.name || 'employee').replace(/[^\w]+/g, '_')}.csv`);

  app.querySelectorAll('[data-hr]').forEach(el => el.addEventListener('change', () => {
    pending[el.dataset.hr] = { ...(pending[el.dataset.hr] || {}), hr: el.value };
  }));
  app.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('input', () => {
    pending[el.dataset.rm] = { ...(pending[el.dataset.rm] || {}), remark: el.value };
  }));
  app.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
    const d = SKILLS.domains.find(x => x.code === b.dataset.copy);
    for (const sk of d.skills) {
      const sel = document.querySelector(`select[data-hr="${sk.id}"]`);
      if (sel && sel.value === '') {
        sel.value = String(sub.ratings[sk.id].self);
        pending[sk.id] = { ...(pending[sk.id] || {}), hr: sel.value };
      }
    }
    toast(`Self ratings accepted for unvalidated skills in domain ${d.code}.`);
  });

  async function save(finalize) {
    const err = document.getElementById('err'); err.hidden = true;
    const btn = document.getElementById(finalize ? 'finalizeBtn' : 'saveBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const j = await api(`/api/hr/submissions/${sub.id}`, {
        method: 'PUT',
        body: JSON.stringify({ validations: pending, finalize })
      });
      scores = j.scores;
      sub.status = j.status;
      document.getElementById('scoreboard').innerHTML = scoreboardHtml();
      for (const ds of scores.domains) {
        const el = document.getElementById('dominfo-' + ds.code);
        if (el) el.textContent = `self ${ds.selfAvg}${ds.validatedAvg != null ? ` · validated ${ds.validatedAvg}` : ` · ${ds.validatedCount}/${ds.skillCount} validated`}`;
      }
      toast(finalize ? `Finalized — band assigned: ${scores.band}` : 'Validation saved.');
      if (finalize) renderDetail(sub.id);
    } catch (e) {
      if (e.message !== 'forbidden') { err.hidden = false; err.textContent = e.message; }
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }
  document.getElementById('saveBtn').onclick = () => save(false);
  document.getElementById('finalizeBtn').onclick = () => save(true);
  document.getElementById('delBtn').onclick = async () => {
    if (!confirm(`Delete ${sub.profile.name}'s submission permanently? This cannot be undone.`)) return;
    await api(`/api/hr/submissions/${sub.id}`, { method: 'DELETE' });
    toast('Submission deleted.');
    renderList();
  };
  window.scrollTo(0, 0);
}

if (hrKey) renderList(); else renderLogin();

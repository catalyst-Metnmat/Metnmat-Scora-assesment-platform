/* Assessment Designer — full control over the framework: categories (domains),
 * skills, proficiency scale, bands, weights, profile fields, import/export.
 * Opens with the HR key (HR conducts the assessment) or the Director key.
 * The "Access & security" tab (key management) is Director-only.
 * Edits a working copy in memory; "Save changes" PUTs the whole framework. */
const app = document.getElementById('app');
const KEY_STORE = 'metnmat-admin-key';
let adminKey = sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE) || '';
let ROLE = 'hr';      // 'admin' (director) or 'hr' — set after login
let FW = null;        // working copy
let tab = 'skills';
let dirty = false;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 's' + Math.random().toString(36).slice(2, 10);

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}
function markDirty() { dirty = true; const b = document.getElementById('saveBtn'); if (b) { b.disabled = false; b.textContent = 'Save changes'; } }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey, ...(opts.headers || {}) } });
  if (res.status === 403) { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); adminKey = ''; renderLogin('Invalid admin key.'); throw new Error('forbidden'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

/* ===================== login ===================== */
function renderLogin(msg) {
  app.innerHTML = `
    <div class="card login-card">
      <h2>Assessment Designer</h2>
      <p class="muted" style="margin-bottom:14px">Enter the <b>HR key</b> to design and manage the assessment (categories, skills, scale, bands, import/export). Company <b>Directors</b> can use their key for full oversight including key management.</p>
      <label for="keyIn">HR or Director key</label>
      <input type="password" id="keyIn" autocomplete="off">
      <label class="agree-row"><input type="checkbox" id="remember"> Remember on this device</label>
      ${msg ? `<div class="error-msg">${esc(msg)}</div>` : ''}
      <div class="actions mt"><button class="btn" id="go">Open Designer</button></div>
    </div>`;
  const tryKey = async () => {
    adminKey = document.getElementById('keyIn').value.trim();
    if (!adminKey) return;
    try {
      const who = await api('/api/hr/whoami');
      ROLE = who.role;
      FW = await api('/api/admin/framework');
      (document.getElementById('remember').checked ? localStorage : sessionStorage).setItem(KEY_STORE, adminKey);
      dirty = false; render();
    }
    catch (e) { if (e.message !== 'forbidden') renderLogin(e.message); }
  };
  document.getElementById('go').onclick = tryKey;
  document.getElementById('keyIn').addEventListener('keydown', e => { if (e.key === 'Enter') tryKey(); });
  document.getElementById('keyIn').focus();
}

/* ===================== shell ===================== */
function render() {
  const tabs = [['skills', 'Categories & Skills'], ['scale', 'Proficiency scale'], ['bands', 'Bands'], ['fields', 'Profile fields'], ['meta', 'Titles']];
  if (ROLE === 'admin') tabs.push(['keys', 'Access & security']);
  if (tab === 'keys' && ROLE !== 'admin') tab = 'skills';
  const totalSkills = FW.domains.reduce((s, d) => s + d.skills.length, 0);
  app.innerHTML = `
    <div class="list-head">
      <div><h1>Assessment Designer</h1>
        <p class="sub" style="margin-bottom:0">${FW.domains.length} categories · ${totalSkills} skills. Changes apply to <b>future</b> submissions and recalculate scores for all cycles.</p></div>
      <div class="actions">
        <button class="btn" id="saveBtn" disabled>Saved</button>
        <button class="btn secondary small" id="importBtn">Import Excel / PDF</button>
        <button class="btn ghost small" id="exportXlsxBtn">Export Excel (all data)</button>
        <button class="btn ghost small" id="revertBtn">Revert</button>
        <button class="btn ghost small" id="lockBtn">Lock</button>
      </div>
    </div>
    <input type="file" id="importFile" accept=".xlsx,.xls,.csv,.pdf" hidden>
    <div id="importPanel"></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="tabbody"></div>`;
  document.getElementById('saveBtn').onclick = save;
  document.getElementById('revertBtn').onclick = async () => { if (dirty && !confirm('Discard unsaved changes?')) return; FW = await api('/api/admin/framework'); dirty = false; render(); };
  document.getElementById('lockBtn').onclick = () => { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); adminKey = ''; renderLogin(); };
  document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').addEventListener('change', onImportFile);
  document.getElementById('exportXlsxBtn').onclick = exportXlsx;
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
  if (dirty) markDirty();
  renderTab();
}

/* ===================== Excel export (all data) ===================== */
async function exportXlsx() {
  toast('Preparing Excel export…');
  const res = await fetch('/api/hr/export.xlsx', { headers: { 'X-Admin-Key': adminKey } });
  if (!res.ok) { toast('Export failed'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'METNMAT_assessment_data.xlsx';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ===================== import Excel / PDF -> draft ===================== */
async function onImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast(`Reading ${file.name}…`);
  const buf = await file.arrayBuffer();
  let j;
  try {
    const res = await fetch('/api/admin/import', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: buf
    });
    j = await res.json();
    if (res.status === 403) { renderLogin('Session expired.'); return; }
    if (!res.ok) throw new Error(j.error || 'Import failed');
  } catch (err) { toast(err.message); return; }

  const preview = j.draft.domains.map(d =>
    `<li style="padding:5px 0;border-bottom:1px dashed var(--line)"><b>${esc(d.code)}</b> — ${esc(d.name)} <span class="muted">(${d.skills.length} questions)</span></li>`).join('');
  document.getElementById('importPanel').innerHTML = `
    <div class="card" style="border-left:4px solid var(--copper)">
      <h2>Import preview — ${j.stats.categories} categories, ${j.stats.skills} questions <span class="muted" style="font-weight:400">(from ${j.source})</span></h2>
      <ul style="list-style:none;margin:10px 0;max-height:240px;overflow-y:auto">${preview}</ul>
      <p class="muted" style="margin-bottom:12px">This is a <b>draft</b> — nothing is saved yet. Load it into the editor, adjust names/weights/questions, then click <b>Save changes</b>. Existing submissions keep their data but are scored against whatever framework is saved.</p>
      <div class="actions">
        <button class="btn small" id="impAppend">Append to current categories</button>
        <button class="btn danger small" id="impReplace">Replace all categories</button>
        <button class="btn ghost small" id="impCancel">Cancel</button>
      </div>
    </div>`;
  const newDomains = j.draft.domains.map(d => ({ code: d.code, name: d.name, weight: d.weight || 0, skills: d.skills.map(s => ({ id: uid(), name: s.name })) }));
  const done = msg => { document.getElementById('importPanel').innerHTML = ''; tab = 'skills'; markDirty(); render(); toast(msg); };
  document.getElementById('impAppend').onclick = () => {
    const used = new Set(FW.domains.map(d => d.code));
    for (const d of newDomains) { while (used.has(d.code)) d.code += 'X'; used.add(d.code); }
    FW.domains.push(...newDomains);
    done('Imported categories appended — review and Save changes.');
  };
  document.getElementById('impReplace').onclick = () => {
    if (!confirm('Replace ALL current categories and skills with the imported draft? (Scale, bands and profile fields are kept. Nothing is saved until you click Save changes.)')) return;
    FW.domains = newDomains;
    done('Framework replaced with the imported draft — review and Save changes.');
  };
  document.getElementById('impCancel').onclick = () => { document.getElementById('importPanel').innerHTML = ''; };
  document.getElementById('importPanel').scrollIntoView({ behavior: 'smooth' });
}

function renderTab() {
  const body = document.getElementById('tabbody');
  if (tab === 'skills') renderSkills(body);
  else if (tab === 'scale') renderScale(body);
  else if (tab === 'bands') renderBands(body);
  else if (tab === 'fields') renderFields(body);
  else if (tab === 'keys') renderKeys(body);
  else renderMeta(body);
}

/* ===================== access & security (key management) ===================== */
function randomKey() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function renderKeys(body) {
  body.innerHTML = `
    <div class="card">
      <h2>Reset the HR access key</h2>
      <p class="muted" style="margin-bottom:12px">Use this when HR forgets their key or it needs rotating. The new key takes effect immediately — share it with HR through a secure channel. Changes here override the <code>HR_KEY</code> environment variable on the server.</p>
      <div class="actions">
        <input type="text" id="hrKeyIn" placeholder="New HR key (min 8 characters)" maxlength="64" style="max-width:300px" autocomplete="off">
        <button class="btn ghost small" id="hrGen">Generate strong key</button>
        <button class="btn small" id="hrSet">Reset HR key</button>
      </div>
      <div id="hrKeyResult"></div>
    </div>
    <div class="card">
      <h2>Change your Director key</h2>
      <p class="muted" style="margin-bottom:12px">Rotate your own key whenever you want. Your current session continues automatically with the new key. Overrides the <code>ADMIN_KEY</code> environment variable.</p>
      <div class="actions">
        <input type="text" id="adKeyIn" placeholder="New admin key (min 8 characters)" maxlength="64" style="max-width:300px" autocomplete="off">
        <button class="btn ghost small" id="adGen">Generate strong key</button>
        <button class="btn small" id="adSet">Change admin key</button>
      </div>
      <div id="adKeyResult"></div>
    </div>
    <div class="card">
      <h3>Security notes</h3>
      <ul class="rules mt">
        <li>Keys are checked with constant-time comparison and a lockout after repeated failures.</li>
        <li>Every key change is recorded in the audit log (the key value itself is never stored in the log).</li>
        <li>The Director key opens everything — designer, HR dashboard, analytics — so HR being locked out never blocks the company.</li>
      </ul>
    </div>`;

  document.getElementById('hrGen').onclick = () => { document.getElementById('hrKeyIn').value = randomKey(); };
  document.getElementById('adGen').onclick = () => { document.getElementById('adKeyIn').value = randomKey(); };

  async function setKey(role, inputId, resultId) {
    const key = document.getElementById(inputId).value.trim();
    const result = document.getElementById(resultId);
    result.innerHTML = '';
    if (key.length < 8) { result.innerHTML = '<div class="error-msg">Key must be at least 8 characters.</div>'; return; }
    if (!confirm(role === 'hr'
      ? 'Reset the HR key now? The old HR key stops working immediately.'
      : 'Change YOUR admin key now? Make sure you save the new key — without it you lose admin access.')) return;
    try {
      await api('/api/admin/keys', { method: 'PUT', body: JSON.stringify({ role, key }) });
      if (role === 'admin') {
        adminKey = key;
        if (localStorage.getItem(KEY_STORE)) localStorage.setItem(KEY_STORE, key);
        else sessionStorage.setItem(KEY_STORE, key);
      }
      result.innerHTML = `
        <div class="mt" style="background:var(--copper-pale);border:1px dashed var(--copper);border-radius:10px;padding:12px 14px">
          <b>${role === 'hr' ? 'New HR key' : 'New admin key'}:</b> <code id="newKeyVal" style="font-size:15px">${esc(key)}</code>
          <button class="btn ghost small" id="copyKey" style="margin-left:10px">Copy</button>
          <div class="muted" style="margin-top:6px">${role === 'hr' ? 'Share this with HR securely. The old key no longer works.' : 'Save this somewhere safe — your session has switched to it already.'}</div>
        </div>`;
      document.getElementById('copyKey').onclick = () => { navigator.clipboard.writeText(key); toast('Key copied to clipboard.'); };
      document.getElementById(inputId).value = '';
      toast(role === 'hr' ? 'HR key reset.' : 'Admin key changed.');
    } catch (e) {
      if (e.message !== 'forbidden') result.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  }
  document.getElementById('hrSet').onclick = () => setKey('hr', 'hrKeyIn', 'hrKeyResult');
  document.getElementById('adSet').onclick = () => setKey('admin', 'adKeyIn', 'adKeyResult');
}

function move(arr, i, dir) { const j = i + dir; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }

/* ===================== categories & skills ===================== */
let expandedSkill = null; // "di:si" of the skill whose advanced settings are open

function advRow(sk, di, si) {
  const type = sk.type || 'rating';
  return `
    <div class="adv-row" data-advrow="${di}:${si}">
      <label class="muted" style="margin:0">Type</label>
      <select data-advk="type" data-pos="${di}:${si}">
        ${['rating', 'mcq', 'text'].map(t => `<option value="${t}" ${type === t ? 'selected' : ''}>${t === 'rating' ? 'Rating 0–5' : t === 'mcq' ? 'MCQ' : 'Subjective'}</option>`).join('')}
      </select>
      <label class="agree-row" style="margin:0"><input type="checkbox" data-advk="required" data-pos="${di}:${si}" ${sk.required === false ? '' : 'checked'}> Mandatory</label>
      <label class="muted" style="margin:0">Weight</label>
      <input type="number" data-advk="weight" data-pos="${di}:${si}" value="${sk.weight || 1}" min="0.5" max="10" step="0.5" style="max-width:80px">
      <label class="muted" style="margin:0">Difficulty</label>
      <select data-advk="difficulty" data-pos="${di}:${si}">
        ${['', 'basic', 'intermediate', 'advanced'].map(x => `<option value="${x}" ${(sk.difficulty || '') === x ? 'selected' : ''}>${x || '—'}</option>`).join('')}
      </select>
      ${type === 'mcq' ? `
        <div style="grid-column:1/-1">
          <label>Options (comma-separated)</label>
          <input data-advk="options" data-pos="${di}:${si}" value="${esc((sk.options || []).join(', '))}" placeholder="Option A, Option B, Option C">
          <label style="margin-top:8px">Correct option number for auto-scoring (1, 2, 3… — leave empty for HR-scored)</label>
          <input type="number" data-advk="correct" data-pos="${di}:${si}" value="${sk.correct != null ? sk.correct + 1 : ''}" min="1" style="max-width:80px">
        </div>` : ''}
    </div>`;
}

function renderSkills(body) {
  body.innerHTML = FW.domains.map((d, di) => `
    <div class="card admin-domain">
      <div class="admin-domain-head">
        <input class="dcode" data-d="${di}" data-k="code" value="${esc(d.code)}" maxlength="4" aria-label="Category code" title="Short code (A, B, C…)">
        <input class="dname" data-d="${di}" data-k="name" value="${esc(d.name)}" placeholder="Category name" aria-label="Category name">
        <span class="wlabel">Weight</span>
        <input type="number" class="dweight" data-d="${di}" data-k="weight" value="${d.weight || 0}" min="0" max="100" aria-label="Weight %">
        <span class="muted">%</span>
        <div class="admin-domain-actions">
          <button class="iconbtn" data-dmove="${di}" data-dir="-1" title="Move up">▲</button>
          <button class="iconbtn" data-dmove="${di}" data-dir="1" title="Move down">▼</button>
          <button class="iconbtn danger" data-ddel="${di}" title="Delete category">✕</button>
        </div>
      </div>
      <div class="admin-skills">
        ${d.skills.map((sk, si) => `
          <div class="admin-skill">
            <span class="sk-no">${si + 1}</span>
            <input data-d="${di}" data-s="${si}" value="${esc(sk.name)}" placeholder="Skill / competency" aria-label="Skill name">
            ${(sk.type && sk.type !== 'rating') || sk.required === false || sk.weight ? `<span class="badge neutral" style="font-size:10px">${sk.type || 'rating'}${sk.required === false ? ' · optional' : ''}${sk.weight ? ' · w' + sk.weight : ''}</span>` : ''}
            <button class="iconbtn ${expandedSkill === di + ':' + si ? 'on' : ''}" data-adv="${di}:${si}" title="Question settings (type, weight, difficulty)">⚙</button>
            <button class="iconbtn" data-smove="${di}:${si}" data-dir="-1" title="Move up">▲</button>
            <button class="iconbtn" data-smove="${di}:${si}" data-dir="1" title="Move down">▼</button>
            <button class="iconbtn danger" data-sdel="${di}:${si}" title="Delete skill">✕</button>
          </div>
          ${expandedSkill === di + ':' + si ? advRow(sk, di, si) : ''}`).join('')}
        <button class="btn ghost small" data-addskill="${di}">+ Add skill</button>
      </div>
    </div>`).join('') + `
    <div class="actions mt">
      <button class="btn small" id="addDomain">+ Add category</button>
      <span class="muted" id="wsum"></span>
    </div>`;

  body.querySelectorAll('[data-adv]').forEach(b => b.onclick = () => {
    expandedSkill = expandedSkill === b.dataset.adv ? null : b.dataset.adv;
    renderTab();
  });
  body.querySelectorAll('[data-advk]').forEach(el => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const [di, si] = el.dataset.pos.split(':').map(Number);
    const sk = FW.domains[di].skills[si];
    const k = el.dataset.advk;
    if (k === 'type') { sk.type = el.value; if (el.value === 'mcq' && !sk.options) sk.options = []; markDirty(); renderTab(); return; }
    if (k === 'required') sk.required = el.checked ? undefined : false;
    if (k === 'weight') { const w = Number(el.value); sk.weight = !isNaN(w) && w > 0 && w !== 1 ? w : undefined; }
    if (k === 'difficulty') sk.difficulty = el.value || undefined;
    if (k === 'options') sk.options = el.value.split(',').map(s => s.trim()).filter(Boolean);
    if (k === 'correct') { const c = Number(el.value); sk.correct = !isNaN(c) && c >= 1 ? c - 1 : null; }
    markDirty();
  }));

  const wsum = () => { document.getElementById('wsum').textContent = 'Total weight: ' + FW.domains.reduce((s, d) => s + (Number(d.weight) || 0), 0) + '%'; };
  wsum();

  body.querySelectorAll('input[data-k]').forEach(el => el.addEventListener('input', () => {
    const d = FW.domains[+el.dataset.d];
    d[el.dataset.k] = el.dataset.k === 'weight' ? Number(el.value) : el.value;
    if (el.dataset.k === 'weight') wsum();
    markDirty();
  }));
  body.querySelectorAll('.admin-skill input').forEach(el => el.addEventListener('input', () => {
    FW.domains[+el.dataset.d].skills[+el.dataset.s].name = el.value; markDirty();
  }));
  body.querySelectorAll('[data-addskill]').forEach(b => b.onclick = () => { FW.domains[+b.dataset.addskill].skills.push({ id: uid(), name: '' }); markDirty(); renderTab(); });
  body.querySelectorAll('[data-sdel]').forEach(b => b.onclick = () => { const [di, si] = b.dataset.sdel.split(':').map(Number); FW.domains[di].skills.splice(si, 1); markDirty(); renderTab(); });
  body.querySelectorAll('[data-smove]').forEach(b => b.onclick = () => { const [di, si] = b.dataset.smove.split(':').map(Number); move(FW.domains[di].skills, si, +b.dataset.dir); markDirty(); renderTab(); });
  body.querySelectorAll('[data-dmove]').forEach(b => b.onclick = () => { move(FW.domains, +b.dataset.dmove, +b.dataset.dir); markDirty(); renderTab(); });
  body.querySelectorAll('[data-ddel]').forEach(b => b.onclick = () => {
    const d = FW.domains[+b.dataset.ddel];
    if (!confirm(`Delete category "${d.name}" and its ${d.skills.length} skills?`)) return;
    FW.domains.splice(+b.dataset.ddel, 1); markDirty(); renderTab();
  });
  document.getElementById('addDomain').onclick = () => { FW.domains.push({ code: '', name: '', weight: 0, skills: [{ id: uid(), name: '' }] }); markDirty(); renderTab(); };
}

/* ===================== scale ===================== */
function renderScale(body) {
  body.innerHTML = `
    <div class="card">
      <h2>Proficiency scale</h2>
      <p class="muted" style="margin-bottom:12px">The 0–N levels employees pick from. Level numbers are assigned top-to-bottom starting at 0.</p>
      ${FW.scale.map((s, i) => `
        <div class="admin-scale">
          <span class="lvl" data-l="${i}">${i}</span>
          <input data-sc="${i}" data-k="label" value="${esc(s.label)}" placeholder="Label" aria-label="Level ${i} label">
          <input data-sc="${i}" data-k="definition" value="${esc(s.definition)}" placeholder="Definition" aria-label="Level ${i} definition">
          <button class="iconbtn danger" data-scdel="${i}" title="Remove level">✕</button>
        </div>`).join('')}
      <button class="btn ghost small mt" id="addScale">+ Add level</button>
    </div>`;
  body.querySelectorAll('input[data-sc]').forEach(el => el.addEventListener('input', () => { FW.scale[+el.dataset.sc][el.dataset.k] = el.value; markDirty(); }));
  body.querySelectorAll('[data-scdel]').forEach(b => b.onclick = () => { if (FW.scale.length <= 2) return toast('Keep at least 2 levels.'); FW.scale.splice(+b.dataset.scdel, 1); reindexScale(); markDirty(); renderTab(); });
  document.getElementById('addScale').onclick = () => { FW.scale.push({ label: '', definition: '' }); reindexScale(); markDirty(); renderTab(); };
}
function reindexScale() { FW.scale.forEach((s, i) => s.level = i); }

/* ===================== bands ===================== */
function renderBands(body) {
  body.innerHTML = `
    <div class="card">
      <h2>Career bands</h2>
      <p class="muted" style="margin-bottom:12px">The validated weighted score (0–5) maps to a band. Ranges should cover 0 to 5 without gaps.</p>
      <table class="list"><thead><tr><th>Min</th><th>Max</th><th>Band name</th><th></th></tr></thead><tbody>
      ${FW.bands.map((b, i) => `
        <tr>
          <td style="width:90px"><input type="number" step="0.01" data-b="${i}" data-k="min" value="${b.min}"></td>
          <td style="width:90px"><input type="number" step="0.01" data-b="${i}" data-k="max" value="${b.max}"></td>
          <td><input data-b="${i}" data-k="name" value="${esc(b.name)}" placeholder="Band name"></td>
          <td style="text-align:right"><button class="iconbtn danger" data-bdel="${i}" title="Remove band">✕</button></td>
        </tr>`).join('')}
      </tbody></table>
      <button class="btn ghost small mt" id="addBand">+ Add band</button>
    </div>`;
  body.querySelectorAll('input[data-b]').forEach(el => el.addEventListener('input', () => { const b = FW.bands[+el.dataset.b]; b[el.dataset.k] = el.dataset.k === 'name' ? el.value : Number(el.value); markDirty(); }));
  body.querySelectorAll('[data-bdel]').forEach(b => b.onclick = () => { if (FW.bands.length <= 1) return toast('Keep at least 1 band.'); FW.bands.splice(+b.dataset.bdel, 1); markDirty(); renderTab(); });
  document.getElementById('addBand').onclick = () => { FW.bands.push({ min: 0, max: 5, name: '' }); markDirty(); renderTab(); };
}

/* ===================== profile fields ===================== */
function renderFields(body) {
  body.innerHTML = `
    <div class="card">
      <h2>Employee profile fields</h2>
      <p class="muted" style="margin-bottom:12px">What employees fill in before the skills. For a dropdown, put comma-separated choices in Options.</p>
      <table class="list"><thead><tr><th>Label</th><th>Type</th><th>Required</th><th>Options (dropdown)</th><th></th></tr></thead><tbody>
      ${FW.profileFields.map((f, i) => `
        <tr>
          <td><input data-f="${i}" data-k="label" value="${esc(f.label)}" placeholder="Label"></td>
          <td><select data-f="${i}" data-k="type">
            ${['text', 'date', 'textarea', 'select'].map(t => `<option value="${t}" ${(f.options ? 'select' : (f.type || 'text')) === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></td>
          <td style="text-align:center"><input type="checkbox" data-f="${i}" data-k="required" ${f.required ? 'checked' : ''} style="accent-color:var(--copper)"></td>
          <td><input data-f="${i}" data-k="options" value="${esc((f.options || []).join(', '))}" placeholder="e.g. Howrah, Sambalpur, Mumbai"></td>
          <td style="text-align:right"><button class="iconbtn danger" data-fdel="${i}" title="Remove field">✕</button></td>
        </tr>`).join('')}
      </tbody></table>
      <button class="btn ghost small mt" id="addField">+ Add field</button>
    </div>`;

  const apply = (i, k, val) => {
    const f = FW.profileFields[i];
    if (k === 'label') { f.label = val; if (!f.id || f._auto) { f.id = (val.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'field') + i; f._auto = true; } }
    else if (k === 'required') f.required = val;
    else if (k === 'type') { if (val === 'select') { f.type = undefined; f.options = f.options || []; } else { f.type = val === 'text' ? undefined : val; if (val !== 'select') delete f.options; } }
    else if (k === 'options') { const arr = val.split(',').map(s => s.trim()).filter(Boolean); if (arr.length) f.options = arr; else delete f.options; }
    markDirty();
  };
  body.querySelectorAll('input[data-k],select[data-k]').forEach(el => {
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => { apply(+el.dataset.f, el.dataset.k, el.type === 'checkbox' ? el.checked : el.value); if (el.dataset.k === 'type') renderTab(); });
  });
  body.querySelectorAll('[data-fdel]').forEach(b => b.onclick = () => { if (FW.profileFields.length <= 1) return toast('Keep at least 1 field.'); FW.profileFields.splice(+b.dataset.fdel, 1); markDirty(); renderTab(); });
  document.getElementById('addField').onclick = () => { FW.profileFields.push({ id: 'field' + FW.profileFields.length, label: '', required: false, _auto: true }); markDirty(); renderTab(); };
}

/* ===================== meta/titles ===================== */
function renderMeta(body) {
  body.innerHTML = `
    <div class="card">
      <h2>Portal titles</h2>
      <div class="grid2 mt">
        <div class="full"><label>Company</label><input data-m="company" value="${esc(FW.company)}"></div>
        <div class="full"><label>Assessment title</label><input data-m="title" value="${esc(FW.title)}"></div>
        <div class="full"><label>Tagline</label><input data-m="tagline" value="${esc(FW.tagline)}"></div>
      </div>
    </div>`;
  body.querySelectorAll('[data-m]').forEach(el => el.addEventListener('input', () => { FW[el.dataset.m] = el.value; markDirty(); }));
}

/* ===================== save ===================== */
async function save() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const payload = JSON.parse(JSON.stringify(FW));
    payload.profileFields.forEach(f => delete f._auto);
    const j = await api('/api/admin/framework', { method: 'PUT', body: JSON.stringify(payload) });
    FW = j.framework; dirty = false;
    toast('Saved — framework updated.');
    render();
    document.getElementById('saveBtn').textContent = 'Saved';
  } catch (e) {
    if (e.message !== 'forbidden') { toast(e.message); btn.disabled = false; btn.textContent = 'Save changes'; }
  }
}

window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

if (adminKey) {
  Promise.all([api('/api/hr/whoami'), api('/api/admin/framework')])
    .then(([who, fw]) => { ROLE = who.role; FW = fw; render(); })
    .catch(e => { if (e.message !== 'forbidden') renderLogin(e.message); });
} else renderLogin();

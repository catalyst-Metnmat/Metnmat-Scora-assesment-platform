/* Employee self-service dashboard: assessment history, score trends,
 * skill profile, competency breakdown. Identity = employee ID + date of joining. */
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = v => v == null ? '—' : Number(v).toFixed(2);
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

function renderGate(msg) {
  app.innerHTML = `
    <div class="card login-card">
      <div class="login-brand"><img src="/logo-metnmat.png" alt="METNMAT" class="login-logo">
        <div class="muted" style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase">SCORA · My Results</div></div>
      <p class="muted" style="margin-bottom:14px">View your own assessment history, scores and skill profile. Log in with your name and 4-digit SCORA code.</p>
      <label for="mName">Full name</label>
      <input type="text" id="mName" autocomplete="name">
      <label for="mCode" style="margin-top:10px">SCORA code (4 digits)</label>
      <input type="text" id="mCode" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">
      ${msg ? `<div class="error-msg">${esc(msg)}</div>` : ''}
      <div class="actions mt"><button class="btn" id="go">View my results</button></div>
    </div>`;
  const go = async () => {
    const name = document.getElementById('mName').value.trim();
    const code = document.getElementById('mCode').value.trim();
    if (!name || !/^\d{4}$/.test(code)) return renderGate('Enter your name and 4-digit SCORA code.');
    try {
      const res = await fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Could not load your results.');
      renderMe(j);
    } catch (e) { renderGate(e.message); }
  };
  document.getElementById('go').onclick = go;
  document.getElementById('mCode').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

function renderMe(me) {
  const latest = me.history[me.history.length - 1];
  const maxScore = 5;

  const trendRows = me.history.map(h => {
    const v = h.weightedValidated != null ? h.weightedValidated : h.weightedSelf;
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(h.cycleName)} <span class="muted">(${fmtDate(h.submittedAt)})</span></span>
        <div class="bar-track"><div class="bar-fill" style="width:${(v / maxScore) * 100}%"></div></div>
        <span class="bar-val">${fmtNum(v)}</span>
      </div>`;
  }).join('');

  const domainRows = latest.domains.map(d => `
    <div class="cmp-row">
      <span class="cmp-label"><b>${d.code}</b> ${esc(d.name)}</span>
      <div class="cmp-bars">
        <div class="cmp-track"><i class="cmp-me" style="width:${((d.validatedAvg != null ? d.validatedAvg : d.selfAvg) / maxScore) * 100}%"></i></div>
      </div>
      <span class="cmp-vals">${fmtNum(d.validatedAvg != null ? d.validatedAvg : d.selfAvg)}${d.validatedAvg == null ? ' <span class="muted">self</span>' : ''}</span>
      <span></span>
    </div>`).join('');

  const skillRows = list => list.map(s => `<tr><td>${s.sno}. ${esc(s.name)}</td><td><b>${s.domain}</b></td><td style="text-align:right"><b>${fmtNum(s.score)}</b></td></tr>`).join('');

  const historyRows = me.history.map(h => `
    <tr><td><b>${esc(h.cycleName)}</b></td><td>${fmtDate(h.submittedAt)}</td>
      <td><span class="badge ${h.status === 'validated' ? 'validated' : 'pending'}">${h.status === 'validated' ? 'Evaluated' : 'Awaiting evaluation'}</span></td>
      <td>${fmtNum(h.weightedSelf)}</td><td>${fmtNum(h.weightedValidated)}</td>
      <td>${h.band ? `<span class="badge band">${esc(h.band)}</span>` : `<span class="badge neutral">${esc(h.provisionalBand)} (provisional)</span>`}</td></tr>`).join('');

  app.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div class="kicker">My results</div>
      <h1>${esc(me.name)}</h1>
      <p class="sub" style="margin-bottom:0">${esc(me.employeeId)} · ${esc(me.designation || '')} · ${esc(me.department || '')}</p>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="v">${me.history.length}</div><div class="l">Assessments</div></div>
      <div class="stat"><div class="v">${fmtNum(latest.weightedValidated != null ? latest.weightedValidated : latest.weightedSelf)}</div><div class="l">Latest score</div></div>
      <div class="stat"><div class="v" style="font-size:14px;line-height:1.3;padding-top:6px">${latest.band ? `<span class="badge band">${esc(latest.band)}</span>` : `<span class="badge neutral">${esc(latest.provisionalBand)}</span>`}</div><div class="l">Band</div></div>
    </div>

    <div class="card"><h2>Assessment history</h2>
      <div style="overflow-x:auto"><table class="list">
        <thead><tr><th>Cycle</th><th>Submitted</th><th>Status</th><th>Self (wtd)</th><th>Validated (wtd)</th><th>Band</th></tr></thead>
        <tbody>${historyRows}</tbody></table></div>
    </div>

    ${me.history.length > 1 ? `<div class="card"><h2>Score trend</h2>${trendRows}</div>` : ''}

    <div class="card"><h2>Competency breakdown <span class="muted" style="font-weight:400;font-size:13px">· latest assessment</span></h2>${domainRows}</div>

    <div class="two-col">
      <div class="card"><h2>Your strongest skills</h2><table class="list mt"><tbody>${skillRows(me.topSkills)}</tbody></table></div>
      <div class="card"><h2>Growth areas</h2><table class="list mt"><tbody>${skillRows(me.weakSkills)}</tbody></table></div>
    </div>
    <p class="muted">Scores marked "self" are your self-ratings, pending the HR validation interview. Validated scores and bands are final.</p>`;
  window.scrollTo(0, 0);
}

renderGate();

/* Landing page: live framework data, animated counters, scroll reveal,
 * proficiency ladder, domain card grid, assessment window status. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* run when the tab is actually visible (rAF and observers pause in hidden tabs) */
function whenVisible(cb) {
  if (!document.hidden) return cb();
  const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); cb(); } };
  document.addEventListener('visibilitychange', h);
}

/* scroll reveal — with a backstop so content can never stay hidden */
function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('in')); return; }
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => io.observe(el));
  setTimeout(() => {
    const broken = document.hidden || innerHeight === 0;
    els.forEach(el => { if (!el.classList.contains('in') && (broken || el.getBoundingClientRect().top < innerHeight)) el.classList.add('in'); });
  }, 2500);
}

/* animated count-up (instant when hidden or reduced motion) */
function countUp(el, target) {
  if (reduceMotion || document.hidden) { el.textContent = target; return; }
  const dur = 1100, t0 = performance.now();
  const tick = now => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

fetch('/api/skills').then(r => r.json()).then(d => {
  const totalSkills = d.domains.reduce((s, x) => s + x.skills.length, 0);
  const kpis = [['kDomains', d.domains.length], ['kSkills', totalSkills], ['kBands', 5]];
  if (document.hidden) kpis.forEach(([id, v]) => { document.getElementById(id).textContent = v; });
  whenVisible(() => kpis.forEach(([id, v]) => countUp(document.getElementById(id), v)));

  /* proficiency ladder */
  const maxLvl = d.scale.length - 1;
  document.getElementById('scaleLadder').innerHTML = d.scale.map((s, i) => `
    <div class="ladder-row">
      <span class="lvl" data-l="${s.level}">${s.level}</span>
      <div class="ladder-label"><b>${esc(s.label)}</b></div>
      <div>
        <div class="ladder-bar"><i style="width:${Math.max(6, (s.level / maxLvl) * 100)}%; animation-delay:${i * 0.08}s"></i></div>
        <span style="font-size:12.5px;color:var(--muted)">${esc(s.definition)}</span>
      </div>
    </div>`).join('');

  /* domain cards */
  document.getElementById('domainGrid').innerHTML = d.domains.map((x, i) => `
    <div class="domain-card reveal" style="transition-delay:${Math.min(i * 35, 280)}ms">
      <span class="lvl lvl-domain">${x.code}</span>
      <div><div class="dc-name">${esc(x.name)}</div><div class="dc-count">${x.skills.length} skills</div></div>
    </div>`).join('');

  /* assessment window */
  const badge = document.getElementById('heroBadge');
  const box = document.getElementById('cycleBox');
  if (d.cycle) {
    badge.innerHTML = '<span class="pulse-dot"></span>' + esc(d.cycle.name) + ' — window open';
    const draft = localStorage.getItem('metnmat-assessment-draft-' + d.cycle.id);
    box.innerHTML = `
      <a class="btn" href="/assessment">${draft ? 'Continue Self-Assessment' : 'Start Self-Assessment'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
      <div class="cycle-line" style="margin-top:14px">${draft ? 'A saved draft was found on this device — pick up where you left off.' : 'Takes roughly 30–45 minutes. Your progress saves automatically.'}</div>`;
  } else {
    badge.classList.add('closed');
    badge.innerHTML = '<span class="pulse-dot"></span>Window closed';
    box.innerHTML = `
      <p class="cycle-line closed">The assessment window is currently <b>closed</b>. Please wait for HR to announce the next cycle.</p>
      <a class="btn" aria-disabled="true" style="opacity:.5;pointer-events:none" href="/assessment">Start Self-Assessment</a>`;
  }

  initReveal();
}).catch(() => {
  document.getElementById('cycleBox').innerHTML = '<p class="cycle-line closed">Could not reach the server. Please refresh.</p>';
  initReveal();
});

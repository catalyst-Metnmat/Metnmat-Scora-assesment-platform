/*
 * METNMAT Skill & Competency Assessment Portal — production server.
 *
 * Storage: store.js (MongoDB when MONGODB_URI is set, else local files).
 * Roles:
 *   Admin (X-Admin-Key) — full power: edit framework (categories, skills, scale,
 *          bands, weights, profile fields), manage cycles, validate, everything HR can do.
 *   HR    (X-HR-Key)    — validate submissions, manage cycles, analytics, exports.
 * Runs as a long process (Render: `node server.js`) or as a serverless function
 * (Vercel: api/index.js requires this module — listen is guarded).
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true }); } catch {}

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3010;
const isServerless = !!process.env.VERCEL;

// kick off storage init immediately; requests wait on it (matters for serverless cold starts).
// If init fails (e.g. DB unreachable), retry on later requests instead of staying broken.
let ready = store.init();
ready.catch(e => console.error('Storage init failed:', e.message || e));
let lastInitRetry = 0;
function ensureReady() {
  return ready.catch(() => {
    if (Date.now() - lastInitRetry > 15000) {
      lastInitRetry = Date.now();
      console.log('Retrying storage connection…');
      ready = store.init();
      ready.catch(e => console.error('Storage retry failed:', e.message || e));
    }
    return ready;
  });
}

// ---------------------------------------------------------------- helpers
const newId = store.newId;
const normalizeEmpId = v => String(v || '').trim().toLowerCase();
const slug = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function allSkills(fw) { return fw.domains.flatMap(d => d.skills); }

function activeWeights(fw, cfg) {
  const w = {};
  for (const d of fw.domains) w[d.code] = cfg.weights && cfg.weights[d.code] != null ? Number(cfg.weights[d.code]) : (d.weight || 0);
  return w;
}

function computeScores(sub, fw, cfg) {
  const skills = allSkills(fw);
  const weights = activeWeights(fw, cfg);
  const totalW = Object.values(weights).reduce((s, v) => s + v, 0) || 1;
  const domains = fw.domains.map(d => {
    let selfSum = 0, valSum = 0, valCount = 0;
    for (const sk of d.skills) {
      const r = sub.ratings[sk.id] || {};
      selfSum += Number(r.self) || 0;
      if (r.hr != null && r.hr !== '') { valSum += Number(r.hr); valCount++; }
    }
    const n = d.skills.length;
    return {
      code: d.code, name: d.name, skillCount: n, weight: weights[d.code],
      selfAvg: n ? +(selfSum / n).toFixed(2) : 0,
      validatedAvg: n && valCount === n ? +(valSum / n).toFixed(2) : null,
      validatedCount: valCount
    };
  });
  const total = skills.length || 1;
  const validatedCount = skills.filter(sk => { const r = sub.ratings[sk.id]; return r && r.hr != null && r.hr !== ''; }).length;
  const overallSelf = +(domains.reduce((s, d) => s + d.selfAvg * d.skillCount, 0) / total).toFixed(2);
  const fullyValidated = domains.length > 0 && domains.every(d => d.validatedAvg != null);
  const overallValidated = fullyValidated ? +(domains.reduce((s, d) => s + d.validatedAvg * d.skillCount, 0) / total).toFixed(2) : null;
  const weightedSelf = +(domains.reduce((s, d) => s + d.selfAvg * d.weight, 0) / totalW).toFixed(2);
  const weightedValidated = fullyValidated ? +(domains.reduce((s, d) => s + d.validatedAvg * d.weight, 0) / totalW).toFixed(2) : null;
  const bands = fw.bands || [];
  const bandFor = score => { const b = bands.find(b => score >= b.min && score <= b.max); return b ? b.name : (bands.length ? bands[bands.length - 1].name : null); };
  return {
    domains, overallSelf, overallValidated, weightedSelf, weightedValidated,
    band: weightedValidated != null ? bandFor(weightedValidated) : null,
    provisionalBand: bandFor(weightedSelf),
    validatedCount, totalSkills: skills.length
  };
}

function subSummary(s, fw, cfg, cycles) {
  const sc = computeScores(s, fw, cfg);
  return {
    id: s.id, cycleId: s.cycleId, profile: s.profile, status: s.status,
    submittedAt: s.submittedAt, validatedAt: s.validatedAt,
    overallSelf: sc.overallSelf, weightedSelf: sc.weightedSelf,
    overallValidated: sc.overallValidated, weightedValidated: sc.weightedValidated,
    band: sc.band, provisionalBand: sc.provisionalBand,
    validatedCount: sc.validatedCount, totalSkills: sc.totalSkills
  };
}

async function employeeHistory(employeeId, excludeSubId, fw, cfg, cycles) {
  const eid = normalizeEmpId(employeeId);
  if (!eid) return [];
  const subs = (await store.listSubmissions())
    .filter(s => s.id !== excludeSubId && normalizeEmpId(s.profile.employeeId) === eid);
  return subs.map(s => {
    const sc = computeScores(s, fw, cfg);
    const cycle = cycles.find(c => c.id === s.cycleId);
    return {
      id: s.id, cycleName: cycle ? cycle.name : '—', submittedAt: s.submittedAt, status: s.status,
      weightedSelf: sc.weightedSelf, weightedValidated: sc.weightedValidated, band: sc.band,
      domains: sc.domains.map(d => ({ code: d.code, selfAvg: d.selfAvg, validatedAvg: d.validatedAvg }))
    };
  }).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

const csvEsc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, p) => {
    // HTML/CSS/JS: always revalidate via ETag (so updates show immediately after a deploy).
    // Images/fonts: cache for a day.
    if (/\.(html|css|js)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// gate API routes until storage is ready (with automatic reconnection attempts)
app.use('/api', (req, res, next) => ensureReady().then(() => next()).catch(() => res.status(503).json({ error: 'Storage unavailable — database connection failed. Check MongoDB Atlas Network Access.' })));

const audit = (event, req, detail) => store.appendAudit({ ts: new Date().toISOString(), event, ip: req.ip, ...detail });

// ---------------------------------------------------------------- auth (timing-safe + lockout)
const authFails = new Map();
const LOCK_AFTER = 8, LOCK_MS = 15 * 60 * 1000;
const keyEq = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function makeAuth(level) {
  // level 'hr' accepts hr OR admin key; level 'admin' accepts admin only
  return async (req, res, next) => {
    const ip = req.ip;
    const rec = authFails.get(ip);
    if (rec && rec.until > Date.now()) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    const { adminKey, hrKey } = await store.getSecrets();
    const provided = String(req.headers['x-admin-key'] || req.headers['x-hr-key'] || '');
    const isAdmin = keyEq(provided, adminKey);
    const ok = level === 'admin' ? isAdmin : (isAdmin || keyEq(provided, hrKey));
    if (!ok) {
      const r = rec && rec.until <= Date.now() ? { count: 0, until: 0 } : (rec || { count: 0, until: 0 });
      r.count++;
      if (r.count >= LOCK_AFTER) { r.until = Date.now() + LOCK_MS; r.count = 0; audit('auth.lockout', req, {}); }
      authFails.set(ip, r);
      return res.status(403).json({ error: 'Invalid access key' });
    }
    authFails.delete(ip);
    req.isAdmin = isAdmin;
    next();
  };
}
const hrAuth = makeAuth('hr');
const adminAuth = makeAuth('admin');

const submitLog = new Map();
function submitLimit(req, res, next) {
  const now = Date.now();
  const arr = (submitLog.get(req.ip) || []).filter(t => now - t < 3600e3);
  if (arr.length >= 80) return res.status(429).json({ error: 'Too many submissions from this network. Try again later.' });
  arr.push(now); submitLog.set(req.ip, arr);
  next();
}

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(new Date().toISOString(), err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------- public API
app.get('/api/skills', wrap(async (_req, res) => {
  const fw = await store.getFramework();
  const cycles = await store.listCycles();
  const open = cycles.find(c => c.status === 'open') || null;
  res.json({
    company: fw.company, title: fw.title, tagline: fw.tagline,
    scale: fw.scale, profileFields: fw.profileFields,
    domains: fw.domains.map(d => ({ code: d.code, name: d.name, skills: d.skills })),
    cycle: open ? { id: open.id, name: open.name } : null
  });
}));

app.post('/api/submissions', submitLimit, wrap(async (req, res) => {
  const fw = await store.getFramework();
  const cycles = await store.listCycles();
  const open = cycles.find(c => c.status === 'open');
  if (!open) return res.status(409).json({ error: 'The assessment window is currently closed. Please contact HR.' });

  const { profile, ratings } = req.body || {};
  if (!profile || typeof profile !== 'object') return res.status(400).json({ error: 'Profile is required' });
  for (const f of fw.profileFields.filter(f => f.required)) {
    if (!profile[f.id] || !String(profile[f.id]).trim()) return res.status(400).json({ error: `${f.label} is required` });
  }
  if (!ratings || typeof ratings !== 'object') return res.status(400).json({ error: 'Ratings are required' });
  const skills = allSkills(fw);
  const missing = skills.filter(sk => {
    const r = ratings[sk.id];
    return !r || r.self == null || r.self === '' || isNaN(Number(r.self)) || Number(r.self) < 0 || Number(r.self) > 5;
  });
  if (missing.length) return res.status(400).json({ error: `${missing.length} skill(s) not rated. Enter 0 explicitly where there is no exposure.` });

  const eid = normalizeEmpId(profile.employeeId);
  const existing = await store.listSubmissions(open.id);
  if (eid && existing.find(s => normalizeEmpId(s.profile.employeeId) === eid))
    return res.status(409).json({ error: `An assessment for employee ID "${String(profile.employeeId).trim()}" already exists in ${open.name}. Contact HR if it needs to be redone.` });

  const clean = {};
  for (const sk of skills) {
    const r = ratings[sk.id];
    clean[sk.id] = { self: Math.round(Number(r.self)), evidence: String(r.evidence || '').trim().slice(0, 500) };
  }
  const sub = {
    id: newId(), cycleId: open.id,
    profile: Object.fromEntries(fw.profileFields.map(f => [f.id, String(profile[f.id] || '').trim().slice(0, 300)])),
    ratings: clean, status: 'submitted', submittedAt: new Date().toISOString(), validatedAt: null
  };
  await store.insertSubmission(sub);
  audit('submission.created', req, { sub: sub.id, employeeId: sub.profile.employeeId, cycle: open.name });
  res.json({ ok: true, id: sub.id, cycle: open.name });
}));

// ---------------------------------------------------------------- HR API
const hr = express.Router();
hr.use(hrAuth);

hr.get('/whoami', (req, res) => res.json({ role: req.isAdmin ? 'admin' : 'hr' }));

hr.get('/cycles', wrap(async (_req, res) => res.json(await store.listCycles())));

hr.post('/cycles', wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Cycle name is required (e.g. "FY 2026-27")' });
  const cycles = await store.listCycles();
  if (cycles.some(c => c.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A cycle with this name already exists.' });
  await store.updateCycles(cs => { for (const c of cs) if (c.status === 'open') { c.status = 'closed'; c.closedAt = new Date().toISOString(); } });
  const cyc = { id: newId(), name, status: 'open', createdAt: new Date().toISOString(), closedAt: null };
  await store.insertCycle(cyc);
  audit('cycle.opened', req, { cycle: name });
  res.json(cyc);
}));

hr.put('/cycles/:id', wrap(async (req, res) => {
  const action = (req.body || {}).action;
  let found = null;
  await store.updateCycles(cs => {
    const cyc = cs.find(c => c.id === req.params.id);
    if (!cyc) return;
    found = cyc;
    if (action === 'close') { cyc.status = 'closed'; cyc.closedAt = new Date().toISOString(); }
    else if (action === 'reopen') { for (const c of cs) if (c.status === 'open') { c.status = 'closed'; c.closedAt = new Date().toISOString(); } cyc.status = 'open'; cyc.closedAt = null; }
  });
  if (!found) return res.status(404).json({ error: 'Cycle not found' });
  if (!['close', 'reopen'].includes(action)) return res.status(400).json({ error: 'action must be "close" or "reopen"' });
  audit('cycle.' + action, req, { cycle: found.name });
  res.json(found);
}));

hr.get('/submissions', wrap(async (req, res) => {
  const [fw, cfg, cycles] = await Promise.all([store.getFramework(), store.getConfig(), store.listCycles()]);
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  res.json(subs.map(s => subSummary(s, fw, cfg, cycles)));
}));

hr.get('/submissions/:id', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const [fw, cfg, cycles] = await Promise.all([store.getFramework(), store.getConfig(), store.listCycles()]);
  res.json({
    submission: sub,
    cycleName: (cycles.find(c => c.id === sub.cycleId) || {}).name || '—',
    scores: computeScores(sub, fw, cfg),
    weights: activeWeights(fw, cfg),
    bands: fw.bands,
    history: await employeeHistory(sub.profile.employeeId, sub.id, fw, cfg, cycles)
  });
}));

hr.put('/submissions/:id', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const [fw, cfg] = await Promise.all([store.getFramework(), store.getConfig()]);
  const { validations, finalize } = req.body || {};
  if (validations && typeof validations === 'object') {
    for (const [skillId, v] of Object.entries(validations)) {
      if (!sub.ratings[skillId] || !v || typeof v !== 'object') continue;
      if (v.hr === '' || v.hr == null) sub.ratings[skillId].hr = null;
      else { const n = Math.round(Number(v.hr)); if (!isNaN(n) && n >= 0 && n <= 5) sub.ratings[skillId].hr = n; }
      if (v.remark != null) sub.ratings[skillId].remark = String(v.remark).trim().slice(0, 500);
    }
  }
  if (finalize) {
    const sc = computeScores(sub, fw, cfg);
    if (sc.validatedCount < sc.totalSkills) return res.status(400).json({ error: `Cannot finalize: ${sc.totalSkills - sc.validatedCount} skill(s) still unvalidated.` });
    sub.status = 'validated'; sub.validatedAt = new Date().toISOString();
    audit('submission.finalized', req, { sub: sub.id, employeeId: sub.profile.employeeId, band: sc.band });
  } else audit('submission.validation-saved', req, { sub: sub.id });
  await store.replaceSubmission(sub.id, sub);
  res.json({ ok: true, scores: computeScores(sub, fw, cfg), status: sub.status });
}));

hr.delete('/submissions/:id', wrap(async (req, res) => {
  const removed = await store.deleteSubmission(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Submission not found' });
  audit('submission.deleted', req, { sub: removed.id, employeeId: removed.profile.employeeId });
  res.json({ ok: true });
}));

hr.get('/weights', wrap(async (_req, res) => {
  const [fw, cfg] = await Promise.all([store.getFramework(), store.getConfig()]);
  res.json({ weights: activeWeights(fw, cfg), defaults: Object.fromEntries(fw.domains.map(d => [d.code, d.weight || 0])) });
}));

hr.put('/weights', wrap(async (req, res) => {
  const w = (req.body || {}).weights;
  if (!w || typeof w !== 'object') return res.status(400).json({ error: 'weights object required' });
  const fw = await store.getFramework();
  const clean = {}; let total = 0;
  for (const d of fw.domains) { const v = Number(w[d.code]); clean[d.code] = isNaN(v) || v < 0 ? 0 : Math.min(100, v); total += clean[d.code]; }
  if (total <= 0) return res.status(400).json({ error: 'At least one domain must have a positive weight.' });
  await store.saveConfig({ weights: clean });
  audit('weights.updated', req, {});
  res.json({ ok: true, weights: clean });
}));

hr.get('/analytics', wrap(async (req, res) => {
  const [fw, cfg] = await Promise.all([store.getFramework(), store.getConfig()]);
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const scored = subs.map(s => ({ s, sc: computeScores(s, fw, cfg) }));
  const bandDist = {}; for (const b of (fw.bands || [])) bandDist[b.name] = 0;
  for (const { sc } of scored) if (sc.band) bandDist[sc.band] = (bandDist[sc.band] || 0) + 1;
  const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : null;
  const domainStats = fw.domains.map(d => {
    const selfA = scored.map(({ sc }) => sc.domains.find(x => x.code === d.code).selfAvg);
    const valA = scored.map(({ sc }) => sc.domains.find(x => x.code === d.code).validatedAvg).filter(v => v != null);
    return { code: d.code, name: d.name, selfAvg: avg(selfA), validatedAvg: avg(valA) };
  });
  const skillAvgs = allSkills(fw).map(sk => {
    const vals = subs.map(s => { const r = s.ratings[sk.id] || {}; return r.hr != null && r.hr !== '' ? Number(r.hr) : Number(r.self) || 0; });
    const d = fw.domains.find(d => d.skills.includes(sk));
    return { sno: sk.sno, name: sk.name, domain: d.code, avg: vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : 0 };
  });
  res.json({
    total: subs.length, validated: subs.filter(s => s.status === 'validated').length,
    avgWeightedValidated: avg(scored.map(({ sc }) => sc.weightedValidated).filter(x => x != null)),
    bandDist, domainStats,
    gaps: subs.length ? [...skillAvgs].sort((a, b) => a.avg - b.avg).slice(0, 10) : [],
    strengths: subs.length ? [...skillAvgs].sort((a, b) => b.avg - a.avg).slice(0, 5) : []
  });
}));

// Full analytics dashboard: every metric, leaderboards, per-domain rankings, deep analysis
hr.get('/dashboard', wrap(async (req, res) => {
  const [fw, cfg, cycles] = await Promise.all([store.getFramework(), store.getConfig(), store.listCycles()]);
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const scored = subs.map(s => ({ s, sc: computeScores(s, fw, cfg) }));
  const avg = a => a.length ? +(a.reduce((x, v) => x + v, 0) / a.length).toFixed(2) : null;

  // ---- per-person summary (rank score = validated when available, else self) ----
  const people = scored.map(({ s, sc }) => {
    const skills = allSkills(fw);
    const evidence = skills.filter(sk => (s.ratings[sk.id] || {}).evidence).length;
    return {
      id: s.id, name: s.profile.name, employeeId: s.profile.employeeId || '',
      department: (s.profile.department || '—').trim() || '—',
      designation: s.profile.designation || '', location: s.profile.location || '',
      status: s.status, submittedAt: s.submittedAt, validatedAt: s.validatedAt,
      overallSelf: sc.overallSelf, overallValidated: sc.overallValidated,
      weightedSelf: sc.weightedSelf, weightedValidated: sc.weightedValidated,
      band: sc.band, provisionalBand: sc.provisionalBand,
      rankScore: sc.weightedValidated != null ? sc.weightedValidated : sc.weightedSelf,
      provisional: sc.weightedValidated == null,
      claimDelta: sc.overallValidated != null ? +(sc.overallSelf - sc.overallValidated).toFixed(2) : null,
      evidencePct: skills.length ? Math.round((evidence / skills.length) * 100) : 0,
      domains: Object.fromEntries(sc.domains.map(d => [d.code, d.validatedAvg != null ? d.validatedAvg : d.selfAvg]))
    };
  });

  const leaderboard = [...people].sort((a, b) => b.rankScore - a.rankScore || a.name.localeCompare(b.name))
    .map((p, i) => ({ rank: i + 1, ...p }));

  // ---- per-domain stats + rankings (toppers) ----
  const domainBoards = fw.domains.map(d => {
    const rows = scored.map(({ s, sc }) => {
      const dd = sc.domains.find(x => x.code === d.code);
      return {
        name: s.profile.name, employeeId: s.profile.employeeId || '',
        department: (s.profile.department || '—').trim() || '—',
        score: dd.validatedAvg != null ? dd.validatedAvg : dd.selfAvg,
        validated: dd.validatedAvg != null
      };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const selfAvgs = scored.map(({ sc }) => sc.domains.find(x => x.code === d.code).selfAvg);
    const valAvgs = scored.map(({ sc }) => sc.domains.find(x => x.code === d.code).validatedAvg).filter(v => v != null);
    const a1 = avg(selfAvgs), a2 = avg(valAvgs);
    return {
      code: d.code, name: d.name, weight: activeWeights(fw, cfg)[d.code], skillCount: d.skills.length,
      avgSelf: a1, avgValidated: a2,
      delta: a1 != null && a2 != null ? +(a2 - a1).toFixed(2) : null,
      max: rows.length ? rows[0].score : null, min: rows.length ? rows[rows.length - 1].score : null,
      ranking: rows
    };
  });

  // ---- bands ----
  const bandDist = {};
  for (const b of (fw.bands || [])) bandDist[b.name] = 0;
  for (const { sc } of scored) if (sc.band) bandDist[sc.band] = (bandDist[sc.band] || 0) + 1;

  // ---- departments ----
  const deptMap = {};
  for (const p of people) {
    (deptMap[p.department] = deptMap[p.department] || []).push(p.rankScore);
  }
  const departments = Object.entries(deptMap)
    .map(([name, scores]) => ({ name, count: scores.length, avg: avg(scores) }))
    .sort((a, b) => b.avg - a.avg);

  // ---- score distribution histogram (1.0 buckets on rank score) ----
  const histogram = [0, 1, 2, 3, 4].map(lo => ({
    label: `${lo}.0–${lo + 1}.0`,
    count: people.filter(p => p.rankScore >= lo && (lo === 4 ? p.rankScore <= 5 : p.rankScore < lo + 1)).length
  }));

  // ---- skill gaps & strengths ----
  const skillAvgs = allSkills(fw).map(sk => {
    const vals = subs.map(s => { const r = s.ratings[sk.id] || {}; return r.hr != null && r.hr !== '' ? Number(r.hr) : Number(r.self) || 0; });
    const d = fw.domains.find(d => d.skills.includes(sk));
    return { sno: sk.sno, name: sk.name, domain: d.code, avg: vals.length ? +(vals.reduce((x, v) => x + v, 0) / vals.length).toFixed(2) : 0 };
  });

  // ---- claim accuracy (self vs validated) ----
  const claims = people.filter(p => p.claimDelta != null);
  const overClaim = [...claims].sort((a, b) => b.claimDelta - a.claimDelta).slice(0, 5).filter(p => p.claimDelta > 0);
  const underClaim = [...claims].sort((a, b) => a.claimDelta - b.claimDelta).slice(0, 5).filter(p => p.claimDelta < 0);

  // ---- validation turnaround ----
  const turnDays = scored.filter(({ s }) => s.validatedAt)
    .map(({ s }) => (new Date(s.validatedAt) - new Date(s.submittedAt)) / 86400000);

  res.json({
    cycleName: req.query.cycleId ? ((cycles.find(c => c.id === req.query.cycleId) || {}).name || '—') : 'All cycles',
    totals: {
      submissions: subs.length,
      validated: subs.filter(s => s.status === 'validated').length,
      pending: subs.filter(s => s.status !== 'validated').length,
      avgWeightedValidated: avg(people.map(p => p.weightedValidated).filter(v => v != null)),
      avgWeightedSelf: avg(people.map(p => p.weightedSelf)),
      avgClaimDelta: avg(claims.map(p => p.claimDelta)),
      avgEvidencePct: avg(people.map(p => p.evidencePct)),
      avgValidationDays: turnDays.length ? +avg(turnDays).toFixed(1) : null,
      departments: departments.length
    },
    bandDist, leaderboard, domainBoards, departments, histogram,
    gaps: subs.length ? [...skillAvgs].sort((a, b) => a.avg - b.avg).slice(0, 10) : [],
    strengths: subs.length ? [...skillAvgs].sort((a, b) => b.avg - a.avg).slice(0, 10) : [],
    overClaim, underClaim
  });
}));

hr.get('/audit', wrap(async (_req, res) => res.json(await store.listAudit(100))));

hr.get('/submissions/:id/export.csv', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const [fw, cfg] = await Promise.all([store.getFramework(), store.getConfig()]);
  const lines = [['S.No', 'Domain', 'Skill', 'Self Rating', 'Evidence', 'HR Validated', 'HR Remarks'].join(',')];
  for (const d of fw.domains) for (const sk of d.skills) {
    const r = sub.ratings[sk.id] || {};
    lines.push([sk.sno, csvEsc(d.code + ' - ' + d.name), csvEsc(sk.name), r.self ?? '', csvEsc(r.evidence), r.hr ?? '', csvEsc(r.remark)].join(','));
  }
  const sc = computeScores(sub, fw, cfg);
  lines.push('', 'Domain,Self Avg,Validated Avg,Weight %');
  for (const d of sc.domains) lines.push([csvEsc(d.code + ' - ' + d.name), d.selfAvg, d.validatedAvg ?? '', d.weight].join(','));
  lines.push('', `Overall self,${sc.overallSelf}`, `Overall validated,${sc.overallValidated ?? ''}`, `Weighted self,${sc.weightedSelf}`, `Weighted validated,${sc.weightedValidated ?? ''}`, `Band,${csvEsc(sc.band ?? sc.provisionalBand + ' (provisional)')}`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="METNMAT_assessment_${(sub.profile.name || 'employee').replace(/[^\w]+/g, '_')}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

hr.get('/export.csv', wrap(async (req, res) => {
  const [fw, cfg, cycles] = await Promise.all([store.getFramework(), store.getConfig(), store.listCycles()]);
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const head = ['Employee', 'Employee ID', 'Department', 'Designation', 'Location', 'Cycle', 'Submitted', 'Status', 'Overall Self', 'Weighted Self', 'Overall Validated', 'Weighted Validated', 'Band',
    ...fw.domains.map(d => `${d.code} Self`), ...fw.domains.map(d => `${d.code} Validated`)];
  const lines = [head.join(',')];
  for (const s of subs) {
    const sc = computeScores(s, fw, cfg);
    const cycle = cycles.find(c => c.id === s.cycleId);
    lines.push([csvEsc(s.profile.name), csvEsc(s.profile.employeeId), csvEsc(s.profile.department), csvEsc(s.profile.designation), csvEsc(s.profile.location),
      csvEsc(cycle ? cycle.name : ''), s.submittedAt.slice(0, 10), s.status, sc.overallSelf, sc.weightedSelf, sc.overallValidated ?? '', sc.weightedValidated ?? '', csvEsc(sc.band ?? ''),
      ...sc.domains.map(d => d.selfAvg), ...sc.domains.map(d => d.validatedAvg ?? '')].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="METNMAT_assessments_all.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

// Full Excel export — every metric and every rating in one workbook
hr.get('/export.xlsx', wrap(async (req, res) => {
  const XLSX = require('xlsx');
  const [fw, cfg, cycles] = await Promise.all([store.getFramework(), store.getConfig(), store.listCycles()]);
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const scored = subs.map(s => ({ s, sc: computeScores(s, fw, cfg) }));
  const cycName = id => (cycles.find(c => c.id === id) || {}).name || '—';

  const wb = XLSX.utils.book_new();

  // 1. Summary — one row per employee
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(scored.map(({ s, sc }) => ({
    Employee: s.profile.name, 'Employee ID': s.profile.employeeId, Department: s.profile.department,
    Designation: s.profile.designation, Location: s.profile.location, Cycle: cycName(s.cycleId),
    Submitted: (s.submittedAt || '').slice(0, 10), Status: s.status, Validated: (s.validatedAt || '').slice(0, 10),
    'Overall Self': sc.overallSelf, 'Weighted Self': sc.weightedSelf,
    'Overall Validated': sc.overallValidated ?? '', 'Weighted Validated': sc.weightedValidated ?? '',
    Band: sc.band ?? sc.provisionalBand + ' (provisional)',
    ...Object.fromEntries(sc.domains.flatMap(d => [[`${d.code} Self`, d.selfAvg], [`${d.code} Validated`, d.validatedAvg ?? '']]))
  }))), 'Summary');

  // 2. Skill detail — long format, every rating
  const detail = [];
  for (const { s } of scored) for (const d of fw.domains) for (const sk of d.skills) {
    const r = s.ratings[sk.id] || {};
    detail.push({
      Employee: s.profile.name, 'Employee ID': s.profile.employeeId, Cycle: cycName(s.cycleId),
      Domain: `${d.code} - ${d.name}`, 'S.No': sk.sno, Skill: sk.name,
      'Self Rating': r.self ?? '', Evidence: r.evidence || '', 'HR Validated': r.hr ?? '', 'HR Remarks': r.remark || ''
    });
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail.length ? detail : [{ Note: 'No submissions yet' }]), 'Skill detail');

  // 3. Leaderboard
  const lead = scored.map(({ s, sc }) => ({ n: s.profile.name, d: s.profile.department, score: sc.weightedValidated ?? sc.weightedSelf, band: sc.band ?? sc.provisionalBand + ' (provisional)', v: sc.weightedValidated != null }))
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ Rank: i + 1, Employee: p.n, Department: p.d, 'Weighted Score': p.score, Basis: p.v ? 'validated' : 'self only', Band: p.band }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lead.length ? lead : [{ Note: 'No submissions yet' }]), 'Leaderboard');

  // 4. Domain averages
  const weights = activeWeights(fw, cfg);
  const avg = a => a.length ? +(a.reduce((x, v) => x + v, 0) / a.length).toFixed(2) : '';
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fw.domains.map(d => ({
    Code: d.code, Domain: d.name, Skills: d.skills.length, 'Weight %': weights[d.code],
    'Avg Self': avg(scored.map(({ sc }) => sc.domains.find(x => x.code === d.code).selfAvg)),
    'Avg Validated': avg(scored.map(({ sc }) => sc.domains.find(x => x.code === d.code).validatedAvg).filter(v => v != null))
  }))), 'Domain averages');

  // 5. Framework reference
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fw.domains.flatMap(d =>
    d.skills.map(sk => ({ 'S.No': sk.sno, Code: d.code, Domain: d.name, Skill: sk.name })))), 'Framework');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="METNMAT_assessment_data.xlsx"');
  res.send(buf);
}));

app.use('/api/hr', hr);

// ---------------------------------------------------------------- ADMIN API (full content control)
const admin = express.Router();
admin.use(adminAuth);

admin.get('/framework', wrap(async (_req, res) => res.json(await store.getFramework())));

// Replace the whole framework (the admin editor sends the edited copy). Validated server-side.
admin.put('/framework', wrap(async (req, res) => {
  const fw = req.body || {};
  const err = validateFramework(fw);
  if (err) return res.status(400).json({ error: err });
  // normalize: ensure skill ids + sno, domain codes unique
  const seen = new Set();
  let sno = 1;
  for (const d of fw.domains) {
    d.code = String(d.code || '').trim().toUpperCase().slice(0, 4) || nextDomainCode(fw, seen);
    while (seen.has(d.code)) d.code += 'X';
    seen.add(d.code);
    d.name = String(d.name).trim().slice(0, 120);
    d.weight = Math.max(0, Number(d.weight) || 0);
    for (const sk of d.skills) {
      if (!sk.id) sk.id = 's' + newId();
      sk.name = String(sk.name).trim().slice(0, 200);
      sk.sno = sno++;
    }
  }
  fw.company = String(fw.company || '').trim().slice(0, 120);
  fw.title = String(fw.title || '').trim().slice(0, 160);
  fw.tagline = String(fw.tagline || '').trim().slice(0, 200);
  await store.saveFramework(fw);
  audit('framework.updated', req, { domains: fw.domains.length, skills: allSkills(fw).length });
  res.json({ ok: true, framework: fw });
}));

// rotate keys (admin can change both keys)
admin.put('/keys', wrap(async (req, res) => {
  res.status(501).json({ error: 'Keys are set via ADMIN_KEY / HR_KEY environment variables in production. Update them on your host and restart.' });
}));

// ---- import an Excel/CSV/PDF file and extract categories + skills into a DRAFT (not saved) ----
const HEADER_WORDS = /^(s\.?\s?no\.?|sl\.?|sr\.?|#|no\.?|skill(s)?( \/ competency)?|competenc(y|ies)|question(s)?|self rating.*|rating(s)?( \(0-5\))?|evidence.*|hr .*|remark(s)?|score|weight ?%?|domain|category|group|grp|name|description|level|label|definition)$/i;

function classifyRows(rows) {
  // rows: array of arrays (cells, already trimmed strings)
  const domains = [];
  let current = null;
  const push = name => {
    name = String(name).trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!name) return;
    current = { code: '', name, weight: 0, skills: [] };
    domains.push(current);
  };
  const addSkill = text => {
    text = String(text).trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!text || text.length < 3) return;
    if (HEADER_WORDS.test(text)) return;
    if (!current) push('Imported');
    if (!current.skills.some(s => s.name.toLowerCase() === text.toLowerCase())) current.skills.push({ name: text });
  };

  for (const cells of rows) {
    const nonEmpty = cells.map(c => String(c ?? '').trim()).filter(Boolean);
    if (!nonEmpty.length) continue;
    // header row (>=2 header-ish words) — skip
    if (nonEmpty.length >= 2 && nonEmpty.filter(c => HEADER_WORDS.test(c)).length >= 2) continue;
    const c0 = String(cells[0] ?? '').trim();
    const texts = nonEmpty.filter(c => isNaN(Number(c)) && c.length > 2);
    const longest = texts.sort((a, b) => b.length - a.length)[0];

    if (/^[A-Z]{1,2}$/i.test(c0) && texts.length) {           // [letter][name] = category
      push(longest); current.code = c0.toUpperCase();
    } else if (c0 !== '' && !isNaN(Number(c0)) && longest) {  // [number][skill]
      addSkill(longest);
    } else if (nonEmpty.length === 1 && longest && longest.length <= 90 && !/[.?]$/.test(longest)) {
      push(longest);                                          // single short text cell = category
    } else if (longest) {
      addSkill(longest);
    }
  }
  return domains.filter(d => d.skills.length || domains.length === 1);
}

function classifyPdfLines(text) {
  const rows = [];
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (!line || line.length < 3) continue;
    let m;
    if ((m = line.match(/^([A-Z])[.)]\s+(.{3,90})$/))) rows.push([m[1], m[2]]);                       // "A. Category"
    else if ((m = line.match(/^(?:section|category|domain|part|module)\s*\d*\s*[:\-–]\s*(.{3,90})/i))) rows.push([m[1]]);
    else if (/^[A-Z0-9 &,\/()\-]{4,60}$/.test(line) && /[A-Z]{3}/.test(line) && !/\d{3,}/.test(line)) rows.push([line]); // ALL CAPS heading
    else if ((m = line.match(/^\d+[.)]\s*(.+)/))) rows.push(['1', m[1]]);                              // "12. question"
    else if ((m = line.match(/^[-•*▪o]\s*(.+)/))) rows.push(['1', m[1]]);                              // bullets
    else if (/\?$/.test(line)) rows.push(['1', line]);                                                 // questions
    else if (line.length <= 90 && !/[.;:]$/.test(line)) rows.push(['1', line]);                        // short plain line
  }
  return classifyRows(rows);
}

admin.post('/import', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 8) return res.status(400).json({ error: 'No file received' });
  const filename = String(req.headers['x-filename'] || 'file');
  const isPdf = buf.slice(0, 5).toString() === '%PDF-';
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // xlsx
  let domains = [], source;

  try {
    if (isPdf) {
      source = 'pdf';
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf);
      domains = classifyPdfLines(data.text || '');
    } else if (isZip || /\.(xlsx?|csv)$/i.test(filename)) {
      source = 'excel';
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = [];
      for (const name of wb.SheetNames) {
        const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        // a sheet name that isn't generic can itself act as a category seed
        if (wb.SheetNames.length > 1 && !/^sheet ?\d*$/i.test(name) && sheetRows.some(r => r.some(c => String(c).trim()))) rows.push([name]);
        rows.push(...sheetRows);
      }
      domains = classifyRows(rows);
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload an Excel (.xlsx/.xls/.csv) or PDF file.' });
    }
  } catch (e) {
    console.error('Import parse failed:', e.message);
    return res.status(400).json({ error: 'Could not read the file. Make sure it is a valid Excel or PDF document.' });
  }

  // assign codes to categories that lack one
  const used = new Set(domains.map(d => d.code).filter(Boolean));
  for (const d of domains) {
    if (!d.code) { for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!used.has(c)) { d.code = c; used.add(c); break; } } }
    d.skills = d.skills.slice(0, 500);
  }
  domains = domains.filter(d => d.skills.length).slice(0, 26);
  const total = domains.reduce((s, d) => s + d.skills.length, 0);
  if (!total) return res.status(422).json({ error: 'No questions or skills could be extracted from this file. Check that it contains a list of skills/questions.' });

  audit('framework.import-draft', req, { file: filename.slice(0, 80), source, categories: domains.length, skills: total });
  res.json({ ok: true, source, draft: { domains }, stats: { categories: domains.length, skills: total } });
}));

app.use('/api/admin', admin);

function nextDomainCode(fw, seen) {
  for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!seen.has(c)) return c; }
  return 'Z' + Math.floor(Math.random() * 99);
}

function validateFramework(fw) {
  if (!fw || typeof fw !== 'object') return 'Invalid framework';
  if (!Array.isArray(fw.domains) || fw.domains.length === 0) return 'At least one category (domain) is required';
  if (!Array.isArray(fw.scale) || fw.scale.length < 2) return 'The proficiency scale needs at least 2 levels';
  if (!Array.isArray(fw.bands) || fw.bands.length === 0) return 'At least one band is required';
  if (!Array.isArray(fw.profileFields) || fw.profileFields.length === 0) return 'At least one profile field is required';
  let totalSkills = 0;
  for (const [i, d] of fw.domains.entries()) {
    if (!d.name || !String(d.name).trim()) return `Category ${i + 1}: name is required`;
    if (!Array.isArray(d.skills)) return `Category "${d.name}": skills must be a list`;
    for (const sk of d.skills) if (!sk.name || !String(sk.name).trim()) return `Category "${d.name}": every skill needs a name`;
    totalSkills += d.skills.length;
  }
  if (totalSkills === 0) return 'Add at least one skill';
  for (const b of fw.bands) { if (!b.name || isNaN(Number(b.min)) || isNaN(Number(b.max))) return 'Each band needs a name, min and max'; }
  for (const f of fw.profileFields) { if (!f.id || !f.label) return 'Each profile field needs an id and label'; }
  return null;
}

// ---------------------------------------------------------------- pages & errors
app.get('/assessment', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'assessment.html')));
app.get('/hr', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'hr.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true, driver: store.driver }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(new Date().toISOString(), err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------- backups (file mode, long process only)
function backupDb() {
  const t = store._backupTarget && store._backupTarget();
  if (!t) return;
  try {
    const dir = path.join(t.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `db-${stamp}.json`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify(t.db, null, 2));
    const old = fs.readdirSync(dir).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (old.length > 30) fs.unlinkSync(path.join(dir, old.shift()));
  } catch (e) { console.error('Backup failed:', e.message); }
}

// ---------------------------------------------------------------- boot
// Don't let a slow/failed DB connection take down the process — log and keep serving.
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.message ? e.message : e));

function start() {
  const line = '='.repeat(66);
  const server = app.listen(PORT, '0.0.0.0', async () => {
    const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log(line);
    console.log('METNMAT Skill & Competency Assessment Portal   [storage: ' + store.driver + ']');
    console.log(line);
    console.log(`Local:        http://localhost:${PORT}`);
    for (const ip of nets) console.log(`On your LAN:  http://${ip}:${PORT}   (share with employees)`);
    try {
      await ready;
      const { adminKey, hrKey } = await store.getSecrets();
      const cycles = await store.listCycles();
      const open = cycles.find(c => c.status === 'open');
      console.log(`Admin panel:  /admin   key: ${adminKey}`);
      console.log(`HR dashboard: /hr      key: ${hrKey}`);
      console.log(`Active cycle: ${open ? open.name : 'NONE — open one from the Admin or HR dashboard'}`);
    } catch (e) {
      console.error('!! STORAGE NOT READY:', e.message);
      if (process.env.MONGODB_URI) {
        console.error('   MongoDB connection failed. Check, in MongoDB Atlas:');
        console.error('   1) Database Access — the user/password in MONGODB_URI exist and match');
        console.error('   2) Network Access — IP 0.0.0.0/0 is allowed');
        console.error('   3) the password is URL-encoded in MONGODB_URI (@ -> %40, etc.)');
      }
    }
    console.log(line);
  });
  if (store.driver === 'file') { backupDb(); setInterval(backupDb, 6 * 3600e3).unref(); }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(`\n${sig} — shutting down.`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}

if (require.main === module && !isServerless) start();

module.exports = app;

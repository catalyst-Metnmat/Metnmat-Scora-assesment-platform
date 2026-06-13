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
const { notify, sendEmail } = require('./notify');
const reports = require('./reports');

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

// ---- assessment window & per-employee exception logic ----
function cycleIsLive(cycle, now = Date.now()) {
  if (!cycle || cycle.status !== 'open') return false;
  if (cycle.opensAt && now < Date.parse(cycle.opensAt)) return false;
  if (cycle.closesAt && now > Date.parse(cycle.closesAt)) return false;
  return true;
}
// identity = the SCORA code plus email/name aliases, so HR can grant exceptions
// by email or name (HR never sees the code — it is employee-private).
const draftIdentity = d => [d.employeeId, (d.profile || {}).email, (d.profile || {}).name];
function activeException(cycle, identity, now = Date.now()) {
  const ids = (Array.isArray(identity) ? identity : [identity]).map(normalizeEmpId).filter(Boolean);
  if (!ids.length) return null;
  return (cycle.exceptions || []).find(e =>
    ids.includes(normalizeEmpId(e.employeeId)) && (!e.expiresAt || now <= Date.parse(e.expiresAt))) || null;
}
// access = live window, OR a personal exception granted by HR/Admin
function cycleAccess(cycle, identity) {
  if (cycleIsLive(cycle)) return { allowed: true, mode: 'live' };
  if (activeException(cycle, identity)) return { allowed: true, mode: 'exception' };
  return { allowed: false };
}
// which cycle can this employee work in right now?
function findAccessCycle(cycles, identity) {
  const live = cycles.find(c => cycleIsLive(c));
  if (live) return { cycle: live, mode: 'live' };
  const byNewest = [...cycles].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  for (const c of byNewest) if (activeException(c, identity)) return { cycle: c, mode: 'exception' };
  return null;
}
function publicCycleInfo(cycle) {
  if (!cycle) return null;
  return { id: cycle.id, name: cycle.name, opensAt: cycle.opensAt || null, closesAt: cycle.closesAt || null, durationMinutes: cycle.durationMinutes || 0, isLive: cycleIsLive(cycle) };
}

// per-attempt timer: HR can set cycle.durationMinutes. The effective hard stop
// for an employee is the soonest of (window close, startedAt + duration).
// An HR exception lifts both — they finish freely.
function attemptDeadline(cycle, startedAt, mode) {
  if (!cycle || mode === 'exception') return null;
  const ends = [];
  if (cycle.closesAt) ends.push(Date.parse(cycle.closesAt));
  if (cycle.durationMinutes && startedAt) ends.push(Date.parse(startedAt) + cycle.durationMinutes * 60000);
  return ends.length ? new Date(Math.min(...ends)).toISOString() : null;
}
function attemptExpired(cycle, draft, mode, now = Date.now()) {
  if (mode === 'exception' || !cycle || !cycle.durationMinutes || !draft || !draft.startedAt) return false;
  return now > Date.parse(draft.startedAt) + cycle.durationMinutes * 60000;
}

// ---- framework snapshots: each cycle scores against the framework frozen at
// its creation, so designer edits never corrupt historical results.
// Legacy cycles without a snapshot get one lazily (from the live framework).
function makeFwResolver() {
  const cache = {};
  return async cycleId => {
    if (!cycleId) return store.getFramework();
    if (!cache[cycleId]) {
      cache[cycleId] = (async () => {
        let snap = await store.getFrameworkSnapshot(cycleId);
        if (!snap) { snap = await store.getFramework(); await store.saveFrameworkSnapshot(cycleId, snap); }
        return snap;
      })();
    }
    return cache[cycleId];
  };
}

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
    // per-question weight (default 1 — the master template uses 1 throughout).
    // Self average covers self-scorable questions (rating / auto-scored MCQ);
    // validated average requires HR to have rated every question in the domain.
    let selfSum = 0, selfW = 0, valSum = 0, valW = 0, valCount = 0;
    for (const sk of d.skills) {
      const w = Math.max(0.01, Number(sk.weight) || 1);
      const r = sub.ratings[sk.id] || {};
      if (r.self != null && r.self !== '') { selfSum += (Number(r.self) || 0) * w; selfW += w; }
      if (r.hr != null && r.hr !== '') { valSum += Number(r.hr) * w; valW += w; valCount++; }
    }
    const n = d.skills.length;
    return {
      code: d.code, name: d.name, skillCount: n, weight: weights[d.code],
      selfAvg: selfW ? +(selfSum / selfW).toFixed(2) : 0,
      validatedAvg: n && valCount === n && valW ? +(valSum / valW).toFixed(2) : null,
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

async function employeeHistory(employeeId, excludeSubId, fwFor, cfg, cycles) {
  const eid = normalizeEmpId(employeeId);
  if (!eid) return [];
  const subs = (await store.listSubmissions())
    .filter(s => s.id !== excludeSubId && normalizeEmpId(s.profile.employeeId) === eid);
  const out = [];
  for (const s of subs) {
    const sc = computeScores(s, await fwFor(s.cycleId), cfg);
    const cycle = cycles.find(c => c.id === s.cycleId);
    out.push({
      id: s.id, cycleName: cycle ? cycle.name : '—', submittedAt: s.submittedAt, status: s.status,
      weightedSelf: sc.weightedSelf, weightedValidated: sc.weightedValidated, band: sc.band,
      domains: sc.domains.map(d => ({ code: d.code, name: d.name, selfAvg: d.selfAvg, validatedAvg: d.validatedAvg }))
    });
  }
  return out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

// which questions must be answered before submission (type/required aware)
function missingRequired(fw, ratings) {
  return allSkills(fw).filter(sk => {
    if (sk.required === false) return false;
    const r = ratings[sk.id];
    if (!r) return true;
    const type = sk.type || 'rating';
    if (type === 'rating') return r.self == null || isNaN(Number(r.self)) || Number(r.self) < 0 || Number(r.self) > 5;
    if (type === 'mcq') return r.answer == null || r.answer === '';
    if (type === 'text') return !String(r.answer || '').trim();
    return false;
  });
}

// Final submit: unanswered required items default to 0 / placeholder once the employee accepts the declaration.
function fillMissingForSubmit(fw, ratings) {
  const filled = {};
  for (const sk of allSkills(fw)) {
    const src = ratings[sk.id];
    if (sk.required === false) {
      if (src) filled[sk.id] = { ...src };
      continue;
    }
    const r = { ...(src || {}) };
    const type = sk.type || 'rating';
    if (type === 'rating') {
      if (r.self == null || r.self === '' || isNaN(Number(r.self))) r.self = 0;
    } else if (type === 'mcq') {
      if (r.answer == null || r.answer === '') r.answer = 0;
    } else if (type === 'text') {
      if (!String(r.answer || '').trim()) r.answer = 'Not provided';
    }
    filled[sk.id] = r;
  }
  return filled;
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
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
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

const audit = (event, req, detail = {}) => store.appendAudit({
  ts: new Date().toISOString(), event, ip: req.ip,
  by: (req.identity && req.identity.label) || detail.by, ...detail
});

// ---------------------------------------------------------------- auth (named users + shared keys)
const authFails = new Map();
const lastLoginAudit = new Map(); // ip+actor -> ts, so logins are logged without flooding the audit trail
const LOCK_AFTER = 8, LOCK_MS = 15 * 60 * 1000;
const keyEq = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const b64url = s => Buffer.from(s).toString('base64url');

// minimal HS256 JWT (no external dependency)
async function signToken(payload) {
  const { authSecret } = await store.getSecrets();
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = head + '.' + body;
  const sig = crypto.createHmac('sha256', authSecret).update(data).digest('base64url');
  return data + '.' + sig;
}
async function verifyToken(token) {
  try {
    const [h, b, s] = String(token).split('.');
    if (!h || !b || !s) return null;
    const { authSecret } = await store.getSecrets();
    const expected = crypto.createHmac('sha256', authSecret).update(h + '.' + b).digest('base64url');
    const a = Buffer.from(s), e = Buffer.from(expected);
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

const hashPw = pw => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex'); };
const verifyPw = (pw, stored) => {
  try { const [s, k] = String(stored).split(':'); const dk = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 32); const kb = Buffer.from(k, 'hex'); return dk.length === kb.length && crypto.timingSafeEqual(dk, kb); }
  catch { return false; }
};

// Resolve who is calling: a named-user bearer token, or a shared role key.
async function resolveIdentity(req) {
  const authz = String(req.headers['authorization'] || '');
  if (authz.startsWith('Bearer ')) {
    const p = await verifyToken(authz.slice(7));
    if (p && p.role && p.username) {
      const u = await store.getUser(p.username);
      if (u && u.status !== 'inactive') return { kind: 'user', role: p.role, username: p.username, name: p.name, label: `${p.name} (@${p.username})` };
    }
    return null; // a present-but-invalid token never falls through to a key
  }
  const { adminKey, hrKey } = await store.getSecrets();
  const provided = String(req.headers['x-admin-key'] || req.headers['x-hr-key'] || '');
  if (provided && keyEq(provided, adminKey)) return { kind: 'key', role: 'admin', label: 'Director key' };
  if (provided && keyEq(provided, hrKey)) return { kind: 'key', role: 'hr', label: 'HR key' };
  return null;
}

function makeAuth(level) {
  // level 'hr' accepts hr OR admin; level 'admin' accepts admin (Director) only
  return async (req, res, next) => {
    const ip = req.ip;
    const rec = authFails.get(ip);
    if (rec && rec.until > Date.now()) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    const identity = await resolveIdentity(req);
    if (!identity) {
      const r = rec && rec.until <= Date.now() ? { count: 0, until: 0 } : (rec || { count: 0, until: 0 });
      r.count++;
      if (r.count >= LOCK_AFTER) { r.until = Date.now() + LOCK_MS; r.count = 0; audit('auth.lockout', req, {}); }
      authFails.set(ip, r);
      return res.status(401).json({ error: 'Sign in required.' });
    }
    req.identity = identity;
    req.isAdmin = identity.role === 'admin';
    if (level === 'admin' && !req.isAdmin) return res.status(403).json({ error: 'Director access required.' });
    authFails.delete(ip);
    // audit login activity (one entry per actor per 6h, not per request)
    const lk = ip + ':' + identity.label;
    if (Date.now() - (lastLoginAudit.get(lk) || 0) > 6 * 3600e3) {
      lastLoginAudit.set(lk, Date.now());
      audit('auth.session', req, { role: identity.role });
    }
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

// named-user login → bearer token
app.post('/api/auth/login', wrap(async (req, res) => {
  const ip = req.ip;
  const rec = authFails.get(ip);
  if (rec && rec.until > Date.now()) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const u = username ? await store.getUser(username) : null;
  if (!u || u.status === 'inactive' || !verifyPw(password, u.passwordHash)) {
    const r = rec && rec.until <= Date.now() ? { count: 0, until: 0 } : (rec || { count: 0, until: 0 });
    r.count++;
    if (r.count >= LOCK_AFTER) { r.until = Date.now() + LOCK_MS; r.count = 0; }
    authFails.set(ip, r);
    return res.status(403).json({ error: 'Invalid username or password.' });
  }
  authFails.delete(ip);
  const token = await signToken({ username: u.username, name: u.name, role: u.role, exp: Date.now() + 12 * 3600e3 });
  u.lastLoginAt = new Date().toISOString();
  await store.upsertUser(u);
  audit('auth.login', req, { by: `${u.name} (@${u.username})`, role: u.role });
  res.json({ ok: true, token, name: u.name, role: u.role, username: u.username });
}));

// ---------------------------------------------------------------- employee accounts (SCORA code)
const emailValid = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
async function generateScoraCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); // "0000".."9999"
    if (!(await store.getEmpAccountByCode(code))) return code;
  }
  return null; // directory effectively full (>~10k employees)
}

// Build the branded "your SCORA credentials" email (username = name, password = 4-digit code).
function scoraCredentialEmail({ name, code, loginUrl }) {
  const text =
    `Hello ${name},\n\n` +
    `Your SCORA account is ready. Use these credentials to log in and complete your skill assessment:\n\n` +
    `  Username (your name): ${name}\n` +
    `  SCORA code (password): ${code}\n\n` +
    `Keep this code safe — it is your password to start the assessment and to view your results later.\n\n` +
    `Log in: ${loginUrl}\n\n` +
    `— SCORA · METNMAT Innovations Pvt. Ltd.`;
  const html =
    `<div style="margin:0;padding:24px 0;background:#0a1628;font-family:Inter,Segoe UI,Arial,sans-serif">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
        `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0e1c33;border:1px solid #1c2c4a;border-radius:14px;overflow:hidden">` +
          `<tr><td style="padding:28px 32px 8px;text-align:center">` +
            `<div style="font-family:Cinzel,Georgia,serif;font-size:26px;letter-spacing:3px;color:#fff;font-weight:700">SCORA</div>` +
            `<div style="font-size:12px;color:#8aa0c4;letter-spacing:1px;margin-top:4px">METNMAT Innovations Pvt. Ltd.</div>` +
          `</td></tr>` +
          `<tr><td style="padding:8px 32px 0;color:#e6edf7;font-size:15px;line-height:1.6">` +
            `<p style="margin:16px 0 8px">Hello <b>${name}</b>,</p>` +
            `<p style="margin:0 0 18px;color:#b9c6dc">Your SCORA account is ready. Use the credentials below to log in and complete your skill assessment.</p>` +
          `</td></tr>` +
          `<tr><td style="padding:0 32px">` +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a1628;border:1px solid #1c2c4a;border-radius:10px">` +
              `<tr><td style="padding:14px 18px;border-bottom:1px solid #1c2c4a">` +
                `<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#7f95ba">Username</div>` +
                `<div style="font-size:16px;color:#fff;margin-top:3px">${name}</div>` +
              `</td></tr>` +
              `<tr><td style="padding:14px 18px">` +
                `<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#7f95ba">SCORA code (password)</div>` +
                `<div style="font-size:28px;font-weight:700;letter-spacing:8px;color:#ff5a5f;margin-top:4px;font-family:Sora,Inter,Arial,sans-serif">${code}</div>` +
              `</td></tr>` +
            `</table>` +
          `</td></tr>` +
          `<tr><td style="padding:18px 32px 4px">` +
            `<a href="${loginUrl}" style="display:block;text-align:center;background:#c01d22;color:#fff;text-decoration:none;font-weight:600;padding:12px 0;border-radius:8px;font-size:15px">Start my assessment</a>` +
          `</td></tr>` +
          `<tr><td style="padding:14px 32px 28px;color:#8aa0c4;font-size:12px;line-height:1.6">` +
            `<p style="margin:0">Keep this code safe — it is your password to start the assessment and to view your results later. If you didn't request this, you can ignore this email.</p>` +
            `<p style="margin:12px 0 0;border-top:1px solid #1c2c4a;padding-top:12px;color:#64789c">Sent by SCORA, the skill &amp; competency platform of METNMAT Innovations Pvt. Ltd. · <a href="https://metnmat.com" style="color:#8aa0c4">metnmat.com</a></p>` +
          `</td></tr>` +
        `</table>` +
      `</td></tr></table>` +
    `</div>`;
  return { text, html };
}

// Register: Full Name + Mobile + Email (all mandatory, email unique) → 4-digit SCORA code (password)
app.post('/api/employee/register', submitLimit, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 100);
  const mobile = String((req.body || {}).mobile || '').trim().slice(0, 25);
  const email = String((req.body || {}).email || '').trim().slice(0, 150);
  const doj = String((req.body || {}).doj || '').trim().slice(0, 7); // "YYYY-MM"
  if (!name) return res.status(400).json({ error: 'Full name is required.' });
  if (!mobile || mobile.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'A valid mobile number is required.' });
  if (!emailValid(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(doj)) return res.status(400).json({ error: 'Your joining month and year are required.' });
  const emailNorm = email.toLowerCase();
  if (await store.getEmpAccountByEmail(emailNorm)) return res.status(409).json({ error: 'This email is already registered. Use your SCORA code to log in — or tap "Forgot your code" to have it emailed to you.' });
  const code = await generateScoraCode();
  if (!code) return res.status(507).json({ error: 'Unable to allocate a SCORA code. Contact HR.' });
  const acc = { code, name, nameNorm: name.toLowerCase().replace(/\s+/g, ' '), email, emailNorm, mobile, doj, createdAt: new Date().toISOString() };
  await store.insertEmpAccount(acc);
  audit('employee.registered', req, { email }); // never log the code — it is employee-private
  // Email the employee their credentials (username = name, password = SCORA code).
  // Fire-and-forget: sendEmail never throws and no-ops when RESEND_API_KEY is unset.
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const { text, html } = scoraCredentialEmail({ name, code, loginUrl: `${base}/assessment` });
  const emailed = await sendEmail(email, 'Your SCORA code & login — METNMAT', text, html);
  res.json({ ok: true, code, name, emailed });
}));

// Login: Name + 4-digit SCORA code (the code is globally unique and is the credential)
app.post('/api/employee/login', submitLimit, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const code = String((req.body || {}).code || '').trim();
  const acc = /^\d{4}$/.test(code) ? await store.getEmpAccountByCode(code) : null;
  if (!acc || acc.nameNorm !== name.toLowerCase().replace(/\s+/g, ' '))
    return res.status(403).json({ error: 'Name and SCORA code do not match. Check both, or register if you are new.' });
  res.json({ ok: true, code: acc.code, name: acc.name, email: acc.email, mobile: acc.mobile });
}));

// Forgot code: email it to the registered address. Same response whether the
// email exists or not (no account enumeration); only the inbox owner learns the code.
app.post('/api/employee/recover', submitLimit, wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!emailValid(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const acc = await store.getEmpAccountByEmail(email);
  if (acc) {
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const { text, html } = scoraCredentialEmail({ name: acc.name, code: acc.code, loginUrl: `${base}/assessment` });
    await sendEmail(acc.email, 'Your SCORA code — METNMAT', text, html);
    audit('employee.code-recovery', req, { email });
  }
  res.json({ ok: true, message: 'If that email is registered, your SCORA code has been sent to it.' });
}));

// ---------------------------------------------------------------- public API
app.get('/api/skills', wrap(async (_req, res) => {
  const cycles = await store.listCycles();
  const open = cycles.find(c => c.status === 'open') || null;
  // employees always see the framework FROZEN for the active cycle
  const fw = await makeFwResolver()(open ? open.id : null);
  res.json({
    company: fw.company, title: fw.title, tagline: fw.tagline,
    scale: fw.scale, profileFields: fw.profileFields,
    domains: fw.domains.map(d => ({
      code: d.code, name: d.name,
      skills: d.skills.map(sk => ({ id: sk.id, sno: sk.sno, name: sk.name, type: sk.type || 'rating', options: sk.options, required: sk.required !== false, difficulty: sk.difficulty }))
    })),
    cycle: publicCycleInfo(open)
  });
}));

// ---------------------------------------------------------------- employee sessions (server-side drafts)
// Start (or resume) an assessment session. Identified by employee ID within the
// accessible cycle; returns a session token used for autosave and submission.
app.post('/api/session/start', submitLimit, wrap(async (req, res) => {
  const cycles = await store.listCycles();
  // identity is the employee's SCORA code (their account credential)
  const code = String((req.body || {}).code || '').trim();
  const acc = /^\d{4}$/.test(code) ? await store.getEmpAccountByCode(code) : null;
  if (!acc) return res.status(403).json({ error: 'Invalid SCORA code. Please log in or register first.' });
  const eid = code;

  const access = findAccessCycle(cycles, [acc.code, acc.emailNorm, acc.nameNorm]);
  if (!access) return res.status(423).json({ error: 'The assessment window is closed. Contact HR if you need an exception to be granted.' });
  const { cycle, mode } = access;

  // enrich from the HR directory if this person was onboarded (matched by email)
  const dirRec = (await store.listEmployees()).find(e => (e.email || '').toLowerCase() === acc.emailNorm) || null;

  // assignment targeting: when the cycle is assigned to specific departments or
  // employees, only they can take it (an HR exception always overrides)
  if (mode !== 'exception' && cycle.assign && ((cycle.assign.departments || []).length || (cycle.assign.employees || []).length)) {
    const ids = [acc.code, acc.emailNorm, acc.nameNorm];
    const inEmployees = (cycle.assign.employees || []).some(e => ids.includes(String(e).trim().toLowerCase()));
    const dept = String((dirRec && dirRec.department) || '').trim().toLowerCase();
    const inDepartments = dept && (cycle.assign.departments || []).some(d => String(d).trim().toLowerCase() === dept);
    if (!inEmployees && !inDepartments)
      return res.status(403).json({ error: `This assessment (${cycle.name}) is assigned to specific departments/employees and you are not on the list. Contact HR if you believe this is a mistake.` });
  }

  const existingSub = (await store.listSubmissions(cycle.id)).find(s => normalizeEmpId(s.profile.employeeId) === eid);
  if (existingSub) return res.status(409).json({ error: `An assessment for SCORA code ${code} is already submitted in ${cycle.name}. Contact HR if it needs to be redone.` });

  // profile = the 3 registered fields + SCORA code, enriched with directory role data
  const cleanProfile = {
    name: acc.name, employeeId: acc.code, email: acc.email, mobile: acc.mobile,
    department: (dirRec && dirRec.department) || '', designation: (dirRec && dirRec.designation) || '',
    manager: (dirRec && dirRec.manager) || '', location: (dirRec && dirRec.location) || '', doj: acc.doj || (dirRec && dirRec.doj) || ''
  };
  let draft = await store.getDraftByEmployee(cycle.id, eid);
  if (draft) {
    draft.profile = cleanProfile;
    draft.updatedAt = new Date().toISOString();
  } else {
    draft = {
      id: newId(), token: newId() + newId(), cycleId: cycle.id, employeeId: eid,
      profile: cleanProfile, ratings: {}, step: 0,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    audit('session.started', req, { employee: acc.email, cycle: cycle.name, mode });
  }
  await store.upsertDraft(draft);
  res.json({
    ok: true, token: draft.token, mode,
    cycle: { ...publicCycleInfo(cycle), mode },
    draft: { profile: draft.profile, ratings: draft.ratings, step: draft.step, startedAt: draft.startedAt },
    deadlineAt: attemptDeadline(cycle, draft.startedAt, mode),
    resumed: Object.keys(draft.ratings).length > 0
  });
}));

// Resume a session by token (e.g. employee returns the next day)
app.get('/api/session/:token', wrap(async (req, res) => {
  const draft = await store.getDraftByToken(req.params.token);
  if (!draft) return res.status(404).json({ error: 'Session not found' });
  const cycles = await store.listCycles();
  const cycle = cycles.find(c => c.id === draft.cycleId);
  const access = cycle ? cycleAccess(cycle, draftIdentity(draft)) : { allowed: false };
  const expired = cycle ? attemptExpired(cycle, draft, access.mode) : false;
  res.json({
    ok: true,
    cycle: cycle ? { ...publicCycleInfo(cycle), mode: access.mode || null } : null,
    accessible: access.allowed && !expired,
    expired,
    deadlineAt: cycle ? attemptDeadline(cycle, draft.startedAt, access.mode) : null,
    draft: { profile: draft.profile, ratings: draft.ratings, step: draft.step, startedAt: draft.startedAt }
  });
}));

// Autosave progress (PUT; POST alias supports navigator.sendBeacon on page close)
async function saveSession(req, res) {
  const draft = await store.getDraftByToken(req.params.token);
  if (!draft) return res.status(404).json({ error: 'Session not found' });
  const cycles = await store.listCycles();
  const cycle = cycles.find(c => c.id === draft.cycleId);
  const access = cycle ? cycleAccess(cycle, draftIdentity(draft)) : { allowed: false };
  if (!access.allowed) return res.status(423).json({ error: 'The assessment window has closed. Your progress is saved — contact HR for an exception.' });
  if (attemptExpired(cycle, draft, access.mode)) return res.status(423).json({ error: 'Your time limit for this assessment has elapsed. Your progress is saved — contact HR if you need more time.' });

  let body = req.body;
  if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString('utf8')); } catch { body = {}; } }
  const { ratings, step, profile } = body || {};
  const fw = await makeFwResolver()(draft.cycleId);
  if (ratings && typeof ratings === 'object') {
    const byId = Object.fromEntries(allSkills(fw).map(sk => [sk.id, sk]));
    for (const [id, r] of Object.entries(ratings)) {
      const sk = byId[id];
      if (!sk || !r || typeof r !== 'object') continue;
      const type = sk.type || 'rating';
      const entry = { evidence: String(r.evidence || '').trim().slice(0, 500) };
      if (type === 'rating') {
        const n = Number(r.self);
        entry.self = isNaN(n) || r.self == null || r.self === '' ? null : Math.min(5, Math.max(0, Math.round(n)));
      } else if (type === 'mcq') {
        const a = Number(r.answer);
        entry.answer = isNaN(a) || r.answer == null || r.answer === '' ? null : Math.max(0, Math.round(a));
        if (entry.answer != null && !(sk.options || [])[entry.answer]) entry.answer = null;
        // auto-score when the question defines a correct option (HR can override)
        entry.self = entry.answer == null ? null : (sk.correct != null ? (entry.answer === Number(sk.correct) ? 5 : 0) : null);
      } else if (type === 'text') {
        entry.answer = String(r.answer || '').trim().slice(0, 2000);
        entry.self = null; // subjective answers are scored by HR
      }
      const hasFiles = draft.ratings[id] && Array.isArray(draft.ratings[id].files) && draft.ratings[id].files.length;
      const hasContent = entry.self != null || (entry.answer != null && entry.answer !== '') || entry.evidence || hasFiles;
      if (hasContent) draft.ratings[id] = { ...draft.ratings[id], ...entry };
      else delete draft.ratings[id];
    }
  }
  if (step != null && !isNaN(Number(step))) draft.step = Math.max(0, Math.round(Number(step)));
  // profile is fixed from the employee's SCORA account at session start — not editable mid-assessment
  draft.updatedAt = new Date().toISOString();
  await store.upsertDraft(draft);
  res.json({ ok: true, savedAt: draft.updatedAt });
}
app.put('/api/session/:token', wrap(saveSession));
app.post('/api/session/:token', express.raw({ type: () => true, limit: '2mb' }), wrap(saveSession));

// ---------------------------------------------------------------- evidence attachments
const MAX_ATT_BYTES = 5 * 1024 * 1024;   // 5 MB per file
const MAX_ATT_PER_SKILL = 3;
const ATT_TYPES = {
  'application/pdf': 1, 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'text/plain': 1,
  'application/msword': 1,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 1,
  'application/vnd.ms-excel': 1,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 1
};
const safeName = n => (String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file');

// Employee attaches an evidence file to a skill (raw binary body, ?skill= & ?name=).
app.post('/api/session/:token/attachment', express.raw({ type: () => true, limit: '6mb' }), wrap(async (req, res) => {
  const draft = await store.getDraftByToken(req.params.token);
  if (!draft) return res.status(404).json({ error: 'Session not found. Refresh the page.' });
  const cycles = await store.listCycles();
  const cycle = cycles.find(c => c.id === draft.cycleId);
  const access = cycle ? cycleAccess(cycle, draftIdentity(draft)) : { allowed: false };
  if (!access.allowed || attemptExpired(cycle, draft, access.mode))
    return res.status(423).json({ error: 'The assessment is closed for editing. Your saved work is intact.' });

  const fw = await makeFwResolver()(draft.cycleId);
  const skillId = String(req.query.skill || '');
  const sk = allSkills(fw).find(s => s.id === skillId);
  if (!sk) return res.status(400).json({ error: 'Unknown question.' });

  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) return res.status(400).json({ error: 'Empty file.' });
  if (buf.length > MAX_ATT_BYTES) return res.status(413).json({ error: 'File too large — maximum 5 MB.' });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ATT_TYPES[type]) return res.status(415).json({ error: 'Unsupported type. Allowed: PDF, image, Word, Excel, text.' });

  const existing = (draft.ratings[skillId] && draft.ratings[skillId].files) || [];
  if (existing.length >= MAX_ATT_PER_SKILL) return res.status(409).json({ error: `Up to ${MAX_ATT_PER_SKILL} files per question.` });

  const name = safeName(req.query.name);
  const att = { id: newId(), owner: draft.employeeId, cycleId: draft.cycleId, skillId, name, type, size: buf.length, data: buf.toString('base64'), createdAt: new Date().toISOString() };
  await store.insertAttachment(att);
  const ref = { id: att.id, name, type, size: att.size };
  draft.ratings[skillId] = { ...(draft.ratings[skillId] || {}), files: [...existing, ref] };
  draft.updatedAt = new Date().toISOString();
  await store.upsertDraft(draft);
  audit('attachment.added', req, { employee: draft.profile && draft.profile.email, skill: sk.name, name, size: att.size });
  res.json({ ok: true, file: ref, files: draft.ratings[skillId].files });
}));

// Employee removes an attached file before submitting.
app.delete('/api/session/:token/attachment/:id', wrap(async (req, res) => {
  const draft = await store.getDraftByToken(req.params.token);
  if (!draft) return res.status(404).json({ error: 'Session not found.' });
  const att = await store.getAttachment(req.params.id);
  if (!att || att.owner !== draft.employeeId) return res.status(404).json({ error: 'File not found.' });
  await store.deleteAttachment(att.id);
  const r = draft.ratings[att.skillId];
  if (r && Array.isArray(r.files)) { r.files = r.files.filter(f => f.id !== att.id); if (!r.files.length) delete r.files; }
  draft.updatedAt = new Date().toISOString();
  await store.upsertDraft(draft);
  res.json({ ok: true, files: (draft.ratings[att.skillId] && draft.ratings[att.skillId].files) || [] });
}));

// Download an evidence file. HR/Director may view any; an employee may view only
// their own — by their SCORA code (?code=) or active session token (?token=).
app.get('/api/attachment/:id', wrap(async (req, res) => {
  const att = await store.getAttachment(req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  let allowed = false;
  if (await resolveIdentity(req)) allowed = true;                                   // HR / Director
  else if (req.query.code && String(req.query.code) === att.owner) allowed = true;  // owner by code
  else if (req.query.token) { const d = await store.getDraftByToken(String(req.query.token)); if (d && d.employeeId === att.owner) allowed = true; }
  if (!allowed) return res.status(403).json({ error: 'Not authorised to view this file.' });
  res.setHeader('Content-Type', att.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(att.name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(att.data, 'base64'));
}));

// Final submission — pulls everything from the autosaved server-side draft
app.post('/api/submissions', submitLimit, wrap(async (req, res) => {
  const { token } = req.body || {};
  const draft = await store.getDraftByToken(String(token || ''));
  if (!draft) return res.status(404).json({ error: 'Session not found or already submitted. Refresh the page.' });

  const cycles = await store.listCycles();
  const cycle = cycles.find(c => c.id === draft.cycleId);
  const access = cycle ? cycleAccess(cycle, draftIdentity(draft)) : { allowed: false };
  if (!access.allowed) return res.status(423).json({ error: 'The assessment window has closed. Your progress is saved — contact HR for an exception.' });
  if (attemptExpired(cycle, draft, access.mode)) return res.status(423).json({ error: 'Your time limit for this assessment has elapsed. Your progress is saved — contact HR if you need more time.' });
  const fw = await makeFwResolver()(cycle.id);
  const filledRatings = fillMissingForSubmit(fw, draft.ratings);

  const missing = missingRequired(fw, filledRatings);
  if (missing.length) return res.status(400).json({ error: `${missing.length} question(s) could not be submitted. Please refresh and try again.` });

  const existing = await store.listSubmissions(cycle.id);
  if (existing.find(s => normalizeEmpId(s.profile.employeeId) === draft.employeeId))
    return res.status(409).json({ error: `An assessment for this employee ID already exists in ${cycle.name}. Contact HR if it needs to be redone.` });

  const clean = {};
  for (const sk of allSkills(fw)) {
    const r = filledRatings[sk.id];
    if (!r) continue; // skipped optional question
    clean[sk.id] = {
      self: r.self == null ? null : Math.round(Number(r.self)),
      evidence: String(r.evidence || '').trim().slice(0, 500)
    };
    if (r.answer !== undefined && r.answer !== null && r.answer !== '') clean[sk.id].answer = r.answer;
    if (Array.isArray(r.files) && r.files.length) clean[sk.id].files = r.files.slice(0, MAX_ATT_PER_SKILL);
  }
  const sub = {
    id: newId(), cycleId: cycle.id,
    profile: draft.profile,
    ratings: clean, status: 'submitted',
    viaException: access.mode === 'exception' || undefined,
    submittedAt: new Date().toISOString(), validatedAt: null
  };
  await store.insertSubmission(sub);
  await store.deleteDraft(draft.id);
  // an exception is single-use: granting closes automatically once used
  if (access.mode === 'exception') {
    const ids = draftIdentity(draft).map(normalizeEmpId).filter(Boolean);
    await store.updateCycles(cs => {
      const c = cs.find(x => x.id === cycle.id);
      if (c && c.exceptions) c.exceptions = c.exceptions.filter(e => !ids.includes(normalizeEmpId(e.employeeId)));
    });
    audit('exception.consumed', req, { employeeId: sub.profile.employeeId, cycle: cycle.name });
  }
  audit('submission.created', req, { sub: sub.id, employeeId: sub.profile.employeeId, cycle: cycle.name, mode: access.mode });
  notify('assessment.submitted', {
    title: `Assessment submitted: ${sub.profile.name}`,
    body: `${sub.profile.name} (${sub.profile.employeeId}, ${sub.profile.department || '—'}) submitted their self-assessment for ${cycle.name}${access.mode === 'exception' ? ' via an HR exception' : ''}. Ready for validation.`,
    emailTo: process.env.HR_NOTIFY_EMAIL
  });
  res.json({ ok: true, id: sub.id, cycle: cycle.name });
}));

// ---------------------------------------------------------------- employee self-service (/my)
// Identity check: the employee's name + 4-digit SCORA code (same as the assessment login).
app.post('/api/me', submitLimit, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const code = String((req.body || {}).code || '').trim();
  const acc = /^\d{4}$/.test(code) ? await store.getEmpAccountByCode(code) : null;
  if (!acc || acc.nameNorm !== name.toLowerCase().replace(/\s+/g, ' '))
    return res.status(403).json({ error: 'Name and SCORA code do not match our records.' });
  const eid = acc.code;
  const subs = (await store.listSubmissions()).filter(s => normalizeEmpId(s.profile.employeeId) === eid);
  if (!subs.length) return res.status(404).json({ error: 'No assessment records found yet for your account.' });

  const [cfg, cycles] = await Promise.all([store.getConfig(), store.listCycles()]);
  const fwFor = makeFwResolver();
  const history = [];
  for (const s of subs.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    const fw = await fwFor(s.cycleId);
    const sc = computeScores(s, fw, cfg);
    history.push({
      cycleName: (cycles.find(c => c.id === s.cycleId) || {}).name || '—',
      submittedAt: s.submittedAt, status: s.status,
      overallSelf: sc.overallSelf, weightedSelf: sc.weightedSelf,
      overallValidated: sc.overallValidated, weightedValidated: sc.weightedValidated,
      band: sc.band, provisionalBand: sc.provisionalBand,
      domains: sc.domains.map(d => ({ code: d.code, name: d.name, selfAvg: d.selfAvg, validatedAvg: d.validatedAvg }))
    });
  }
  // skill profile from the latest submission
  const latest = subs[subs.length - 1];
  const latestFw = await fwFor(latest.cycleId);
  const skillScores = latestFw.domains.flatMap(d => d.skills.map(sk => {
    const r = latest.ratings[sk.id] || {};
    const score = r.hr != null && r.hr !== '' ? Number(r.hr) : (r.self != null ? Number(r.self) : null);
    return score == null ? null : { sno: sk.sno, name: sk.name, domain: d.code, score };
  })).filter(Boolean).sort((a, b) => b.score - a.score);
  res.json({
    name: latest.profile.name, employeeId: latest.profile.employeeId,
    department: latest.profile.department, designation: latest.profile.designation,
    history,
    topSkills: skillScores.slice(0, 8),
    weakSkills: skillScores.slice(-8).reverse()
  });
}));

// ---------------------------------------------------------------- HR API
const hr = express.Router();
hr.use(hrAuth);

// SCORA codes are employee-private: not even HR/Director may see them. Scrub
// every 4-digit code (employeeId/code fields) from all HR JSON responses.
// The HR-managed directory (/employees) is exempt — those are HR's own IDs.
const CODE_MASK = '••••';
const looksLikeCode = v => typeof v === 'string' && /^\d{4}$/.test(v);
function scrubCodes(v) {
  if (Array.isArray(v)) return v.map(scrubCodes);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v))
      out[k] = (k === 'employeeId' || k === 'code') && looksLikeCode(val) ? CODE_MASK : scrubCodes(val);
    return out;
  }
  return v;
}
hr.use((req, res, next) => {
  if (req.path === '/employees' || req.path.startsWith('/employees/')) return next();
  const json = res.json.bind(res);
  res.json = body => json(scrubCodes(body));
  next();
});

hr.get('/whoami', (req, res) => res.json({
  role: req.isAdmin ? 'admin' : 'hr',
  name: req.identity.kind === 'user' ? req.identity.name : (req.isAdmin ? 'Director' : 'HR'),
  username: req.identity.username || null,
  kind: req.identity.kind
}));

hr.get('/cycles', wrap(async (_req, res) => res.json(await store.listCycles())));

const parseWhen = v => { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? undefined : new Date(t).toISOString(); };
const parseDuration = v => { const n = Number(v); return isNaN(n) || n <= 0 ? 0 : Math.min(100000, Math.round(n)); };

hr.post('/cycles', wrap(async (req, res) => {
  const { name: rawName, opensAt, closesAt, durationMinutes } = req.body || {};
  const name = String(rawName || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Cycle name is required (e.g. "FY 2026-27")' });
  const o = parseWhen(opensAt), c = parseWhen(closesAt);
  if (o === undefined || c === undefined) return res.status(400).json({ error: 'Invalid date/time format.' });
  if (o && c && Date.parse(c) <= Date.parse(o)) return res.status(400).json({ error: 'The close time must be after the open time.' });
  const cycles = await store.listCycles();
  if (cycles.some(x => x.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A cycle with this name already exists.' });
  await store.updateCycles(cs => { for (const x of cs) if (x.status === 'open') { x.status = 'closed'; x.closedAt = new Date().toISOString(); } });
  const cyc = { id: newId(), name, status: 'open', opensAt: o, closesAt: c, durationMinutes: parseDuration(durationMinutes), exceptions: [], createdAt: new Date().toISOString(), closedAt: null };
  await store.insertCycle(cyc);
  // freeze the framework for this cycle so later designer edits never affect its scoring
  await store.saveFrameworkSnapshot(cyc.id, await store.getFramework());
  audit('cycle.opened', req, { cycle: name, window: `${o || 'now'} -> ${c || 'no limit'}` });
  notify('assessment.assigned', {
    title: `Assessment cycle opened: ${name}`,
    body: `The assessment window ${name} is now ${o ? 'scheduled (opens ' + o.slice(0, 16).replace('T', ' ') + ' UTC)' : 'open'}${c ? ', closes ' + c.slice(0, 16).replace('T', ' ') + ' UTC' : ''}. Employees can take their assessment at the portal.`,
    emailTo: process.env.HR_NOTIFY_EMAIL
  });
  res.json(cyc);
}));

hr.put('/cycles/:id', wrap(async (req, res) => {
  const { action, opensAt, closesAt, departments, employees } = req.body || {};
  let found = null, err = null;
  await store.updateCycles(cs => {
    const cyc = cs.find(c => c.id === req.params.id);
    if (!cyc) return;
    found = cyc;
    if (action === 'close') { cyc.status = 'closed'; cyc.closedAt = new Date().toISOString(); }
    else if (action === 'reopen') { for (const c of cs) if (c.status === 'open') { c.status = 'closed'; c.closedAt = new Date().toISOString(); } cyc.status = 'open'; cyc.closedAt = null; }
    else if (action === 'schedule') {
      const o = parseWhen(opensAt), c2 = parseWhen(closesAt);
      if (o === undefined || c2 === undefined) { err = 'Invalid date/time format.'; return; }
      if (o && c2 && Date.parse(c2) <= Date.parse(o)) { err = 'The close time must be after the open time.'; return; }
      cyc.opensAt = o; cyc.closesAt = c2;
      if (req.body.durationMinutes !== undefined) cyc.durationMinutes = parseDuration(req.body.durationMinutes);
    }
    else if (action === 'assign') {
      // target the assessment at specific departments and/or employee IDs (empty = everyone)
      const assign = {
        departments: (Array.isArray(departments) ? departments : []).map(s => String(s).trim()).filter(Boolean).slice(0, 50),
        employees: (Array.isArray(employees) ? employees : []).map(s => String(s).trim()).filter(Boolean).slice(0, 1000)
      };
      // set null (not delete) so the change persists under Mongo $set
      cyc.assign = (assign.departments.length || assign.employees.length) ? assign : null;
    }
  });
  if (!found) return res.status(404).json({ error: 'Cycle not found' });
  if (err) return res.status(400).json({ error: err });
  if (!['close', 'reopen', 'schedule', 'assign'].includes(action)) return res.status(400).json({ error: 'action must be "close", "reopen", "schedule" or "assign"' });
  audit('cycle.' + action, req, { cycle: found.name, ...(action === 'assign' ? { departments: (found.assign || {}).departments || [], employees: ((found.assign || {}).employees || []).length } : {}) });
  res.json(found);
}));

// Director-only: complete system overview (everything, everywhere)
hr.get('/overview', wrap(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Director access only' });
  const [cycles, subs, employees, drafts, cfg, auditLog] = await Promise.all([
    store.listCycles(), store.listSubmissions(), store.listEmployees(), store.listDrafts(), store.getConfig(), store.listAudit(20)
  ]);
  const fwFor = makeFwResolver();
  const scoresByCycle = {};
  for (const s of subs) {
    const sc = computeScores(s, await fwFor(s.cycleId), cfg);
    (scoresByCycle[s.cycleId] = scoresByCycle[s.cycleId] || []).push({ status: s.status, v: sc.weightedValidated });
  }
  const avg = a => a.length ? +(a.reduce((x, v) => x + v, 0) / a.length).toFixed(2) : null;
  const cycleRows = [...cycles].reverse().map(c => {
    const list = scoresByCycle[c.id] || [];
    return {
      id: c.id, name: c.name, status: c.status, isLive: cycleIsLive(c),
      opensAt: c.opensAt || null, closesAt: c.closesAt || null,
      assigned: c.assign ? ((c.assign.departments || []).length + ' dept / ' + (c.assign.employees || []).length + ' emp') : 'everyone',
      exceptions: (c.exceptions || []).length,
      submissions: list.length,
      validated: list.filter(x => x.status === 'validated').length,
      avgValidated: avg(list.map(x => x.v).filter(v => v != null)),
      inProgress: drafts.filter(d => d.cycleId === c.id).length
    };
  });
  res.json({
    totals: {
      cycles: cycles.length, submissions: subs.length,
      validated: subs.filter(s => s.status === 'validated').length,
      employees: employees.length, inProgress: drafts.length,
      activeCycle: (cycles.find(c => cycleIsLive(c)) || {}).name || null
    },
    cycles: cycleRows,
    recentActivity: auditLog
  });
}));

// ---- per-employee exceptions: reopen a closed assessment for specific employees ----
hr.post('/cycles/:id/exceptions', wrap(async (req, res) => {
  const { employeeId, name, hours } = req.body || {};
  const eid = String(employeeId || '').trim();
  if (!eid) return res.status(400).json({ error: 'Employee ID is required.' });
  const h = Number(hours);
  const expiresAt = !isNaN(h) && h > 0 ? new Date(Date.now() + h * 3600e3).toISOString() : null;
  let found = null;
  await store.updateCycles(cs => {
    const cyc = cs.find(c => c.id === req.params.id);
    if (!cyc) return;
    found = cyc;
    cyc.exceptions = (cyc.exceptions || []).filter(e => normalizeEmpId(e.employeeId) !== normalizeEmpId(eid));
    cyc.exceptions.push({ employeeId: eid, name: String(name || '').trim().slice(0, 100), grantedAt: new Date().toISOString(), expiresAt });
  });
  if (!found) return res.status(404).json({ error: 'Cycle not found' });
  audit('exception.granted', req, { employeeId: eid, cycle: found.name, expiresAt: expiresAt || 'until removed' });
  const dirRec = await store.getEmployee(normalizeEmpId(eid));
  notify('assessment.reopened', {
    title: `Assessment reopened for ${name || eid}`,
    body: `An exception was granted for employee ID ${eid} in ${found.name}${expiresAt ? ', valid until ' + expiresAt.slice(0, 16).replace('T', ' ') + ' UTC' : ''}. They can now start or resume their assessment.`,
    emailTo: (dirRec && dirRec.email) || undefined
  });
  res.json({ ok: true, exceptions: found.exceptions });
}));

hr.delete('/cycles/:id/exceptions/:employeeId', wrap(async (req, res) => {
  const eid = normalizeEmpId(decodeURIComponent(req.params.employeeId));
  let found = null;
  await store.updateCycles(cs => {
    const cyc = cs.find(c => c.id === req.params.id);
    if (!cyc) return;
    found = cyc;
    cyc.exceptions = (cyc.exceptions || []).filter(e => normalizeEmpId(e.employeeId) !== eid);
  });
  if (!found) return res.status(404).json({ error: 'Cycle not found' });
  audit('exception.removed', req, { employeeId: eid, cycle: found.name });
  res.json({ ok: true, exceptions: found.exceptions });
}));

// in-progress drafts (live monitoring during the window)
hr.get('/drafts', wrap(async (req, res) => {
  const fw = await store.getFramework();
  const total = allSkills(fw).length;
  const drafts = await store.listDrafts(req.query.cycleId || undefined);
  res.json(drafts.map(d => ({
    id: d.id, cycleId: d.cycleId, name: d.profile.name, email: d.profile.email || '',
    department: d.profile.department || '—',
    ratedCount: Object.keys(d.ratings).length, totalSkills: total,
    startedAt: d.startedAt, updatedAt: d.updatedAt
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
}));

// discard an abandoned in-progress draft
hr.delete('/drafts/:id', wrap(async (req, res) => {
  const drafts = await store.listDrafts();
  const d = drafts.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Draft not found' });
  await store.deleteDraft(d.id);
  await store.deleteAttachmentsByOwner(d.employeeId, d.cycleId); // drop the abandoned draft's evidence files
  audit('draft.discarded', req, { employeeId: d.profile.employeeId });
  res.json({ ok: true });
}));

hr.get('/submissions', wrap(async (req, res) => {
  const [cfg, cycles] = await Promise.all([store.getConfig(), store.listCycles()]);
  const fwFor = makeFwResolver();
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const out = [];
  for (const s of subs) out.push(subSummary(s, await fwFor(s.cycleId), cfg, cycles));
  res.json(out);
}));

hr.get('/submissions/:id', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const [cfg, cycles] = await Promise.all([store.getConfig(), store.listCycles()]);
  const fwFor = makeFwResolver();
  const fw = await fwFor(sub.cycleId);
  const sc = computeScores(sub, fw, cfg);

  // ---- deep analysis: rank within cycle, domain comparison vs company, skill extremes, band gap ----
  const cycleSubs = await store.listSubmissions(sub.cycleId);
  const cycleScored = cycleSubs.map(s => ({ id: s.id, sc: computeScores(s, fw, cfg) }));
  const rankOf = x => x.sc.weightedValidated != null ? x.sc.weightedValidated : x.sc.weightedSelf;
  const ordered = [...cycleScored].sort((a, b) => rankOf(b) - rankOf(a));
  const rank = ordered.findIndex(x => x.id === sub.id) + 1;
  const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : null;

  const companyDomainAvgs = Object.fromEntries(fw.domains.map(d => [d.code,
    avg(cycleScored.map(({ sc }) => { const dd = sc.domains.find(x => x.code === d.code); return dd.validatedAvg != null ? dd.validatedAvg : dd.selfAvg; }))]));

  const skillScores = fw.domains.flatMap(d => d.skills.map(sk => {
    const r = sub.ratings[sk.id] || {};
    return { sno: sk.sno, name: sk.name, domain: d.code, score: r.hr != null && r.hr !== '' ? Number(r.hr) : Number(r.self) || 0 };
  }));
  const sortedSkills = [...skillScores].sort((a, b) => b.score - a.score || a.sno - b.sno);

  const myScore = sc.weightedValidated != null ? sc.weightedValidated : sc.weightedSelf;
  const sortedBands = [...(fw.bands || [])].sort((a, b) => a.min - b.min);
  const nextBand = sortedBands.find(b => b.min > myScore) || null;

  res.json({
    submission: sub,
    cycleName: (cycles.find(c => c.id === sub.cycleId) || {}).name || '—',
    scores: sc,
    weights: activeWeights(fw, cfg),
    bands: fw.bands,
    history: await employeeHistory(sub.profile.employeeId, sub.id, fwFor, cfg, cycles),
    analysis: {
      rank, totalInCycle: cycleScored.length,
      percentile: cycleScored.length > 1 ? Math.round(((cycleScored.length - rank) / (cycleScored.length - 1)) * 100) : 100,
      companyDomainAvgs,
      topSkills: sortedSkills.slice(0, 5),
      weakSkills: sortedSkills.slice(-5).reverse(),
      domainDeltas: sc.domains.map(d => ({ code: d.code, delta: d.validatedAvg != null ? +(d.selfAvg - d.validatedAvg).toFixed(2) : null })),
      nextBand: nextBand ? { name: nextBand.name, needed: +(nextBand.min - myScore).toFixed(2) } : null
    }
  });
}));

hr.put('/submissions/:id', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const cfg = await store.getConfig();
  const fw = await makeFwResolver()(sub.cycleId);
  const { validations, finalize } = req.body || {};
  if (validations && typeof validations === 'object') {
    const valid = new Set(allSkills(fw).map(sk => sk.id));
    for (const [skillId, v] of Object.entries(validations)) {
      if (!valid.has(skillId) || !v || typeof v !== 'object') continue;
      if (!sub.ratings[skillId]) sub.ratings[skillId] = { self: null, evidence: '' }; // skipped optional question — HR can still score it
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
    const dirRec = await store.getEmployee(normalizeEmpId(sub.profile.employeeId));
    notify('assessment.evaluated', {
      title: `Evaluation completed: ${sub.profile.name}`,
      body: `${sub.profile.name} (${sub.profile.employeeId}) has been evaluated. Weighted validated score ${sc.weightedValidated} — ${sc.band}.`,
      emailTo: (dirRec && dirRec.email) || undefined
    });
  } else audit('submission.validation-saved', req, { sub: sub.id });
  await store.replaceSubmission(sub.id, sub);
  res.json({ ok: true, scores: computeScores(sub, fw, cfg), status: sub.status });
}));

hr.delete('/submissions/:id', wrap(async (req, res) => {
  const removed = await store.deleteSubmission(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Submission not found' });
  await store.deleteAttachmentsByOwner(normalizeEmpId(removed.profile.employeeId), removed.cycleId); // remove its evidence files
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
async function buildDashboardData(cycleId) {
  const [fw, cfg, cycles] = await Promise.all([store.getFramework(), store.getConfig(), store.listCycles()]);
  const fwFor = makeFwResolver();
  const subs = await store.listSubmissions(cycleId || undefined);
  const scored = [];
  for (const s of subs) scored.push({ s, sc: computeScores(s, await fwFor(s.cycleId), cfg) });
  const avg = a => a.length ? +(a.reduce((x, v) => x + v, 0) / a.length).toFixed(2) : null;

  // ---- per-person summary (rank score = validated when available, else self) ----
  const people = scored.map(({ s, sc }) => {
    const skills = allSkills(fw);
    const evidence = skills.filter(sk => (s.ratings[sk.id] || {}).evidence).length;
    return {
      id: s.id, name: s.profile.name, email: s.profile.email || '',
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

  return {
    cycleName: cycleId ? ((cycles.find(c => c.id === cycleId) || {}).name || '—') : 'All cycles',
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
    allSkillAvgs: skillAvgs, // full per-skill company averages (used by the Skill-Gap & Matrix reports)
    overClaim, underClaim
  };
}

hr.get('/dashboard', wrap(async (req, res) => res.json(await buildDashboardData(req.query.cycleId))));

// Executive summary PDF (management report for a cycle or all cycles)
hr.get('/report.pdf', wrap(async (req, res) => {
  const dash = await buildDashboardData(req.query.cycleId);
  await reports.executiveSummary(res, { dash, cycleName: dash.cycleName });
}));

// Dedicated analytical reports (all reuse the dashboard data bundle + framework)
hr.get('/report/departments.pdf', wrap(async (req, res) => {
  const dash = await buildDashboardData(req.query.cycleId);
  await reports.departmentReport(res, { dash, cycleName: dash.cycleName, fw: await store.getFramework() });
  audit('report.departments', req, { cycle: dash.cycleName });
}));
hr.get('/report/skill-gap.pdf', wrap(async (req, res) => {
  const dash = await buildDashboardData(req.query.cycleId);
  await reports.skillGapReport(res, { dash, cycleName: dash.cycleName, fw: await store.getFramework() });
  audit('report.skillGap', req, { cycle: dash.cycleName });
}));
hr.get('/report/competency-matrix.pdf', wrap(async (req, res) => {
  const dash = await buildDashboardData(req.query.cycleId);
  await reports.competencyMatrix(res, { dash, cycleName: dash.cycleName, fw: await store.getFramework() });
  audit('report.competencyMatrix', req, { cycle: dash.cycleName });
}));
hr.get('/report/hr-evaluation.pdf', wrap(async (req, res) => {
  const dash = await buildDashboardData(req.query.cycleId);
  await reports.hrEvaluationReport(res, { dash, cycleName: dash.cycleName, fw: await store.getFramework() });
  audit('report.hrEvaluation', req, { cycle: dash.cycleName });
}));

// Per-employee assessment report PDF
hr.get('/submissions/:id/report.pdf', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const [cfg, cycles] = await Promise.all([store.getConfig(), store.listCycles()]);
  const fwFor = makeFwResolver();
  const fw = await fwFor(sub.cycleId);
  await reports.employeeReport(res, {
    sub, fw,
    scores: computeScores(sub, fw, cfg),
    cycleName: (cycles.find(c => c.id === sub.cycleId) || {}).name || '—',
    history: await employeeHistory(sub.profile.employeeId, sub.id, fwFor, cfg, cycles)
  });
}));

hr.get('/audit', wrap(async (_req, res) => res.json(await store.listAudit(100))));

// ---------------------------------------------------------------- employee directory
// self-registered employee accounts (SCORA-code logins) — HR can view/remove
hr.get('/empaccounts', wrap(async (_req, res) => {
  // the SCORA code is employee-private — never include it here
  const accounts = (await store.listEmpAccounts())
    .map(({ nameNorm, emailNorm, code, ...a }) => a)
    .sort((p, q) => (p.name || '').localeCompare(q.name || ''));
  res.json({ accounts });
}));
// delete by email — HR identifies accounts by email, never by code
hr.delete('/empaccounts/:email', wrap(async (req, res) => {
  const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
  const a = await store.getEmpAccountByEmail(email);
  if (!a) return res.status(404).json({ error: 'Account not found' });
  await store.deleteEmpAccount(a.code);
  audit('employee.account-deleted', req, { email: a.email });
  res.json({ ok: true });
}));

hr.get('/employees', wrap(async (_req, res) => {
  const employees = (await store.listEmployees()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({
    employees,
    departments: [...new Set(employees.map(e => e.department).filter(Boolean))].sort(),
    designations: [...new Set(employees.map(e => e.designation).filter(Boolean))].sort()
  });
}));

function cleanEmployee(raw) {
  const employeeId = String(raw.employeeId || '').trim().slice(0, 50);
  if (!employeeId) return null;
  return {
    employeeId, employeeIdNorm: normalizeEmpId(employeeId),
    name: String(raw.name || '').trim().slice(0, 100),
    email: String(raw.email || '').trim().slice(0, 150),
    department: String(raw.department || '').trim().slice(0, 80),
    designation: String(raw.designation || '').trim().slice(0, 80),
    manager: String(raw.manager || '').trim().slice(0, 50),
    location: String(raw.location || '').trim().slice(0, 80),
    doj: String(raw.doj || '').trim().slice(0, 10),
    status: raw.status === 'inactive' ? 'inactive' : 'active',
    updatedAt: new Date().toISOString()
  };
}

hr.post('/employees', wrap(async (req, res) => {
  const emp = cleanEmployee(req.body || {});
  if (!emp) return res.status(400).json({ error: 'Employee ID is required.' });
  if (!emp.name) return res.status(400).json({ error: 'Name is required.' });
  await store.upsertEmployee(emp);
  audit('employee.saved', req, { employeeId: emp.employeeId, status: emp.status });
  res.json({ ok: true, employee: emp });
}));

hr.delete('/employees/:eid', wrap(async (req, res) => {
  const eid = normalizeEmpId(decodeURIComponent(req.params.eid));
  const existing = await store.getEmployee(eid);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  await store.deleteEmployee(eid);
  audit('employee.deleted', req, { employeeId: existing.employeeId });
  res.json({ ok: true });
}));

// bulk onboarding via Excel/CSV — flexible header matching
hr.post('/employees/import', express.raw({ type: () => true, limit: '10mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 4) return res.status(400).json({ error: 'No file received' });
  const XLSX = require('xlsx');
  let rows;
  try {
    const wb = XLSX.read(req.body, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch { return res.status(400).json({ error: 'Could not read the file. Upload an Excel or CSV with a header row.' }); }
  const pick = (row, ...names) => {
    for (const k of Object.keys(row)) if (names.some(n => k.toLowerCase().replace(/[^a-z]/g, '').includes(n))) return row[k];
    return '';
  };
  let imported = 0, skipped = 0;
  for (const row of rows) {
    const emp = cleanEmployee({
      employeeId: pick(row, 'employeeid', 'empid', 'id'),
      name: pick(row, 'name'),
      email: pick(row, 'email', 'mail'),
      department: pick(row, 'department', 'dept', 'function'),
      designation: pick(row, 'designation', 'role', 'title'),
      manager: pick(row, 'manager', 'reporting'),
      location: pick(row, 'location', 'city', 'site'),
      doj: String(pick(row, 'doj', 'joining', 'dateofjoining')).slice(0, 10),
      status: String(pick(row, 'status')).toLowerCase().includes('inactive') ? 'inactive' : 'active'
    });
    if (emp && emp.name) { await store.upsertEmployee(emp); imported++; } else skipped++;
  }
  if (!imported) return res.status(422).json({ error: 'No employees could be read. The sheet needs at least "Employee ID" and "Name" columns.' });
  audit('employee.bulk-import', req, { imported, skipped });
  res.json({ ok: true, imported, skipped });
}));

hr.get('/submissions/:id/export.csv', wrap(async (req, res) => {
  const sub = await store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const cfg = await store.getConfig();
  const fw = await makeFwResolver()(sub.cycleId);
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
  const fwFor = makeFwResolver();
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const head = ['Employee', 'Email', 'Department', 'Designation', 'Location', 'Cycle', 'Submitted', 'Status', 'Overall Self', 'Weighted Self', 'Overall Validated', 'Weighted Validated', 'Band',
    ...fw.domains.map(d => `${d.code} Self`), ...fw.domains.map(d => `${d.code} Validated`)];
  const lines = [head.join(',')];
  for (const s of subs) {
    const sc = computeScores(s, await fwFor(s.cycleId), cfg);
    const cycle = cycles.find(c => c.id === s.cycleId);
    lines.push([csvEsc(s.profile.name), csvEsc(s.profile.email || ''), csvEsc(s.profile.department), csvEsc(s.profile.designation), csvEsc(s.profile.location),
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
  const fwFor = makeFwResolver();
  const subs = await store.listSubmissions(req.query.cycleId || undefined);
  const scored = [];
  for (const s of subs) scored.push({ s, sc: computeScores(s, await fwFor(s.cycleId), cfg) });
  const cycName = id => (cycles.find(c => c.id === id) || {}).name || '—';

  const wb = XLSX.utils.book_new();

  // 1. Summary — one row per employee
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(scored.map(({ s, sc }) => ({
    Employee: s.profile.name, Email: s.profile.email || '', Department: s.profile.department,
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
      Employee: s.profile.name, Email: s.profile.email || '', Cycle: cycName(s.cycleId),
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

// ---------------------------------------------------------------- DESIGNER + GOVERNANCE API
// Role model: HR conducts the assessment — designer + import are HR-level
// (the Director/admin key also passes). Key management stays Director-only.
const admin = express.Router();

admin.get('/framework', hrAuth, wrap(async (_req, res) => res.json(await store.getFramework())));

// Replace the whole framework (the designer sends the edited copy). Validated server-side.
admin.put('/framework', hrAuth, wrap(async (req, res) => {
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
      // question-type metadata (defaults preserve the master template exactly)
      sk.type = ['rating', 'mcq', 'text'].includes(sk.type) ? sk.type : 'rating';
      if (sk.type === 'rating') { delete sk.options; delete sk.correct; }
      else if (sk.type === 'mcq') {
        sk.options = (Array.isArray(sk.options) ? sk.options : []).map(o => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
        sk.correct = sk.correct != null && sk.correct !== '' && sk.options[Number(sk.correct)] ? Number(sk.correct) : null;
      } else { delete sk.options; delete sk.correct; }
      if (sk.required === false) sk.required = false; else delete sk.required;
      const w = Number(sk.weight);
      if (!isNaN(w) && w > 0 && w !== 1) sk.weight = Math.min(10, w); else delete sk.weight;
      if (['basic', 'intermediate', 'advanced'].includes(sk.difficulty)) {} else delete sk.difficulty;
      if (sk.type === 'rating') delete sk.type; // keep master template storage byte-identical
    }
  }
  fw.company = String(fw.company || '').trim().slice(0, 120);
  fw.title = String(fw.title || '').trim().slice(0, 160);
  fw.tagline = String(fw.tagline || '').trim().slice(0, 200);
  await store.saveFramework(fw);
  audit('framework.updated', req, { domains: fw.domains.length, skills: allSkills(fw).length, by: req.isAdmin ? 'director' : 'hr' });
  res.json({ ok: true, framework: fw });
}));

// ---- named user management (Director only) ----
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
admin.get('/users', adminAuth, wrap(async (_req, res) => {
  const users = (await store.listUsers()).map(({ passwordHash, ...u }) => u).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ users });
}));
admin.post('/users', adminAuth, wrap(async (req, res) => {
  const { username: rawU, name, role, password } = req.body || {};
  const username = String(rawU || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3–32 chars: letters, numbers, dot, dash, underscore.' });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Full name is required.' });
  if (!['hr', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be HR or Director.' });
  const existing = await store.getUser(username);
  const user = {
    username, name: String(name).trim().slice(0, 100), role,
    status: (req.body.status === 'inactive') ? 'inactive' : 'active',
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    lastLoginAt: existing ? existing.lastLoginAt : null,
    passwordHash: existing ? existing.passwordHash : null
  };
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    user.passwordHash = hashPw(password);
  } else if (!existing) {
    return res.status(400).json({ error: 'A password is required for a new user.' });
  }
  await store.upsertUser(user);
  audit('user.saved', req, { user: username, role });
  res.json({ ok: true });
}));
admin.delete('/users/:username', adminAuth, wrap(async (req, res) => {
  const username = String(req.params.username || '').toLowerCase();
  const u = await store.getUser(username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  await store.deleteUser(username);
  audit('user.deleted', req, { user: username });
  res.json({ ok: true });
}));

// key management — Director-only: rotate the director key and reset HR's key.
// Runtime keys override the ADMIN_KEY / HR_KEY environment variables.
admin.put('/keys', adminAuth, wrap(async (req, res) => {
  const { role, key } = req.body || {};
  if (!['admin', 'hr'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "hr"' });
  const k = String(key || '').trim();
  if (k.length < 8 || k.length > 64) return res.status(400).json({ error: 'Key must be 8–64 characters.' });
  if (/\s/.test(k)) return res.status(400).json({ error: 'Key cannot contain spaces.' });
  const current = await store.getSecrets();
  const other = role === 'admin' ? current.hrKey : current.adminKey;
  if (k === other) return res.status(400).json({ error: 'Admin and HR keys must be different.' });
  await store.saveSecrets({ [role === 'admin' ? 'adminKey' : 'hrKey']: k });
  audit('keys.changed', req, { role }); // the key itself is never logged
  res.json({ ok: true, role });
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

admin.post('/import', hrAuth, express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
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
    for (const sk of d.skills) {
      if (!sk.name || !String(sk.name).trim()) return `Category "${d.name}": every skill needs a name`;
      if (sk.type === 'mcq' && (!Array.isArray(sk.options) || sk.options.filter(o => String(o).trim()).length < 2))
        return `"${String(sk.name).slice(0, 50)}": MCQ questions need at least 2 options`;
    }
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
app.get('/my', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'my.html')));

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
      console.log(`Designer (/admin):     HR key or Director key`);
      console.log(`HR dashboard (/hr):    hr key: ${hrKey}`);
      console.log(`Director (oversight + key management): admin key: ${adminKey}`);
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

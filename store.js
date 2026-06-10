/*
 * Storage abstraction with two interchangeable drivers:
 *   - mongo : MongoDB Atlas (set MONGODB_URI) — used in production / any free host
 *   - file  : local JSON files under data/  — used for local development
 *
 * The driver is chosen automatically by the presence of MONGODB_URI.
 * Every method is async so the server code is identical for both drivers.
 *
 * Data model (logical):
 *   framework : the editable assessment definition (domains, skills, scale, bands, profileFields)
 *   config    : { weights }  — HR weight overrides
 *   secrets   : { adminKey, hrKey }
 *   cycles[]  : { id, name, status, createdAt, closedAt }
 *   submissions[] : { id, cycleId, profile, ratings, status, submittedAt, validatedAt }
 *   audit[]   : { ts, event, ip, ... }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const SEED_FILE = path.join(DATA_DIR, 'skills.json');

const newId = () => crypto.randomBytes(8).toString('base64url');
const loadJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const seedFramework = () => loadJson(SEED_FILE, null);

// ============================================================ FILE DRIVER
function fileDriver() {
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  const FW_FILE = path.join(DATA_DIR, 'framework.json');
  const CFG_FILE = path.join(DATA_DIR, 'config.json');
  const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const writeAtomic = (file, content) => {
    const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  };

  let db = loadJson(DB_FILE, { cycles: [], submissions: [] });
  if (!Array.isArray(db.cycles)) db.cycles = [];
  if (!Array.isArray(db.submissions)) db.submissions = [];

  let framework = loadJson(FW_FILE, null);
  let config = loadJson(CFG_FILE, {});

  const saveDb = () => writeAtomic(DB_FILE, JSON.stringify(db, null, 2));
  const saveFw = () => writeAtomic(FW_FILE, JSON.stringify(framework, null, 2));
  const saveCfg = () => writeAtomic(CFG_FILE, JSON.stringify(config, null, 2));

  return {
    driver: 'file',
    async init() {
      if (!framework) { framework = seedFramework(); if (framework) saveFw(); }
      // migrate pre-cycle submissions into a legacy closed cycle
      if (db.submissions.some(s => !s.cycleId)) {
        const legacy = { id: newId(), name: 'Initial cycle', status: 'closed', createdAt: new Date().toISOString(), closedAt: new Date().toISOString() };
        db.cycles.unshift(legacy);
        for (const s of db.submissions) if (!s.cycleId) s.cycleId = legacy.id;
        saveDb();
      }
      // keys: env overrides, else generate + persist
      if (!config.adminKey) config.adminKey = crypto.randomBytes(12).toString('base64url');
      if (!config.hrKey) config.hrKey = crypto.randomBytes(12).toString('base64url');
      saveCfg();
    },
    async getSecrets() {
      return {
        adminKey: process.env.ADMIN_KEY || config.adminKey,
        hrKey: process.env.HR_KEY || config.hrKey
      };
    },
    async getFramework() { return framework; },
    async saveFramework(fw) { framework = fw; saveFw(); },
    async getConfig() { return { weights: config.weights || null }; },
    async saveConfig(cfg) { config.weights = cfg.weights; saveCfg(); },
    async listCycles() { return db.cycles.slice(); },
    async insertCycle(c) { db.cycles.push(c); saveDb(); return c; },
    async updateCycles(mutator) { mutator(db.cycles); saveDb(); },
    async listSubmissions(cycleId) { return (cycleId ? db.submissions.filter(s => s.cycleId === cycleId) : db.submissions).map(s => JSON.parse(JSON.stringify(s))); },
    async getSubmission(id) { const s = db.submissions.find(x => x.id === id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    async insertSubmission(s) { db.submissions.push(s); saveDb(); return s; },
    async replaceSubmission(id, s) { const i = db.submissions.findIndex(x => x.id === id); if (i >= 0) db.submissions[i] = s; saveDb(); },
    async deleteSubmission(id) { const i = db.submissions.findIndex(x => x.id === id); if (i < 0) return null; const [r] = db.submissions.splice(i, 1); saveDb(); return r; },
    async appendAudit(entry) { fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', () => {}); },
    async listAudit(limit = 100) {
      try { return fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-limit).reverse().map(l => JSON.parse(l)); }
      catch { return []; }
    },
    _backupTarget() { return { db, dir: DATA_DIR }; }
  };
}

// ============================================================ MONGO DRIVER
function mongoDriver(uri) {
  const { MongoClient } = require('mongodb');
  const dbName = process.env.MONGODB_DB || 'metnmat_assessment';

  // cache the client across (serverless) invocations; a failed connect clears
  // the cache so the next request retries instead of staying broken forever
  const getClient = () => {
    if (!global.__metnmatMongo) {
      const p = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 }).connect();
      p.catch(() => { if (global.__metnmatMongo === p) global.__metnmatMongo = undefined; });
      global.__metnmatMongo = p;
    }
    return global.__metnmatMongo;
  };
  const col = async name => (await getClient()).db(dbName).collection(name);

  return {
    driver: 'mongo',
    async init() {
      const meta = await col('meta');
      if (!(await meta.findOne({ _id: 'framework' }))) {
        const seed = seedFramework();
        if (seed) await meta.updateOne({ _id: 'framework' }, { $set: { _id: 'framework', value: seed } }, { upsert: true });
      }
      const cfg = await meta.findOne({ _id: 'secrets' });
      const secrets = (cfg && cfg.value) || {};
      let changed = false;
      if (!secrets.adminKey) { secrets.adminKey = crypto.randomBytes(12).toString('base64url'); changed = true; }
      if (!secrets.hrKey) { secrets.hrKey = crypto.randomBytes(12).toString('base64url'); changed = true; }
      if (changed) await meta.updateOne({ _id: 'secrets' }, { $set: { _id: 'secrets', value: secrets } }, { upsert: true });
      await (await col('submissions')).createIndex({ cycleId: 1 });
      await (await col('audit')).createIndex({ ts: -1 });
    },
    async getSecrets() {
      const meta = await col('meta');
      const s = (await meta.findOne({ _id: 'secrets' }) || {}).value || {};
      return { adminKey: process.env.ADMIN_KEY || s.adminKey, hrKey: process.env.HR_KEY || s.hrKey };
    },
    async getFramework() { return ((await (await col('meta')).findOne({ _id: 'framework' })) || {}).value || null; },
    async saveFramework(fw) { await (await col('meta')).updateOne({ _id: 'framework' }, { $set: { value: fw } }, { upsert: true }); },
    async getConfig() { return { weights: (((await (await col('meta')).findOne({ _id: 'config' })) || {}).value || {}).weights || null }; },
    async saveConfig(cfg) { await (await col('meta')).updateOne({ _id: 'config' }, { $set: { value: { weights: cfg.weights } } }, { upsert: true }); },
    async listCycles() { return (await (await col('cycles')).find({}).toArray()).map(({ _id, ...c }) => c); },
    async insertCycle(c) { await (await col('cycles')).insertOne({ _id: c.id, ...c }); return c; },
    async updateCycles(mutator) {
      const cycles = (await (await col('cycles')).find({}).toArray()).map(({ _id, ...c }) => c);
      mutator(cycles);
      const cc = await col('cycles');
      for (const c of cycles) await cc.updateOne({ _id: c.id }, { $set: c }, { upsert: true });
    },
    async listSubmissions(cycleId) {
      const q = cycleId ? { cycleId } : {};
      return (await (await col('submissions')).find(q).toArray()).map(({ _id, ...s }) => s);
    },
    async getSubmission(id) { const s = await (await col('submissions')).findOne({ _id: id }); if (!s) return null; const { _id, ...rest } = s; return rest; },
    async insertSubmission(s) { await (await col('submissions')).insertOne({ _id: s.id, ...s }); return s; },
    async replaceSubmission(id, s) { await (await col('submissions')).replaceOne({ _id: id }, { _id: id, ...s }); },
    async deleteSubmission(id) { const s = await this.getSubmission(id); if (s) await (await col('submissions')).deleteOne({ _id: id }); return s; },
    async appendAudit(entry) { try { await (await col('audit')).insertOne(entry); } catch {} },
    async listAudit(limit = 100) { return (await (await col('audit')).find({}).sort({ ts: -1 }).limit(limit).toArray()).map(({ _id, ...e }) => e); },
    _backupTarget() { return null; } // Mongo data is durable; no local file backup
  };
}

// ============================================================ FACTORY
const store = process.env.MONGODB_URI ? mongoDriver(process.env.MONGODB_URI) : fileDriver();
store.newId = newId;
module.exports = store;

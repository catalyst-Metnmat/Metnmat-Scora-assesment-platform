# METNMAT Skill & Competency Assessment Portal

Production portal for the METNMAT Innovations Pvt. Ltd. proficiency-based compensation and promotion framework. Built from `METNMAT_Skill_Assessment.xlsx` — 16 categories (A–P), 227 skills, 0–5 proficiency scale, HR validation, configurable weights, and 5 career bands. Designed for **annual use**, with a full **Admin designer** to change any category/skill/scale/band, a database backend that survives free cloud hosting, and one-click free deployment.

---

## Roles & pages

| Page | Who | What they do |
|---|---|---|
| `/` → `/assessment` | Employees | Self-assess (no login). One submission per employee per cycle. |
| `/hr` | HR | Validate submissions, manage cycles, analytics, CSV exports. |
| `/admin` | Admin | **Full content control** — add/edit/delete categories & skills, edit the scale, bands, weights, and profile fields. Plus everything HR can do. |

There are **two keys**: `ADMIN_KEY` (full power) and `HR_KEY` (validation only). The admin key also works on the HR dashboard.

---

## Run locally (no database needed)

```bash
npm install
npm start
```

Open `http://localhost:3010`. With no `MONGODB_URI`, it uses local JSON files in `data/` and prints both keys + the active cycle in the console.

---

## Deploy for free

You need **two free accounts**: MongoDB Atlas (the database, so data survives) and a host (Render or Vercel). Total cost: ₹0.

### What you must give me / set (the only secrets)

| Variable | Where it comes from | Required? |
|---|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string | **Yes** (for cloud) |
| `ADMIN_KEY` | You invent a strong secret | **Yes** in production |
| `HR_KEY` | You invent a strong secret | **Yes** in production |
| `MONGODB_DB` | Database name | Optional (default `metnmat_assessment`) |

Generate two strong keys (run twice):
```bash
node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"
```

### Step 1 — MongoDB Atlas (the database)

1. Sign up at **https://www.mongodb.com/atlas** → create a **free M0 cluster** (512 MB, never expires).
2. **Database Access** → Add a database user (username + password). Save the password.
3. **Network Access** → Add IP `0.0.0.0/0` (allow from anywhere — required for cloud hosts).
4. **Database → Connect → Drivers** → copy the connection string. It looks like:
   `mongodb+srv://USER:<db_password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   Replace `<db_password>` with the user password from step 2. **This is your `MONGODB_URI`.**

On first start, the app automatically seeds all 16 categories and 227 skills from `data/skills.json` into the database.

### Step 2a — Deploy on Render (recommended, simplest)

1. Push this folder to a **GitHub** repo (`git init`, commit, push). `node_modules` and runtime data are already git-ignored.
2. Go to **https://render.com** → **New → Web Service** → connect the repo.
3. Render reads `render.yaml` automatically (Build: `npm install`, Start: `node server.js`, health check `/healthz`).
4. Under **Environment**, add: `MONGODB_URI`, `ADMIN_KEY`, `HR_KEY`.
5. Deploy. You get a public HTTPS URL like `https://metnmat-assessment.onrender.com`.

> Render's free service sleeps after 15 min idle (~30 s cold start on the next visit) — perfectly fine for a yearly assessment tool. Data lives in Atlas, so sleeping never loses anything.

### Step 2b — Deploy on Vercel (alternative)

This app is already Vercel-ready (`vercel.json` + `api/index.js`).

1. Push to GitHub.
2. **https://vercel.com → New Project →** import the repo (framework preset: **Other**).
3. **Settings → Environment Variables**: add `MONGODB_URI`, `ADMIN_KEY`, `HR_KEY`.
4. Deploy → public HTTPS URL like `https://metnmat-assessment.vercel.app`.

> Vercel runs the app as serverless functions. It works well; just note free functions have a ~10 s timeout and the brute-force lockout is best-effort across cold starts (the timing-safe key check still fully protects you). For an always-on single process, Render is slightly simpler — both are free.

### Step 3 — First login

Visit `/admin` with your `ADMIN_KEY` and `/hr` with your `HR_KEY`. Open a cycle (e.g. "FY 2026-27") and share the base URL with employees.

---

## Annual workflow

1. **Open a cycle** (HR or Admin → *Manage cycles*, e.g. "FY 2026-27"). Opening one auto-closes the previous; while none is open the employee portal is closed.
2. **Employees self-assess** at `/` — profile → all categories (every skill 0–5) → declaration → submit. Draft auto-saves per cycle on their device. One submission per employee ID.
3. **HR validates** each submission in the validation interview, then **Save & finalize** to assign the band from the weighted validated score.
4. **Review** — analytics (band distribution, domain heatmap, top skill gaps/strengths), per-employee **year-over-year** history with domain deltas, CSV exports (per employee or whole cycle), and an audit log.

## Editing the assessment (Admin)

`/admin` → tabs for **Categories & Skills** (add/edit/delete/reorder), **Proficiency scale**, **Bands**, **Profile fields**, and **Titles**. Save applies to future submissions and recalculates all scores. Changing content is best done **between cycles**.

## Bands (default — fully editable in Admin)

| Score | Band |
|---|---|
| 0.00–1.49 | Band 1 – Trainee / Entry |
| 1.50–2.49 | Band 2 – Associate / Junior |
| 2.50–3.49 | Band 3 – Executive / Engineer |
| 3.50–4.24 | Band 4 – Senior / Specialist |
| 4.25–5.00 | Band 5 – Lead / Principal |

## Security & reliability

- Keys via `X-Admin-Key` / `X-HR-Key` headers only (never in URLs), constant-time comparison, lockout after repeated failures.
- Strict Content-Security-Policy and security headers; all scoring is server-side; inputs validated server-side; submission rate limiting.
- MongoDB persistence (durable); local file mode keeps atomic writes + daily backups in `data/backups/` and an audit log.

## Files

- `server.js` — app, API, scoring, roles · `store.js` — Mongo/file storage abstraction
- `import-skills.js` — re-seed `data/skills.json` from Excel: `node import-skills.js <xlsx>`
- `api/index.js`, `vercel.json`, `render.yaml`, `.env.example` — deployment
- `public/` — landing, assessment wizard, HR dashboard, Admin designer

## Updating the deployed app

Edit code → `git commit` → `git push`. Render/Vercel redeploy automatically. CSS/JS revalidate on every load, so changes show immediately (no stale cache).

# SCORA — Project Context & Handoff

_Last updated: 10 Jun 2026. Read this first when resuming work._

## 1. What this is
**SCORA** (platform name) — the **Employee Skill & Competency Assessment & Evaluation portal** for **METNMAT Innovations Pvt. Ltd.** (the company). It runs the company's proficiency-based compensation & promotion framework: employees self-rate on a 0–5 scale across the full skill catalogue, HR validates each rating in an interview, scores roll up to a career band.

- **Location:** `C:\Users\ritik\OneDrive\Desktop\Metnmat assesment portal`
- **Stack:** Node + Express 5, vanilla JS frontend (no framework/build step), MongoDB Atlas (with a local-file fallback).
- **Run locally:** `npm install` then `npm start` → http://localhost:3010 (port 3010). Preview launch config name: `metnmat-assessment` (in the parent project's `.claude/launch.json`).
- **Master data source:** `C:\Users\ritik\Downloads\METNMAT_Skill_Assessment.xlsx` — 16 domains (A–P), **227 skills**, 0–5 scale, 5 bands, domain weights. `node import-skills.js <xlsx>` regenerates `data/skills.json` (the seed). The live framework is verified an EXACT match of the workbook — this is the master template and must not be silently altered.

## 2. Status
- **~16 build passes done.** Git: ~16 commits on `master`. **NOT yet pushed to GitHub and NOT yet deployed.**
- **Live backend:** MongoDB Atlas is connected and working (`assessment_admin@cluster0.xf0g4j5`). The full `.env` (gitignored) has the real `MONGODB_URI`, `ADMIN_KEY`, `HR_KEY`. **Keys are also stored in auto-memory.**
- **Demo data: CLEARED (10 Jun 2026, pre-handover).** All test submissions, drafts, SCORA accounts and attachments were deleted; the DB holds only the framework (16 domains / 227 skills), the open cycle "FY 2026-27" + its snapshot, and the audit trail. The platform is at a clean first-run state for the company.
- **Audit/readiness:** see `AUDIT.md` — ~94/100 for deployed purpose, ~90/100 vs the full enterprise spec.

## 3. Roles & authentication
Three actors, dual-mode auth (named accounts OR shared keys):

- **Director** (`ADMIN_KEY`, or a named user with role `admin`) — full oversight: Company Overview, read-only Admin stats, Users management, key rotation, plus everything HR can do.
- **HR** (`HR_KEY`, or named user role `hr`) — conducts assessments: cycles & assignment, employee directory, validation/evaluation, analytics, exports, and the embedded Designer.
- **Employee** — **no key.** Registers with **Full Name + Mobile + Email + Joining month/year** (all mandatory, email unique) → gets a **unique 4-digit SCORA code** (their password; username = their name). Logs in with **Name + SCORA code**.

**Mechanics:**
- Staff auth: `resolveIdentity()` in `server.js` accepts a **Bearer JWT** (HS256, 12h, named user) OR a shared key header (`X-Admin-Key`/`X-HR-Key`). Timing-safe compare, 8-fail lockout. Client stores credential in `localStorage`/`sessionStorage` key **`scora-auth`** `{mode:'token'|'key', value, name, role}`, shared by `hr.js` AND `designer.js`/`admin.js` (single sign-in across pages).
- Named users: `POST /api/auth/login` → token. Director-only CRUD at `/api/admin/users`. Password = scrypt; token secret = `JWT_SECRET` env or auto-generated `authSecret`.
- Employee identity = the **SCORA code** (it's `profile.employeeId` on submissions). Endpoints: `POST /api/employee/register`, `POST /api/employee/login`, and `session/start` takes `{code}`.

## 4. Assessment lifecycle (cycles)
A **cycle** (e.g. "FY 2026-27") is one assessment round. Fields: `{id, name, status:'open'|'closed', opensAt, closesAt, durationMinutes, assign, exceptions[]}`.
- **Window:** `opensAt`/`closesAt` — overall availability. `cycleIsLive()` = open AND within window.
- **Per-attempt timer:** `durationMinutes` — a per-employee countdown that starts when they begin; effective deadline = soonest of window-close and start+duration (`attemptDeadline`/`attemptExpired`). Wizard shows a live mm:ss countdown and auto-locks (progress saved) on expiry.
- **Assignment:** `assign = {departments[], employees[]}` (empty/null = everyone). Enforced at session start (employee's department comes from the HR directory by email; employee match by code/email/name).
- **Exceptions:** `exceptions[{employeeId,name,expiresAt}]` — reopen a closed/expired assessment for specific people; auto-removed when they submit; override window + timer.
- Opening a new cycle auto-closes the previous. One submission per employee per cycle.

## 5. Employee experience (`/` → `/assessment`, `/my`)
- Landing `/` = marketing/info page (hero, scale ladder, domains, "How it works"). Links: My Results, HR Console.
- `/assessment` = **register/login card** → (if new) **code-reveal screen** → wizard: domain-by-domain rating (0–5 buttons; also supports MCQ/subjective for future templates), evidence text, sticky progress + countdown, **server-side autosave** (debounced + `sendBeacon`), resume by token or by re-login. Review screen + declaration → submit.
- Sessions are **server-side drafts** (`drafts` collection) keyed by token and by employeeId(code). Token in `localStorage` `metnmat-session-token`.
- `/my` = employee self-dashboard: login with Name + SCORA code → history, score trends, competency breakdown, strengths/growth areas.

## 6. HR / Director dashboard (`/hr`)
Single-page app with a **`.subnav` tab bar**; role-aware ("HR Console" vs "Director Console"):
- **Overview** (Director) — company-wide KPIs, all cycles table, recent HR activity.
- **Admin** (Director, read-only) — company stats only (bands, departments, domain proficiency, gaps/strengths).
- **Submissions** — list + in-progress drafts; click a submission → **validation detail** (per-skill HR rating + remarks, accept-self, finalize→band, deep analysis: rank/percentile/vs-company/next-band, year-over-year, PDF/CSV).
- **Analytics** — full dashboard: leaderboard, per-domain toppers, proficiency matrix, dept comparison, claim accuracy, gaps/strengths, attention flags.
- **Employees** — HR directory (CRUD, Excel/CSV bulk import, status, reporting-manager **org-tree**). Also `/api/hr/empaccounts` to view/delete self-registered SCORA accounts.
- **Cycles & assign** — create/schedule cycles, set window + time limit, assign to depts/employees, exceptions; **"Build / edit assessment"** button opens the Designer.
- **Users** (Director) — named HR/Director account CRUD.
- **Settings** — domain weights, audit log, sign out.

**Designer** = `public/designer.js`, a self-contained `window.Designer.mount(container, {authHeaders, role, onError, onKeyChange, toast})` module. Mounted **natively** (no iframe) in the dashboard (via "Build / edit assessment") and on the standalone `/admin` page. Edits categories, skills (add/edit/delete/reorder, per-question type/weight/difficulty/optional), scale, bands, profile fields, titles; Excel/PDF **import**; Excel **export**; key management (Director only). Saves whole framework via `PUT /api/admin/framework`.

## 7. Scoring & framework snapshots
- Each cycle **freezes a framework snapshot** at creation (`makeFwResolver()` → `meta` doc `fwsnap_<cycleId>`). All scoring uses the cycle's frozen framework, so later Designer edits never corrupt historical results.
- `computeScores(sub, fw, cfg)`: per-domain self/validated averages (per-question weighted), overall + weighted scores, band from weighted-validated. Weights configurable (`config.weights`), default from workbook.

## 8. Storage (`store.js`)
Two interchangeable async drivers chosen by `MONGODB_URI`:
- **mongo** (production) — collections: `meta` (framework, config, secrets, `fwsnap_*`), `cycles`, `submissions`, `drafts`, `employees`, `users`, `empAccounts`, `audit`. Connection cached on `global` for serverless.
- **file** (local dev, no URI) — `data/db.json`, `framework.json`, `config.json`, `audit.log`, daily `backups/`. Seeds framework from `data/skills.json`.
- **Mongo gotcha (fixed, watch for recurrence):** `updateCycles` uses `$set` — you cannot `delete obj.field` to clear; set it to `null` instead (this bit the assign-clear).

## 9. Reports / exports / audit
- CSV (per employee + per cycle), 5-sheet Excel workbook (`/api/hr/export.xlsx`), PDF via `pdfkit` (`reports.js`): per-employee report + executive summary (buffered-then-send).
- Audit log records logins, submissions, evaluations, finalizations, cycle/exception/assignment changes, framework edits, key/user changes, with `by` (named user or key) + IP.
- **Notifications were intentionally REMOVED** (user decision) — do not re-add without asking.

## 10. Deployment (not done yet)
Free path = **MongoDB Atlas + Render** (or Vercel). Files ready: `render.yaml`, `vercel.json` + `api/index.js`, `.env.example`, `/healthz`.
Steps: push to GitHub → Render New Web Service (reads `render.yaml`) → set env vars `MONGODB_URI`, `ADMIN_KEY`, `HR_KEY` (optionally `JWT_SECRET`, `MONGODB_DB`). `.env`, `node_modules`, runtime `data/*` are gitignored; `data/skills.json` (seed) IS tracked.
**Before rollout:** rotate the Mongo password + both keys (they've appeared in chat), delete the DEMO submissions, set a weekly backup/export habit (Atlas free tier has no auto-backup).

## 11. File map
- `server.js` — app, all APIs, scoring, auth, lifecycle. `store.js` — storage drivers. `reports.js` — PDFs. `import-skills.js` — re-seed from Excel. `test-mongo.js` — connection check. `api/index.js` — Vercel entry.
- `public/`: `index.html`+`home.js` (landing), `assessment.html`+`assessment.js` (employee wizard), `hr.html`+`hr.js` (HR/Director dashboard), `admin.html`+`admin.js` (standalone designer bootstrap), `designer.js` (designer module), `my.html`+`my.js` (employee self-dashboard), `404.html`, `style.css`, `favicon.svg`.
- `data/skills.json` (seed, tracked); `data/*` runtime (gitignored). `.env` (gitignored, real secrets). `README.md`, `AUDIT.md`, this `CONTEXT.md`.

## 12. Design system
Navy `#0a1628` + brand red `#c01d22` (CSS vars still named `--copper*`). Fonts: Sora (headings), Inter (body), Cinzel (SCORA wordmark) via Google Fonts (CSP allows fonts.googleapis/​gstatic). Logo = red/black interlocked M/N SVG monogram. Premium motion (shimmer, fadeUp, pop, scroll-reveal); respects `prefers-reduced-motion`. CSP is strict — **no inline scripts** (inline styles allowed).

## 13. Verification quirks (this machine)
- `preview_screenshot` often **times out** because continuous CSS animations never let the page go "idle" — verify via `preview_snapshot` / `preview_eval` / computed styles instead.
- Preview proxy **blocks cross-frame `iframe.contentDocument`** reads — test embedded views by navigating the top window instead.
- PowerShell 5.1: `Get-Content -Raw` without `-Encoding UTF8` mojibakes UTF-8 files; commit messages with inner quotes break `-m` — use `-F` or careful here-strings. Git shows harmless LF→CRLF warnings.
- Verify flows with both a shared key (`HR_KEY`/`ADMIN_KEY`) and check role gating; always clean up test data (drafts, submissions, empAccounts) afterward, keep the DEMO pair.

## 14. Likely next steps / open items
- GitHub push + Render deploy (the main remaining action).
- Optional from the spec, not built: evidence **file upload/attachments** (needs object storage; base64-in-Mongo is the fallback option), WhatsApp transport, approval workflow beyond finalize, full SSO.
- The Designer still has a "Profile fields" tab from the pre-SCORA model — now unused by the employee flow (harmless; could hide).

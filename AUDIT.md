# SCORA — Production Audit & Readiness Report

**Platform:** SCORA — Employee Skill & Competency Assessment & Evaluation portal
**Company:** METNMAT Innovations Pvt. Ltd.
**Audited:** 10 Jun 2026 · against the enterprise HR-assessment spec
**Method:** every claim below was verified against the running code (`server.js`, `store.js`, `reports.js`, `public/*`) and exercised live on MongoDB Atlas — nothing is assumed complete.

> **Headline:** The original METNMAT Skill Assessment workbook (16 domains A–P, 227 skills, 0–5 scale, 5 bands, domain weights) is the verified master template and is preserved byte-for-byte. Each cycle freezes its own framework snapshot, so later edits never corrupt historical results.

---

## 1. Existing Features (verified present)

### Identity & roles
- **Employee self-registration → unique 4-digit SCORA code** (random `0000`–`9999`, collision-checked). Username = name, password = code. Login = name + code. ✔
- **Credentials emailed** on registration (branded HTML via Resend) + **self-service "Forgot your code"** recovery (no account enumeration). ✔ *(sending blocked only by domain verification — see §3.)*
- **SCORA code is employee-private** — masked from every HR/Director API response, export, and audit entry; HR identifies people by email. ✔
- **Three roles** with dual auth: **Director** (admin key or named `admin` JWT), **HR** (HR key or named `hr` JWT), **Employee** (code). JWT HS256 12 h; timing-safe key compare; **8-fail lockout**; named-user CRUD (scrypt). ✔
- RBAC enforced server-side (`hrAuth`/`adminAuth`, `req.isAdmin`); Director sees everything HR sees plus overview, users, key rotation. ✔

### Assessment lifecycle
- **Cycles** with `status`, **opensAt/closesAt window**, **per-attempt timer** (`durationMinutes`), activate/close, one-submission-per-employee-per-cycle. ✔
- **Assignment targeting** (departments / specific employees; empty = everyone). ✔
- **Reopen for specific employees** via per-person **exceptions** (temporary, auto-consumed on submit, identity-matched by code/email/name). ✔
- **Auto-save** (debounced + `sendBeacon` on page-hide) to server-side drafts; **resume** by token or by re-login from any device. ✔
- **Session persistence** — server-side draft keyed by token + employee; no repeated login during an attempt. ✔
- **Forward-only flow** — once a domain is completed and confirmed it locks; only further questions appear (per business rule). ✔

### Question & evaluation engine
- Question types: **Rating 0–5, MCQ (auto-scored when a correct option is set), Subjective/Text**. Per-question **weight, difficulty, mandatory/optional, skill category, competency group (domain), HR remarks, evidence field**. ✔
- **Evidence upload / file attachments** — PDF/image/Word/Excel/text, ≤5 MB, ≤3 per question; owner- or HR-gated download; cleaned up on draft/submission delete. ✔ *(new this pass)*
- Evaluation: HR reviews answers, **manually scores, overrides auto-scores, adds remarks, finalizes → band**. System computes **self rating, HR/validated rating, variance (claim delta), per-question weighted, weighted overall, final band**. ✔

### Employee management
- Directory CRUD; **department, designation, reporting-manager hierarchy (org-tree)**; **Excel/CSV bulk import**; status (active/inactive). ✔

### Analytics
- **Employee** `/my`: history, score trends, competency breakdown, strongest/growth skills. ✔
- **HR**: completion, department performance, skill-gap & strengths, top/low performers, proficiency matrix, attention flags, pending evaluations. ✔
- **Director**: company overview, per-cycle stats, recent HR activity, read-only company stats tab. ✔

### Audit, reports, security
- **Audit log**: logins, register, session start, submission, evaluation, finalize, cycle/window/assignment/exception changes, framework edits, key/user changes, attachment add, draft/submission delete — each with actor + IP. ✔
- **Exports**: per-employee & per-cycle **CSV**, 5-sheet **Excel** workbook, **PDF** employee report + executive summary. ✔
- **Security headers** (CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy), JSON body limit, per-route rate limiting, `/healthz`, strict no-inline-script CSP. ✔

---

## 2. Missing / Partial Features

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Email actually delivering | **Blocked (config)** | Code is complete; Resend rejects until `metnmat.com` is verified in the key's account. **Action: verify domain / use the verified-account key.** |
| 2 | Dedicated **Department Performance**, **Skill-Gap**, **Competency Matrix**, **HR Evaluation** reports as standalone PDFs | **Partial** | All this data exists in the HR dashboard + 5-sheet Excel; only *Employee Report* and *Executive Summary* exist as dedicated PDFs. |
| 3 | Attachment download on `/my` (employee self-view of own files) | **Partial** | Employees can view/remove files during the assessment; `/my` is an aggregate dashboard with no per-answer view. |
| 4 | Anti-virus / content scanning of uploads | **Missing** | Uploads are validated by MIME type, size (5 MB), and count (3); no malware scanning. |
| 5 | Automated database backups | **Missing (ops)** | Atlas M0 free tier has no auto-backup; needs a scheduled `mongodump`/export. File driver keeps daily local backups. |
| 6 | WhatsApp / SMS transport | **Stub** | `sendWhatsApp` is a future-ready stub; not wired. |
| 7 | Approval workflow beyond HR finalize | **Not built** | Single-step finalize → band; no multi-level sign-off chain. |
| 8 | Full SSO / SCIM | **Not built** | Named JWT accounts + shared keys only. |

---

## 3. Security Gaps

| Severity | Gap | Recommendation |
|----------|-----|----------------|
| **High (ops)** | Secrets (`MONGODB_URI`, `ADMIN_KEY`, `HR_KEY`) appeared in chat during development | **Rotate all three** before public rollout; set them only in the Render dashboard. |
| Medium | SCORA codes stored **plaintext** in Mongo | Low entropy (10 000 space) so hashing adds little, but consider hashing + lookup-by-hash, or accept as a low-value credential. They are already masked from all HR surfaces. |
| Medium | No **HSTS** header | Add `Strict-Transport-Security` (Render terminates TLS; safe to enable). |
| Medium | Uploads not malware-scanned | Add ClamAV / a scanning service if employees upload untrusted files; today limited by type/size/count + `nosniff` + `Content-Disposition: attachment`. |
| Low | Rate-limiting is per-process in-memory | Fine for single instance; move to a shared store if scaling horizontally. |
| Low | `?code=` in attachment download URL (employee self-view) | Lands in browser history; it's the employee's own code. Acceptable; could switch to a short-lived signed token. |
| ✔ Good | Timing-safe key compare, 8-fail lockout, scrypt passwords, strict CSP, no-inline-script, RBAC, audit trail, input validation/clamping, code privacy | — |

---

## 4. UI/UX Gaps

- ✔ Strong: real METNMAT branding, responsive, premium motion (reduced-motion respected), friendly multi-step employee entry with inline validation, 4-cell code entry, autosave status, live countdown, forward-only lock with confirm modal.
- ⚠ **Continuous topbar shimmer** keeps pages from going "idle," which breaks automated screenshot tooling (verify via DOM). Cosmetic; could pause the animation after first paint.
- ⚠ Designer still shows a legacy **"Profile fields"** tab unused by the SCORA flow — harmless, could be hidden.
- ⚠ No bulk "download all evidence for a submission" button (files download individually).

---

## 5. Database Design

- ✔ Clean storage abstraction (`store.js`) with two interchangeable async drivers (Mongo / local-file); identical server code for both.
- ✔ Collections: `meta` (framework/config/secrets/`fwsnap_*`), `cycles`, `submissions`, `drafts`, `employees`, `users`, `empAccounts`, `audit`, **`attachments`**. Indexed: submissions.cycleId, audit.ts, drafts (token / cycle+employee), employees.idNorm (unique), users.username (unique), empAccounts.code & emailNorm (unique), attachments.owner+cycleId.
- ✔ **Framework snapshot per cycle** isolates historical scoring from later edits.
- ⚠ Attachments stored **base64 in Mongo** — fine at the 5 MB cap in a separate collection (never bloats submission docs), but for heavy file usage **GridFS or object storage (S3/GCS)** would be more efficient.
- ⚠ Mongo `$set` cannot unset a field by `delete` — known footgun, handled (assign-clear sets `null`).

---

## 6. Scalability

- ✔ Connection cached on `global` (serverless-friendly), pool size 5, self-healing reconnect, retries on init failure.
- ✔ Stateless app except in-memory rate-limit/lockout — horizontally scalable if that moves to a shared store.
- ⚠ Base64 attachments increase read/write payloads; object storage recommended past light usage.
- ⚠ Analytics/dashboard compute scores in-process over all submissions per request — fine for hundreds/low-thousands; add caching/pagination for large orgs.
- ✔ 227-skill framework, large directories, Excel import all handled.

---

## 7. Reporting Gaps

- ✔ Present: Employee Assessment Report (PDF), Executive Summary (PDF), per-employee & per-cycle CSV, 5-sheet Excel (Summary, Skill detail, Leaderboard, Domain averages, Framework).
- ✖ Not yet as **dedicated PDF**: Department Performance, Skill-Gap, Competency Matrix, HR Evaluation report. *(All derivable from the dashboard/Excel today.)*
- Recommendation: add these four to `reports.js` (the PDF helpers — `table`, `bar`, `kv` — already exist) for one-click board-ready exports.

---

## 8. Analytics Gaps

- ✔ Completion rates, band distribution, department comparison, domain proficiency heatmap, skill gaps/strengths, leaderboards & per-domain toppers, self-vs-validated variance, evidence coverage %, attention flags, year-over-year per employee.
- ⚠ No **time-series trend across cycles** at the company level (per-employee history exists).
- ⚠ No **evidence-attachment coverage** metric yet (evidence % currently counts the text field only).
- ⚠ Heatmap caps at ~40 rows; large orgs need pagination/virtualization.

---

## 9. Permission Issues

- ✔ Verified live: HR JWT cannot reach admin-only routes (403); employee code cannot reach HR routes; key vs token both gated; Director-only overview/users/keys enforced via `req.isAdmin`.
- ✔ Attachment download correctly gated (HR/Director, or owner by code/token; anonymous → 403 — tested).
- ✔ SCORA-code privacy enforced at the response layer for **all** HR endpoints (directory `/employees` intentionally exempt — those are HR's own IDs).
- ⚠ Shared role keys attribute actions to "HR key"/"Director key" + IP rather than a named person — prefer named accounts for clean attribution (both supported).

---

## 10. Production Readiness Score

| Dimension | Score |
|-----------|-------|
| Core assessment & lifecycle | 98 |
| Roles / RBAC / auth | 95 |
| Evaluation & scoring | 97 |
| Evidence & attachments | 92 |
| Analytics | 90 |
| Reporting | 82 |
| Security | 88 |
| Scalability | 85 |
| Data integrity (snapshots/audit) | 96 |
| Ops (email live, backups, secrets) | 72 |
| **Overall (deployed purpose)** | **≈ 93 / 100** |

### Blocking items before go-live (must do)
1. **Rotate** `MONGODB_URI` password, `ADMIN_KEY`, `HR_KEY`; set them only in Render env vars.
2. **Verify `metnmat.com` in Resend** (or use the verified-account key) so registration & recovery emails actually send.
3. **Delete the DEMO submissions** (Asha/Bikram) from Atlas.
4. **Set `PUBLIC_URL`** in Render so email links point to the live site; add **`JWT_SECRET`** so named-user sessions survive redeploys.
5. Establish a **weekly Atlas export/backup** habit (M0 has no auto-backup).

### Recommended soon (non-blocking)
- Add the four dedicated PDF reports (§7).
- Add HSTS header; consider hashing SCORA codes.
- Move many/large attachments to object storage if file usage grows.
- Hide the legacy Designer "Profile fields" tab.

---

*No feature in §1 is listed without being exercised in code during this audit. Items in §2–§9 are gaps or partials, prioritized in §10.*

/*
 * Email helper (Resend). Used for transactional mail only — currently the
 * employee SCORA-code email sent on registration (see server.js).
 *
 * The old in-app notification feed was intentionally removed, so notify() is a
 * deliberate no-op kept only so existing call sites stay valid. Do NOT re-add
 * notification emails here without an explicit decision — enabling RESEND_API_KEY
 * must not start emailing employees on submit/assign/reopen/evaluate.
 */
const MAIL_FROM = process.env.MAIL_FROM || 'METNMAT Assessment <noreply@metnmat.com>';

async function sendEmail(to, subject, text, html) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const payload = { from: MAIL_FROM, to: [to], subject, text };
    if (html) payload.html = html;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) console.error('Email send failed:', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) { console.error('Email send failed:', e.message); return false; }
}

// Inert by design (notifications were removed). Kept so existing call sites are
// harmless no-ops; never throws, never emails.
async function notify() { /* no-op */ }

module.exports = { notify, sendEmail };

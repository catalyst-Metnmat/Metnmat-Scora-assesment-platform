/*
 * Notification engine: in-app feed (always) + email via Resend (when
 * RESEND_API_KEY is set) + WhatsApp transport stub (future-ready).
 * Never throws — notification failure must not break the main action.
 */
const store = require('./store');

const MAIL_FROM = process.env.MAIL_FROM || 'METNMAT Assessment <noreply@metnmat.com>';

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text })
    });
    if (!res.ok) console.error('Email send failed:', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) { console.error('Email send failed:', e.message); return false; }
}

// WhatsApp transport — future-ready stub. Wire a provider (e.g. Twilio/Meta
// Cloud API) here; the event payload shape is already final.
async function sendWhatsApp(_phone, _text) { return false; }

/**
 * notify(event, { title, body, emailTo, phone })
 * Always records an in-app notification; sends email/WhatsApp when possible.
 */
async function notify(event, { title, body, emailTo, phone } = {}) {
  try {
    await store.insertNotification({
      id: store.newId(), ts: new Date().toISOString(), event,
      title: String(title || event).slice(0, 200),
      body: String(body || '').slice(0, 500),
      read: false,
      emailed: emailTo ? await sendEmail(emailTo, title, body) : false
    });
    if (phone) await sendWhatsApp(phone, `${title}\n${body}`);
  } catch (e) { console.error('notify failed:', e.message); }
}

module.exports = { notify, sendEmail };

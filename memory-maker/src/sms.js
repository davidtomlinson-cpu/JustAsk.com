// SMS sending, via Twilio's plain REST API — no SDK dependency, same
// pattern as the sibling JustAsk backend. Entirely optional: with no
// Twilio credentials set, sendSms silently no-ops everywhere it's called.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const smsEnabled = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);

function sendSms(toE164, body) {
  if (!smsEnabled || !toE164) return Promise.resolve();
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json';
  const auth = Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
  const params = new URLSearchParams({ To: toE164, From: TWILIO_FROM_NUMBER, Body: body });
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  }).then(async (res) => {
    if (!res.ok) console.error('SMS send failed:', res.status, await res.text().catch(() => ''));
  }).catch((err) => console.error('SMS send failed:', err.message));
}

module.exports = { sendSms, smsEnabled };

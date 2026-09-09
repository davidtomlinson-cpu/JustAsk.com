// One call, two channels — every place in the app that needs to tell a
// user "something happened" goes through this: it always writes an
// in-app notification, and additionally texts them if `sms` is true AND
// they've opted into SMS with a phone number on file. Callers don't need
// to check smsOptIn themselves; that check lives here, once.

const { dbRun, dbGet } = require('./db');
const { newId } = require('./helpers');
const { sendSms } = require('./sms');

async function notifyUser(userId, { type, title, body, link, sms = false, smsBody }) {
  const id = newId('notif');
  const now = new Date().toISOString();
  await dbRun(
    'INSERT INTO notifications (id, "userId", type, title, body, link, "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, type, title, body || null, link || null, now]
  );
  if (sms) {
    const user = await dbGet('SELECT phone, "smsOptIn" FROM users WHERE id = $1', [userId]);
    if (user && user.smsOptIn && user.phone) {
      sendSms(user.phone, smsBody || (title + (body ? ' — ' + body : '')));
    }
  }
}

async function notifyUsers(userIds, opts) {
  for (const userId of userIds) await notifyUser(userId, opts);
}

module.exports = { notifyUser, notifyUsers };

// Daily/hourly sweep: find every due-but-unsent reminder (event reminders,
// to-do reminders) and send it. Guarded by CRON_SECRET, same pattern as the
// sibling JustAsk backend's /api/cron/important-dates — an external
// scheduler (GitHub Actions, cron-job.org, etc) calls this on a schedule;
// the app itself does nothing time-based on its own.

const { dbAll, dbRun } = require('./db');
const { sendSms } = require('./sms');

function formatWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function sweepEventReminders() {
  const now = new Date().toISOString();
  const due = await dbAll(
    `SELECT reminders.id, reminders."offsetHours", events.title, events."startsAt", users.name, users.phone, users."smsOptIn"
     FROM reminders
     JOIN events ON events.id = reminders."eventId"
     JOIN users ON users.id = reminders."userId"
     WHERE reminders."sentAt" IS NULL AND reminders."dueAt" <= $1`,
    [now]
  );
  let sent = 0;
  for (const r of due) {
    if (r.smsOptIn && r.phone) {
      await sendSms(r.phone, `The Memory Maker reminder: "${r.title}" is coming up on ${formatWhen(r.startsAt)}.`);
      sent++;
    }
    await dbRun('UPDATE reminders SET "sentAt" = $1 WHERE id = $2', [now, r.id]);
  }
  return sent;
}

async function sweepTodoReminders() {
  const now = new Date();
  const nowIso = now.toISOString();
  const candidates = await dbAll(
    `SELECT todos.*, users.name, users.phone, users."smsOptIn" FROM todos
     JOIN users ON users.id = todos."assignedTo"
     WHERE todos.status = 'pending' AND todos."dueAt" IS NOT NULL AND todos."reminderOffsetHours" IS NOT NULL
       AND todos."reminderSentAt" IS NULL`
  );
  let sent = 0;
  for (const t of candidates) {
    const dueAtMs = new Date(t.dueAt).getTime() - t.reminderOffsetHours * 3600 * 1000;
    if (dueAtMs > now.getTime()) continue;
    if ((t.reminderChannel === 'sms' || t.reminderChannel === 'both') && t.smsOptIn && t.phone) {
      await sendSms(t.phone, `The Memory Maker: don't forget — "${t.title}" is due ${formatWhen(t.dueAt)}.`);
    }
    await dbRun('UPDATE todos SET "reminderSentAt" = $1 WHERE id = $2', [nowIso, t.id]);
    sent++;
  }
  return sent;
}

async function runSweep() {
  const eventReminders = await sweepEventReminders();
  const todoReminders = await sweepTodoReminders();
  return { eventReminders, todoReminders };
}

module.exports = { runSweep };

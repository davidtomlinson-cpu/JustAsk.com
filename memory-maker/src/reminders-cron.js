// Daily/hourly sweep: find every due-but-unsent reminder (event reminders,
// to-do reminders) and send it. Guarded by CRON_SECRET, same pattern as the
// sibling JustAsk backend's /api/cron/important-dates — an external
// scheduler (GitHub Actions, cron-job.org, etc) calls this on a schedule;
// the app itself does nothing time-based on its own.

const { dbGet, dbAll, dbRun } = require('./db');
const { sendSms } = require('./sms');
const { syncAllGoogleCalendars } = require('./routes/integrations');

function formatWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
  const googleSync = await syncAllGoogleCalendars().catch((err) => { console.error('Google Calendar sweep failed:', err.message); return { synced: 0 }; });
  return { eventReminders, todoReminders, googleCalendarsSynced: googleSync.synced };
}

// "What have I got on today, including my to-dos" — texted once per user
// per day (guarded by daily_summary_log so a retried/overlapping cron run
// never double-sends), on its own fixed-time schedule rather than the
// hourly reminders sweep above — see POST /api/cron/daily-summary and
// .github/workflows/memory-maker-daily-summary.yml.
async function sweepDailySummaries() {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = today + 'T00:00:00.000Z';
  const dayEnd = today + 'T23:59:59.999Z';
  const users = await dbAll(`SELECT id, name, phone FROM users WHERE "smsOptIn" = true AND phone IS NOT NULL`);

  let sent = 0;
  for (const user of users) {
    const already = await dbGet('SELECT 1 FROM daily_summary_log WHERE "userId" = $1 AND date = $2', [user.id, today]);
    if (already) continue;

    const events = await dbAll(
      `SELECT DISTINCT events.title, events."startsAt", events."allDay" FROM events
       LEFT JOIN family_members ON family_members."familyId" = events."familyId" AND family_members."userId" = $1
       LEFT JOIN friend_group_members ON friend_group_members."groupId" = events."groupId" AND friend_group_members."userId" = $1
       LEFT JOIN event_attendees ON event_attendees."eventId" = events.id AND event_attendees."userId" = $1 AND event_attendees.status != 'declined'
       WHERE (family_members."userId" IS NOT NULL OR friend_group_members."userId" IS NOT NULL
              OR event_attendees."userId" IS NOT NULL OR events."createdBy" = $1)
         AND events."startsAt" >= $2 AND events."startsAt" <= $3
       ORDER BY events."startsAt" ASC`,
      [user.id, dayStart, dayEnd]
    );
    const todos = await dbAll(
      `SELECT title FROM todos WHERE "assignedTo" = $1 AND status = 'pending' AND "dueAt" IS NOT NULL AND "dueAt" <= $2 ORDER BY "dueAt" ASC`,
      [user.id, dayEnd]
    );

    if (events.length || todos.length) {
      const parts = [];
      if (events.length) {
        const lines = events.slice(0, 5).map((e) => (e.allDay ? e.title : `${e.title} @ ${formatTime(e.startsAt)}`));
        parts.push('Today: ' + lines.join(', ') + (events.length > 5 ? `, +${events.length - 5} more` : ''));
      }
      if (todos.length) {
        const lines = todos.slice(0, 5).map((t) => t.title);
        parts.push('To-do: ' + lines.join(', ') + (todos.length > 5 ? `, +${todos.length - 5} more` : ''));
      }
      const firstName = (user.name || '').split(' ')[0] || 'there';
      await sendSms(user.phone, `Good morning ${firstName}! ${parts.join('. ')}. Have a great day! — The Memory Maker`);
      sent++;
    }
    await dbRun('INSERT INTO daily_summary_log ("userId", date, "sentAt") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user.id, today, new Date().toISOString()]);
  }
  return sent;
}

module.exports = { runSweep, sweepDailySummaries };

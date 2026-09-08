// Google Calendar sync — connect a user's real Google Calendar so it's
// pulled into their conflict-checking and calendar view. This is a
// one-way (read-only) import: events land in our own `events` table
// tagged externalSource='google' so they render, get conflict-checked,
// and get cleaned up on re-sync just like any other event, but they're
// never editable here and nothing is ever written back to Google.
//
// Imported events are personal (no familyId/groupId, the connecting user
// is the sole attendee) and marked `private` — see src/routes/calendar.js's
// findConflicts, which shows a private event's real title only to its own
// owner and just "Busy" to anyone else it conflicts with.

const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, baseUrlFromReq } = require('../helpers');
const google = require('../google');

const router = express.Router();
const publicRouter = express.Router();

const SYNC_WINDOW_DAYS = 30;

async function userFromToken(token) {
  if (!isNonEmptyString(token)) return null;
  const row = await dbGet(
    `SELECT users.id, users.name, sessions."expiresAt" FROM sessions
     JOIN users ON users.id = sessions."userId" WHERE sessions.token = $1`,
    [token]
  );
  if (!row || new Date(row.expiresAt) < new Date()) return null;
  return { id: row.id, name: row.name };
}

async function ensureFreshAccessToken(conn) {
  if (new Date(conn.expiresAt) > new Date(Date.now() + 60000)) return conn.accessToken;
  if (!conn.refreshToken) throw new Error('This Google connection needs to be reconnected.');
  const tokens = await google.refreshAccessToken(conn.refreshToken);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await dbRun('UPDATE calendar_connections SET "accessToken" = $1, "expiresAt" = $2 WHERE id = $3', [tokens.access_token, expiresAt, conn.id]);
  return tokens.access_token;
}

async function syncGoogleCalendarForUser(userId) {
  const conn = await dbGet(`SELECT * FROM calendar_connections WHERE "userId" = $1 AND provider = 'google'`, [userId]);
  if (!conn) return { connected: false, synced: 0 };

  const accessToken = await ensureFreshAccessToken(conn);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + SYNC_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const items = await google.listEvents(accessToken, timeMin, timeMax);

  const seenExternalIds = [];
  for (const item of items) {
    if (item.status === 'cancelled' || !item.start || !item.end) continue;
    const allDay = !item.start.dateTime;
    const startsAt = item.start.dateTime || item.start.date + 'T00:00:00.000Z';
    const endsAt = item.end.dateTime || item.end.date + 'T23:59:59.000Z';
    seenExternalIds.push(item.id);

    const existing = await dbGet(`SELECT id FROM events WHERE "createdBy" = $1 AND "externalSource" = 'google' AND "externalId" = $2`, [userId, item.id]);
    if (existing) {
      await dbRun('UPDATE events SET title = $1, description = $2, "startsAt" = $3, "endsAt" = $4, "allDay" = $5, location = $6, "updatedAt" = $7 WHERE id = $8',
        [item.summary || '(No title)', item.description || null, startsAt, endsAt, allDay, item.location || null, new Date().toISOString(), existing.id]);
    } else {
      const id = newId('evt');
      const now = new Date().toISOString();
      await dbRun(
        `INSERT INTO events (id, "familyId", "groupId", title, description, "startsAt", "endsAt", "allDay", location, "occasionType", recurrence, "reminderOffsetsHours", "createdBy", "createdAt", "updatedAt", private, "externalSource", "externalId")
         VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, 'event', 'none', '[]', $8, $9, $9, true, 'google', $10)`,
        [id, item.summary || '(No title)', item.description || null, startsAt, endsAt, allDay, item.location || null, userId, now, item.id]
      );
      await dbRun('INSERT INTO event_attendees ("eventId", "userId", status, "respondedAt") VALUES ($1, $2, \'accepted\', $3)', [id, userId, now]);
    }
  }

  // Anything previously imported into this window that Google no longer
  // reports (deleted or cancelled since the last sync) gets removed too.
  const previouslyImported = await dbAll(
    `SELECT id, "externalId" FROM events WHERE "createdBy" = $1 AND "externalSource" = 'google' AND "startsAt" >= $2 AND "startsAt" < $3`,
    [userId, timeMin, timeMax]
  );
  for (const row of previouslyImported) {
    if (!seenExternalIds.includes(row.externalId)) {
      await dbRun('DELETE FROM event_attendees WHERE "eventId" = $1', [row.id]);
      await dbRun('DELETE FROM reminders WHERE "eventId" = $1', [row.id]);
      await dbRun('DELETE FROM events WHERE id = $1', [row.id]);
    }
  }

  await dbRun('UPDATE calendar_connections SET "lastSyncedAt" = $1 WHERE id = $2', [new Date().toISOString(), conn.id]);
  return { connected: true, synced: items.length };
}

// Sync every connected user — called from the hourly reminders cron sweep
// so connections stay fresh without anyone needing to press "sync now".
async function syncAllGoogleCalendars() {
  if (!google.googleCalendarEnabled) return { synced: 0 };
  const conns = await dbAll(`SELECT "userId" FROM calendar_connections WHERE provider = 'google'`);
  let synced = 0;
  for (const c of conns) {
    try {
      await syncGoogleCalendarForUser(c.userId);
      synced++;
    } catch (err) {
      console.error('Google Calendar sync failed for user', c.userId, err.message);
    }
  }
  return { synced };
}

router.get('/integrations/google/status', ah(async (req, res) => {
  const conn = await dbGet(`SELECT "calendarEmail", "lastSyncedAt" FROM calendar_connections WHERE "userId" = $1 AND provider = 'google'`, [req.user.id]);
  res.json({
    enabled: google.googleCalendarEnabled,
    connected: !!conn,
    calendarEmail: conn ? conn.calendarEmail : null,
    lastSyncedAt: conn ? conn.lastSyncedAt : null
  });
}));

router.post('/integrations/google/sync', ah(async (req, res) => {
  if (!google.googleCalendarEnabled) return res.status(501).json({ error: 'Google Calendar sync is not configured on this server yet.' });
  const conn = await dbGet(`SELECT 1 FROM calendar_connections WHERE "userId" = $1 AND provider = 'google'`, [req.user.id]);
  if (!conn) return res.status(400).json({ error: 'Connect your Google Calendar first.' });
  const result = await syncGoogleCalendarForUser(req.user.id);
  res.json(result);
}));

router.delete('/integrations/google', ah(async (req, res) => {
  await dbRun(`DELETE FROM events WHERE "createdBy" = $1 AND "externalSource" = 'google'`, [req.user.id]);
  await dbRun(`DELETE FROM calendar_connections WHERE "userId" = $1 AND provider = 'google'`, [req.user.id]);
  res.json({ ok: true });
}));

// Full-page navigation can't carry an Authorization header, so this one
// route (and its callback below) authenticate via the session token in the
// query string / OAuth `state` instead of the usual requireAuth() middleware
// — that's also why both live on the public router (mounted before
// requireAuth() in server.js) despite needing a signed-in user.
publicRouter.get('/integrations/google/connect', ah(async (req, res) => {
  if (!google.googleCalendarEnabled) return res.status(501).json({ error: 'Google Calendar sync is not configured on this server yet.' });
  const user = await userFromToken(req.query.token);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  const state = Buffer.from(JSON.stringify({ token: req.query.token })).toString('base64url');
  res.redirect(google.buildAuthUrl(baseUrlFromReq(req), state));
}));

publicRouter.get('/integrations/google/callback', ah(async (req, res) => {
  if (!google.googleCalendarEnabled) return res.redirect('/?googleError=' + encodeURIComponent('Google Calendar sync is not configured on this server.'));
  if (req.query.error) return res.redirect('/?googleError=' + encodeURIComponent('Google sign-in was cancelled.'));

  let state;
  try { state = JSON.parse(Buffer.from(req.query.state || '', 'base64url').toString('utf8')); } catch (e) { state = {}; }
  const user = await userFromToken(state.token);
  if (!user) return res.redirect('/?googleError=' + encodeURIComponent('Your session expired — sign in and try connecting again.'));

  try {
    const tokens = await google.exchangeCode(baseUrlFromReq(req), req.query.code);
    const info = await google.fetchUserInfo(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const existing = await dbGet(`SELECT id, "refreshToken" FROM calendar_connections WHERE "userId" = $1 AND provider = 'google'`, [user.id]);
    if (existing) {
      await dbRun(
        'UPDATE calendar_connections SET "accessToken" = $1, "refreshToken" = COALESCE($2, "refreshToken"), "expiresAt" = $3, "calendarEmail" = $4 WHERE id = $5',
        [tokens.access_token, tokens.refresh_token || null, expiresAt, info ? info.email : null, existing.id]
      );
    } else {
      await dbRun(
        'INSERT INTO calendar_connections (id, "userId", provider, "accessToken", "refreshToken", "expiresAt", "calendarEmail", "createdAt") VALUES ($1,$2,\'google\',$3,$4,$5,$6,$7)',
        [newId('gcal'), user.id, tokens.access_token, tokens.refresh_token || null, expiresAt, info ? info.email : null, new Date().toISOString()]
      );
    }
    await syncGoogleCalendarForUser(user.id).catch((err) => console.error('Initial Google sync failed:', err.message));
    res.redirect('/?googleConnected=1');
  } catch (err) {
    console.error('Google OAuth callback failed:', err.message);
    res.redirect('/?googleError=' + encodeURIComponent('Could not connect your Google Calendar. Try again.'));
  }
}));

module.exports = { router, publicRouter, syncGoogleCalendarForUser, syncAllGoogleCalendars };

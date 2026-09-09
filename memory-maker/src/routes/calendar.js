const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, newToken, normalizeUkPhone, baseUrlFromReq } = require('../helpers');
const { notifyUser } = require('../notify');
const { sendSms } = require('../sms');
const { assertFamilyMember, assertGroupMember } = require('./families');

const router = express.Router();
const publicRouter = express.Router();

async function attendeesOf(eventId) {
  return dbAll(
    `SELECT users.id, users.name, users.color, event_attendees.status, event_attendees."respondedAt"
     FROM event_attendees JOIN users ON users.id = event_attendees."userId"
     WHERE event_attendees."eventId" = $1`,
    [eventId]
  );
}

// Overlap check: two ranges [aStart,aEnd) and [bStart,bEnd) overlap if
// aStart < bEnd AND bStart < aEnd.
async function findConflicts(userIds, startsAt, endsAt, excludeEventId) {
  if (!userIds.length) return {};
  const conflicts = {};
  for (const userId of userIds) {
    const rows = await dbAll(
      `SELECT events.id, CASE WHEN events.private THEN 'Busy' ELSE events.title END as title,
              events."startsAt", events."endsAt"
       FROM event_attendees JOIN events ON events.id = event_attendees."eventId"
       WHERE event_attendees."userId" = $1 AND event_attendees.status != 'declined'
         AND events.id != $2
         AND events."startsAt" < $3 AND $4 < events."endsAt"`,
      [userId, excludeEventId || '', endsAt, startsAt]
    );
    if (rows.length) conflicts[userId] = rows;
  }
  return conflicts;
}

async function scopeAllowed(req, res, familyId, groupId) {
  if (familyId && !(await assertFamilyMember(req, res, familyId))) return false;
  if (groupId && !(await assertGroupMember(req, res, groupId))) return false;
  return true;
}

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — everything the user can
// see across every family/group they belong to, plus personal invites, in
// one range query. This is the "explore the calendar" view.
router.get('/calendar', ah(async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2999-12-31';
  const rows = await dbAll(
    `SELECT DISTINCT events.* FROM events
     LEFT JOIN family_members ON family_members."familyId" = events."familyId" AND family_members."userId" = $1
     LEFT JOIN friend_group_members ON friend_group_members."groupId" = events."groupId" AND friend_group_members."userId" = $1
     LEFT JOIN event_attendees ON event_attendees."eventId" = events.id AND event_attendees."userId" = $1
     WHERE (family_members."userId" IS NOT NULL OR friend_group_members."userId" IS NOT NULL
            OR event_attendees."userId" IS NOT NULL OR events."createdBy" = $1)
       AND events."startsAt" < $3 AND $2 < events."endsAt"
     ORDER BY events."startsAt" ASC`,
    [req.user.id, from + 'T00:00:00.000Z', to + 'T23:59:59.999Z']
  );
  for (const ev of rows) ev.attendees = await attendeesOf(ev.id);
  res.json({ events: rows });
}));

router.post('/events', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.title)) return res.status(400).json({ error: 'A title is required' });
  if (!isNonEmptyString(b.startsAt) || !isNonEmptyString(b.endsAt)) {
    return res.status(400).json({ error: 'startsAt and endsAt are required (ISO timestamps)' });
  }
  if (!(await scopeAllowed(req, res, b.familyId, b.groupId))) return;

  const id = newId('evt');
  const now = new Date().toISOString();
  const reminderOffsets = Array.isArray(b.reminderOffsetsHours) ? b.reminderOffsetsHours.filter((n) => Number.isFinite(n)) : [];

  await dbRun(
    `INSERT INTO events (id, "familyId","groupId",title,description,"startsAt","endsAt","allDay",location,"occasionType",recurrence,"reminderOffsetsHours","createdBy","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, b.familyId || null, b.groupId || null, b.title.trim(), b.description || null, b.startsAt, b.endsAt,
      !!b.allDay, b.location || null, b.occasionType || 'event', b.recurrence || 'none',
      JSON.stringify(reminderOffsets), req.user.id, now, now]
  );

  let attendeeIds = Array.isArray(b.attendeeUserIds) ? Array.from(new Set(b.attendeeUserIds)) : [];
  if (!attendeeIds.includes(req.user.id)) attendeeIds.push(req.user.id);

  const conflicts = await findConflicts(attendeeIds, b.startsAt, b.endsAt, id);

  const whenLabel = new Date(b.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  for (const userId of attendeeIds) {
    await dbRun('INSERT INTO event_attendees ("eventId","userId",status,"respondedAt") VALUES ($1,$2,$3,$4)',
      [id, userId, userId === req.user.id ? 'accepted' : 'invited', userId === req.user.id ? now : null]);
    for (const hours of reminderOffsets) {
      const dueAt = new Date(new Date(b.startsAt).getTime() - hours * 3600 * 1000).toISOString();
      await dbRun('INSERT INTO reminders (id,"eventId","userId","offsetHours","dueAt",channel,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [newId('rem'), id, userId, hours, dueAt, 'sms', now]);
    }
    if (userId !== req.user.id) {
      await notifyUser(userId, {
        type: 'event_invite', title: `${req.user.name} invited you to ${b.title.trim()}`, body: whenLabel, link: 'calendar', sms: true
      });
    }
  }

  // Yearly recurrence (birthdays, anniversaries) — rather than an
  // expand-on-read recurrence engine, generate the next few years' worth of
  // real event rows up front so they simply show up on the calendar and get
  // their own reminders, same as any other event.
  if (b.recurrence === 'yearly') {
    for (let yearOffset = 1; yearOffset <= 4; yearOffset++) {
      const futureId = newId('evt');
      const futureStart = new Date(b.startsAt);
      futureStart.setUTCFullYear(futureStart.getUTCFullYear() + yearOffset);
      const futureEnd = new Date(b.endsAt);
      futureEnd.setUTCFullYear(futureEnd.getUTCFullYear() + yearOffset);
      await dbRun(
        `INSERT INTO events (id, "familyId","groupId",title,description,"startsAt","endsAt","allDay",location,"occasionType",recurrence,"reminderOffsetsHours","createdBy","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [futureId, b.familyId || null, b.groupId || null, b.title.trim(), b.description || null,
          futureStart.toISOString(), futureEnd.toISOString(), !!b.allDay, b.location || null,
          b.occasionType || 'event', 'yearly', JSON.stringify(reminderOffsets), req.user.id, now, now]
      );
      for (const userId of attendeeIds) {
        await dbRun('INSERT INTO event_attendees ("eventId","userId",status,"respondedAt") VALUES ($1,$2,$3,$4)',
          [futureId, userId, userId === req.user.id ? 'accepted' : 'invited', userId === req.user.id ? now : null]);
        for (const hours of reminderOffsets) {
          const dueAt = new Date(futureStart.getTime() - hours * 3600 * 1000).toISOString();
          await dbRun('INSERT INTO reminders (id,"eventId","userId","offsetHours","dueAt",channel,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [newId('rem'), futureId, userId, hours, dueAt, 'sms', now]);
        }
      }
    }
  }

  const event = await dbGet('SELECT * FROM events WHERE id = $1', [id]);
  event.attendees = await attendeesOf(id);
  res.status(201).json({ event, conflicts });
}));

async function loadEventForUser(req, res) {
  const event = await dbGet('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!event) { res.status(404).json({ error: 'Not found' }); return null; }
  const attendee = await dbGet('SELECT 1 FROM event_attendees WHERE "eventId" = $1 AND "userId" = $2', [event.id, req.user.id]);
  const inFamily = event.familyId && await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [event.familyId, req.user.id]);
  const inGroup = event.groupId && await dbGet('SELECT 1 FROM friend_group_members WHERE "groupId" = $1 AND "userId" = $2', [event.groupId, req.user.id]);
  if (!attendee && !inFamily && !inGroup) { res.status(403).json({ error: 'Not allowed to view this event' }); return null; }
  return event;
}

router.get('/events/:id', ah(async (req, res) => {
  const event = await loadEventForUser(req, res);
  if (!event) return;
  event.attendees = await attendeesOf(event.id);
  res.json({ event });
}));

router.patch('/events/:id', ah(async (req, res) => {
  const event = await loadEventForUser(req, res);
  if (!event) return;
  if (event.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the organizer can edit this event' });
  const b = req.body || {};
  const startsAt = b.startsAt || event.startsAt;
  const endsAt = b.endsAt || event.endsAt;
  await dbRun(
    `UPDATE events SET title=$1, description=$2, "startsAt"=$3, "endsAt"=$4, "allDay"=$5, location=$6, "occasionType"=$7, "updatedAt"=$8 WHERE id=$9`,
    [b.title || event.title, b.description !== undefined ? b.description : event.description, startsAt, endsAt,
      b.allDay !== undefined ? !!b.allDay : event.allDay, b.location !== undefined ? b.location : event.location,
      b.occasionType || event.occasionType, new Date().toISOString(), event.id]
  );
  const attendeeIds = (await attendeesOf(event.id)).map((a) => a.id);
  const conflicts = await findConflicts(attendeeIds, startsAt, endsAt, event.id);
  const updated = await dbGet('SELECT * FROM events WHERE id = $1', [event.id]);
  updated.attendees = await attendeesOf(event.id);
  res.json({ event: updated, conflicts });
}));

router.delete('/events/:id', ah(async (req, res) => {
  const event = await loadEventForUser(req, res);
  if (!event) return;
  if (event.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the organizer can delete this event' });
  await dbRun('DELETE FROM reminders WHERE "eventId" = $1', [event.id]);
  await dbRun('DELETE FROM event_attendees WHERE "eventId" = $1', [event.id]);
  await dbRun('DELETE FROM events WHERE id = $1', [event.id]);
  res.json({ ok: true });
}));

router.post('/events/:id/rsvp', ah(async (req, res) => {
  const status = (req.body || {}).status;
  if (!['accepted', 'declined', 'invited'].includes(status)) return res.status(400).json({ error: 'status must be accepted, declined or invited' });
  const row = await dbGet('SELECT 1 FROM event_attendees WHERE "eventId" = $1 AND "userId" = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'You are not invited to this event' });
  await dbRun('UPDATE event_attendees SET status = $1, "respondedAt" = $2 WHERE "eventId" = $3 AND "userId" = $4',
    [status, new Date().toISOString(), req.params.id, req.user.id]);
  if (status === 'accepted' || status === 'declined') {
    const event = await dbGet('SELECT title, "createdBy" FROM events WHERE id = $1', [req.params.id]);
    if (event && event.createdBy !== req.user.id) {
      await notifyUser(event.createdBy, {
        type: 'event_rsvp',
        title: `${req.user.name} ${status === 'accepted' ? "is in for" : "can't make"} ${event.title}`,
        link: 'calendar'
      });
    }
  }
  res.json({ ok: true });
}));

// Invite one more person to this specific event by phone number — the
// "bring a friend who isn't in this family/group, or isn't on the app at
// all" path. If the number already belongs to an account, this is just a
// normal invite (added to event_attendees, notified in-app/SMS same as
// anyone invited at creation). If not, we text them a no-login accept/
// decline link instead; claimEventInvites() below is what actually puts
// the event on their calendar once they sign up.
router.post('/events/:id/invite-by-phone', ah(async (req, res) => {
  const event = await loadEventForUser(req, res);
  if (!event) return;
  if (event.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the organizer can invite people to this event' });
  const b = req.body || {};
  const phone = normalizeUkPhone(b.phone);
  if (!phone) return res.status(400).json({ error: "That doesn't look like a valid UK mobile number." });

  const baseUrl = baseUrlFromReq(req);
  const whenLabel = new Date(event.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const existingUser = await dbGet('SELECT id, name FROM users WHERE phone = $1', [phone]);

  if (existingUser) {
    const already = await dbGet('SELECT 1 FROM event_attendees WHERE "eventId" = $1 AND "userId" = $2', [event.id, existingUser.id]);
    if (already) return res.status(409).json({ error: `${existingUser.name} is already invited to this event` });
    await dbRun('INSERT INTO event_attendees ("eventId","userId",status,"respondedAt") VALUES ($1,$2,$3,$4)', [event.id, existingUser.id, 'invited', null]);
    await notifyUser(existingUser.id, {
      type: 'event_invite', title: `${req.user.name} invited you to ${event.title}`, body: whenLabel, link: 'calendar', sms: true
    });
    return res.status(201).json({ ok: true, matchedExistingUser: true, name: existingUser.name });
  }

  const existingInvite = await dbGet(`SELECT 1 FROM event_invites WHERE "eventId" = $1 AND phone = $2 AND status = 'invited'`, [event.id, phone]);
  if (existingInvite) return res.status(409).json({ error: 'Already invited — waiting on their reply' });

  const token = newToken();
  await dbRun(
    `INSERT INTO event_invites (id,"eventId",phone,name,token,status,"invitedBy","createdAt") VALUES ($1,$2,$3,$4,$5,'invited',$6,$7)`,
    [newId('evinv'), event.id, phone, isNonEmptyString(b.name) ? b.name.trim() : null, token, req.user.id, new Date().toISOString()]
  );
  sendSms(phone, `${req.user.name} invited you to "${event.title}" (${whenLabel}) on The Memory Maker. Accept or decline: ${baseUrl}/event-invite/${token}`);
  res.status(201).json({ ok: true, matchedExistingUser: false });
}));

// Opens (or returns the existing) chat scoped to this event's confirmed
// attendees — "select a date with confirmed attendees" and message just
// them, separate from the whole family/group thread. Membership is
// implicit and live: it's derived from event_attendees.status = 'accepted'
// at read time (src/routes/messaging.js), same pattern as family/group
// chats deriving membership from their own membership tables, so someone
// who later declines loses access and a newly-accepted attendee gains it.
router.post('/events/:id/conversation', ah(async (req, res) => {
  const event = await loadEventForUser(req, res);
  if (!event) return;
  const attendee = await dbGet('SELECT status FROM event_attendees WHERE "eventId" = $1 AND "userId" = $2', [event.id, req.user.id]);
  if (!attendee || attendee.status !== 'accepted') {
    return res.status(403).json({ error: "Only confirmed attendees can open this event's chat" });
  }
  let convo = await dbGet(`SELECT * FROM conversations WHERE "eventId" = $1 AND type = 'event'`, [event.id]);
  if (!convo) {
    const id = newId('conv');
    await dbRun(`INSERT INTO conversations (id, type, "eventId", "createdAt") VALUES ($1,'event',$2,$3)`,
      [id, event.id, new Date().toISOString()]);
    convo = await dbGet('SELECT * FROM conversations WHERE id = $1', [id]);
  }
  res.json({ conversationId: convo.id });
}));

// Quick check for the "explore the calendar / avoid double-booking" view:
// pass a set of userIds + a time range, get back who's already busy.
router.post('/calendar/check-conflicts', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.startsAt) || !isNonEmptyString(b.endsAt)) return res.status(400).json({ error: 'startsAt and endsAt are required' });
  const userIds = Array.isArray(b.userIds) ? b.userIds : [req.user.id];
  const conflicts = await findConflicts(userIds, b.startsAt, b.endsAt, b.excludeEventId);
  res.json({ conflicts });
}));

// Simple .ics export so events can be pulled into Google Calendar / Apple
// Calendar / Outlook — the practical shape "calendar sync" takes without a
// live OAuth integration into a third-party calendar provider.
function icsEscape(s) {
  return String(s || '').replace(/[\\,;]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
}
function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

router.get('/calendar.ics', ah(async (req, res) => {
  const rows = await dbAll(
    `SELECT DISTINCT events.* FROM events
     LEFT JOIN family_members ON family_members."familyId" = events."familyId" AND family_members."userId" = $1
     LEFT JOIN friend_group_members ON friend_group_members."groupId" = events."groupId" AND friend_group_members."userId" = $1
     LEFT JOIN event_attendees ON event_attendees."eventId" = events.id AND event_attendees."userId" = $1
     WHERE family_members."userId" IS NOT NULL OR friend_group_members."userId" IS NOT NULL
        OR event_attendees."userId" IS NOT NULL OR events."createdBy" = $1
     ORDER BY events."startsAt" ASC`,
    [req.user.id]
  );
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Memory Maker//EN'];
  for (const ev of rows) {
    lines.push('BEGIN:VEVENT', 'UID:' + ev.id + '@memorymaker', 'DTSTAMP:' + icsDate(ev.createdAt),
      'DTSTART:' + icsDate(ev.startsAt), 'DTEND:' + icsDate(ev.endsAt),
      'SUMMARY:' + icsEscape(ev.title), 'DESCRIPTION:' + icsEscape(ev.description || ''),
      'LOCATION:' + icsEscape(ev.location || ''), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="memory-maker.ics"');
  res.send(lines.join('\r\n'));
}));

// ---- Public, no-login event-invite response (phone number, not an account) ----

publicRouter.get('/event-invite/:token', ah(async (req, res) => {
  const inv = await dbGet(
    `SELECT event_invites.*, events.title, events."startsAt", events."endsAt", events.location, events."allDay"
     FROM event_invites JOIN events ON events.id = event_invites."eventId"
     WHERE event_invites.token = $1`,
    [req.params.token]
  );
  if (!inv) return res.status(404).json({ error: 'This invite link is not valid' });
  const inviter = await dbGet('SELECT name FROM users WHERE id = $1', [inv.invitedBy]);
  res.json({
    title: inv.title, startsAt: inv.startsAt, endsAt: inv.endsAt, location: inv.location, allDay: inv.allDay,
    inviterName: inviter ? inviter.name : 'Someone', status: inv.status, name: inv.name
  });
}));

publicRouter.post('/event-invite/:token', ah(async (req, res) => {
  const status = (req.body || {}).status;
  if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'status must be accepted or declined' });
  const inv = await dbGet('SELECT * FROM event_invites WHERE token = $1', [req.params.token]);
  if (!inv) return res.status(404).json({ error: 'This invite link is not valid' });
  await dbRun('UPDATE event_invites SET status = $1, "respondedAt" = $2 WHERE token = $3', [status, new Date().toISOString(), req.params.token]);
  if (status === 'accepted') {
    const event = await dbGet('SELECT title, "createdBy" FROM events WHERE id = $1', [inv.eventId]);
    if (event) {
      await notifyUser(event.createdBy, { type: 'event_rsvp', title: `${inv.name || 'Your invite'} is in for ${event.title}`, link: 'calendar' });
    }
  }
  res.json({ ok: true });
}));

// Runs at signup and whenever a phone number is added/changed (see
// src/auth.js) — any event invite sent to that number before they had an
// account, that they already said yes to, becomes a real event_attendees
// row so it's on their calendar the moment they join. Declined invites are
// left alone; there's nothing to add.
async function claimEventInvites(userId, phone) {
  if (!phone) return 0;
  const rows = await dbAll(`SELECT * FROM event_invites WHERE phone = $1 AND status = 'accepted' AND "claimedByUserId" IS NULL`, [phone]);
  for (const inv of rows) {
    const already = await dbGet('SELECT 1 FROM event_attendees WHERE "eventId" = $1 AND "userId" = $2', [inv.eventId, userId]);
    if (!already) {
      await dbRun('INSERT INTO event_attendees ("eventId","userId",status,"respondedAt") VALUES ($1,$2,$3,$4)',
        [inv.eventId, userId, 'accepted', inv.respondedAt || new Date().toISOString()]);
    }
    await dbRun('UPDATE event_invites SET "claimedByUserId" = $1 WHERE id = $2', [userId, inv.id]);
  }
  return rows.length;
}

module.exports = { router, publicRouter, findConflicts, attendeesOf, claimEventInvites };

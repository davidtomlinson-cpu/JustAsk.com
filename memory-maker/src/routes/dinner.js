const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, newToken, baseUrlFromReq, DAYS, DAY_LABELS } = require('../helpers');
const { sendSms } = require('../sms');
const { assertFamilyMember, assertGroupMember } = require('./families');

const router = express.Router();

async function scopeAllowed(req, res, familyId, groupId) {
  if (familyId && !(await assertFamilyMember(req, res, familyId))) return false;
  if (groupId && !(await assertGroupMember(req, res, groupId))) return false;
  return true;
}

async function membersFor(familyId, groupId) {
  if (familyId) {
    return dbAll(`SELECT users.id, users.name, users.phone, users."smsOptIn" FROM family_members
      JOIN users ON users.id = family_members."userId" WHERE family_members."familyId" = $1`, [familyId]);
  }
  return dbAll(`SELECT users.id, users.name, users.phone, users."smsOptIn" FROM friend_group_members
    JOIN users ON users.id = friend_group_members."userId" WHERE friend_group_members."groupId" = $1`, [groupId]);
}

async function recipientsWithResponses(pollId) {
  const recipients = await dbAll(
    `SELECT dinner_poll_recipients.id, dinner_poll_recipients.token, dinner_poll_recipients."respondedAt",
            users.id as "userId", users.name, users.color
     FROM dinner_poll_recipients JOIN users ON users.id = dinner_poll_recipients."userId"
     WHERE dinner_poll_recipients."pollId" = $1 ORDER BY users.name ASC`,
    [pollId]
  );
  for (const r of recipients) {
    const responses = await dbAll('SELECT day, "inFor" FROM dinner_poll_responses WHERE "recipientId" = $1', [r.id]);
    r.days = DAYS.reduce((acc, d) => { acc[d] = false; return acc; }, {});
    for (const resp of responses) r.days[resp.day] = resp.inFor;
  }
  return recipients;
}

// Create a poll for a family or group's week ("ask a group what nights
// they're in for dinner"). Creates one recipient row per member (with a
// magic-link token) and texts anyone who's opted into SMS.
router.post('/dinner-polls', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.familyId && !b.groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!isNonEmptyString(b.weekStart)) return res.status(400).json({ error: 'weekStart (Monday, YYYY-MM-DD) is required' });
  if (!(await scopeAllowed(req, res, b.familyId, b.groupId))) return;

  const id = newId('poll');
  const now = new Date().toISOString();
  await dbRun('INSERT INTO dinner_polls (id,"familyId","groupId","weekStart","createdBy","createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
    [id, b.familyId || null, b.groupId || null, b.weekStart, req.user.id, now]);

  const members = await membersFor(b.familyId, b.groupId);
  const baseUrl = baseUrlFromReq(req);
  for (const member of members) {
    const token = newToken();
    await dbRun('INSERT INTO dinner_poll_recipients (id,"pollId","userId",token,"createdAt") VALUES ($1,$2,$3,$4,$5)',
      [newId('pr'), id, member.id, token, now]);
    if (member.smsOptIn && member.phone) {
      sendSms(member.phone, `The Memory Maker: which nights are you in for dinner this week? Reply here: ${baseUrl}/dinner/${token}`);
    }
  }

  const poll = await dbGet('SELECT * FROM dinner_polls WHERE id = $1', [id]);
  poll.recipients = await recipientsWithResponses(id);
  res.status(201).json({ poll });
}));

router.get('/dinner-polls', ah(async (req, res) => {
  const { familyId, groupId, weekStart } = req.query;
  if (!familyId && !groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!(await scopeAllowed(req, res, familyId, groupId))) return;
  let where = familyId ? '"familyId" = $1' : '"groupId" = $1';
  const params = [familyId || groupId];
  if (weekStart) { where += ' AND "weekStart" = $2'; params.push(weekStart); }
  const rows = await dbAll(`SELECT * FROM dinner_polls WHERE ${where} ORDER BY "weekStart" DESC`, params);
  for (const p of rows) p.recipients = await recipientsWithResponses(p.id);
  res.json({ polls: rows });
}));

router.get('/dinner-polls/:id', ah(async (req, res) => {
  const poll = await dbGet('SELECT * FROM dinner_polls WHERE id = $1', [req.params.id]);
  if (!poll) return res.status(404).json({ error: 'Not found' });
  if (!(await scopeAllowed(req, res, poll.familyId, poll.groupId))) return;
  poll.recipients = await recipientsWithResponses(poll.id);
  res.json({ poll });
}));

// The compiled weekly plan: who's in for dinner on which day.
router.get('/dinner-polls/:id/plan', ah(async (req, res) => {
  const poll = await dbGet('SELECT * FROM dinner_polls WHERE id = $1', [req.params.id]);
  if (!poll) return res.status(404).json({ error: 'Not found' });
  if (!(await scopeAllowed(req, res, poll.familyId, poll.groupId))) return;
  const recipients = await recipientsWithResponses(poll.id);
  const plan = DAYS.map((day) => ({
    day, label: DAY_LABELS[day],
    inFor: recipients.filter((r) => r.days[day]).map((r) => ({ id: r.userId, name: r.name, color: r.color }))
  }));
  res.json({ weekStart: poll.weekStart, plan });
}));

// ---- Public, no-login response (the SMS link lands here) ----
const publicRouter = express.Router();

publicRouter.get('/dinner-response/:token', ah(async (req, res) => {
  const recipient = await dbGet('SELECT * FROM dinner_poll_recipients WHERE token = $1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'This link is not valid' });
  const poll = await dbGet('SELECT * FROM dinner_polls WHERE id = $1', [recipient.pollId]);
  const user = await dbGet('SELECT id, name FROM users WHERE id = $1', [recipient.userId]);
  const responses = await dbAll('SELECT day, "inFor" FROM dinner_poll_responses WHERE "recipientId" = $1', [recipient.id]);
  const days = DAYS.reduce((acc, d) => { acc[d] = false; return acc; }, {});
  for (const r of responses) days[r.day] = r.inFor;
  res.json({ weekStart: poll.weekStart, user, days, dayLabels: DAY_LABELS, respondedAt: recipient.respondedAt });
}));

publicRouter.post('/dinner-response/:token', ah(async (req, res) => {
  const recipient = await dbGet('SELECT * FROM dinner_poll_recipients WHERE token = $1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'This link is not valid' });
  const selectedDays = Array.isArray((req.body || {}).days) ? (req.body.days).filter((d) => DAYS.includes(d)) : [];
  for (const day of DAYS) {
    const inFor = selectedDays.includes(day);
    await dbRun(
      `INSERT INTO dinner_poll_responses ("recipientId", day, "inFor") VALUES ($1,$2,$3)
       ON CONFLICT ("recipientId", day) DO UPDATE SET "inFor" = $3`,
      [recipient.id, day, inFor]
    );
  }
  await dbRun('UPDATE dinner_poll_recipients SET "respondedAt" = $1 WHERE id = $2', [new Date().toISOString(), recipient.id]);
  res.json({ ok: true });
}));

module.exports = { router, publicRouter };

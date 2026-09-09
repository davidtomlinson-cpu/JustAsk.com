// General-purpose polls — "cinema Wednesday? yes/no", "Spain or Portugal?"
// — distinct from the Mon-Sun dinner_polls in src/routes/dinner.js. An
// arbitrary question with arbitrary options, one vote per person
// (changeable), optionally texted out with a magic link.

const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, newToken, baseUrlFromReq } = require('../helpers');
const { sendSms } = require('../sms');
const { notifyUser } = require('../notify');
const { assertFamilyMember, assertGroupMember } = require('./families');

const router = express.Router();
const publicRouter = express.Router();

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

async function pollWithResults(pollId, viewerUserId) {
  const poll = await dbGet(`SELECT polls.*, users.name as "createdByName" FROM polls JOIN users ON users.id = polls."createdBy" WHERE polls.id = $1`, [pollId]);
  if (!poll) return null;
  const options = await dbAll('SELECT * FROM poll_options WHERE "pollId" = $1 ORDER BY position ASC', [pollId]);
  const votes = await dbAll(
    `SELECT poll_votes."optionId", users.id as "userId", users.name, users.color FROM poll_votes
     JOIN users ON users.id = poll_votes."userId" WHERE poll_votes."pollId" = $1`,
    [pollId]
  );
  poll.options = options.map((o) => ({
    ...o,
    voters: votes.filter((v) => v.optionId === o.id).map((v) => ({ id: v.userId, name: v.name, color: v.color }))
  }));
  poll.totalVotes = votes.length;
  poll.myVote = viewerUserId ? (votes.find((v) => v.userId === viewerUserId) || {}).optionId || null : null;
  return poll;
}

router.get('/polls', ah(async (req, res) => {
  const { familyId, groupId } = req.query;
  if (!familyId && !groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!(await scopeAllowed(req, res, familyId, groupId))) return;
  const where = familyId ? '"familyId" = $1' : '"groupId" = $1';
  const rows = await dbAll(`SELECT id FROM polls WHERE ${where} ORDER BY "createdAt" DESC`, [familyId || groupId]);
  const polls = [];
  for (const row of rows) polls.push(await pollWithResults(row.id, req.user.id));
  res.json({ polls });
}));

router.post('/polls', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.familyId && !b.groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!isNonEmptyString(b.question)) return res.status(400).json({ error: 'A question is required' });
  const options = Array.isArray(b.options) ? b.options.map((o) => (o || '').trim()).filter(Boolean) : [];
  if (options.length < 2) return res.status(400).json({ error: 'At least 2 options are required' });
  if (!(await scopeAllowed(req, res, b.familyId, b.groupId))) return;

  const id = newId('poll2');
  const now = new Date().toISOString();
  await dbRun('INSERT INTO polls (id, "familyId", "groupId", question, "createdBy", "createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
    [id, b.familyId || null, b.groupId || null, b.question.trim(), req.user.id, now]);
  for (let i = 0; i < options.length; i++) {
    await dbRun('INSERT INTO poll_options (id, "pollId", label, position) VALUES ($1,$2,$3,$4)', [newId('opt'), id, options[i], i]);
  }

  const members = await membersFor(b.familyId, b.groupId);
  const baseUrl = baseUrlFromReq(req);
  for (const member of members) {
    if (member.id === req.user.id) continue;
    await notifyUser(member.id, { type: 'poll_new', title: `${req.user.name} started a poll`, body: b.question.trim(), link: 'requests' });
    if (b.notify) {
      const token = newToken();
      await dbRun('INSERT INTO poll_recipients (id, "pollId", "userId", token, "createdAt") VALUES ($1,$2,$3,$4,$5)',
        [newId('plr'), id, member.id, token, now]);
      if (member.smsOptIn && member.phone) {
        sendSms(member.phone, `The Memory Maker: ${req.user.name} asks — "${b.question.trim()}" ${baseUrl}/poll/${token}`);
      }
    }
  }

  res.status(201).json({ poll: await pollWithResults(id, req.user.id) });
}));

async function loadPollForUser(req, res) {
  const poll = await dbGet('SELECT * FROM polls WHERE id = $1', [req.params.id]);
  if (!poll) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!(await scopeAllowed(req, res, poll.familyId, poll.groupId))) return null;
  return poll;
}

router.get('/polls/:id', ah(async (req, res) => {
  const poll = await loadPollForUser(req, res);
  if (!poll) return;
  res.json({ poll: await pollWithResults(poll.id, req.user.id) });
}));

router.post('/polls/:id/vote', ah(async (req, res) => {
  const poll = await loadPollForUser(req, res);
  if (!poll) return;
  const optionId = (req.body || {}).optionId;
  const option = await dbGet('SELECT * FROM poll_options WHERE id = $1 AND "pollId" = $2', [optionId, poll.id]);
  if (!option) return res.status(400).json({ error: 'Not a valid option for this poll' });
  await dbRun(
    `INSERT INTO poll_votes ("pollId", "userId", "optionId", "votedAt") VALUES ($1,$2,$3,$4)
     ON CONFLICT ("pollId", "userId") DO UPDATE SET "optionId" = $3, "votedAt" = $4`,
    [poll.id, req.user.id, optionId, new Date().toISOString()]
  );
  res.json({ poll: await pollWithResults(poll.id, req.user.id) });
}));

router.delete('/polls/:id', ah(async (req, res) => {
  const poll = await loadPollForUser(req, res);
  if (!poll) return;
  if (poll.createdBy !== req.user.id) return res.status(403).json({ error: 'Only whoever created this poll can delete it' });
  await dbRun('DELETE FROM poll_votes WHERE "pollId" = $1', [poll.id]);
  await dbRun('DELETE FROM poll_recipients WHERE "pollId" = $1', [poll.id]);
  await dbRun('DELETE FROM poll_options WHERE "pollId" = $1', [poll.id]);
  await dbRun('DELETE FROM polls WHERE id = $1', [poll.id]);
  res.json({ ok: true });
}));

// ---- Public, no-login vote (the SMS link lands here) ----

publicRouter.get('/poll-response/:token', ah(async (req, res) => {
  const recipient = await dbGet('SELECT * FROM poll_recipients WHERE token = $1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'This link is not valid' });
  const poll = await pollWithResults(recipient.pollId, recipient.userId);
  const user = await dbGet('SELECT id, name FROM users WHERE id = $1', [recipient.userId]);
  res.json({ poll, user });
}));

publicRouter.post('/poll-response/:token', ah(async (req, res) => {
  const recipient = await dbGet('SELECT * FROM poll_recipients WHERE token = $1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'This link is not valid' });
  const optionId = (req.body || {}).optionId;
  const option = await dbGet('SELECT * FROM poll_options WHERE id = $1 AND "pollId" = $2', [optionId, recipient.pollId]);
  if (!option) return res.status(400).json({ error: 'Not a valid option for this poll' });
  await dbRun(
    `INSERT INTO poll_votes ("pollId", "userId", "optionId", "votedAt") VALUES ($1,$2,$3,$4)
     ON CONFLICT ("pollId", "userId") DO UPDATE SET "optionId" = $3, "votedAt" = $4`,
    [recipient.pollId, recipient.userId, optionId, new Date().toISOString()]
  );
  res.json({ poll: await pollWithResults(recipient.pollId, recipient.userId) });
}));

module.exports = { router, publicRouter };

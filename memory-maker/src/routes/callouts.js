// "Call to action" — an open request to a family/group ("can someone grab
// bread on the way home?") that anyone can accept. Whoever accepts first
// claims it (enforced with a conditional UPDATE, not a read-then-write, so
// two people tapping "accept" at the same moment can't both win it) and
// everyone else in the group sees who's got it. Optionally texted out with
// a magic link, same shape as the dinner poll / meal rating flows.

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

// Every route that returns a callout goes through this instead of each
// hand-rolling its own JOIN — an earlier version of the accept/patch/public
// endpoints returned a bare `SELECT *` and silently dropped
// createdByName/acceptedByName, which only broke once accepted client-side.
async function calloutWithNames(id) {
  return dbGet(
    `SELECT callouts.*, creator.name as "createdByName", accepter.name as "acceptedByName", accepter.color as "acceptedByColor"
     FROM callouts
     JOIN users creator ON creator.id = callouts."createdBy"
     LEFT JOIN users accepter ON accepter.id = callouts."acceptedBy"
     WHERE callouts.id = $1`,
    [id]
  );
}

router.get('/callouts', ah(async (req, res) => {
  const { familyId, groupId, status } = req.query;
  if (!familyId && !groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!(await scopeAllowed(req, res, familyId, groupId))) return;
  let where = familyId ? '"familyId" = $1' : '"groupId" = $1';
  const params = [familyId || groupId];
  if (status) { where += ' AND status = $' + (params.length + 1); params.push(status); }
  const rows = await dbAll(
    `SELECT callouts.*, creator.name as "createdByName", accepter.name as "acceptedByName", accepter.color as "acceptedByColor"
     FROM callouts
     JOIN users creator ON creator.id = callouts."createdBy"
     LEFT JOIN users accepter ON accepter.id = callouts."acceptedBy"
     WHERE ${where} ORDER BY (status = 'open') DESC, callouts."createdAt" DESC`,
    params
  );
  res.json({ callouts: rows });
}));

router.post('/callouts', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.familyId && !b.groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!isNonEmptyString(b.title)) return res.status(400).json({ error: 'A title is required' });
  if (!(await scopeAllowed(req, res, b.familyId, b.groupId))) return;

  const id = newId('co');
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO callouts (id, "familyId", "groupId", title, notes, status, "createdBy", "createdAt") VALUES ($1,$2,$3,$4,$5,'open',$6,$7)`,
    [id, b.familyId || null, b.groupId || null, b.title.trim(), b.notes || null, req.user.id, now]
  );

  // In-app notification for every other member always (it's free); the
  // magic-link SMS (with its own accept token) only when notify was asked
  // for, same as before.
  const members = await membersFor(b.familyId, b.groupId);
  const baseUrl = baseUrlFromReq(req);
  for (const member of members) {
    if (member.id === req.user.id) continue;
    await notifyUser(member.id, {
      type: 'callout_new', title: `${req.user.name} is asking for help`, body: b.title.trim(), link: 'requests'
    });
    if (b.notify) {
      const token = newToken();
      await dbRun('INSERT INTO callout_recipients (id, "calloutId", "userId", token, "createdAt") VALUES ($1,$2,$3,$4,$5)',
        [newId('cor'), id, member.id, token, now]);
      if (member.smsOptIn && member.phone) {
        sendSms(member.phone, `The Memory Maker: ${req.user.name} is asking — "${b.title.trim()}". Can you help? ${baseUrl}/callout/${token}`);
      }
    }
  }

  res.status(201).json({ callout: await calloutWithNames(id) });
}));

async function loadCalloutForUser(req, res) {
  const callout = await dbGet('SELECT * FROM callouts WHERE id = $1', [req.params.id]);
  if (!callout) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!(await scopeAllowed(req, res, callout.familyId, callout.groupId))) return null;
  return callout;
}

async function claimCallout(calloutId, userId) {
  const now = new Date().toISOString();
  const result = await dbRun(
    `UPDATE callouts SET status = 'accepted', "acceptedBy" = $1, "acceptedAt" = $2 WHERE id = $3 AND status = 'open'`,
    [userId, now, calloutId]
  );
  if (result.rowCount > 0) {
    const callout = await dbGet('SELECT title, "createdBy" FROM callouts WHERE id = $1', [calloutId]);
    const accepter = await dbGet('SELECT name FROM users WHERE id = $1', [userId]);
    if (callout.createdBy !== userId) {
      await notifyUser(callout.createdBy, {
        type: 'callout_accepted', title: `${accepter.name} accepted your request`, body: callout.title, link: 'requests', sms: true
      });
    }
  }
  return result.rowCount > 0;
}

router.post('/callouts/:id/accept', ah(async (req, res) => {
  const callout = await loadCalloutForUser(req, res);
  if (!callout) return;
  const claimed = await claimCallout(callout.id, req.user.id);
  const updated = await calloutWithNames(callout.id);
  if (!claimed) return res.status(409).json({ error: 'Someone already got this one', callout: updated });
  res.json({ callout: updated });
}));

router.patch('/callouts/:id', ah(async (req, res) => {
  const callout = await loadCalloutForUser(req, res);
  if (!callout) return;
  const status = (req.body || {}).status;
  const now = new Date().toISOString();
  if (status === 'done') {
    if (callout.acceptedBy !== req.user.id) return res.status(403).json({ error: 'Only whoever accepted this can mark it done' });
    await dbRun('UPDATE callouts SET status = $1, "completedAt" = $2 WHERE id = $3', ['done', now, callout.id]);
  } else if (status === 'cancelled') {
    if (callout.createdBy !== req.user.id) return res.status(403).json({ error: 'Only whoever posted this can cancel it' });
    await dbRun('UPDATE callouts SET status = $1 WHERE id = $2', ['cancelled', callout.id]);
  } else if (status === 'open') {
    // "Actually I can't do this after all" — release it back for someone else to take.
    if (callout.acceptedBy !== req.user.id) return res.status(403).json({ error: 'Only whoever accepted this can release it' });
    await dbRun('UPDATE callouts SET status = $1, "acceptedBy" = NULL, "acceptedAt" = NULL WHERE id = $2', ['open', callout.id]);
  } else {
    return res.status(400).json({ error: 'status must be done, cancelled or open' });
  }
  res.json({ callout: await calloutWithNames(callout.id) });
}));

router.delete('/callouts/:id', ah(async (req, res) => {
  const callout = await loadCalloutForUser(req, res);
  if (!callout) return;
  if (callout.createdBy !== req.user.id) return res.status(403).json({ error: 'Only whoever posted this can delete it' });
  await dbRun('DELETE FROM callout_recipients WHERE "calloutId" = $1', [callout.id]);
  await dbRun('DELETE FROM callouts WHERE id = $1', [callout.id]);
  res.json({ ok: true });
}));

// ---- Public, no-login accept (the SMS link lands here) ----

publicRouter.get('/callout-response/:token', ah(async (req, res) => {
  const recipient = await dbGet('SELECT * FROM callout_recipients WHERE token = $1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'This link is not valid' });
  res.json({ callout: await calloutWithNames(recipient.calloutId) });
}));

publicRouter.post('/callout-response/:token', ah(async (req, res) => {
  const recipient = await dbGet('SELECT * FROM callout_recipients WHERE token = $1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'This link is not valid' });
  const claimed = await claimCallout(recipient.calloutId, recipient.userId);
  const updated = await calloutWithNames(recipient.calloutId);
  if (!claimed) return res.status(409).json({ error: 'Someone already got this one', callout: updated });
  res.json({ callout: updated });
}));

module.exports = { router, publicRouter };

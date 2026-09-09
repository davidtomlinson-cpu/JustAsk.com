const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, newJoinCode, normalizeUkPhone, baseUrlFromReq, makeUploader } = require('../helpers');
const { sendSms } = require('../sms');

const router = express.Router();
const publicRouter = express.Router();
const upload = makeUploader();

async function membersOf(table, memberTable, col, id) {
  return dbAll(
    `SELECT users.id, users.name, users.email, users.color, ${memberTable}.role, ${memberTable}."joinedAt"
     FROM ${memberTable} JOIN users ON users.id = ${memberTable}."userId"
     WHERE ${memberTable}."${col}" = $1 ORDER BY ${memberTable}."joinedAt" ASC`,
    [id]
  );
}

// ---- Families ----

router.get('/families', ah(async (req, res) => {
  const rows = await dbAll(
    `SELECT families.* FROM families
     JOIN family_members ON family_members."familyId" = families.id
     WHERE family_members."userId" = $1 ORDER BY families."createdAt" ASC`,
    [req.user.id]
  );
  res.json({ families: rows });
}));

router.post('/families', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name)) return res.status(400).json({ error: 'A family name is required' });
  const id = newId('fam');
  const now = new Date().toISOString();
  let joinCode;
  for (let i = 0; i < 5; i++) {
    joinCode = newJoinCode();
    if (!(await dbGet('SELECT id FROM families WHERE "joinCode" = $1', [joinCode]))) break;
  }
  await dbRun('INSERT INTO families (id, name, "ownerId", "joinCode", "createdAt") VALUES ($1,$2,$3,$4,$5)',
    [id, b.name.trim(), req.user.id, joinCode, now]);
  await dbRun('INSERT INTO family_members ("familyId","userId",role,"joinedAt") VALUES ($1,$2,$3,$4)',
    [id, req.user.id, 'owner', now]);
  await dbRun('INSERT INTO conversations (id, type, "familyId", "createdAt") VALUES ($1,$2,$3,$4)',
    [newId('conv'), 'family', id, now]);
  const family = await dbGet('SELECT * FROM families WHERE id = $1', [id]);
  res.status(201).json({ family });
}));

async function assertFamilyMember(req, res, familyId) {
  const row = await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [familyId, req.user.id]);
  if (!row) {
    res.status(403).json({ error: 'You are not a member of this family' });
    return false;
  }
  return true;
}

router.get('/families/:id', ah(async (req, res) => {
  if (!(await assertFamilyMember(req, res, req.params.id))) return;
  const family = await dbGet('SELECT * FROM families WHERE id = $1', [req.params.id]);
  if (!family) return res.status(404).json({ error: 'Not found' });
  const members = await membersOf('families', 'family_members', 'familyId', req.params.id);
  res.json({ family, members });
}));

router.patch('/families/:id', ah(async (req, res) => {
  if (!(await assertFamilyMember(req, res, req.params.id))) return;
  const name = ((req.body || {}).name || '').trim();
  if (!isNonEmptyString(name)) return res.status(400).json({ error: 'A family name is required' });
  await dbRun('UPDATE families SET name = $1 WHERE id = $2', [name, req.params.id]);
  const family = await dbGet('SELECT * FROM families WHERE id = $1', [req.params.id]);
  res.json({ family });
}));

router.post('/families/:id/photo', upload.single('file'), ah(async (req, res) => {
  if (!(await assertFamilyMember(req, res, req.params.id))) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const photoUrl = '/uploads/' + req.file.filename;
  await dbRun('UPDATE families SET "photoUrl" = $1 WHERE id = $2', [photoUrl, req.params.id]);
  res.json({ photoUrl });
}));

// Text an invite link to someone — they don't need an account yet; the link
// (handled client-side, see server.js's /join/family/:code route) shows a
// preview of the family and prompts sign-up/login before joining.
router.post('/families/:id/invite', ah(async (req, res) => {
  if (!(await assertFamilyMember(req, res, req.params.id))) return;
  const phone = normalizeUkPhone((req.body || {}).phone);
  if (!phone) return res.status(400).json({ error: "That doesn't look like a valid UK mobile number." });
  const family = await dbGet('SELECT * FROM families WHERE id = $1', [req.params.id]);
  const url = `${baseUrlFromReq(req)}/join/family/${family.joinCode}`;
  await sendSms(phone, `${req.user.name} invited you to join "${family.name}" on The Memory Maker: ${url}`);
  res.json({ ok: true });
}));

router.post('/families/join', ah(async (req, res) => {
  const code = ((req.body || {}).joinCode || '').trim().toUpperCase();
  if (!isNonEmptyString(code)) return res.status(400).json({ error: 'A join code is required' });
  const family = await dbGet('SELECT * FROM families WHERE "joinCode" = $1', [code]);
  if (!family) return res.status(404).json({ error: "That join code doesn't match a family" });
  const existing = await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [family.id, req.user.id]);
  if (!existing) {
    await dbRun('INSERT INTO family_members ("familyId","userId",role,"joinedAt") VALUES ($1,$2,$3,$4)',
      [family.id, req.user.id, 'member', new Date().toISOString()]);
  }
  res.json({ family });
}));

router.delete('/families/:id/members/me', ah(async (req, res) => {
  await dbRun('DELETE FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// Public preview shown before the invitee has logged in — just enough to
// say "you've been invited to join The Tomlinsons" without exposing the
// member list to someone who hasn't joined yet.
publicRouter.get('/families/join-preview/:code', ah(async (req, res) => {
  const family = await dbGet('SELECT id, name, "photoUrl" FROM families WHERE "joinCode" = $1', [req.params.code.toUpperCase()]);
  if (!family) return res.status(404).json({ error: "That invite link isn't valid" });
  const { count } = await dbGet('SELECT COUNT(*)::int as count FROM family_members WHERE "familyId" = $1', [family.id]);
  res.json({ type: 'family', name: family.name, photoUrl: family.photoUrl, memberCount: count });
}));

// ---- Friend groups ----

router.get('/groups', ah(async (req, res) => {
  const rows = await dbAll(
    `SELECT friend_groups.* FROM friend_groups
     JOIN friend_group_members ON friend_group_members."groupId" = friend_groups.id
     WHERE friend_group_members."userId" = $1 ORDER BY friend_groups."createdAt" ASC`,
    [req.user.id]
  );
  res.json({ groups: rows });
}));

router.post('/groups', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name)) return res.status(400).json({ error: 'A group name is required' });
  const id = newId('grp');
  const now = new Date().toISOString();
  let joinCode;
  for (let i = 0; i < 5; i++) {
    joinCode = newJoinCode();
    if (!(await dbGet('SELECT id FROM friend_groups WHERE "joinCode" = $1', [joinCode]))) break;
  }
  await dbRun('INSERT INTO friend_groups (id, name, "ownerId", "joinCode", "createdAt") VALUES ($1,$2,$3,$4,$5)',
    [id, b.name.trim(), req.user.id, joinCode, now]);
  await dbRun('INSERT INTO friend_group_members ("groupId","userId",role,"joinedAt") VALUES ($1,$2,$3,$4)',
    [id, req.user.id, 'owner', now]);
  await dbRun('INSERT INTO conversations (id, type, "groupId", "createdAt") VALUES ($1,$2,$3,$4)',
    [newId('conv'), 'group', id, now]);
  const group = await dbGet('SELECT * FROM friend_groups WHERE id = $1', [id]);
  res.status(201).json({ group });
}));

async function assertGroupMember(req, res, groupId) {
  const row = await dbGet('SELECT 1 FROM friend_group_members WHERE "groupId" = $1 AND "userId" = $2', [groupId, req.user.id]);
  if (!row) {
    res.status(403).json({ error: 'You are not a member of this friend group' });
    return false;
  }
  return true;
}

router.get('/groups/:id', ah(async (req, res) => {
  if (!(await assertGroupMember(req, res, req.params.id))) return;
  const group = await dbGet('SELECT * FROM friend_groups WHERE id = $1', [req.params.id]);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const members = await membersOf('friend_groups', 'friend_group_members', 'groupId', req.params.id);
  res.json({ group, members });
}));

router.patch('/groups/:id', ah(async (req, res) => {
  if (!(await assertGroupMember(req, res, req.params.id))) return;
  const name = ((req.body || {}).name || '').trim();
  if (!isNonEmptyString(name)) return res.status(400).json({ error: 'A group name is required' });
  await dbRun('UPDATE friend_groups SET name = $1 WHERE id = $2', [name, req.params.id]);
  const group = await dbGet('SELECT * FROM friend_groups WHERE id = $1', [req.params.id]);
  res.json({ group });
}));

router.post('/groups/:id/photo', upload.single('file'), ah(async (req, res) => {
  if (!(await assertGroupMember(req, res, req.params.id))) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const photoUrl = '/uploads/' + req.file.filename;
  await dbRun('UPDATE friend_groups SET "photoUrl" = $1 WHERE id = $2', [photoUrl, req.params.id]);
  res.json({ photoUrl });
}));

router.post('/groups/:id/invite', ah(async (req, res) => {
  if (!(await assertGroupMember(req, res, req.params.id))) return;
  const phone = normalizeUkPhone((req.body || {}).phone);
  if (!phone) return res.status(400).json({ error: "That doesn't look like a valid UK mobile number." });
  const group = await dbGet('SELECT * FROM friend_groups WHERE id = $1', [req.params.id]);
  const url = `${baseUrlFromReq(req)}/join/group/${group.joinCode}`;
  await sendSms(phone, `${req.user.name} invited you to join "${group.name}" on The Memory Maker: ${url}`);
  res.json({ ok: true });
}));

router.post('/groups/join', ah(async (req, res) => {
  const code = ((req.body || {}).joinCode || '').trim().toUpperCase();
  if (!isNonEmptyString(code)) return res.status(400).json({ error: 'A join code is required' });
  const group = await dbGet('SELECT * FROM friend_groups WHERE "joinCode" = $1', [code]);
  if (!group) return res.status(404).json({ error: "That join code doesn't match a friend group" });
  const existing = await dbGet('SELECT 1 FROM friend_group_members WHERE "groupId" = $1 AND "userId" = $2', [group.id, req.user.id]);
  if (!existing) {
    await dbRun('INSERT INTO friend_group_members ("groupId","userId",role,"joinedAt") VALUES ($1,$2,$3,$4)',
      [group.id, req.user.id, 'member', new Date().toISOString()]);
  }
  res.json({ group });
}));

router.delete('/groups/:id/members/me', ah(async (req, res) => {
  await dbRun('DELETE FROM friend_group_members WHERE "groupId" = $1 AND "userId" = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

publicRouter.get('/groups/join-preview/:code', ah(async (req, res) => {
  const group = await dbGet('SELECT id, name, "photoUrl" FROM friend_groups WHERE "joinCode" = $1', [req.params.code.toUpperCase()]);
  if (!group) return res.status(404).json({ error: "That invite link isn't valid" });
  const { count } = await dbGet('SELECT COUNT(*)::int as count FROM friend_group_members WHERE "groupId" = $1', [group.id]);
  res.json({ type: 'group', name: group.name, photoUrl: group.photoUrl, memberCount: count });
}));

module.exports = { router, publicRouter, assertFamilyMember, assertGroupMember };

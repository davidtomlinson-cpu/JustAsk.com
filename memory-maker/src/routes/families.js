const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, newJoinCode } = require('../helpers');

const router = express.Router();

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

module.exports = { router, assertFamilyMember, assertGroupMember };

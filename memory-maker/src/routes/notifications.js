const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah } = require('../helpers');

const router = express.Router();

router.get('/notifications', ah(async (req, res) => {
  const rows = await dbAll('SELECT * FROM notifications WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 50', [req.user.id]);
  res.json({ notifications: rows });
}));

router.get('/notifications/unread-count', ah(async (req, res) => {
  const row = await dbGet('SELECT COUNT(*)::int as count FROM notifications WHERE "userId" = $1 AND "readAt" IS NULL', [req.user.id]);
  res.json({ count: row.count });
}));

router.post('/notifications/:id/read', ah(async (req, res) => {
  await dbRun('UPDATE notifications SET "readAt" = $1 WHERE id = $2 AND "userId" = $3', [new Date().toISOString(), req.params.id, req.user.id]);
  res.json({ ok: true });
}));

router.post('/notifications/read-all', ah(async (req, res) => {
  await dbRun('UPDATE notifications SET "readAt" = $1 WHERE "userId" = $2 AND "readAt" IS NULL', [new Date().toISOString(), req.user.id]);
  res.json({ ok: true });
}));

module.exports = { router };

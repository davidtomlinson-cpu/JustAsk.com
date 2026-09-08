const crypto = require('crypto');
const express = require('express');
const { dbGet, dbRun } = require('./db');
const { ah, isNonEmptyString, newId, normalizeUkPhone } = require('./helpers');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const parts = (stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await dbRun('INSERT INTO sessions (token, "userId", "expiresAt", "createdAt") VALUES ($1,$2,$3,$4)',
    [token, userId, expiresAt, now.toISOString()]);
  return token;
}

async function userFromReq(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  const row = await dbGet(
    `SELECT users.id, users.name, users.email, users.phone, users."smsOptIn", users.color, sessions."expiresAt"
     FROM sessions JOIN users ON users.id = sessions."userId"
     WHERE sessions.token = $1`,
    [match[1]]
  );
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date()) {
    await dbRun('DELETE FROM sessions WHERE token = $1', [match[1]]);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, smsOptIn: row.smsOptIn, color: row.color };
}

function requireAuth() {
  return ah(async function (req, res, next) {
    const user = await userFromReq(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    req.user = user;
    next();
  });
}

const router = express.Router();

const AVATAR_COLORS = ['#4F46E5', '#DB2777', '#059669', '#D97706', '#0891B2', '#7C3AED', '#DC2626', '#65A30D'];

router.post('/signup', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name) || !isNonEmptyString(b.email) || !isNonEmptyString(b.password)) {
    return res.status(400).json({ error: 'Name, email and password are all required' });
  }
  if (b.password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const email = b.email.toLowerCase().trim();
  if (await dbGet('SELECT id FROM users WHERE email = $1', [email])) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const id = newId('user');
  const now = new Date().toISOString();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  let phone = null;
  if (isNonEmptyString(b.phone)) {
    phone = normalizeUkPhone(b.phone);
    if (!phone) return res.status(400).json({ error: "That doesn't look like a valid UK mobile number." });
  }
  await dbRun(
    'INSERT INTO users (id, name, email, "passwordHash", phone, "smsOptIn", color, "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, b.name.trim(), email, hashPassword(b.password), phone, !!phone, color, now]
  );
  const token = await createSession(id);
  res.status(201).json({ token, user: { id, name: b.name.trim(), email, phone, smsOptIn: !!phone, color } });
}));

router.post('/login', ah(async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').toLowerCase().trim();
  const row = await dbGet('SELECT * FROM users WHERE email = $1', [email]);
  if (!row || !verifyPassword(b.password || '', row.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = await createSession(row.id);
  res.json({ token, user: { id: row.id, name: row.name, email: row.email, phone: row.phone, smsOptIn: row.smsOptIn, color: row.color } });
}));

router.post('/logout', requireAuth(), ah(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  await dbRun('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
}));

router.get('/me', requireAuth(), ah(async (req, res) => {
  res.json({ user: req.user });
}));

router.patch('/me', requireAuth(), ah(async (req, res) => {
  const b = req.body || {};
  const current = await dbGet('SELECT phone, "smsOptIn" FROM users WHERE id = $1', [req.user.id]);
  let phone = current.phone;
  if (b.phone !== undefined) {
    if (b.phone === null || b.phone === '') {
      phone = null;
    } else {
      phone = normalizeUkPhone(b.phone);
      if (!phone) return res.status(400).json({ error: "That doesn't look like a valid UK mobile number." });
    }
  }
  const smsOptIn = b.smsOptIn !== undefined ? !!b.smsOptIn && !!phone : current.smsOptIn;
  await dbRun('UPDATE users SET phone = $1, "smsOptIn" = $2 WHERE id = $3', [phone, smsOptIn, req.user.id]);
  const updated = await dbGet('SELECT id, name, email, phone, "smsOptIn", color FROM users WHERE id = $1', [req.user.id]);
  res.json({ user: updated });
}));

module.exports = { router, requireAuth, userFromReq, hashPassword, verifyPassword, createSession };

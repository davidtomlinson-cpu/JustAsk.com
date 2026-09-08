const crypto = require('crypto');

function ah(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newJoinCode() {
  // Short, human-typeable code for sharing a family/group verbally or by text.
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Accepts common UK mobile formats and normalizes to E.164 — same rule as
// the sibling JustAsk backend in this repo.
function normalizeUkPhone(raw) {
  if (!isNonEmptyString(raw)) return null;
  const digits = raw.replace(/[\s\-()]/g, '');
  if (/^\+44\d{10}$/.test(digits)) return digits;
  if (/^0044\d{10}$/.test(digits)) return '+44' + digits.slice(4);
  if (/^44\d{10}$/.test(digits)) return '+' + digits;
  if (/^0\d{10}$/.test(digits)) return '+44' + digits.slice(1);
  return null;
}

function baseUrlFromReq(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return proto + '://' + req.get('host');
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

// Monday of the week containing `d` (a Date), as YYYY-MM-DD.
function mondayOf(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

function dateForDay(weekStart, day) {
  const idx = DAYS.indexOf(day);
  const d = new Date(weekStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + idx);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  ah, isNonEmptyString, newId, newToken, newJoinCode, normalizeUkPhone, baseUrlFromReq,
  DAYS, DAY_LABELS, mondayOf, dateForDay
};

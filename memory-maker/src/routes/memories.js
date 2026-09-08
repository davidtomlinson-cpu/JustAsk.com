const path = require('path');
const express = require('express');
const multer = require('multer');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId } = require('../helpers');
const { assertFamilyMember, assertGroupMember } = require('./families');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — generous enough for a phone photo/video clip

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, newId('media') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype) || /^video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only photo or video files can be uploaded'));
  }
});

async function mediaOf(memoryId) {
  return dbAll('SELECT * FROM memory_media WHERE "memoryId" = $1 ORDER BY "createdAt" ASC', [memoryId]);
}
async function attendeesOf(memoryId) {
  return dbAll(
    `SELECT users.id, users.name, users.color FROM memory_attendees
     JOIN users ON users.id = memory_attendees."userId" WHERE memory_attendees."memoryId" = $1`,
    [memoryId]
  );
}

async function scopeAllowed(req, res, familyId, groupId) {
  if (familyId && !(await assertFamilyMember(req, res, familyId))) return false;
  if (groupId && !(await assertGroupMember(req, res, groupId))) return false;
  return true;
}

async function canSeeMemory(req, memory) {
  if (memory.createdBy === req.user.id) return true;
  if (memory.familyId && await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [memory.familyId, req.user.id])) return true;
  if (memory.groupId && await dbGet('SELECT 1 FROM friend_group_members WHERE "groupId" = $1 AND "userId" = $2', [memory.groupId, req.user.id])) return true;
  return false;
}

// List memories for a date, or a date range, scoped to a family/group — this
// is what backs "tap today's date and see/add what happened".
router.get('/memories', ah(async (req, res) => {
  const { familyId, groupId, date, from, to } = req.query;
  if (!familyId && !groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!(await scopeAllowed(req, res, familyId, groupId))) return;

  let where = familyId ? '"familyId" = $1' : '"groupId" = $1';
  const params = [familyId || groupId];
  if (date) { where += ' AND date = $2'; params.push(date); }
  else if (from && to) { where += ' AND date BETWEEN $2 AND $3'; params.push(from, to); }

  const rows = await dbAll(`SELECT * FROM memories WHERE ${where} ORDER BY date DESC, "createdAt" DESC`, params);
  for (const m of rows) { m.media = await mediaOf(m.id); m.attendees = await attendeesOf(m.id); }
  res.json({ memories: rows });
}));

router.post('/memories', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.date)) return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required' });
  if (!b.familyId && !b.groupId) return res.status(400).json({ error: 'familyId or groupId is required' });
  if (!(await scopeAllowed(req, res, b.familyId, b.groupId))) return;

  const id = newId('mem');
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO memories (id,"familyId","groupId","eventId",date,title,note,"createdBy","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, b.familyId || null, b.groupId || null, b.eventId || null, b.date, b.title || null, b.note || null, req.user.id, now]
  );
  const attendeeIds = Array.isArray(b.attendeeUserIds) ? Array.from(new Set(b.attendeeUserIds)) : [];
  if (!attendeeIds.includes(req.user.id)) attendeeIds.push(req.user.id);
  for (const userId of attendeeIds) {
    await dbRun('INSERT INTO memory_attendees ("memoryId","userId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, userId]);
  }
  const memory = await dbGet('SELECT * FROM memories WHERE id = $1', [id]);
  memory.media = [];
  memory.attendees = await attendeesOf(id);
  res.status(201).json({ memory });
}));

router.get('/memories/:id', ah(async (req, res) => {
  const memory = await dbGet('SELECT * FROM memories WHERE id = $1', [req.params.id]);
  if (!memory) return res.status(404).json({ error: 'Not found' });
  if (!(await canSeeMemory(req, memory))) return res.status(403).json({ error: 'Not allowed to view this memory' });
  memory.media = await mediaOf(memory.id);
  memory.attendees = await attendeesOf(memory.id);
  res.json({ memory });
}));

// The "press a button, camera opens, upload straight into today's album"
// flow: the frontend's <input capture> hands back a file, this stores it
// and attaches it to the memory in one call.
router.post('/memories/:id/media', upload.single('file'), ah(async (req, res) => {
  const memory = await dbGet('SELECT * FROM memories WHERE id = $1', [req.params.id]);
  if (!memory) return res.status(404).json({ error: 'Not found' });
  if (!(await canSeeMemory(req, memory))) return res.status(403).json({ error: 'Not allowed to add to this memory' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
  const id = newId('media');
  const url = '/uploads/' + req.file.filename;
  await dbRun('INSERT INTO memory_media (id,"memoryId",type,url,"uploadedBy","createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
    [id, memory.id, type, url, req.user.id, new Date().toISOString()]);
  res.status(201).json({ media: { id, memoryId: memory.id, type, url, uploadedBy: req.user.id } });
}));

router.delete('/memories/:memoryId/media/:mediaId', ah(async (req, res) => {
  const memory = await dbGet('SELECT * FROM memories WHERE id = $1', [req.params.memoryId]);
  if (!memory) return res.status(404).json({ error: 'Not found' });
  const media = await dbGet('SELECT * FROM memory_media WHERE id = $1 AND "memoryId" = $2', [req.params.mediaId, req.params.memoryId]);
  if (!media) return res.status(404).json({ error: 'Not found' });
  if (media.uploadedBy !== req.user.id && memory.createdBy !== req.user.id) return res.status(403).json({ error: 'Not allowed to remove this' });
  await dbRun('DELETE FROM memory_media WHERE id = $1', [req.params.mediaId]);
  res.json({ ok: true });
}));

module.exports = { router, UPLOAD_DIR };

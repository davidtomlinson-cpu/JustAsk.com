// Messaging: one implicit group chat per family and per friend group (every
// member is automatically a participant, no invites needed), plus 1:1
// direct messages between two people who share a family or friend group.
// Text + shared photos/videos, polling-based (GET .../messages?after=...)
// rather than websockets — same "poll every few seconds" pattern the
// sibling JustAsk app already uses for its own live updates, which keeps
// this dependency-free.

const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, makeUploader } = require('../helpers');

const router = express.Router();
const upload = makeUploader();

async function listConversationsFor(userId) {
  const familyConvos = await dbAll(
    `SELECT conversations.id, conversations.type, families.name as title, families."photoUrl" as "photoUrl",
            NULL as "otherUserId", NULL as "otherUserColor"
     FROM conversations
     JOIN families ON families.id = conversations."familyId"
     JOIN family_members ON family_members."familyId" = families.id AND family_members."userId" = $1
     WHERE conversations.type = 'family'`,
    [userId]
  );
  const groupConvos = await dbAll(
    `SELECT conversations.id, conversations.type, friend_groups.name as title, friend_groups."photoUrl" as "photoUrl",
            NULL as "otherUserId", NULL as "otherUserColor"
     FROM conversations
     JOIN friend_groups ON friend_groups.id = conversations."groupId"
     JOIN friend_group_members ON friend_group_members."groupId" = friend_groups.id AND friend_group_members."userId" = $1
     WHERE conversations.type = 'group'`,
    [userId]
  );
  const directConvos = await dbAll(
    `SELECT conversations.id, conversations.type, other.name as title, NULL as "photoUrl",
            other.id as "otherUserId", other.color as "otherUserColor"
     FROM conversation_participants me
     JOIN conversations ON conversations.id = me."conversationId" AND conversations.type = 'direct'
     JOIN conversation_participants them ON them."conversationId" = conversations.id AND them."userId" != $1
     JOIN users other ON other.id = them."userId"
     WHERE me."userId" = $1`,
    [userId]
  );
  // Event chats only show up once someone's actually opened one (see
  // POST /api/events/:id/conversation) — membership tracks event_attendees
  // live, so this only lists ones where the caller is still a confirmed
  // ("accepted") attendee right now.
  const eventConvos = await dbAll(
    `SELECT conversations.id, conversations.type, events.title as title, NULL as "photoUrl",
            NULL as "otherUserId", NULL as "otherUserColor", events."startsAt" as "eventStartsAt"
     FROM conversations
     JOIN events ON events.id = conversations."eventId"
     JOIN event_attendees ON event_attendees."eventId" = events.id AND event_attendees."userId" = $1 AND event_attendees.status = 'accepted'
     WHERE conversations.type = 'event'`,
    [userId]
  );

  const all = [...familyConvos, ...groupConvos, ...directConvos, ...eventConvos];
  if (!all.length) return [];
  const ids = all.map((c) => c.id);
  const lastMessages = await dbAll(
    `SELECT DISTINCT ON (messages."conversationId") messages."conversationId" as "conversationId",
            messages.body, messages."senderId", messages."createdAt", users.name as "senderName",
            EXISTS(SELECT 1 FROM message_media WHERE message_media."messageId" = messages.id) as "hasMedia"
     FROM messages JOIN users ON users.id = messages."senderId"
     WHERE messages."conversationId" = ANY($1)
     ORDER BY messages."conversationId", messages."createdAt" DESC`,
    [ids]
  );
  const lastByConvo = {};
  for (const m of lastMessages) lastByConvo[m.conversationId] = m;

  return all
    .map((c) => ({ ...c, lastMessage: lastByConvo[c.id] || null }))
    .sort((a, b) => {
      const at = a.lastMessage ? a.lastMessage.createdAt : '';
      const bt = b.lastMessage ? b.lastMessage.createdAt : '';
      return bt.localeCompare(at);
    });
}

router.get('/conversations', ah(async (req, res) => {
  res.json({ conversations: await listConversationsFor(req.user.id) });
}));

// Get-or-create a direct conversation with another user — restricted to
// people who share a family or friend group, so this can't be used to
// message a stranger.
router.post('/conversations/direct', ah(async (req, res) => {
  const otherUserId = (req.body || {}).userId;
  if (!isNonEmptyString(otherUserId)) return res.status(400).json({ error: 'userId is required' });
  if (otherUserId === req.user.id) return res.status(400).json({ error: "You can't message yourself" });

  const other = await dbGet('SELECT id, name, color FROM users WHERE id = $1', [otherUserId]);
  if (!other) return res.status(404).json({ error: 'User not found' });

  const shared = await dbGet(
    `SELECT 1 FROM family_members a JOIN family_members b ON a."familyId" = b."familyId" WHERE a."userId" = $1 AND b."userId" = $2
     UNION SELECT 1 FROM friend_group_members a JOIN friend_group_members b ON a."groupId" = b."groupId" WHERE a."userId" = $1 AND b."userId" = $2`,
    [req.user.id, otherUserId]
  );
  if (!shared) return res.status(403).json({ error: "You can only message people who share a family or friend group with you" });

  const existing = await dbGet(
    `SELECT conversations.id FROM conversations
     JOIN conversation_participants p1 ON p1."conversationId" = conversations.id AND p1."userId" = $1
     JOIN conversation_participants p2 ON p2."conversationId" = conversations.id AND p2."userId" = $2
     WHERE conversations.type = 'direct'`,
    [req.user.id, otherUserId]
  );
  let conversationId = existing ? existing.id : null;
  if (!conversationId) {
    conversationId = newId('conv');
    const now = new Date().toISOString();
    await dbRun('INSERT INTO conversations (id, type, "createdAt") VALUES ($1,$2,$3)', [conversationId, 'direct', now]);
    await dbRun('INSERT INTO conversation_participants ("conversationId","userId","createdAt") VALUES ($1,$2,$3),($1,$4,$3)',
      [conversationId, req.user.id, now, otherUserId]);
  }
  res.status(201).json({ conversation: { id: conversationId, type: 'direct', title: other.name, photoUrl: null, otherUserId: other.id, otherUserColor: other.color, lastMessage: null } });
}));

async function loadConversationForUser(req, res) {
  const convo = await dbGet('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
  if (!convo) { res.status(404).json({ error: 'Not found' }); return null; }
  let allowed = false;
  if (convo.type === 'family') {
    allowed = !!(await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [convo.familyId, req.user.id]));
  } else if (convo.type === 'group') {
    allowed = !!(await dbGet('SELECT 1 FROM friend_group_members WHERE "groupId" = $1 AND "userId" = $2', [convo.groupId, req.user.id]));
  } else if (convo.type === 'event') {
    const attendee = await dbGet('SELECT status FROM event_attendees WHERE "eventId" = $1 AND "userId" = $2', [convo.eventId, req.user.id]);
    allowed = !!attendee && attendee.status === 'accepted';
  } else {
    allowed = !!(await dbGet('SELECT 1 FROM conversation_participants WHERE "conversationId" = $1 AND "userId" = $2', [convo.id, req.user.id]));
  }
  if (!allowed) { res.status(403).json({ error: 'Not allowed to view this conversation' }); return null; }
  return convo;
}

async function mediaOf(messageId) {
  return dbAll('SELECT id, type, url FROM message_media WHERE "messageId" = $1', [messageId]);
}

// GET .../messages with no `after` = initial load (most recent `limit`,
// oldest-first); with `after` = only what's arrived since, for polling.
router.get('/conversations/:id/messages', ah(async (req, res) => {
  const convo = await loadConversationForUser(req, res);
  if (!convo) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  let rows;
  if (req.query.after) {
    rows = await dbAll(
      `SELECT messages.*, users.name as "senderName", users.color as "senderColor" FROM messages
       JOIN users ON users.id = messages."senderId"
       WHERE messages."conversationId" = $1 AND messages."createdAt" > $2 ORDER BY messages."createdAt" ASC`,
      [convo.id, req.query.after]
    );
  } else {
    rows = await dbAll(
      `SELECT messages.*, users.name as "senderName", users.color as "senderColor" FROM messages
       JOIN users ON users.id = messages."senderId"
       WHERE messages."conversationId" = $1 ORDER BY messages."createdAt" DESC LIMIT $2`,
      [convo.id, limit]
    );
    rows.reverse();
  }
  for (const m of rows) m.media = await mediaOf(m.id);
  res.json({ messages: rows });
}));

router.post('/conversations/:id/messages', upload.single('file'), ah(async (req, res) => {
  const convo = await loadConversationForUser(req, res);
  if (!convo) return;
  const body = ((req.body || {}).body || '').trim();
  if (!body && !req.file) return res.status(400).json({ error: 'A message needs text or a photo/video' });

  const id = newId('msg');
  const now = new Date().toISOString();
  await dbRun('INSERT INTO messages (id, "conversationId", "senderId", body, "createdAt") VALUES ($1,$2,$3,$4,$5)',
    [id, convo.id, req.user.id, body || null, now]);

  let media = [];
  if (req.file) {
    const mediaId = newId('media');
    const type = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const url = '/uploads/' + req.file.filename;
    await dbRun('INSERT INTO message_media (id, "messageId", type, url, "createdAt") VALUES ($1,$2,$3,$4,$5)', [mediaId, id, type, url, now]);
    media = [{ id: mediaId, type, url }];
  }

  res.status(201).json({ message: { id, conversationId: convo.id, senderId: req.user.id, senderName: req.user.name, senderColor: req.user.color, body: body || null, createdAt: now, media } });
}));

router.delete('/messages/:id', ah(async (req, res) => {
  const message = await dbGet('SELECT * FROM messages WHERE id = $1', [req.params.id]);
  if (!message) return res.status(404).json({ error: 'Not found' });
  if (message.senderId !== req.user.id) return res.status(403).json({ error: 'You can only delete your own messages' });
  await dbRun('DELETE FROM message_media WHERE "messageId" = $1', [message.id]);
  await dbRun('DELETE FROM messages WHERE id = $1', [message.id]);
  res.json({ ok: true });
}));

module.exports = { router };

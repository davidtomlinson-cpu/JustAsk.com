// The Memory Maker — database layer (Postgres via `pg`).
//
// Same shape as the sibling JustAsk backend in this repo: a plain Pool,
// get/all/run helpers so call sites read synchronously-ish, and one big
// CREATE TABLE IF NOT EXISTS block that's safe to re-run on every boot.
// This app's tables are entirely separate from JustAsk's (different names,
// no shared foreign keys) so the two can live in the same Postgres
// database, or different ones, without colliding.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. The Memory Maker needs a Postgres database — see README.md.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
});

async function dbGet(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0];
}
async function dbAll(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}
async function dbRun(text, params) {
  return pool.query(text, params);
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT NOT NULL,
    phone TEXT,
    "smsOptIn" BOOLEAN NOT NULL DEFAULT false,
    color TEXT NOT NULL DEFAULT '#4F46E5',
    "createdAt" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS families (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    "photoUrl" TEXT,
    "ownerId" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL UNIQUE,
    "createdAt" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS family_members (
    "familyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TEXT NOT NULL,
    PRIMARY KEY ("familyId", "userId")
  );
  CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members("userId");

  CREATE TABLE IF NOT EXISTS friend_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    "photoUrl" TEXT,
    "ownerId" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL UNIQUE,
    "createdAt" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friend_group_members (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TEXT NOT NULL,
    PRIMARY KEY ("groupId", "userId")
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON friend_group_members("userId");

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    "familyId" TEXT,
    "groupId" TEXT,
    title TEXT NOT NULL,
    description TEXT,
    "startsAt" TEXT NOT NULL,
    "endsAt" TEXT NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    location TEXT,
    "occasionType" TEXT NOT NULL DEFAULT 'event',
    recurrence TEXT NOT NULL DEFAULT 'none',
    "reminderOffsetsHours" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    private BOOLEAN NOT NULL DEFAULT false,
    "externalSource" TEXT,
    "externalId" TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_family ON events("familyId");
  CREATE INDEX IF NOT EXISTS idx_events_group ON events("groupId");
  CREATE INDEX IF NOT EXISTS idx_events_starts ON events("startsAt");

  CREATE TABLE IF NOT EXISTS event_attendees (
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'invited',
    "respondedAt" TEXT,
    PRIMARY KEY ("eventId", "userId")
  );
  CREATE INDEX IF NOT EXISTS idx_attendees_user ON event_attendees("userId");

  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offsetHours" INTEGER NOT NULL,
    "dueAt" TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'sms',
    "sentAt" TEXT,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders("dueAt");

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    "familyId" TEXT,
    "groupId" TEXT,
    "eventId" TEXT,
    date TEXT NOT NULL,
    title TEXT,
    note TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_date ON memories(date);
  CREATE INDEX IF NOT EXISTS idx_memories_family ON memories("familyId");
  CREATE INDEX IF NOT EXISTS idx_memories_group ON memories("groupId");

  CREATE TABLE IF NOT EXISTS memory_media (
    id TEXT PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_memory ON memory_media("memoryId");

  CREATE TABLE IF NOT EXISTS memory_attendees (
    "memoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    PRIMARY KEY ("memoryId", "userId")
  );

  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    "familyId" TEXT NOT NULL,
    "assignedTo" TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    "dueAt" TEXT,
    "reminderOffsetHours" INTEGER,
    "reminderChannel" TEXT NOT NULL DEFAULT 'app',
    "reminderSentAt" TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_todos_family ON todos("familyId");
  CREATE INDEX IF NOT EXISTS idx_todos_assignee ON todos("assignedTo");

  CREATE TABLE IF NOT EXISTS high_fives (
    id TEXT PRIMARY KEY,
    "todoId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    UNIQUE ("todoId", "fromUserId")
  );

  CREATE TABLE IF NOT EXISTS dinner_polls (
    id TEXT PRIMARY KEY,
    "familyId" TEXT,
    "groupId" TEXT,
    "weekStart" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_polls_week ON dinner_polls("weekStart");
  CREATE INDEX IF NOT EXISTS idx_polls_family ON dinner_polls("familyId");
  CREATE INDEX IF NOT EXISTS idx_polls_group ON dinner_polls("groupId");

  CREATE TABLE IF NOT EXISTS dinner_poll_recipients (
    id TEXT PRIMARY KEY,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "respondedAt" TEXT,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_poll_recipients_poll ON dinner_poll_recipients("pollId");

  CREATE TABLE IF NOT EXISTS dinner_poll_responses (
    "recipientId" TEXT NOT NULL,
    day TEXT NOT NULL,
    "inFor" BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY ("recipientId", day)
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    "familyId" TEXT,
    "createdBy" TEXT NOT NULL,
    title TEXT NOT NULL,
    servings INTEGER,
    ingredients TEXT NOT NULL,
    instructions TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceUrl" TEXT,
    liked BOOLEAN NOT NULL DEFAULT false,
    "timesCooked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recipes_family ON recipes("familyId");

  CREATE TABLE IF NOT EXISTS weekly_meal_days (
    id TEXT PRIMARY KEY,
    "familyId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    day TEXT NOT NULL,
    "recipeId" TEXT,
    notes TEXT,
    "createdAt" TEXT NOT NULL,
    UNIQUE ("familyId", "weekStart", day)
  );

  CREATE TABLE IF NOT EXISTS shopping_list_items (
    id TEXT PRIMARY KEY,
    "familyId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    ingredient TEXT NOT NULL,
    quantity TEXT,
    unit TEXT,
    days TEXT NOT NULL,
    "recipeIds" TEXT NOT NULL,
    checked BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shopping_family_week ON shopping_list_items("familyId", "weekStart");

  CREATE TABLE IF NOT EXISTS meal_ratings (
    id TEXT PRIMARY KEY,
    "weeklyMealDayId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    rating TEXT,
    "respondedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    UNIQUE ("weeklyMealDayId", "recipientId")
  );

  -- Messaging: one implicit conversation per family and per friend group
  -- (every member is a participant by virtue of membership, no separate
  -- participant rows needed there), plus direct 1:1 conversations which do
  -- use conversation_participants explicitly.
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    "familyId" TEXT,
    "groupId" TEXT,
    "eventId" TEXT,
    "createdAt" TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_family ON conversations("familyId") WHERE type = 'family';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_group ON conversations("groupId") WHERE type = 'group';

  CREATE TABLE IF NOT EXISTS conversation_participants (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    PRIMARY KEY ("conversationId", "userId")
  );
  CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants("userId");

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    body TEXT,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages("conversationId", "createdAt");

  CREATE TABLE IF NOT EXISTS message_media (
    id TEXT PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_media_message ON message_media("messageId");

  -- One connected external calendar per user per provider (currently just
  -- Google). accessToken/refreshToken are OAuth2 tokens; imported events
  -- live in the regular events table, tagged via events."externalSource".
  CREATE TABLE IF NOT EXISTS calendar_connections (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'google',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TEXT NOT NULL,
    "calendarEmail" TEXT,
    "lastSyncedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    UNIQUE ("userId", provider)
  );

  -- Dedupe guard so a daily-summary cron that fires more than once (a
  -- manual re-trigger, an overlapping schedule) never double-texts someone
  -- on the same day.
  CREATE TABLE IF NOT EXISTS daily_summary_log (
    "userId" TEXT NOT NULL,
    date TEXT NOT NULL,
    "sentAt" TEXT NOT NULL,
    PRIMARY KEY ("userId", date)
  );

  -- "Call to action" — an open request anyone in the family/group can
  -- claim (first to accept gets it; status enforces that atomically, see
  -- src/routes/callouts.js). "callout_recipients" mirrors dinner_poll's
  -- recipient/token shape so a callout can optionally be texted out with a
  -- magic link that accepts it without needing to open the app.
  CREATE TABLE IF NOT EXISTS callouts (
    id TEXT PRIMARY KEY,
    "familyId" TEXT,
    "groupId" TEXT,
    title TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    "createdBy" TEXT NOT NULL,
    "acceptedBy" TEXT,
    "acceptedAt" TEXT,
    "completedAt" TEXT,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_callouts_family ON callouts("familyId");
  CREATE INDEX IF NOT EXISTS idx_callouts_group ON callouts("groupId");

  CREATE TABLE IF NOT EXISTS callout_recipients (
    id TEXT PRIMARY KEY,
    "calloutId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_callout_recipients_callout ON callout_recipients("calloutId");

  -- General-purpose polls (distinct from the Mon-Sun dinner_polls above) —
  -- an arbitrary question with arbitrary options ("Spain or Portugal?",
  -- "cinema Wednesday? yes/no"), one vote per person, changeable.
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    "familyId" TEXT,
    "groupId" TEXT,
    question TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_polls2_family ON polls("familyId");
  CREATE INDEX IF NOT EXISTS idx_polls2_group ON polls("groupId");

  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    "pollId" TEXT NOT NULL,
    label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options("pollId");

  CREATE TABLE IF NOT EXISTS poll_recipients (
    id TEXT PRIMARY KEY,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_poll_recipients2_poll ON poll_recipients("pollId");

  CREATE TABLE IF NOT EXISTS poll_votes (
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "votedAt" TEXT NOT NULL,
    PRIMARY KEY ("pollId", "userId")
  );
`;

async function initDb() {
  await pool.query(SCHEMA_SQL);
  // Additive migrations for columns/rows introduced after a database may
  // already have data — safe to re-run every boot.
  await pool.query('ALTER TABLE families ADD COLUMN IF NOT EXISTS "photoUrl" TEXT');
  await pool.query('ALTER TABLE friend_groups ADD COLUMN IF NOT EXISTS "photoUrl" TEXT');
  await pool.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "eventId" TEXT');
  await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS private BOOLEAN NOT NULL DEFAULT false');
  await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS "externalSource" TEXT');
  await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS "externalId" TEXT');
  // These indexes reference columns only guaranteed to exist after the
  // ALTERs above run (an already-existing table from before this feature
  // wouldn't have had them yet), so they can't live in the CREATE TABLE
  // block above — that runs first, before the ALTERs.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_event ON conversations("eventId") WHERE type = 'event'`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events("createdBy", "externalSource", "externalId") WHERE "externalSource" IS NOT NULL`);
  await backfillConversations();
}

// Group chat is implicit (every family/group member is a participant) but
// still needs one conversation row per family/group to hang messages off
// of. New families/groups create theirs at creation time; this backfills
// any that existed before messaging did.
async function backfillConversations() {
  const crypto = require('crypto');
  const orphanFamilies = await dbAll(
    `SELECT families.id, families."createdAt" FROM families
     LEFT JOIN conversations ON conversations."familyId" = families.id AND conversations.type = 'family'
     WHERE conversations.id IS NULL`
  );
  for (const f of orphanFamilies) {
    await dbRun('INSERT INTO conversations (id, type, "familyId", "createdAt") VALUES ($1,$2,$3,$4)',
      ['conv_' + crypto.randomBytes(8).toString('hex'), 'family', f.id, f.createdAt]);
  }
  const orphanGroups = await dbAll(
    `SELECT friend_groups.id, friend_groups."createdAt" FROM friend_groups
     LEFT JOIN conversations ON conversations."groupId" = friend_groups.id AND conversations.type = 'group'
     WHERE conversations.id IS NULL`
  );
  for (const g of orphanGroups) {
    await dbRun('INSERT INTO conversations (id, type, "groupId", "createdAt") VALUES ($1,$2,$3,$4)',
      ['conv_' + crypto.randomBytes(8).toString('hex'), 'group', g.id, g.createdAt]);
  }
}

module.exports = { pool, dbGet, dbAll, dbRun, initDb };

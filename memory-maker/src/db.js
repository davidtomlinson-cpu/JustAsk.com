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
    "updatedAt" TEXT NOT NULL
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
`;

async function initDb() {
  await pool.query(SCHEMA_SQL);
}

module.exports = { pool, dbGet, dbAll, dbRun, initDb };

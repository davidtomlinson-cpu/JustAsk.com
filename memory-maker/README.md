# The Memory Maker

A family planner: shared calendars, a photo/video memory album tied to each
date, to-do lists with high-fives, weekly dinner planning, AI recipe
generation, an interactive shopping list, and post-meal ratings.

This is a **separate app living inside the JustAsk.com repo** — its own
`package.json`, its own Postgres tables, its own deployment. It shares
nothing with the sibling `aaa-backend` (JustAsk Club purchase-request app)
at the repo root except the pattern it's built on (plain Express + Postgres,
no framework, no build step).

## Running it locally

You'll need Node.js 18+ and a Postgres database.

```bash
cd memory-maker
npm install
cp .env.example .env   # then fill in DATABASE_URL at minimum
DATABASE_URL=postgresql://user:pass@localhost:5432/memorymaker_dev npm start
```

Open http://localhost:3100 (or whatever `PORT` you set). All tables and
indexes are created automatically on startup — nothing to migrate by hand.

**Local Postgres via Docker**, if you don't already have one:

```bash
docker run -d --name memorymaker-postgres -e POSTGRES_PASSWORD=memorymaker_dev \
  -e POSTGRES_USER=memorymaker -e POSTGRES_DB=memorymaker_dev -p 5432:5432 postgres:16
```

## What's implemented

Everything below is real, working, end-to-end (backend API + a mobile-first
PWA frontend), not a mock-up:

- **Accounts & families** — sign up, create or join a family via a short
  join code (`/api/families`, `/api/families/join`), same pattern for
  **friend groups** (`/api/groups`) so you can keep a separate calendar and
  dinner/meal planning circle for a friendship group, distinct from family.
- **Shared calendar** — events with attendees, all-day/timed, location,
  and an "occasion type" (birthday/anniversary/other) with **yearly
  recurrence** (creating a birthday event also creates the next 4 years'
  occurrences up front, so it just shows up going forward).
- **Conflict detection** — creating or editing an event checks every
  invited attendee's existing calendar and flags clashes inline, before and
  after saving (`POST /api/calendar/check-conflicts`, and every
  create/update response includes a `conflicts` object). The month calendar
  is the "explore what's already booked" view.
- **Memories** — tap a date (Today tab, or any day in Calendar), press the
  camera button, and the photo/video your phone's camera captures uploads
  straight into that date's memory album, taggable with who was there.
- **Configurable SMS reminders** — pick 1 day / 2 days / 3 days / 1 week
  before an event (or a custom to-do reminder), sent by SMS via Twilio. A
  scheduled sweep (`POST /api/cron/sweep`, guarded by `CRON_SECRET`) is what
  actually sends them — see "Reminders" below.
- **To-dos** — assigned per family member, mark complete or failed, and
  other family members can **high-five** a completed task.
- **Dinner poll → weekly plan** — ask the family/group "who's in for
  dinner this week"; each person gets a simple Monday–Sunday list (by SMS
  link, or directly in-app) and the app compiles who's in on which night.
- **AI recipe generation** — a short prompt ("chicken thigh recipe for 4
  people with a tomato sauce") via Claude, review, then save it. Manual and
  link-based recipes (save a recipe you found elsewhere) work the same way,
  and any saved recipe can be liked for quick reuse.
- **Interactive shopping list** — assign a recipe to each night of the
  week, then generate a shopping list that aggregates ingredients across
  the week's recipes, tags which day(s) each item is needed for, and lets
  you uncheck ("I've already got this") anything already in the
  cupboard/fridge.
- **Post-meal ratings** — after a night's dinner, send everyone who said
  they were in a quick vote: Delicious / Edible / Takeaway next time please.
- **Family/group photos and renaming** — give a family or friend group a
  name and a photo (`PATCH`/`POST .../photo`), same pattern for both.
- **SMS invite links** — any member can text someone a join link
  (`POST .../invite`); the link shows a preview (name + photo, no member
  list) before the invitee even signs in, then joins them once they do.
- **Messaging** — an automatic group chat per family and per friend group
  (every member's already in it, nothing to set up), 1:1 direct messages
  restricted to people who share a family/group with you, and **event
  chat**: once you've confirmed you're attending something, you can open a
  chat scoped to just that event's confirmed attendees
  (`POST /api/events/:id/conversation`) — leaves automatically if you later
  decline. All three support text and a shared photo/video per message.
- **Google Calendar sync** — connect your real Google Calendar and its
  events get pulled in for conflict-checking (see "Google Calendar sync"
  below for exactly what this does and doesn't do).
- **Daily morning summary** — a once-a-day SMS with today's events plus any
  to-dos due today or overdue, sent automatically (see "Reminders" below).

## Google Calendar sync — what it actually does

This is a **one-way, read-only pull**, not a two-way live sync: once you
connect your Google account (`GET /api/integrations/google/connect`, OAuth2
with a `calendar.readonly` scope), the next 30 days of your primary Google
Calendar get imported into your Memory Maker calendar so they show up
alongside family/group events and get checked for conflicts — nothing is
ever created, edited, or deleted on your actual Google Calendar. Imported
events are personal (marked `private`): only you see the real title in your
own calendar view; anyone else who'd conflict with one just sees "Busy",
never the details. Re-syncing (hourly, via the cron sweep — see
"Reminders" — or on demand via `POST /api/integrations/google/sync`)
updates and removes imported events to match what's currently on Google,
so cancellations disappear on the next sync too.

To turn it on: create an OAuth client (type "Web application") in
[Google Cloud Console](https://console.cloud.google.com/), enable the
Calendar API, add `<your-public-url>/api/integrations/google/callback` as
an authorized redirect URI, and set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
Until both are set, `/api/config` reports `googleCalendarEnabled: false`
and the connect endpoint 501s — same optional/gated pattern as Twilio/Claude.

A genuinely two-way sync (creating/editing events on Google Calendar from
here too) is a reasonable next step if wanted, but wasn't necessary for the
actual goal — avoiding double-booking against commitments that live outside
this app — so it wasn't built. The universal `GET /api/calendar.ics` export
still covers the opposite direction (subscribing to your Memory Maker
calendar from Google/Apple/Outlook).

**The camera button** — pressing it opens `<input type="file" capture>`,
which triggers the device's native camera on iOS/Android/desktop browsers
directly from the web app, no native wrapper needed. That's a standard,
reliable way to do this from a PWA. A Capacitor-wrapped version of this app
(the repo's sibling app already has Capacitor set up for iOS/Android) could
swap this for the native Camera plugin for a slightly slicker in-app
capture UI — not done here since it's a separate native-build step, and the
web version already gives the described behaviour (tap → camera opens →
photo/video lands in the album).

## Project structure

```
memory-maker/
  server.js              bootstrap: mounts every router, serves public/
  src/
    db.js                 Postgres pool + schema
    auth.js                sessions, password hashing, /api/auth/*
    helpers.js              shared small utilities + shared upload storage
    sms.js / ai.js / google.js  Twilio + Claude + Google Calendar, all optional/gated
    reminders-cron.js         sweeps POST /api/cron/sweep and /api/cron/daily-summary run
    routes/
      families.js           families + friend groups + membership, photos, SMS invites
      calendar.js             events, attendees, conflicts, .ics export, event chat
      memories.js               memory albums + photo/video upload
      todos.js                    to-dos + high-fives
      dinner.js                     weekly dinner poll + public response
      recipes.js                     AI/manual/link recipes
      shopping.js                     weekly meal days, shopping list, ratings
      messaging.js                    family/group/event/direct chat
      integrations.js                 Google Calendar OAuth connect/sync
  public/
    index.html / app.js / styles.css   the whole frontend (no build step)
    manifest.json / service-worker.js  PWA install support
    icons/                              generated by scripts/gen-icons.js
  scripts/gen-icons.js    placeholder icon generator (swap for real artwork)
  uploads/                 uploaded photos/videos (local disk — see below)
```

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `PORT` | `3100` | Port the server listens on |
| `PGSSL` | *(unset)* | Set to `require` for managed Postgres (Render/Railway/Fly) |
| `PUBLIC_BASE_URL` | *(auto-detected)* | Used to build the SMS magic links (dinner poll, meal rating) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | *(unset — SMS off)* | All three needed to turn SMS on. UK numbers only for now. |
| `ANTHROPIC_API_KEY` | *(unset — AI recipes off)* | Turns on `/api/recipes/generate` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(unset — Google sync off)* | Both needed to turn on Google Calendar sync — see that section above |
| `CRON_SECRET` | *(unset — sweeps disabled)* | Shared secret for `POST /api/cron/sweep` and `POST /api/cron/daily-summary` — set the same value here and as a GitHub Actions secret (see below) |

`/api/config` reports which of these are switched on so the frontend can
hide/disable the relevant bits rather than erroring.

## Reminders — the sweeps need an external trigger

Like its sibling app, this server has no built-in scheduler (a `setInterval`
only fires while the process happens to be awake, which isn't guaranteed on
most free/small hosting tiers). Two GitHub Actions workflows drive
everything time-based:

- `.github/workflows/memory-maker-reminders.yml` calls `POST /api/cron/sweep`
  **hourly** — sends due event/to-do SMS reminders, and re-syncs everyone's
  connected Google Calendar.
- `.github/workflows/memory-maker-daily-summary.yml` calls
  `POST /api/cron/daily-summary` **once a day at a fixed UTC time** (07:00
  UTC by default — edit the workflow's cron expression if your users are
  mostly in a different timezone) — sends the "here's what you've got on
  today" SMS digest. There's no per-user timezone support yet, so this is
  one send time for everyone, not each user's local morning; the
  `daily_summary_log` table stops it double-sending if the workflow ever
  runs twice in a day.

Once you've deployed:

1. Set `CRON_SECRET` on the deployed service.
2. Add two repository secrets: `MEMORY_MAKER_BASE_URL` (e.g.
   `https://memory-maker.onrender.com`) and `MEMORY_MAKER_CRON_SECRET`
   (same value as `CRON_SECRET`) — both workflows share them.

Until those secrets are set, the workflows just no-op rather than failing.

## Photo/video storage

Uploads are stored on local disk under `uploads/` and served statically.
That's fine for local development, but **on most hosting platforms
(including Render's free tier) local disk doesn't survive a redeploy or an
idle-timeout restart** — same caveat the sibling app's README calls out for
SQLite. For anything beyond local testing/demo use, swap `multer`'s
`diskStorage` in `src/routes/memories.js` for an S3-compatible bucket (or
similar) — the upload route is the one place that would need to change.

Uploaded files also aren't access-controlled beyond an unguessable random
filename (no per-request auth check on `/uploads/*`) — acceptable for an
MVP among a trusted family/friend group, worth tightening (signed URLs, or
a proxy route that checks membership) before wider use.

## Deploying it

Same shape as the sibling app: **Render** (New → Postgres, then New → Web
Service pointed at `memory-maker/` as the root directory, build command
`npm install`, start command `npm start`, set `DATABASE_URL` + `PGSSL=require`),
or **Railway/Fly.io** with their managed Postgres, or your own VPS behind
nginx/Caddy with real TLS. See the root README's "Deploying it somewhere
real" section for the detailed walkthrough — it applies here unchanged,
just pointed at this directory instead.

## Backups

Everything lives in Postgres — back that up, not the app:

```bash
pg_dump "$DATABASE_URL" > memory-maker-backup-$(date +%Y%m%d).sql
```

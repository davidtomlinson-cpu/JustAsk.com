// The Memory Maker — a family planner (calendars, memories, to-dos, dinner
// planning, recipes, shopping lists). Express + Postgres API, frontend
// served from ./public — one deploy gives you both, same shape as the
// sibling JustAsk backend in this repo, but a fully separate app: separate
// package.json, separate tables, separate deployment.

const path = require('path');
const express = require('express');
const cors = require('cors');

const { initDb } = require('./src/db');
const { ah } = require('./src/helpers');
const { router: authRouter, requireAuth } = require('./src/auth');
const { router: familiesRouter, publicRouter: familiesPublicRouter } = require('./src/routes/families');
const { router: calendarRouter } = require('./src/routes/calendar');
const { router: memoriesRouter, UPLOAD_DIR } = require('./src/routes/memories');
const { router: todosRouter } = require('./src/routes/todos');
const { router: dinnerRouter, publicRouter: dinnerPublicRouter } = require('./src/routes/dinner');
const { router: recipesRouter } = require('./src/routes/recipes');
const { router: shoppingRouter, publicRouter: shoppingPublicRouter } = require('./src/routes/shopping');
const { router: messagingRouter } = require('./src/routes/messaging');
const { router: integrationsRouter, publicRouter: integrationsPublicRouter } = require('./src/routes/integrations');
const { runSweep, sweepDailySummaries } = require('./src/reminders-cron');
const { smsEnabled } = require('./src/sms');
const { googleCalendarEnabled } = require('./src/google');

const PORT = process.env.PORT || 3100;

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---- Public, unauthenticated endpoints ----

app.use('/api/auth', authRouter); // signup/login are public; logout/me require a token internally
app.use('/api', dinnerPublicRouter); // GET/POST /api/dinner-response/:token
app.use('/api', shoppingPublicRouter); // GET/POST /api/meal-rating/:token
app.use('/api', familiesPublicRouter); // GET /api/families|groups/join-preview/:code
app.use('/api', integrationsPublicRouter); // GET /api/integrations/google/connect|callback

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    smsEnabled,
    recipeGenerationEnabled: !!process.env.ANTHROPIC_API_KEY,
    googleCalendarEnabled
  });
});

// The daily/hourly reminders sweep — called by an external scheduler (see
// .github/workflows/memory-maker-reminders.yml), not by anything in-process.
app.post('/api/cron/sweep', ah(async (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(501).json({ error: 'CRON_SECRET is not configured on this server' });
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret' });
  const result = await runSweep();
  res.json({ ok: true, ...result });
}));

// The once-a-day "here's what you've got on today" SMS digest — its own
// endpoint/schedule (see .github/workflows/memory-maker-daily-summary.yml)
// rather than piggybacking on the hourly sweep above, since it needs to
// fire at a specific morning time, not every hour.
app.post('/api/cron/daily-summary', ah(async (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(501).json({ error: 'CRON_SECRET is not configured on this server' });
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret' });
  const sent = await sweepDailySummaries();
  res.json({ ok: true, sent });
}));

// ---- Authenticated API ----

app.use('/api', requireAuth(), familiesRouter);
app.use('/api', requireAuth(), calendarRouter);
app.use('/api', requireAuth(), memoriesRouter);
app.use('/api', requireAuth(), todosRouter);
app.use('/api', requireAuth(), dinnerRouter);
app.use('/api', requireAuth(), recipesRouter);
app.use('/api', requireAuth(), shoppingRouter);
app.use('/api', requireAuth(), messagingRouter);
app.use('/api', requireAuth(), integrationsRouter);

// ---- Static files ----

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Client-side routes for the SMS magic links (the frontend reads the token
// out of the URL and calls the public API above) — these need to serve the
// same single-page app rather than 404ing.
app.get(['/dinner/:token', '/rate/:token', '/join/family/:code', '/join/group/:code'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.message && /Only photo or video files/.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large (50MB max).' });
  }
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`The Memory Maker listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

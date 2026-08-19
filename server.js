// JustAsk.com — purchase request backend
//
// A small Express + SQLite API that stores purchase requests so they can be
// shared between everyone using the app (the requester, on one device, and
// the purchasing team, on another). Serves the frontend from ./public too,
// so `npm start` gives you a single, complete, deployable app.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'requests.db');

// ---- Stripe configuration ----
// Sign up at https://stripe.com, grab your API keys from the Dashboard
// (Developers -> API keys), and set these as environment variables when you
// run the server. Until STRIPE_SECRET_KEY is set, online payment is simply
// switched off — /api/config tells the frontend that, and it explains as
// much to anyone who tries to pay.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// Used to build the URL Stripe sends people back to after paying. If unset,
// it's worked out from the incoming request's own Host header, which is
// fine for most single-domain deployments.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ---- Staff login ----
// There's no self-signup for the purchasing team — you set one login here.
// Change these before deploying anywhere real; the fallback values below
// only exist so this runs out of the box in local testing.
const STAFF_EMAIL = (process.env.STAFF_EMAIL || 'staff@example.com').toLowerCase().trim();
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'changeme123';
if (!process.env.STAFF_EMAIL || !process.env.STAFF_PASSWORD) {
  console.warn(
    'STAFF_EMAIL / STAFF_PASSWORD not set — using the default staff login (' +
    STAFF_EMAIL + ' / ' + STAFF_PASSWORD + '). Set both before deploying anywhere real.'
  );
}

// ---- Pricing ----
// The business enters its direct cost for each tier; this margin is added
// automatically to work out what the requester is actually shown and
// charged. Change this one number if the business's markup ever changes —
// everything downstream (the quote screen, Checkout, the paid summary)
// derives from it, nothing else needs to be touched.
const MARKUP_RATE = process.env.MARKUP_RATE !== undefined ? parseFloat(process.env.MARKUP_RATE) : 0.20;

function applyMarkup(cost) {
  return Math.round(cost * (1 + MARKUP_RATE) * 100) / 100;
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());

// The Stripe webhook needs the raw request body (untouched by express.json)
// to verify the signature, so it's registered before the JSON body parser
// and handles its own body parsing.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json());

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    item TEXT NOT NULL,
    link TEXT,
    qty INTEGER NOT NULL DEFAULT 1,
    budgetTier TEXT,
    recipient TEXT NOT NULL,
    postcode TEXT NOT NULL,
    addressLine TEXT NOT NULL,
    neededBy TEXT,
    priority TEXT NOT NULL DEFAULT 'Next Day',
    requester TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Processing',
    directCosts TEXT,
    quotes TEXT,
    selectedTier TEXT,
    selectedCost REAL,
    paymentStatus TEXT NOT NULL DEFAULT 'unpaid',
    stripeSessionId TEXT,
    paidAt TEXT,
    userId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'buyer',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    requestId TEXT NOT NULL,
    item TEXT NOT NULL,
    link TEXT,
    qty INTEGER NOT NULL DEFAULT 1,
    budgetTier TEXT,
    recipient TEXT NOT NULL,
    postcode TEXT NOT NULL,
    addressLine TEXT NOT NULL,
    neededBy TEXT,
    priority TEXT NOT NULL DEFAULT 'Next Day',
    notes TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_requestId ON order_items(requestId);

  CREATE TABLE IF NOT EXISTS status_events (
    id TEXT PRIMARY KEY,
    requestId TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_status_events_requestId ON status_events(requestId);
`);

// Lightweight migration for databases created before payment/account support existed.
(function migrate() {
  const existingCols = db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name);
  const wanted = [
    ['paymentStatus', "paymentStatus TEXT NOT NULL DEFAULT 'unpaid'"],
    ['stripeSessionId', 'stripeSessionId TEXT'],
    ['paidAt', 'paidAt TEXT'],
    ['directCosts', 'directCosts TEXT'],
    ['userId', 'userId TEXT']
  ];
  for (const [name, ddl] of wanted) {
    if (!existingCols.includes(name)) db.exec('ALTER TABLE requests ADD COLUMN ' + ddl);
  }
})();

// Rename any rows still sitting on a status from before the stage list was
// trimmed down to Processing/Quoted/Awaiting Payment/Order On Route/Order
// Delivered/Cancelled — without this, an order created under the old
// pipeline would keep a status value that's no longer valid for PATCH and
// wouldn't match anything in the frontend's status list. The three old
// post-payment stages all collapse forward into "Order On Route", since
// that's as far as this app tracks between payment and delivery now.
(function renameLegacyStatuses() {
  const renames = [
    ['Pending', 'Processing'],
    ['Awaiting payment', 'Awaiting Payment'],
    ['Order Accepted', 'Order On Route'],
    ['Order Processed', 'Order On Route'],
    ['Order Shipped', 'Order On Route']
  ];
  const updateRequests = db.prepare('UPDATE requests SET status = ? WHERE status = ?');
  const updateEvents = db.prepare('UPDATE status_events SET status = ? WHERE status = ?');
  for (const [from, to] of renames) {
    updateRequests.run(to, from);
    updateEvents.run(to, from);
  }
})();

// ---- Password hashing (Node's built-in crypto — no extra dependency) ----
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

// ---- Bootstrap the one staff login (no self-signup for the purchasing team) ----
(function ensureStaffAccount() {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(STAFF_EMAIL);
  if (!existing) {
    db.prepare('INSERT INTO users (id, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?)')
      .run('user_staff', 'Purchasing team', STAFF_EMAIL, hashPassword(STAFF_PASSWORD), 'staff', new Date().toISOString());
  } else if (existing.role !== 'staff') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('staff', existing.id);
  }
})();

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run(token, userId, new Date().toISOString());
  return token;
}

function userFromReq(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  const row = db.prepare(`
    SELECT users.id, users.name, users.email, users.role
    FROM sessions JOIN users ON users.id = sessions.userId
    WHERE sessions.token = ?
  `).get(match[1]);
  return row || null;
}

function requireAuth(role) {
  return function (req, res, next) {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed for this account' });
    req.user = user;
    next();
  };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ---- Auth routes ----
// Self-signup creates a buyer account only — the one staff login is set via
// STAFF_EMAIL/STAFF_PASSWORD above, not through this endpoint.
app.post('/api/auth/signup', (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.name) || !isNonEmptyString(b.email) || !isNonEmptyString(b.password)) {
    return res.status(400).json({ error: 'Name, email and password are all required' });
  }
  if (b.password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const email = b.email.toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const id = 'user_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?)')
    .run(id, b.name.trim(), email, hashPassword(b.password), 'buyer', now);
  const token = createSession(id);
  res.status(201).json({ token, user: { id, name: b.name.trim(), email, role: 'buyer' } });
});

app.post('/api/auth/login', (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').toLowerCase().trim();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !verifyPassword(b.password || '', row.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = createSession(row.id);
  res.json({ token, user: { id: row.id, name: row.name, email: row.email, role: row.role } });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({ user: req.user });
});

// Attaches any of "this device"'s guest-submitted requests (not yet owned by
// anyone) to the account that's just signed up or logged in.
app.post('/api/requests/claim', requireAuth('buyer'), (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter(isNonEmptyString) : [];
  if (!ids.length) return res.json({ claimed: 0 });
  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE requests SET userId = ?, updatedAt = ? WHERE id = ? AND userId IS NULL");
  let claimed = 0;
  for (const id of ids) {
    const result = stmt.run(req.user.id, now, id);
    claimed += result.changes;
  }
  res.json({ claimed });
});

// "Order On Route" and "Order Delivered" are the delivery pipeline a buyer
// actually cares about tracking once they've paid — each one gets its own
// status_events row (see recordStatusEvent below) so the buyer can see
// exactly when their order moved from one stage to the next. "Cancelled" is
// a separate exception outcome, not part of the normal flow.
const VALID_STATUSES = ['Processing', 'Quoted', 'Awaiting Payment', 'Order On Route', 'Order Delivered', 'Cancelled'];
const VALID_TIERS = ['Basic', 'Standard', 'Premium'];

function baseUrlFromReq(req) {
  return PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
}

// A request can be seen/managed by staff (anyone), the buyer who owns it, or
// — if it has no owner at all — anyone holding its (unguessable) id, which
// preserves the old no-login behaviour for guest-submitted requests.
function canAccessRequest(user, row) {
  if (user && user.role === 'staff') return true;
  if (!row.userId) return true;
  return !!(user && user.id === row.userId);
}

// Every time a request's status changes, this logs a row a buyer can read
// back as a timeline ("Order Accepted — 10 Aug, 2:14pm", etc). Called from
// every code path that changes `status` (creation, staff PATCH, /pay,
// markPaid, the Stripe webhook) so the history is always complete regardless
// of which of those paths caused the move.
function recordStatusEvent(requestId, status, when) {
  db.prepare('INSERT INTO status_events (id, requestId, status, createdAt) VALUES (?,?,?,?)')
    .run('se_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), requestId, status, when);
}

function statusHistoryForRequest(id) {
  return db.prepare('SELECT status, createdAt FROM status_events WHERE requestId = ? ORDER BY createdAt ASC').all(id);
}

function markPaid(requestId, sessionId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE requests
    SET status = 'Order On Route', paymentStatus = 'paid', stripeSessionId = ?, paidAt = ?, updatedAt = ?
    WHERE id = ?
  `).run(sessionId, now, now, requestId);
  recordStatusEvent(requestId, 'Order On Route', now);
}

// ---- Stripe webhook handler (registered above, ahead of express.json()) ----
function handleStripeWebhook(req, res) {
  if (!stripeClient || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook is not configured on this server.');
  }

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  const session = event.data && event.data.object;
  const requestId = session && session.metadata && session.metadata.requestId;

  if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && requestId) {
    if (session.payment_status === 'paid') markPaid(requestId, session.id);
  }

  if ((event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') && requestId) {
    const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    // Only revert if still waiting — never clobber a payment that already succeeded.
    if (existing && existing.paymentStatus === 'pending') {
      const revertedAt = new Date().toISOString();
      db.prepare(`UPDATE requests SET status = 'Quoted', paymentStatus = 'unpaid', updatedAt = ? WHERE id = ?`)
        .run(revertedAt, requestId);
      recordStatusEvent(requestId, 'Quoted', revertedAt);
    }
  }

  res.json({ received: true });
}

// A "request" is really an order/basket — one shared quote, one payment,
// covering one or more products underneath it (order_items). This lets a
// buyer put several different products in one basket and check out once.
function itemsForRequest(id) {
  return db.prepare('SELECT * FROM order_items WHERE requestId = ? ORDER BY createdAt ASC').all(id);
}
function rowToRequest(row) {
  if (!row) return null;
  const items = itemsForRequest(row.id);
  const history = statusHistoryForRequest(row.id);
  return Object.assign({}, row, {
    quotes: row.quotes ? JSON.parse(row.quotes) : null,
    directCosts: row.directCosts ? JSON.parse(row.directCosts) : null,
    // Requests created before basket support existed have no order_items row
    // at all — synthesize one from the old flat columns so every request
    // looks the same shape (`items: [...]`) to callers, old or new.
    items: items.length ? items : [{
      id: row.id + '_legacy', requestId: row.id,
      item: row.item, link: row.link, qty: row.qty, budgetTier: row.budgetTier,
      recipient: row.recipient, postcode: row.postcode, addressLine: row.addressLine,
      neededBy: row.neededBy, priority: row.priority, notes: row.notes,
      createdAt: row.createdAt
    }],
    // Requests created before this feature existed (or that predate their
    // very first status_events row for some other reason) have no logged
    // history at all — fall back to a single entry for the row's current
    // status so the timeline is never empty.
    statusHistory: history.length ? history : [{ status: row.status, createdAt: row.updatedAt || row.createdAt }]
  });
}

function uid() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ---- List requests ----
// Staff see everything. A signed-in buyer sees only their own. Signed-out
// (guest) callers get nothing from a bare list — pass ?ids=a,b,c (the ids of
// whatever this browser has itself created or been handed) to look up just
// those, which is how a guest tracks their own requests without an account.
app.get('/api/requests', (req, res) => {
  const user = userFromReq(req);
  let rows;
  if (user && user.role === 'staff') {
    rows = db.prepare('SELECT * FROM requests ORDER BY createdAt DESC').all();
  } else if (user) {
    rows = db.prepare('SELECT * FROM requests WHERE userId = ? ORDER BY createdAt DESC').all(user.id);
  } else {
    const ids = isNonEmptyString(req.query.ids) ? req.query.ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
    rows = ids.length
      ? db.prepare(`SELECT * FROM requests WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY createdAt DESC`).all(...ids)
      : [];
  }
  res.json(rows.map(rowToRequest));
});

// ---- Get one ----
app.get('/api/requests/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRequest(userFromReq(req), row)) return res.status(404).json({ error: 'Not found' });
  res.json(rowToRequest(row));
});

// ---- Create a new request (a basket of one or more items) ----
// Open to everyone, signed in or not — a buyer never has to make an account
// just to ask for something. If they happen to be signed in, the request is
// linked to their account automatically so it shows up under "My requests".
// Body shape: { requester, items: [{ item, recipient, postcode, addressLine,
// link?, qty?, budgetTier?, neededBy?, priority?, notes? }, ...] } — each
// item can have its own recipient/address, since a basket can hold gifts
// going to different people. Staff quote and the buyer pays for the whole
// basket as a single order (see PATCH and /pay below), not per item.
app.post('/api/requests', (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.requester)) {
    return res.status(400).json({ error: 'Missing or empty field: requester' });
  }
  const items = Array.isArray(b.items) ? b.items : null;
  if (!items || !items.length) {
    return res.status(400).json({ error: 'Add at least one item to the basket before submitting' });
  }
  const itemRequiredFields = ['item', 'recipient', 'postcode', 'addressLine'];
  for (let i = 0; i < items.length; i++) {
    for (const field of itemRequiredFields) {
      if (!isNonEmptyString(items[i][field])) {
        return res.status(400).json({ error: 'Item ' + (i + 1) + ' in the basket is missing: ' + field });
      }
    }
    if (items[i].budgetTier && !VALID_TIERS.includes(items[i].budgetTier)) {
      return res.status(400).json({ error: 'Item ' + (i + 1) + ' in the basket has an invalid budgetTier' });
    }
  }

  const user = userFromReq(req);
  const now = new Date().toISOString();
  const firstItem = items[0];
  const uniqueRecipients = Array.from(new Set(items.map((it) => it.recipient.trim())));

  // These flat columns are a denormalized preview of the basket, kept only
  // for backward compatibility with the pre-basket schema (they're NOT NULL
  // there) — order_items (inserted below) is the real source of truth, and
  // that's what rowToRequest() actually returns as `items`.
  const row = {
    id: uid(),
    item: items.length > 1 ? (firstItem.item.trim() + ' +' + (items.length - 1) + ' more') : firstItem.item.trim(),
    link: isNonEmptyString(firstItem.link) ? firstItem.link.trim() : null,
    qty: items.reduce((sum, it) => sum + Math.max(1, parseInt(it.qty, 10) || 1), 0),
    budgetTier: items.length === 1 ? (firstItem.budgetTier || null) : null,
    recipient: uniqueRecipients.length > 1 ? (uniqueRecipients.length + ' recipients') : uniqueRecipients[0],
    postcode: firstItem.postcode.trim().toUpperCase(),
    addressLine: firstItem.addressLine.trim(),
    neededBy: items.length === 1 ? (isNonEmptyString(firstItem.neededBy) ? firstItem.neededBy : null) : null,
    priority: isNonEmptyString(firstItem.priority) ? firstItem.priority : 'Next Day',
    requester: b.requester.trim(),
    notes: items.length === 1 ? (isNonEmptyString(firstItem.notes) ? firstItem.notes.trim() : null) : null,
    status: 'Processing',
    directCosts: null,
    quotes: null,
    selectedTier: null,
    selectedCost: null,
    paymentStatus: 'unpaid',
    stripeSessionId: null,
    paidAt: null,
    userId: (user && user.role === 'buyer') ? user.id : null,
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO requests
      (id, item, link, qty, budgetTier, recipient, postcode, addressLine, neededBy,
       priority, requester, notes, status, directCosts, quotes, selectedTier, selectedCost,
       paymentStatus, stripeSessionId, paidAt, userId, createdAt, updatedAt)
    VALUES
      (@id, @item, @link, @qty, @budgetTier, @recipient, @postcode, @addressLine, @neededBy,
       @priority, @requester, @notes, @status, @directCosts, @quotes, @selectedTier, @selectedCost,
       @paymentStatus, @stripeSessionId, @paidAt, @userId, @createdAt, @updatedAt)
  `).run(row);

  const insertItem = db.prepare(`
    INSERT INTO order_items
      (id, requestId, item, link, qty, budgetTier, recipient, postcode, addressLine, neededBy, priority, notes, createdAt)
    VALUES
      (@id, @requestId, @item, @link, @qty, @budgetTier, @recipient, @postcode, @addressLine, @neededBy, @priority, @notes, @createdAt)
  `);
  items.forEach((it, i) => {
    insertItem.run({
      id: row.id + '_item' + i,
      requestId: row.id,
      item: it.item.trim(),
      link: isNonEmptyString(it.link) ? it.link.trim() : null,
      qty: Math.max(1, parseInt(it.qty, 10) || 1),
      budgetTier: it.budgetTier || null,
      recipient: it.recipient.trim(),
      postcode: it.postcode.trim().toUpperCase(),
      addressLine: it.addressLine.trim(),
      neededBy: isNonEmptyString(it.neededBy) ? it.neededBy : null,
      priority: isNonEmptyString(it.priority) ? it.priority : 'Next Day',
      notes: isNonEmptyString(it.notes) ? it.notes.trim() : null,
      createdAt: now
    });
  });

  recordStatusEvent(row.id, row.status, now);

  res.status(201).json(rowToRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(row.id)));
});

// ---- Update a request: status changes, quotes, tier selection ----
// Staff-only — managing a request (quoting it, moving its status along) is
// purchasing-team work, not something a buyer's own login can do directly.
app.patch('/api/requests/:id', requireAuth('staff'), (req, res) => {
  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  const next = Object.assign({}, existing);

  if (b.status !== undefined) {
    if (!VALID_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    next.status = b.status;
  }

  if (b.directCosts !== undefined) {
    if (b.directCosts === null) {
      next.directCosts = null;
      next.quotes = null;
    } else {
      const computedQuotes = {};
      for (const tier of VALID_TIERS) {
        const v = b.directCosts[tier];
        if (typeof v !== 'number' || isNaN(v) || v < 0) {
          return res.status(400).json({ error: 'directCosts must include a non-negative number for: ' + tier });
        }
        computedQuotes[tier] = applyMarkup(v);
      }
      next.directCosts = JSON.stringify(b.directCosts);
      next.quotes = JSON.stringify(computedQuotes); // the customer-facing price — never the raw cost
    }
  } else if (b.quotes !== undefined) {
    // Direct override of the customer-facing price without a cost basis —
    // kept for flexibility (e.g. scripting), but the app's own UI always
    // goes through directCosts above so the markup is never bypassed.
    if (b.quotes === null) {
      next.quotes = null;
    } else {
      for (const tier of VALID_TIERS) {
        const v = b.quotes[tier];
        if (typeof v !== 'number' || isNaN(v) || v < 0) {
          return res.status(400).json({ error: 'quotes must include a non-negative number for: ' + tier });
        }
      }
      next.quotes = JSON.stringify(b.quotes);
    }
  }

  if (b.selectedTier !== undefined) {
    if (b.selectedTier !== null && !VALID_TIERS.includes(b.selectedTier)) {
      return res.status(400).json({ error: 'Invalid selectedTier' });
    }
    next.selectedTier = b.selectedTier;
  }

  if (b.selectedCost !== undefined) {
    if (b.selectedCost !== null && (typeof b.selectedCost !== 'number' || isNaN(b.selectedCost))) {
      return res.status(400).json({ error: 'Invalid selectedCost' });
    }
    next.selectedCost = b.selectedCost;
  }

  next.updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE requests
    SET status = @status, directCosts = @directCosts, quotes = @quotes, selectedTier = @selectedTier,
        selectedCost = @selectedCost, updatedAt = @updatedAt
    WHERE id = @id
  `).run(next);

  // Only log a new timeline entry when the status actually moved — quoting
  // (directCosts/quotes) or a tier tweak with the status unchanged shouldn't
  // add a duplicate "still on the same stage" row to the buyer's timeline.
  if (b.status !== undefined && b.status !== existing.status) {
    recordStatusEvent(req.params.id, next.status, next.updatedAt);
  }

  res.json(rowToRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id)));
});

// ---- Start a payment: creates a Stripe Checkout Session for one tier ----
app.post('/api/requests/:id/pay', async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Online payment isn't set up yet. Ask whoever runs this app to add Stripe API keys." });
  }

  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRequest(userFromReq(req), existing)) return res.status(404).json({ error: 'Not found' });

  const tier = (req.body || {}).tier;
  if (!VALID_TIERS.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });

  if (existing.status !== 'Quoted' && existing.status !== 'Awaiting Payment') {
    return res.status(409).json({ error: "This request isn't awaiting a choice right now." });
  }

  const quotes = existing.quotes ? JSON.parse(existing.quotes) : null;
  const price = quotes && quotes[tier];
  if (typeof price !== 'number' || isNaN(price) || price <= 0) {
    return res.status(400).json({ error: 'No valid quoted price for that tier yet.' });
  }

  const baseUrl = baseUrlFromReq(req);

  try {
    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: existing.item + ' — ' + tier,
            description: 'JustAsk.com purchase request'
          },
          unit_amount: Math.round(price * 100)
        },
        quantity: 1
      }],
      metadata: { requestId: existing.id, tier: tier },
      success_url: baseUrl + '/?paid=' + encodeURIComponent(existing.id) + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: baseUrl + '/?paymentCancelled=' + encodeURIComponent(existing.id)
    });

    const payNow = new Date().toISOString();
    db.prepare(`
      UPDATE requests
      SET status = 'Awaiting Payment', selectedTier = ?, selectedCost = ?,
          paymentStatus = 'pending', stripeSessionId = ?, updatedAt = ?
      WHERE id = ?
    `).run(tier, price, session.id, payNow, existing.id);
    if (existing.status !== 'Awaiting Payment') recordStatusEvent(existing.id, 'Awaiting Payment', payNow);

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session create failed:', err.message);
    res.status(502).json({ error: 'Stripe error: ' + err.message });
  }
});

// ---- Confirm a payment immediately when the requester returns from Stripe ----
// (The webhook below is the durable source of truth — this just gives fast
// feedback in the tab that's still open, and is safe because it re-checks
// the session with Stripe rather than trusting the URL on its own.)
app.post('/api/requests/:id/confirm-payment', async (req, res) => {
  if (!stripeClient) return res.status(503).json({ error: "Online payment isn't set up yet." });

  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRequest(userFromReq(req), existing)) return res.status(404).json({ error: 'Not found' });

  const sessionId = (req.body || {}).sessionId;
  if (!isNonEmptyString(sessionId)) return res.status(400).json({ error: 'Missing sessionId' });

  try {
    const session = await stripeClient.checkout.sessions.retrieve(sessionId);
    if (!session.metadata || session.metadata.requestId !== existing.id) {
      return res.status(400).json({ error: 'Session does not match this request' });
    }
    if (session.payment_status === 'paid') {
      markPaid(existing.id, session.id);
    }
    res.json(rowToRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(existing.id)));
  } catch (err) {
    console.error('Stripe session retrieve failed:', err.message);
    res.status(502).json({ error: 'Stripe error: ' + err.message });
  }
});

// ---- Frontend config: lets the UI know whether payment is switched on, and the markup rate ----
app.get('/api/config', (req, res) => {
  res.json({ paymentsEnabled: !!stripeClient, markupRate: MARKUP_RATE, itemSearchEnabled: !!process.env.ANTHROPIC_API_KEY });
});

// ---- Staff item sourcing search ----
// Lets staff describe an item (plus an optional reference link, the delivery
// address, and how urgently it's needed) and get back real, currently
// available places to buy it — anything from a small local shop up to a
// major retailer — found via Claude with web search. Gated behind
// ANTHROPIC_API_KEY so it's entirely optional, same pattern as Stripe/
// getAddress.io: if the key isn't set, the frontend just hides the tool.
const SOURCE_URGENCY_VALUES = ['Same Day', 'Next Day', 'ASAP'];

app.post('/api/staff/source-item', requireAuth('staff'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: 'Item search is not configured on this server yet.' });
  }
  const { itemDescription, link, deliveryAddress, urgency } = req.body || {};
  if (!isNonEmptyString(itemDescription)) {
    return res.status(400).json({ error: 'Describe the item you want to search for.' });
  }
  if (!isNonEmptyString(deliveryAddress)) {
    return res.status(400).json({ error: 'A delivery address is needed so results can be checked for feasibility.' });
  }
  const urgencyLabel = SOURCE_URGENCY_VALUES.includes(urgency) ? urgency : 'Next Day';

  const prompt = 'You are helping a personal-concierge purchasing team source a specific item for a customer.\n\n' +
    'Item requested: ' + itemDescription + '\n' +
    (isNonEmptyString(link) ? 'Reference link the customer provided: ' + link + '\n' : '') +
    'Delivery address: ' + deliveryAddress + '\n' +
    'Needed by: ' + urgencyLabel + '\n\n' +
    'Search the web for real, currently available places to buy this exact item (or the closest sensible match). ' +
    'Consider the full range of sources — small local/independent shops near the delivery address (e.g. a local florist, ' +
    'butcher, hardware shop) as well as major online retailers (e.g. Amazon, John Lewis, Argos) — whichever genuinely ' +
    'fits the item and the delivery deadline. Find between 3 and 6 concrete options. For each, note whether delivery ' +
    'or collection in the required timeframe looks realistic based on what the source page says.\n\n' +
    'Respond with ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:\n' +
    '{"options":[{"retailer":string,"productName":string,"price":number|null,"currency":"GBP",' +
    '"url":string,"isLocal":boolean,"deliveryFeasible":boolean,"deliveryNote":string}]}';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!apiRes.ok) {
      const errBody = await apiRes.text().catch(() => '');
      console.error('source-item: Anthropic API error', apiRes.status, errBody);
      return res.status(502).json({ error: 'The search service returned an error. Try again in a moment.' });
    }

    const data = await apiRes.json();
    const textBlocks = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    let parsed;
    try {
      const cleaned = textBlocks.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('source-item: could not parse model output as JSON', textBlocks);
      return res.status(502).json({ error: 'Got a response back but could not read it as search results. Try again.' });
    }

    const options = Array.isArray(parsed.options) ? parsed.options : [];
    res.json({ options: options, urgency: urgencyLabel });
  } catch (err) {
    console.error('source-item error', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'The search took too long and timed out. Try again, maybe with a more specific description.' });
    }
    res.status(502).json({ error: 'Could not reach the search service. Try again in a moment.' });
  }
});

// ---- Delete ----
// Staff can delete anything; a signed-in buyer can delete their own; a
// guest-submitted (unowned) request can still be deleted by anyone holding
// its id, matching the old no-login behaviour for that case.
app.delete('/api/requests/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRequest(userFromReq(req), existing)) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM requests WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---- Health check ----
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Serve the frontend ----
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('JustAsk.com backend listening on port ' + PORT);
  console.log('Database file: ' + DB_PATH);
});

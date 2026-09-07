# JustAsk.com — purchase request app + backend

This is the small backend for the purchase-request app: a plain Node.js
(Express) API backed by Postgres, plus the app's frontend served straight
out of the same process. One deploy gives you both.

(This used to run on a single SQLite file. That's genuinely fine for local
development, but SQLite-on-local-disk has nowhere durable to live on most
hosting platforms — including Render's free tier, where the filesystem gets
recreated on every deploy and every idle-timeout restart, silently wiping
every request, account and session. Postgres survives both.)

Because everyone now talks to the same server, the requester and the
purchasing team can be on completely different devices and still see each
other's changes — the app polls the server every 8 seconds and there's also
a manual refresh button (top-right, next to the dark-mode toggle) with a
small green/red dot showing whether it's currently connected.

There are two kinds of login, and one way to skip logging in entirely — see
"Accounts" below for the full picture:

- **Buyers** can create a free account to see their own requests from any
  device ("My requests"), or just carry on as a **guest** with no account at
  all, exactly like the app always worked — a guest's requests are tracked
  on that device only.
- **Staff** (the purchasing team) sign in with one shared login to see and
  manage every request, on the "Manage" tab.

Once a request is quoted, the requester pays online (via Stripe) for
whichever tier they pick, right in the app — see "Online payment" below for
how to switch that on.

Quoting works on a cost-plus-margin basis: the purchasing team types in what
each tier actually costs to buy, and the app automatically adds the
business's margin on top to work out what the requester is shown and
charged. See "Pricing markup" below.

## Running it locally

You'll need Node.js 18 or later, and a Postgres database to point at.

**Getting a local Postgres.** Easiest with Docker:

```bash
docker run -d --name justask-postgres -e POSTGRES_PASSWORD=justask_dev \
  -e POSTGRES_USER=justask -e POSTGRES_DB=justask_dev -p 5432:5432 postgres:16
```

Or install Postgres directly (`apt install postgresql` / `brew install postgresql`)
and create a database + user with `createdb`/`psql` however you normally would.
Either way, you end up with a connection string that looks like
`postgresql://justask:justask_dev@localhost:5432/justask_dev`.

**Running the app:**

```bash
npm install
DATABASE_URL=postgresql://justask:justask_dev@localhost:5432/justask_dev npm start
```

Then open http://localhost:3000 — that's the whole app, form and dashboard
both, served by the same server that holds the data.

All the tables, indexes, and the one-time schema migrations run automatically
on startup against whatever `DATABASE_URL` points at — there's no separate
migration step to run by hand. To start with a clean slate, drop and
recreate the database (or just `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
inside it) and restart the server.

`DATABASE_URL` is required — the server refuses to start without it, on
purpose, rather than silently falling back to something that won't survive a
restart.

## Project structure

```
aaa-backend/
  server.js          the API + static file server (talks to Postgres via DATABASE_URL)
  package.json
  public/
    index.html       the customer-facing frontend — form, wizard, order tracking
    staff.html        the staff dashboard, separate page, separate login
```

## The API

All under `/api`, all JSON:

| Method | Path                | Does |
|--------|---------------------|------|
| GET    | /api/requests       | List requests — staff get everything, a signed-in buyer gets only their own, a signed-out call gets nothing unless you pass `?ids=a,b,c` (see "Accounts") |
| POST   | /api/requests       | Create one — body is `{ requester, items: [...] }` (see "Baskets" below); each item needs `item`, `recipient`, `postcode`, `addressLine` at minimum. Works signed in or not; if the caller is a signed-in buyer the request is linked to their account automatically |
| GET    | /api/requests/:id    | Fetch one — allowed for staff, the owning buyer, or anyone (no login needed) if the request has no owner at all |
| PATCH  | /api/requests/:id    | **Staff only.** Update `status`, `directCosts`, `quotes`, `selectedTier`, `selectedCost` — send only the fields you're changing |
| DELETE | /api/requests/:id    | Staff can delete anything; a signed-in buyer can delete their own; an unowned (guest) request can be deleted by anyone holding its id |
| GET    | /api/health          | Returns `{ ok: true }` — useful for uptime checks |
| GET    | /api/config          | Returns `{ paymentsEnabled, markupRate, itemSearchEnabled }` so the frontend knows whether Stripe and the item sourcing search are switched on (`markupRate` is included for completeness — the current frontend doesn't display it anywhere) |
| POST   | /api/staff/source-item | **Staff only.** Body `{ itemDescription, link?, deliveryAddress, urgency }` (`urgency` one of `Same Day`/`Next Day`/`ASAP`) — asks Claude to search the web and returns `{ options: [...] }`. 501 if `ANTHROPIC_API_KEY` isn't set. |
| POST   | /api/requests/:id/pay | Body `{ tier }` — creates a Stripe Checkout Session for that tier's quoted price, returns `{ url }` to redirect the browser to |
| POST   | /api/requests/:id/confirm-payment | Body `{ sessionId }` — re-checks that session with Stripe and marks the request paid if it succeeded; called automatically when someone returns from the Stripe payment page |
| POST   | /api/stripe/webhook  | Stripe calls this directly (not something you call yourself) — see "Online payment" below |
| POST   | /api/auth/signup     | Body `{ name, email, password }` — creates a **buyer** account (there's no self-signup for staff — see "Accounts"). Returns `{ token, user }` |
| POST   | /api/auth/login      | Body `{ email, password }` — works for both a buyer account and the one staff login. Returns `{ token, user }` |
| POST   | /api/auth/logout     | Ends the current session (send the token as `Authorization: Bearer <token>`) |
| GET    | /api/auth/me         | Returns `{ user }` for the signed-in token — the frontend uses this to restore a session after a page reload |
| POST   | /api/requests/claim  | Body `{ ids: [...] }`, buyer login required — attaches any of those request ids that have no owner yet onto the signed-in account. Used right after a buyer signs up/in, to claim whatever they'd already submitted as a guest on that device |

Every route above that isn't a plain `GET`/health check reads an optional
`Authorization: Bearer <token>` header, and behaves differently depending on
who (if anyone) that token belongs to — see "Accounts" for the full rules.

`directCosts` looks like `{ "Basic": 45, "Standard": 65, "Premium": 120 }`
— what the business actually pays. Send this and the server calculates
`quotes` for you (see "Pricing markup" below), so you never need to work
out the marked-up figure yourself. `quotes` has the same shape and holds
the marked-up, customer-facing price — you can still PATCH `quotes`
directly instead if you want to bypass the automatic markup for a one-off
(e.g. scripting), but the app's own UI always goes through `directCosts`.
Valid `status` values: `Processing`, `Quoted`, `Awaiting Payment`,
`Order On Route`, `Order Delivered`, `Cancelled` (see "Delivery updates"
below for the last two, and how `Cancelled` fits in).

Every request/order returned by the API also includes a `statusHistory`
array — `[{ status, createdAt }, ...]` in the order each stage actually
happened, oldest first. That's what the frontend's "Order timeline" is
built from.

## Deploying it somewhere real

Pick whichever fits how your team already works. In every case the two
things that matter are: **run `npm install && npm start`**, and **set
`DATABASE_URL` to a real, managed Postgres database** — not a database
running on the same disk as the app, which brings back the exact
lose-everything-on-restart problem this setup avoids.

### Render (probably the easiest)

1. Push this folder to a GitHub repo.
2. On Render: **New → Postgres**, create a database (the free tier works
   fine to start). Render shows you its connection string — you don't need
   to copy it by hand if the web service and database are in the same
   Render account: adding the database as an environment "resource" link to
   your web service auto-injects `DATABASE_URL`. Otherwise copy the
   **Internal Database URL** it shows you.
3. New → Web Service → connect the repo.
4. Build command: `npm install`. Start command: `npm start`.
5. Under the web service's Environment tab, set `DATABASE_URL` to the
   connection string from step 2 (skip this if step 2's linking already set
   it), and set `PGSSL=require` (Render's managed Postgres needs SSL, and
   its certificate isn't one Node trusts by default without this).

That's it — no persistent disk to attach, no `DATA_DIR` to configure. The
database lives independently of the web service, so it survives deploys and
idle-timeout restarts on the free tier.

### Railway / Fly.io

Same shape: create a managed Postgres addon/service (both platforms offer
one directly), point `DATABASE_URL` at it, and set `PGSSL=require` if the
provider's Postgres requires SSL (check its dashboard — Railway and Fly's
managed Postgres typically do). Point this repo at the platform as normal
(`npm start` as the run command) — no volumes or persistent disks needed.

### Your own server / VPS

```bash
git clone <your-repo> aaa-backend
cd aaa-backend
npm install
DATABASE_URL=postgresql://user:pass@your-postgres-host:5432/justask PORT=3000 npm start
```

Keep it running with `pm2` (`npm i -g pm2 && pm2 start server.js --name aaa`)
or a systemd unit so it restarts on reboot. Put it behind nginx/Caddy with
HTTPS if it'll be reachable from outside your network — put a real TLS
certificate in front of it rather than exposing plain HTTP, since request
details (names, addresses) will be traveling over it.

### Environment variables

| Variable  | Default             | What it does |
|-----------|---------------------|---------------|
| `PORT`    | `3000`              | Port the server listens on |
| `DATABASE_URL` | *(required, no default)* | Postgres connection string. The server refuses to start without it. |
| `PGSSL`   | *(unset — no SSL)*  | Set to `require` for managed Postgres providers (Render, Railway, Fly.io) that need SSL but use a certificate Node doesn't trust by default. Leave unset for local Postgres. |
| `STRIPE_SECRET_KEY` | *(unset — payments off)* | Your Stripe secret key. Setting this is what switches online payment on. |
| `STRIPE_WEBHOOK_SECRET` | *(unset)* | The signing secret Stripe gives you for the webhook endpoint (see below) |
| `PUBLIC_BASE_URL` | *(worked out from the request)* | Set this to your real public URL (e.g. `https://requests.yourcompany.com`) if the auto-detected one is ever wrong — it's used to build the "come back here after paying" links |
| `MARKUP_RATE` | `0.2` (20%) | The margin added automatically on top of the direct cost the purchasing team enters. `0.2` = 20%, `0.15` = 15%, and so on. |
| `STAFF_EMAIL` | `staff@example.com` | The purchasing team's login email. **Change this before deploying anywhere real** — the default is only there so the app runs out of the box locally. |
| `STAFF_PASSWORD` | `changeme123` | The purchasing team's login password. **Change this too.** If either `STAFF_EMAIL` or `STAFF_PASSWORD` is left unset, the server logs a warning on startup as a reminder. |
| `ANTHROPIC_API_KEY` | *(unset — item search off)* | Your Anthropic API key. Setting this switches on the staff "Find sourcing options" tool (see below). Each search costs a small amount of API usage, so treat it like the Stripe/Ideal Postcodes keys — optional, and billed to your own Anthropic account. |

## Installing it as an app (PWA)

JustAsk.com is a Progressive Web App — buyers and staff can add it to their
home screen or dock and open it like a normal app, no App Store required.

**What's in place:**

- `public/manifest.json` — app name, brand colours (navy `#0B2545`), and icon
  set for every size Android/iOS/desktop ask for.
- `public/icons/` — the icon artwork, generated from the brand mark, at every
  required size (16, 32, 152, 167, 180, 192, 384, 512, plus a maskable 512
  for Android's adaptive icon shapes). `icon-source.svg` is the editable
  source if the mark ever changes.
- `public/service-worker.js` — caches the app shell (the HTML, manifest and
  icons) so the app installs cleanly and reopens instantly. It never caches
  anything under `/api/` — order data and statuses always come straight from
  the server, never from a stale cache.
- `<head>` tags in `public/index.html` — the manifest link, theme colour,
  and Apple-specific tags Safari needs for "Add to Home Screen" to behave
  like a real app (its own icon, no browser address bar, etc).

**How people install it:**

- **Android (Chrome):** visiting the site shows an automatic "Install app"
  prompt (or Menu → *Install app* / *Add to Home screen*).
- **iPhone/iPad (Safari):** Share icon → *Add to Home Screen*. Safari doesn't
  support the automatic prompt, so this is the one platform where it's worth
  telling people about the option.
- **Desktop (Chrome/Edge):** an install icon appears in the address bar.

**One requirement:** service workers only run over HTTPS (`localhost` is
exempt, which is why it works during local development). Any of the hosts
in "Deploying it somewhere real" above give you HTTPS automatically, so
there's nothing extra to configure — just deploy normally and the install
prompt will start showing up on its own.

This covers installing the app as a PWA. Wrapping it for the Apple App
Store / Google Play (via Capacitor) or distributing it privately through
Apple Business Manager are bigger, separate steps — ask if that's the
direction you want to go next.

## Accounts

There's no single "logged in or not" switch — three separate things can be
true at once, and the app behaves differently for each:

**Staff** — one shared login for the purchasing team, set via
`STAFF_EMAIL`/`STAFF_PASSWORD` above (not something anyone can sign up for).
Signing in on the **Manage** tab unlocks the full dashboard: every request,
the margin tile, quoting, and status changes. Nobody else can reach any of
that — `PATCH` (quoting, status changes) is staff-only at the API level too,
not just hidden in the UI.

**Buyer accounts** — anyone can create one from the **My requests** tab
(name, email, password — `POST /api/auth/signup`). Once signed in, "My
requests" shows only requests tied to that account, from any device, and
new requests they submit are linked to it automatically. There's nothing
staff-like about a buyer account; it can't reach the Manage tab or see
anyone else's requests.

**Guests** — submitting a request has never required an account, and still
doesn't. Without signing in, "My requests" tracks whatever this specific
browser has submitted (via a small list of ids kept in `localStorage`), and
that's genuinely all it can see — there's no way to browse anyone else's
requests without being signed in as the right buyer or as staff. If a guest
later creates an account, everything they'd already submitted on that
device is attached to the new account automatically (via
`POST /api/requests/claim`), so nothing is lost by starting as a guest.

Because the server enforces all of this (not just the frontend), the old
"anyone with the URL can see and manage everything" behaviour is gone —
each of the three checks above is a real permission check on the API, not
just a UI choice. The trade-off: a guest who's never signed in and doesn't
know a request's id genuinely cannot look it up.

## Baskets

A single request is really an **order**, and an order can hold more than
one item. On the **New request** tab, a buyer adds items to a basket one at
a time — each with its own recipient, delivery address, budget preference,
priority, and notes — then submits the whole basket in one go. That's
deliberate: a buyer sending a Christmas hamper to one colleague and a set
of headphones to another can do both in a single submission instead of
filing two separate requests.

Everything after submission stays at the order level, unchanged from
before baskets existed: the purchasing team quotes Basic/Standard/Premium
**once** for the whole basket (not per item), the buyer picks one of those
three tiers, and — if online payment is switched on — pays for the entire
basket in a single Stripe Checkout session. The per-item detail (who each
thing is going to, and where) stays visible in the request's detail view
for staff and the requester throughout, but quoting, status, and payment
all happen once per order.

On the wire, `POST /api/requests` takes:

```json
{
  "requester": "Dave Tomlinson",
  "items": [
    { "item": "Christmas hamper", "recipient": "Alice Smith", "postcode": "SW1A 1AA", "addressLine": "10 Downing St", "budgetTier": "Standard" },
    { "item": "Wireless headphones", "recipient": "Bob Jones", "postcode": "EC1A 1BB", "addressLine": "22 Old St", "qty": 2, "priority": "Same Day" }
  ]
}
```

Every item accepts the same fields the old flat request body did (`item`,
`link`, `qty`, `budgetTier`, `recipient`, `postcode`, `addressLine`,
`neededBy`, `priority`, `notes`) — `requester` just moved up a level, since
it belongs to the whole basket rather than any one item.

The response (and every `GET`) always includes an `items` array with the
full per-item detail, however the order was created. Requests made before
this feature existed are read back exactly the same way: the server
synthesizes a one-item `items` array from that row's original flat columns,
so nothing that reads from the API needs to special-case old vs new data.
Under the hood this is stored as an additive `order_items` table alongside
the existing `requests` table — no existing data was migrated or altered
to support this.

## Delivery updates

An order moves through a simple 5-stage pipeline from submission to
delivery:

**Processing** → **Quoted** → **Awaiting Payment** →
**Order On Route** → **Order Delivered**

"Order On Route" is set automatically the moment payment succeeds — there's
no separate "accepted" or "being packed" stage to manage in between, it's
either awaiting payment or it's on its way. **Cancelled** sits outside this
flow entirely: staff can move any order to Cancelled at any point, as an
exception rather than a normal stage.

Staff move an order along by picking the next stage from the same status
buttons used everywhere else (the Manage dashboard's request detail view) —
there's no separate screen for this. Each move is logged with a timestamp,
so the buyer can always see exactly when their order reached each stage,
not just where it is right now.

**How the buyer finds out.** This app has no email or SMS sending set up,
so updates are entirely in-app:

- Once an order has been paid for, its detail view shows a horizontal
  **stage tracker** — a Domino's-pizza-tracker-style progress bar across
  "Order On Route" and "Order Delivered", lighting up whichever one the
  order is currently at (and the one before it, once delivered). It's the
  at-a-glance view; nothing shows here before payment (there's nothing to
  track yet), and a Cancelled order doesn't get one either.
- Below that, every request's detail view also has a full **"Order
  timeline"** — every stage the order has passed through, each with its own
  date and time, oldest first. This works for staff and for the buyer/guest
  viewing their own request.
- "My requests" already refreshes automatically every few seconds. On top
  of that, a signed-in buyer or guest gets a small toast the moment a poll
  notices one of their orders changed stage (e.g. *"Update: 'Christmas
  hamper +1 more' is now Order On Route"*) — as long as they have the tab
  open. Staff don't get these toasts for their own changes, since they're
  the ones making them.
- Nothing here depends on the buyer having an account — guests get exactly
  the same timeline and toasts on whatever browser they used to submit
  the request (or that has since claimed it via `?ids=`).

If you want real email or SMS on top of this later, the natural place to
add it is right next to the `recordStatusEvent()` call in `server.js` —
every code path that changes a request's status already funnels through
it, so it's a single hook rather than something to duplicate across five
places (creation, staff PATCH, `/pay`, `markPaid`, and the Stripe webhook).

## Pricing markup

The purchasing team never types in a customer-facing price directly. When
they quote a request, they enter what each tier actually costs the business
to buy (the "direct cost"), and the server automatically adds the margin
set by `MARKUP_RATE` (20% by default) to work out what the requester sees
and pays. That calculation happens **only on the server** and entirely in
the background — the quote-entry screen doesn't mention the percentage or
show what the marked-up price will be, and the direct cost is never sent
to, or shown to, the requester at any point. The marked-up price is what
flows through to the "choose an option" tiles, the Stripe Checkout charge,
and the order summary — never the raw cost, and never the margin itself.

The one place the margin is visible at all is the **"Margin earned" tile**
at the top of the Manage dashboard, which totals up (marked-up price −
direct cost) across every completed, paid order. That's a running business
figure, not a per-request breakdown, and — see "Accounts" above — the
Manage dashboard now requires the staff login to open at all, so this
figure is never visible to a buyer or guest.

To change the percentage, set `MARKUP_RATE` (e.g. `MARKUP_RATE=0.15` for
15%) as an environment variable and restart the server — no code changes
needed.

## Staff item sourcing search (Claude + web search)

Staff can ask Claude to search the web for real, currently available places
to buy a specific item — anything from a small local shop (a florist, a
butcher) up to a major online retailer — right from the item breakdown in
the request detail view. It takes an item description, an optional link the
customer provided, the delivery address, and how urgently it's needed (Same
Day / Next Day / ASAP), and returns a short list of options with retailer,
price (where found), a link, and a note on whether delivery in that window
looks realistic.

This is entirely optional and off by default. Until you set
`ANTHROPIC_API_KEY`, the tool simply doesn't appear in the staff view — same
pattern as Stripe and Ideal Postcodes. To turn it on:

1. Get an API key from the [Anthropic Console](https://console.anthropic.com)
2. Set `ANTHROPIC_API_KEY=sk-ant-...` in your environment (or Render's
   environment variables) and restart/redeploy
3. `/api/config` will now report `itemSearchEnabled: true`, and a "Find
   sourcing options" button will appear next to each item for staff

Each search makes one call to Claude with web search enabled, billed to your
own Anthropic account at standard API rates — there's no separate charge
from JustAsk.com itself, but it's real usage, so it's worth keeping an eye on
if staff use it heavily.

## Online payment (Stripe)

Card payment is handled entirely by [Stripe Checkout](https://stripe.com/payments/checkout) —
when a requester taps a priced tier, they're redirected to a Stripe-hosted
payment page to enter their card details. **Card numbers never pass through
this server or this codebase at all** — that's what keeps this app out of
PCI-compliance scope. Nothing here was built to collect raw card data, and
it shouldn't be; Stripe's hosted page is the secure part.

Until you add Stripe API keys, this feature is simply switched off: the
"Choose an option" tiles still show the quoted prices, but tapping one
explains that online payment isn't set up yet rather than trying (and
failing) to charge anyone.

### Setting it up

1. Sign up at [stripe.com](https://stripe.com) — no approval wait for test
   mode, you can start integrating immediately.
2. In the Stripe Dashboard, make sure you're in **Test mode** (toggle,
   top-right) while you're trying this out. Go to Developers → API keys and
   copy the **Secret key** (starts `sk_test_...`).
3. Set it as an environment variable wherever you run the server:
   `STRIPE_SECRET_KEY=sk_test_...`. Restart the server. `/api/config` should
   now report `paymentsEnabled: true`.
4. Set up the webhook (this is what reliably marks a request "Order
   Accepted" once paid, even if someone closes the tab right after paying):
   - **For local testing:** install the [Stripe CLI](https://docs.stripe.com/stripe-cli),
     run `stripe login` once, then `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
     It prints a webhook signing secret (`whsec_...`) — set that as
     `STRIPE_WEBHOOK_SECRET` and restart the server.
   - **Once deployed:** in the Stripe Dashboard, go to Developers → Webhooks
     → Add endpoint. URL: `https://your-domain/api/stripe/webhook`. Events
     to send: `checkout.session.completed`, `checkout.session.expired`,
     `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`.
     Stripe shows you a signing secret when you save it — set that as
     `STRIPE_WEBHOOK_SECRET`.
5. Test the whole flow with [Stripe's test cards](https://docs.stripe.com/testing) —
   `4242 4242 4242 4242`, any future expiry, any 3-digit CVC, will simulate
   a successful payment; `4000 0000 0000 0002` simulates a decline.
6. When you're confident it works, switch the Dashboard out of Test mode,
   grab the **live** secret key (`sk_live_...`) and a **live** webhook
   signing secret the same way, and swap those in as the environment
   variables on your real deployment.

Stripe takes its own processing fee per transaction (currently around 1.5%
+ 20p for UK cards — worth checking [their current pricing](https://stripe.com/gb/pricing)
since it does change) — that's between you and Stripe, this app doesn't add
anything on top.

## The Ideal Postcodes key

`public/index.html` still has the same postcode-lookup hook from before —
open it and look for:

```js
var IDEAL_POSTCODES_API_KEY = ''; // <-- paste your Ideal Postcodes API key here
```

(This used to point at getAddress.io, which shut down in Feb 2026 after
losing a High Court case over its address database — Ideal Postcodes was
the winning party in that case, and is the natural replacement.)

Same caveat as before: this key is visible to anyone who views the page
source, since it's a plain static file. Ask Ideal Postcodes to restrict the
key to your deployed domain once you have one.

## Backups

All the app's data lives in Postgres now, so back up the database, not the
app. Render's managed Postgres takes automatic daily backups on paid plans
(check what your plan/tier includes); Railway and Fly.io's managed Postgres
offerings have their own backup features too — check their dashboards. For
anything self-managed, a scheduled `pg_dump` to somewhere safe is the usual
approach:

```bash
pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d).sql
```

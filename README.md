# Calendar Fundraiser

A Node/Express app where users pick an open date on a shared calendar,
pledge a dollar amount, save a card via Stripe, and get charged
automatically on that date. Once a date is claimed by anyone, it's locked
for everyone else.

## Stack

- Node.js + Express
- PostgreSQL + Prisma
- Stripe (SetupIntent for saving cards, PaymentIntent for off-session charges)
- node-cron for the daily charge job
- Plain HTML/CSS/JS front end

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — your Postgres connection string
   - `SESSION_SECRET` — any long random string
   - `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` — from your Stripe dashboard (use test keys first)

3. **Set up the database**

   ```bash
   npx prisma migrate dev --name init
   npx prisma generate
   ```

4. **Run the app**

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000`.

## How it works

- **Uniqueness across all users**: `DateClaim.date` has a `@unique`
  constraint in `prisma/schema.prisma`. If two users try to claim the same
  date, the database rejects the second insert (`P2002` error), which the
  API turns into a friendly "already claimed" response.
- **Card collection**: the front end uses Stripe Elements + a SetupIntent
  to tokenize the card. Raw card numbers never reach your server — only a
  Stripe `payment_method` id is stored.
- **Automatic charging**: `jobs/chargeDueDates.js` runs daily (via
  `node-cron` in `server.js`, scheduled for 3am server time) and creates an
  off-session `PaymentIntent` for every `PENDING` claim whose date is today.
  Successful charges become `CHARGED`; failures become `FAILED` with a
  reason recorded.
- **Per-user view**: `/api/calendar` returns every claimed date (so it
  greys out for all users) and flags which ones belong to the current user
  (`isMine`), so each user sees their own pledges highlighted.

## Production notes

- Run the cron job as a separate worker process or use an external
  scheduler (e.g. a managed cron service hitting an authenticated endpoint)
  rather than relying on `node-cron` inside a single web dyno — safer if
  you scale to multiple instances.
- Add email notifications for `FAILED` charges so users can update their
  card.
- Add Stripe webhook handling (`payment_intent.payment_failed`, etc.) for
  more robust failure tracking.
- Switch `cookie-session` to a server-side session store (e.g. Redis) if
  you need to invalidate sessions or scale horizontally.

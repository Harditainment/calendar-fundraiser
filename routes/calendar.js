const express = require('express');
const prisma = require('../prisma/client');
const stripe = require('../stripeClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Helper: normalize a YYYY-MM-DD string to a UTC midnight Date, and
// validate it's a real, non-past date.
function parseDateOnly(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(dateStr + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) return null;
  return d;
}

function isPastDate(d) {
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return d < todayUTC;
}

// GET /api/calendar?year=2026&month=6
// Returns claim status for every date in the given month, for ALL users
// (so the UI can grey out dates claimed by anyone), plus whether the
// CURRENT user owns each claimed date.
router.get('/calendar', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'year and month query params are required (month is 1-12)' });
    }

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1)); // first day of next month

    const claims = await prisma.dateClaim.findMany({
      where: { date: { gte: start, lt: end } },
      select: {
        date: true,
        amountCents: true,
        status: true,
        userId: true,
      },
    });

    const currentUserId = req.session && req.session.userId;

    const result = claims.map((c) => ({
      date: c.date.toISOString().slice(0, 10),
      amount: c.amountCents / 100,
      status: c.status,
      isMine: currentUserId ? c.userId === currentUserId : false,
    }));

    res.json({ claims: result });
  } catch (err) {
    console.error('Calendar fetch error:', err);
    res.status(500).json({ error: 'Failed to load calendar' });
  }
});

// POST /api/setup-intent
// Creates a Stripe SetupIntent so the client can securely collect and save
// a card via Stripe Elements WITHOUT charging it yet.
router.post('/setup-intent', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });

    const setupIntent = await stripe.setupIntents.create({
      customer: user.stripeCustomerId,
      payment_method_types: ['card'],
      usage: 'off_session', // we'll charge this later without the user present
    });

    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error('SetupIntent error:', err);
    res.status(500).json({ error: 'Failed to start payment setup' });
  }
});

// POST /api/claims
// Body: { date: "YYYY-MM-DD", amount: number (dollars), paymentMethodId: string }
// Claims a date for the current user. Fails if the date is already taken
// by ANYONE (enforced by DB unique constraint + pre-check).
router.post('/claims', requireAuth, async (req, res) => {
  try {
    const { date, amount, paymentMethodId } = req.body;

    if (!date || !amount || !paymentMethodId) {
      return res.status(400).json({ error: 'date, amount, and paymentMethodId are required' });
    }

    const parsedDate = parseDateOnly(date);
    if (!parsedDate) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    }
    if (isPastDate(parsedDate)) {
      return res.status(400).json({ error: 'Cannot claim a date in the past' });
    }

    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });

    // Attach the payment method to the customer for future off-session use.
    await stripe.paymentMethods.attach(paymentMethodId, { customer: user.stripeCustomerId });
    await stripe.customers.update(user.stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // The unique constraint on DateClaim.date guarantees that if two users
    // race for the same date, only one insert succeeds.
    const claim = await prisma.dateClaim.create({
      data: {
        date: parsedDate,
        amountCents,
        status: 'PENDING',
        stripePaymentMethodId: paymentMethodId,
        userId: user.id,
      },
    });

    res.json({
      id: claim.id,
      date: claim.date.toISOString().slice(0, 10),
      amount: claim.amountCents / 100,
      status: claim.status,
    });
  } catch (err) {
    // Prisma unique constraint violation code
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'That date has already been claimed by someone else' });
    }
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Failed to reserve date' });
  }
});

// GET /api/my-claims
// Returns the current user's claims, including past charge history.
router.get('/my-claims', requireAuth, async (req, res) => {
  try {
    const claims = await prisma.dateClaim.findMany({
      where: { userId: req.session.userId },
      orderBy: { date: 'asc' },
    });

    res.json({
      claims: claims.map((c) => ({
        id: c.id,
        date: c.date.toISOString().slice(0, 10),
        amount: c.amountCents / 100,
        status: c.status,
        chargedAt: c.chargedAt,
        failureReason: c.failureReason,
      })),
    });
  } catch (err) {
    console.error('My claims error:', err);
    res.status(500).json({ error: 'Failed to load your claims' });
  }
});

// DELETE /api/claims/:id
// Allows a user to cancel their own PENDING claim (frees the date back up).
router.delete('/claims/:id', requireAuth, async (req, res) => {
  try {
    const claim = await prisma.dateClaim.findUnique({ where: { id: req.params.id } });

    if (!claim || claim.userId !== req.session.userId) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    if (claim.status !== 'PENDING') {
      return res.status(400).json({ error: 'Only pending (uncharged) claims can be cancelled' });
    }

    await prisma.dateClaim.delete({ where: { id: claim.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Cancel claim error:', err);
    res.status(500).json({ error: 'Failed to cancel claim' });
  }
});

module.exports = router;

const express = require('express');
const prisma = require('../prisma/client');
const stripe = require('../stripeClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Helper: normalize a YYYY-MM-DD string to a UTC midnight Date, validating
// it's a real calendar date.
function parseDateOnly(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(dateStr + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) return null;
  const [y, m, day] = dateStr.split('-').map(Number);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return null;
  return d;
}

// The donation amount is fixed by the day-of-month: the 1st = $1,
// the 31st = $31, etc.
function amountForDate(d) {
  return d.getUTCDate();
}

// GET /api/calendar?year=2026&month=6
// Returns every date in the given month already locked by a successful
// charge (for ALL users), plus whether the CURRENT user owns it. Every
// other date — past, present, or future — is selectable.
router.get('/calendar', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'year and month query params are required (month is 1-12)' });
    }

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    const claims = await prisma.dateClaim.findMany({
      where: { date: { gte: start, lt: end }, status: 'CHARGED' },
      select: { date: true, amountCents: true, userId: true },
    });

    const currentUserId = req.session && req.session.userId;

    const result = claims.map((c) => ({
      date: c.date.toISOString().slice(0, 10),
      amount: c.amountCents / 100,
      isMine: currentUserId ? c.userId === currentUserId : false,
    }));

    res.json({ claims: result });
  } catch (err) {
    console.error('Calendar fetch error:', err);
    res.status(500).json({ error: 'Failed to load calendar' });
  }
});

// POST /api/claims
// Body: { date: "YYYY-MM-DD", paymentMethodId: string }
// Charges the user immediately for an amount equal to the day-of-month
// (in dollars), then claims the date for the current user. Fails if the
// date is already claimed by ANYONE (DB unique constraint enforces this).
router.post('/claims', requireAuth, async (req, res) => {
  try {
    const { date, paymentMethodId } = req.body;

    if (!date || !paymentMethodId) {
      return res.status(400).json({ error: 'date and paymentMethodId are required' });
    }

    const parsedDate = parseDateOnly(date);
    if (!parsedDate) {
      return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' });
    }

    const existing = await prisma.dateClaim.findFirst({
      where: { date: parsedDate, status: 'CHARGED' },
    });
    if (existing) {
      return res.status(409).json({ error: 'That date has already been claimed by someone else' });
    }

    const amountCents = amountForDate(parsedDate) * 100;

    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });

    await stripe.paymentMethods.attach(paymentMethodId, { customer: user.stripeCustomerId });

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: user.stripeCustomerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: false,
	automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: `Calendar fundraiser donation for ${date} ($${amountCents / 100})`,
      });
    } catch (stripeErr) {
      // Card declined or otherwise failed - date stays open.
      return res.status(402).json({ error: stripeErr.message || 'Payment failed' });
    }

    if (paymentIntent.status === 'requires_action') {
      // 3D Secure or similar additional authentication is required.
      // The client must confirm this client_secret, then retry the claim.
      return res.status(402).json({
        error: 'Additional authentication required',
        requiresAction: true,
        clientSecret: paymentIntent.client_secret,
      });
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(402).json({ error: `Payment was not completed (status: ${paymentIntent.status})` });
    }

    try {
      const claim = await prisma.dateClaim.create({
        data: {
          date: parsedDate,
          amountCents,
          status: 'CHARGED',
          userId: user.id,
        },
      });

      res.json({
        id: claim.id,
        date: claim.date.toISOString().slice(0, 10),
        amount: claim.amountCents / 100,
        status: claim.status,
      });
    } catch (dbErr) {
      // Payment succeeded but someone else claimed this exact date in the
      // brief window between our check and now (DB unique constraint hit).
      // Refund the charge since the date can't be granted.
      if (dbErr.code === 'P2002') {
        await stripe.refunds.create({ payment_intent: paymentIntent.id });
        return res.status(409).json({ error: 'That date was just claimed by someone else. Your card was not charged (refunded).' });
      }
      throw dbErr;
    }
  } catch (err) {
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Failed to process your donation' });
  }
});

// GET /api/my-claims
// Returns the current user's successful donations.
router.get('/my-claims', requireAuth, async (req, res) => {
  try {
    const claims = await prisma.dateClaim.findMany({
      where: { userId: req.session.userId, status: 'CHARGED' },
      orderBy: { date: 'asc' },
    });

    res.json({
      claims: claims.map((c) => ({
        id: c.id,
        date: c.date.toISOString().slice(0, 10),
        amount: c.amountCents / 100,
        status: c.status,
        chargedAt: c.chargedAt,
      })),
    });
  } catch (err) {
    console.error('My claims error:', err);
    res.status(500).json({ error: 'Failed to load your donations' });
  }
});

module.exports = router;

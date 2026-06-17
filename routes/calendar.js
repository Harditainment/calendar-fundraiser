const express = require('express');
const prisma = require('../prisma/client');
const stripe = require('../stripeClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// This fundraiser currently runs for June only.
const FUNDRAISER_MONTH = 6;
const DAYS_IN_FUNDRAISER_MONTH = 30;

function isValidMonthDay(month, day) {
  if (month !== FUNDRAISER_MONTH) return false;
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_FUNDRAISER_MONTH) return false;
  return true;
}

// GET /api/calendar
// Returns the CURRENT user's full Jan-Dec calendar: which (month, day)
// cells they've already claimed/charged.
router.get('/calendar', requireAuth, async (req, res) => {
  try {
    const claims = await prisma.dateClaim.findMany({
      where: { userId: req.session.userId, status: 'CHARGED' },
      select: { month: true, day: true, amountCents: true },
    });

    res.json({
      claims: claims.map((c) => ({
        month: c.month,
        day: c.day,
        amount: c.amountCents / 100,
      })),
    });
  } catch (err) {
    console.error('Calendar fetch error:', err);
    res.status(500).json({ error: 'Failed to load calendar' });
  }
});

// POST /api/claims
// Body: { month: 1-12, day: 1-31, paymentMethodId: string }
// Charges the user immediately for an amount equal to `day` (in dollars),
// then permanently locks that (month, day) cell for this user.
router.post('/claims', requireAuth, async (req, res) => {
  try {
    const { month, day, paymentMethodId } = req.body;
    const monthNum = Number(month);
    const dayNum = Number(day);

    if (!paymentMethodId || !isValidMonthDay(monthNum, dayNum)) {
      return res.status(400).json({ error: 'A valid month, day, and paymentMethodId are required' });
    }

    const existing = await prisma.dateClaim.findFirst({
      where: { userId: req.session.userId, month: monthNum, day: dayNum, status: 'CHARGED' },
    });
    if (existing) {
      return res.status(409).json({ error: 'You have already filled this date on your calendar' });
    }

    const amountCents = dayNum * 100;

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
        description: `Calendar fundraiser donation for month ${monthNum}, day ${dayNum} ($${amountCents / 100})`,
      });
    } catch (stripeErr) {
      // Card declined or otherwise failed - cell stays open.
      return res.status(402).json({ error: stripeErr.message || 'Payment failed' });
    }

    if (paymentIntent.status === 'requires_action') {
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
          month: monthNum,
          day: dayNum,
          amountCents,
          status: 'CHARGED',
          userId: user.id,
        },
      });

      res.json({
        id: claim.id,
        month: claim.month,
        day: claim.day,
        amount: claim.amountCents / 100,
        status: claim.status,
      });
    } catch (dbErr) {
      // Race: the user double-clicked and claimed this cell in the brief
      // window between our check and now. Refund since it can't be granted twice.
      if (dbErr.code === 'P2002') {
        await stripe.refunds.create({ payment_intent: paymentIntent.id });
        return res.status(409).json({ error: 'This date was just filled. Your card was not charged (refunded).' });
      }
      throw dbErr;
    }
  } catch (err) {
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Failed to process your donation' });
  }
});

// GET /api/my-claims
// Returns the current user's successful donations, with running total.
router.get('/my-claims', requireAuth, async (req, res) => {
  try {
    const claims = await prisma.dateClaim.findMany({
      where: { userId: req.session.userId, status: 'CHARGED' },
      orderBy: [{ month: 'asc' }, { day: 'asc' }],
    });

    const total = claims.reduce((sum, c) => sum + c.amountCents, 0) / 100;

    res.json({
      total,
      claims: claims.map((c) => ({
        id: c.id,
        month: c.month,
        day: c.day,
        amount: c.amountCents / 100,
        chargedAt: c.chargedAt,
      })),
    });
  } catch (err) {
    console.error('My claims error:', err);
    res.status(500).json({ error: 'Failed to load your donations' });
  }
});

module.exports = router;

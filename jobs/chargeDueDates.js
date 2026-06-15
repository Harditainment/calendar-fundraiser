// jobs/chargeDueDates.js
//
// Run this once per day (e.g. via node-cron in server.js, or an external
// scheduler like a system cron / Vercel Cron hitting a protected endpoint).
//
// For every DateClaim where `date` == today and status == PENDING, attempt
// to charge the saved payment method off-session. Update status to CHARGED
// or FAILED accordingly.

require('dotenv').config();
const prisma = require('../prisma/client');
const stripe = require('../stripeClient');

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function chargeDueDates() {
  const today = todayUTC();

  const dueClaims = await prisma.dateClaim.findMany({
    where: { date: today, status: 'PENDING' },
    include: { user: true },
  });

  console.log(`[chargeDueDates] Found ${dueClaims.length} claim(s) due for ${today.toISOString().slice(0, 10)}`);

  for (const claim of dueClaims) {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: claim.amountCents,
        currency: 'usd',
        customer: claim.user.stripeCustomerId,
        payment_method: claim.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        description: `Calendar fundraiser pledge for ${claim.date.toISOString().slice(0, 10)}`,
      });

      if (paymentIntent.status === 'succeeded') {
        await prisma.dateClaim.update({
          where: { id: claim.id },
          data: { status: 'CHARGED', chargedAt: new Date() },
        });
        console.log(`[chargeDueDates] Charged $${claim.amountCents / 100} for claim ${claim.id}`);
      } else {
        await prisma.dateClaim.update({
          where: { id: claim.id },
          data: { status: 'FAILED', failureReason: `Unexpected status: ${paymentIntent.status}` },
        });
      }
    } catch (err) {
      console.error(`[chargeDueDates] Failed to charge claim ${claim.id}:`, err.message);

      await prisma.dateClaim.update({
        where: { id: claim.id },
        data: {
          status: 'FAILED',
          failureReason: err.message || 'Unknown error',
        },
      });

      // TODO: notify the user by email that their card was declined,
      // and optionally allow them to update their payment method and retry.
    }
  }
}

// Allow running directly: `node jobs/chargeDueDates.js`
if (require.main === module) {
  chargeDueDates()
    .then(() => {
      console.log('[chargeDueDates] Done');
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('[chargeDueDates] Fatal error:', err);
      return prisma.$disconnect().finally(() => process.exit(1));
    });
}

module.exports = chargeDueDates;

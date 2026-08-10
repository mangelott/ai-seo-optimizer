const express = require('express');
const stripe = require('../services/stripe');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { PLANS } = require('../config/plans');

const router = express.Router();

router.post('/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const planConfig = PLANS[plan];
  if (!planConfig || !planConfig.stripePriceId) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const userResult = await pool.query(
    'SELECT email, stripe_customer_id FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = userResult.rows[0];

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: req.user.id },
    });
    customerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
      customerId,
      req.user.id,
    ]);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: planConfig.stripePriceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/billing?success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/billing?canceled=true`,
    metadata: { userId: req.user.id, plan },
  });

  res.json({ url: session.url });
});

router.get('/summary', requireAuth, async (req, res) => {
  const userResult = await pool.query(
    'SELECT plan, lifetime_free_audits_used, stripe_customer_id FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = userResult.rows[0];
  const planConfig = PLANS[user.plan] || PLANS.free;
  const isFree = user.plan === 'free';

  const usageResult = await pool.query(
    `SELECT COUNT(*) FROM audits WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [req.user.id]
  );
  const auditsThisMonth = isFree ? user.lifetime_free_audits_used : parseInt(usageResult.rows[0].count, 10);
  const auditsLimit = isFree ? planConfig.lifetimeFullAudits : planConfig.auditsPerMonth;

  let paymentMethod = null;
  let invoices = [];

  if (user.stripe_customer_id) {
    try {
      const [pmList, invoiceList] = await Promise.all([
        stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card', limit: 1 }),
        stripe.invoices.list({ customer: user.stripe_customer_id, limit: 12 }),
      ]);
      if (pmList.data[0]) {
        paymentMethod = { brand: pmList.data[0].card.brand, last4: pmList.data[0].card.last4 };
      }
      invoices = invoiceList.data.map((inv) => ({
        date: new Date(inv.created * 1000).toISOString(),
        description: inv.lines.data[0]?.description || inv.description || 'Subscription',
        amount: (inv.amount_paid / 100).toFixed(2),
        currency: inv.currency,
        pdfUrl: inv.invoice_pdf,
      }));
    } catch {
      // Stripe customer may not have payment methods/invoices yet
    }
  }

  res.json({
    plan: user.plan,
    planName: planConfig.name,
    auditsThisMonth,
    auditsLimit,
    paymentMethod,
    invoices,
  });
});

router.post('/portal', requireAuth, async (req, res) => {
  const userResult = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [
    req.user.id,
  ]);
  const customerId = userResult.rows[0]?.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No billing account found' });

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.FRONTEND_URL}/billing`,
  });

  res.json({ url: session.url });
});

module.exports = router;

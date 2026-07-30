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

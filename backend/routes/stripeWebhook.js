const express = require('express');
const stripe = require('../services/stripe');
const pool = require('../db/pool');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { userId, plan } = session.metadata;

      await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, userId]);
      await pool.query(
        `INSERT INTO subscriptions (user_id, stripe_subscription_id, plan, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (stripe_subscription_id) DO UPDATE SET plan = $3, status = 'active'`,
        [userId, session.subscription, plan]
      );
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const status = sub.status === 'active' ? 'active' : 'canceled';

      await pool.query(
        `UPDATE subscriptions SET status = $1, current_period_end = to_timestamp($2), updated_at = now()
         WHERE stripe_subscription_id = $3`,
        [status, sub.current_period_end, sub.id]
      );

      if (status === 'canceled') {
        const subRecord = await pool.query(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
          [sub.id]
        );
        if (subRecord.rows[0]) {
          await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [
            'free',
            subRecord.rows[0].user_id,
          ]);
        }
      }
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;

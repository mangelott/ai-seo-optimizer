const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, domain, created_at, recurring_enabled, recurring_interval_days,
     recurring_delivery, last_recurring_run_at, auto_fix_enabled, wp_url, wp_username
     FROM monitored_domains WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const { recurringEnabled, recurringIntervalDays, recurringDelivery } = req.body;

  if (recurringEnabled && !(Number.isInteger(recurringIntervalDays) && recurringIntervalDays > 0)) {
    return res.status(400).json({ error: 'recurringIntervalDays must be a positive integer to enable recurring audits' });
  }
  if (recurringEnabled && !['email', 'in_app'].includes(recurringDelivery)) {
    return res.status(400).json({ error: 'recurringDelivery must be "email" or "in_app"' });
  }

  const result = await pool.query(
    `UPDATE monitored_domains
     SET recurring_enabled = COALESCE($1, recurring_enabled),
         recurring_interval_days = CASE WHEN $1 = false THEN recurring_interval_days ELSE COALESCE($2, recurring_interval_days) END,
         recurring_delivery = COALESCE($3, recurring_delivery)
     WHERE id = $4 AND user_id = $5
     RETURNING id, domain, recurring_enabled, recurring_interval_days, recurring_delivery, last_recurring_run_at`,
    [recurringEnabled ?? null, recurringIntervalDays ?? null, recurringDelivery ?? null, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Domain not found' });
  res.json(result.rows[0]);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    'DELETE FROM monitored_domains WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Domain not found' });
  res.json({ ok: true });
});

module.exports = router;

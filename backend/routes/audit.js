const express = require('express');
const pool = require('../db/pool');
const { auditQueue } = require('../jobs/queue');
const { requireAuth } = require('../middleware/auth');
const { enforcePlanLimit } = require('../middleware/planLimit');

const router = express.Router();

router.post('/', requireAuth, enforcePlanLimit, async (req, res) => {
  const { domain, language } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  const result = await pool.query(
    'INSERT INTO audits (user_id, domain) VALUES ($1, $2) RETURNING id',
    [req.user.id, domain]
  );
  const auditId = result.rows[0].id;

  if (req.planKey === 'free') {
    await pool.query(
      'UPDATE users SET lifetime_free_audits_used = lifetime_free_audits_used + 1 WHERE id = $1',
      [req.user.id]
    );
  }

  await auditQueue.add('run-audit', {
    auditId,
    domain,
    categories: req.plan.categories,
    language: language || 'en',
  });

  res.status(202).json({ auditId, status: 'pending' });
});

router.get('/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM audits WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json(result.rows[0]);
});

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, domain, status, score, created_at, completed_at,
     jsonb_array_length(COALESCE(ai_recommendations, '[]'::jsonb)) AS issue_count
     FROM audits WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

module.exports = router;

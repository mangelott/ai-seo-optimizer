const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { enforcePlanLimit } = require('../middleware/planLimit');
const { createAudit } = require('../services/auditRunner');

const router = express.Router();

router.post('/', requireAuth, enforcePlanLimit, async (req, res) => {
  const { domain, language } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  const auditId = await createAudit({
    userId: req.user.id,
    domain,
    language,
    planKey: req.planKey,
    categories: req.plan.categories,
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

router.patch('/:id/share', requireAuth, async (req, res) => {
  const { shared } = req.body;
  const result = await pool.query(
    'UPDATE audits SET is_shared = $1 WHERE id = $2 AND user_id = $3 RETURNING is_shared, share_token',
    [!!shared, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json(result.rows[0]);
});

module.exports = router;

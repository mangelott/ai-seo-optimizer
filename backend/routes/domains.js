const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, domain, created_at FROM monitored_domains WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(result.rows);
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

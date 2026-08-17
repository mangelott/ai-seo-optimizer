const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/:token', async (req, res) => {
  const result = await pool.query(
    `SELECT id, domain, status, technical_result, content_result, keyword_result,
     backlink_result, ai_recommendations, score, gsc_result, created_at, completed_at
     FROM audits WHERE share_token = $1 AND is_shared = true`,
    [req.params.token]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Report not found or no longer shared' });
  res.json(result.rows[0]);
});

module.exports = router;

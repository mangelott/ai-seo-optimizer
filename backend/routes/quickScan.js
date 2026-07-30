const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { runQuickScan } = require('../services/quickScan');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many scans from this IP, try again later' },
});

router.post('/', scanLimiter, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  try {
    const { scanId, score, issuesCount } = await runQuickScan(domain, req.ip);
    res.status(201).json({ scanId, score, issuesCount });
  } catch {
    res.status(422).json({ error: 'Could not analyze this URL' });
  }
});

router.get('/:id', async (req, res) => {
  const result = await pool.query(
    'SELECT id, domain, score, issues_count, claimed_by_user_id FROM quick_scans WHERE id = $1',
    [req.params.id]
  );
  const scan = result.rows[0];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  res.json({
    scanId: scan.id,
    domain: scan.domain,
    score: scan.score,
    issuesCount: scan.issues_count,
    claimed: !!scan.claimed_by_user_id,
  });
});

router.get('/:id/full', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT full_result, claimed_by_user_id FROM quick_scans WHERE id = $1',
    [req.params.id]
  );
  const scan = result.rows[0];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.claimed_by_user_id !== req.user.id) {
    return res.status(403).json({ error: 'This scan is not linked to your account' });
  }

  res.json(scan.full_result);
});

module.exports = router;

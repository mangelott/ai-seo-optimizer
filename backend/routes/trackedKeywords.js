const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { PLANS } = require('../config/plans');

const router = express.Router();

// Independent of rankTrackingChecksPerMonth (which caps how many checks
// actually run and is what really bounds cost — see config/plans.js) — this
// just bounds list size itself for readability, same rationale and same
// number as routes/aeo.js's MAX_TARGET_QUERIES_PER_DOMAIN.
const MAX_TRACKED_KEYWORDS_PER_DOMAIN = 10;

// Same team-shares-owner's-plan rule as middleware/planLimit.js's
// checkPlanLimit, duplicated in miniature here since rank-tracking gating
// only needs the plan, not the full audit-limit check — see routes/aeo.js
// for the same pattern.
async function getEffectivePlan(userId) {
  const result = await pool.query(
    `SELECT u.plan, u.team_id, owner.plan AS team_owner_plan
     FROM users u
     LEFT JOIN teams t ON t.id = u.team_id
     LEFT JOIN users owner ON owner.id = t.owner_user_id
     WHERE u.id = $1`,
    [userId]
  );
  const row = result.rows[0];
  const planKey = row?.team_id && row?.team_owner_plan ? row.team_owner_plan : row?.plan;
  return PLANS[planKey] || PLANS.free;
}

router.get('/keywords', requireAuth, async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const result = await pool.query(
    `SELECT tk.id, tk.keyword, tk.created_at, tk.last_checked_at,
            latest.position AS latest_position, latest.checked_at AS latest_checked_at
     FROM tracked_keywords tk
     LEFT JOIN LATERAL (
       SELECT position, checked_at FROM rank_tracking rt
       WHERE rt.user_id = tk.user_id AND rt.domain = tk.domain AND rt.keyword = tk.keyword
       ORDER BY checked_at DESC LIMIT 1
     ) latest ON true
     WHERE tk.user_id = $1 AND tk.domain = $2
     ORDER BY tk.created_at ASC`,
    [req.user.id, domain]
  );
  res.json(result.rows);
});

router.post('/keywords', requireAuth, async (req, res) => {
  const { domain, keyword } = req.body;
  if (!domain || !keyword) return res.status(400).json({ error: 'domain and keyword are required' });

  const plan = await getEffectivePlan(req.user.id);
  if (!plan.rankTrackingChecksPerMonth) {
    return res.status(402).json({ error: 'Rank tracking is not included in your plan. Upgrade to Pro or Agency.' });
  }

  const countResult = await pool.query(
    'SELECT COUNT(*) FROM tracked_keywords WHERE user_id = $1 AND domain = $2',
    [req.user.id, domain]
  );
  if (parseInt(countResult.rows[0].count, 10) >= MAX_TRACKED_KEYWORDS_PER_DOMAIN) {
    return res.status(400).json({ error: `You can track up to ${MAX_TRACKED_KEYWORDS_PER_DOMAIN} keywords per domain.` });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tracked_keywords (user_id, domain, keyword) VALUES ($1, $2, $3)
       RETURNING id, keyword, created_at, last_checked_at`,
      [req.user.id, domain, keyword]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This keyword is already tracked for this domain.' });
    throw err;
  }
});

router.delete('/keywords/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    'DELETE FROM tracked_keywords WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Keyword not found' });
  res.json({ ok: true });
});

// Position history grouped by keyword, for the rank-over-time chart in the
// domain history report (frontend History.jsx) — one array of {checkedAt,
// position} points per keyword, so the chart can draw one line each.
router.get('/history', requireAuth, async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const result = await pool.query(
    `SELECT keyword, position, checked_at FROM rank_tracking
     WHERE user_id = $1 AND domain = $2 ORDER BY keyword ASC, checked_at ASC`,
    [req.user.id, domain]
  );

  const byKeyword = new Map();
  for (const row of result.rows) {
    if (!byKeyword.has(row.keyword)) byKeyword.set(row.keyword, []);
    byKeyword.get(row.keyword).push({ checkedAt: row.checked_at, position: row.position });
  }

  res.json(Array.from(byKeyword, ([keyword, points]) => ({ keyword, points })));
});

module.exports = router;

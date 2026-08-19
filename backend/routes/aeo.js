const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { PLANS } = require('../config/plans');

const router = express.Router();

// Independent of aeoQueriesPerMonth (which caps how many checks run) — this
// bounds list size itself, since queries only get added/removed by hand.
const MAX_TARGET_QUERIES_PER_DOMAIN = 10;
// Checking competitor citations reuses the same provider response as the
// user's own check (services/aeoTracking.js), so this cap is only about
// keeping the alert list readable, not API cost.
const MAX_COMPETITOR_DOMAINS_PER_QUERY = 5;

function validCompetitorDomains(competitorDomains) {
  return Array.isArray(competitorDomains) && competitorDomains.every((d) => typeof d === 'string' && d.trim());
}

// Same team-shares-owner's-plan rule as middleware/planLimit.js's
// checkPlanLimit, duplicated in miniature here since AEO gating only needs
// the plan, not the full audit-limit check.
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

router.get('/queries', requireAuth, async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const result = await pool.query(
    `SELECT id, query, created_at, last_checked_at, competitor_domains FROM aeo_target_queries
     WHERE user_id = $1 AND domain = $2 ORDER BY created_at ASC`,
    [req.user.id, domain]
  );
  res.json(result.rows);
});

router.post('/queries', requireAuth, async (req, res) => {
  const { domain, query, competitorDomains } = req.body;
  if (!domain || !query) return res.status(400).json({ error: 'domain and query are required' });

  if (competitorDomains !== undefined) {
    if (!validCompetitorDomains(competitorDomains)) {
      return res.status(400).json({ error: 'competitorDomains must be an array of non-empty strings' });
    }
    if (competitorDomains.length > MAX_COMPETITOR_DOMAINS_PER_QUERY) {
      return res.status(400).json({ error: `You can track up to ${MAX_COMPETITOR_DOMAINS_PER_QUERY} competitor domains per query.` });
    }
  }

  const plan = await getEffectivePlan(req.user.id);
  if (!plan.aeoQueriesPerMonth) {
    return res.status(402).json({ error: 'AEO tracking is not included in your plan. Upgrade to Pro or Agency.' });
  }

  const countResult = await pool.query(
    'SELECT COUNT(*) FROM aeo_target_queries WHERE user_id = $1 AND domain = $2',
    [req.user.id, domain]
  );
  if (parseInt(countResult.rows[0].count, 10) >= MAX_TARGET_QUERIES_PER_DOMAIN) {
    return res.status(400).json({ error: `You can track up to ${MAX_TARGET_QUERIES_PER_DOMAIN} queries per domain.` });
  }

  try {
    const result = await pool.query(
      `INSERT INTO aeo_target_queries (user_id, domain, query, competitor_domains) VALUES ($1, $2, $3, $4)
       RETURNING id, query, created_at, last_checked_at, competitor_domains`,
      [req.user.id, domain, query, competitorDomains ?? []]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This query is already tracked for this domain.' });
    throw err;
  }
});

router.patch('/queries/:id/competitors', requireAuth, async (req, res) => {
  const { competitorDomains } = req.body;
  if (!validCompetitorDomains(competitorDomains)) {
    return res.status(400).json({ error: 'competitorDomains must be an array of non-empty strings' });
  }
  if (competitorDomains.length > MAX_COMPETITOR_DOMAINS_PER_QUERY) {
    return res.status(400).json({ error: `You can track up to ${MAX_COMPETITOR_DOMAINS_PER_QUERY} competitor domains per query.` });
  }

  const result = await pool.query(
    `UPDATE aeo_target_queries SET competitor_domains = $1 WHERE id = $2 AND user_id = $3
     RETURNING id, query, created_at, last_checked_at, competitor_domains`,
    [competitorDomains, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Query not found' });
  res.json(result.rows[0]);
});

router.delete('/queries/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    'DELETE FROM aeo_target_queries WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Query not found' });
  res.json({ ok: true });
});

// AEO Score: percentage of this domain's target queries cited by at least
// one provider in their most recent check, plus a per-week trend so the
// report can show whether citation coverage is improving.
router.get('/score', requireAuth, async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const targetQueries = await pool.query(
    `SELECT id, query, created_at, last_checked_at FROM aeo_target_queries
     WHERE user_id = $1 AND domain = $2 ORDER BY created_at ASC`,
    [req.user.id, domain]
  );

  const latestPerQueryProvider = await pool.query(
    `SELECT DISTINCT ON (query, provider) query, provider, cited, response_snippet, checked_at
     FROM aeo_queries
     WHERE user_id = $1 AND domain = $2
     ORDER BY query, provider, checked_at DESC`,
    [req.user.id, domain]
  );

  const resultsByQuery = new Map();
  for (const row of latestPerQueryProvider.rows) {
    if (!resultsByQuery.has(row.query)) resultsByQuery.set(row.query, []);
    resultsByQuery.get(row.query).push(row);
  }

  const queries = targetQueries.rows.map((tq) => {
    const results = resultsByQuery.get(tq.query) || [];
    return {
      id: tq.id,
      query: tq.query,
      lastCheckedAt: tq.last_checked_at,
      results,
      citedByAny: results.some((r) => r.cited),
    };
  });

  const checkedQueries = queries.filter((q) => q.results.length > 0);
  const score = checkedQueries.length
    ? Math.round((checkedQueries.filter((q) => q.citedByAny).length / checkedQueries.length) * 100)
    : null;

  // Approximate trend: per week, the share of individual provider checks
  // that were citations. Coarser than the per-query score above (it doesn't
  // dedupe providers per query) but good enough to show direction over time
  // without a much heavier per-week-per-query aggregation.
  const history = await pool.query(
    `SELECT date_trunc('week', checked_at) AS week,
            COUNT(*) FILTER (WHERE cited) AS cited_count,
            COUNT(*) AS check_count
     FROM aeo_queries
     WHERE user_id = $1 AND domain = $2
     GROUP BY week ORDER BY week ASC`,
    [req.user.id, domain]
  );

  res.json({
    score,
    queries,
    history: history.rows.map((r) => ({
      week: r.week,
      citedCount: parseInt(r.cited_count, 10),
      checkCount: parseInt(r.check_count, 10),
    })),
  });
});

module.exports = router;

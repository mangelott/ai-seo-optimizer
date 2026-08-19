const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Backlink-gap analysis (Agency only, see config/plans.js backlinkGapAnalysis)
// is the most expensive DataForSEO backlinks call, priced per competitor
// looked up — capped independently of aeo.js's MAX_COMPETITOR_DOMAINS_PER_QUERY.
const MAX_COMPETITOR_DOMAINS = 5;

function validCompetitorDomains(domains) {
  return Array.isArray(domains) && domains.every((d) => typeof d === 'string' && d.trim());
}

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, domain, created_at, recurring_enabled, recurring_interval_days,
     recurring_delivery, last_recurring_run_at, auto_fix_enabled, wp_url, wp_username, gsc_site_url,
     github_repo, github_branch, competitor_domains
     FROM monitored_domains
     WHERE user_id IN (SELECT id FROM users WHERE id = $1 OR team_id = (SELECT team_id FROM users WHERE id = $1))
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const { recurringEnabled, recurringIntervalDays, recurringDelivery, competitorDomains } = req.body;

  if (recurringEnabled && !(Number.isInteger(recurringIntervalDays) && recurringIntervalDays > 0)) {
    return res.status(400).json({ error: 'recurringIntervalDays must be a positive integer to enable recurring audits' });
  }
  if (recurringEnabled && !['email', 'in_app'].includes(recurringDelivery)) {
    return res.status(400).json({ error: 'recurringDelivery must be "email" or "in_app"' });
  }
  if (competitorDomains !== undefined) {
    if (!validCompetitorDomains(competitorDomains)) {
      return res.status(400).json({ error: 'competitorDomains must be an array of non-empty strings' });
    }
    if (competitorDomains.length > MAX_COMPETITOR_DOMAINS) {
      return res.status(400).json({ error: `You can track up to ${MAX_COMPETITOR_DOMAINS} competitor domains.` });
    }
  }

  const result = await pool.query(
    `UPDATE monitored_domains
     SET recurring_enabled = COALESCE($1, recurring_enabled),
         recurring_interval_days = CASE WHEN $1 = false THEN recurring_interval_days ELSE COALESCE($2, recurring_interval_days) END,
         recurring_delivery = COALESCE($3, recurring_delivery),
         competitor_domains = COALESCE($4, competitor_domains)
     WHERE id = $5 AND user_id = $6
     RETURNING id, domain, recurring_enabled, recurring_interval_days, recurring_delivery, last_recurring_run_at, competitor_domains`,
    [recurringEnabled ?? null, recurringIntervalDays ?? null, recurringDelivery ?? null, competitorDomains ?? null, req.params.id, req.user.id]
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

const pool = require('../db/pool');
const { PLANS } = require('../config/plans');
// Required as a namespaced object (not destructured) so tests can mock
// checkPosition with node:test's t.mock.method — see jobs/aeoTracking.js for
// the same pattern.
const rankTracking = require('../services/rankTracking');

// Daily by default: unlike AI-assistant citations (jobs/aeoTracking.js checks
// weekly, since those rarely change day to day), search positions genuinely
// move often enough for daily checks to be worth it. Cost is bounded by
// config/plans.js rankTrackingChecksPerMonth below, not by this interval — a
// user tracking few keywords gets checked close to daily, while one near
// their monthly cap gets the same budget spread across more keywords, same
// as real rank-tracking tools. Overridable so tests can shrink it.
const CHECK_INTERVAL_DAYS = Number(process.env.RANK_CHECK_INTERVAL_DAYS) || 1;

async function runDueRankChecks() {
  const due = await pool.query(
    `SELECT tk.id, tk.user_id, tk.domain, tk.keyword, u.plan
     FROM tracked_keywords tk
     JOIN users u ON u.id = tk.user_id
     WHERE tk.last_checked_at IS NULL
        OR tk.last_checked_at <= now() - ($1 || ' days')::interval
     ORDER BY tk.last_checked_at ASC NULLS FIRST`,
    [CHECK_INTERVAL_DAYS]
  );

  let checked = 0;
  let skipped = 0;

  for (const row of due.rows) {
    const plan = PLANS[row.plan] || PLANS.free;

    // Always stamp last_checked_at, even on skip, so a user without rank
    // tracking on their plan doesn't get re-evaluated every single run —
    // same reasoning as jobs/aeoTracking.js / jobs/recurringAudits.js.
    await pool.query('UPDATE tracked_keywords SET last_checked_at = now() WHERE id = $1', [row.id]);

    if (!plan.rankTrackingChecksPerMonth) {
      skipped += 1;
      continue;
    }

    const usageResult = await pool.query(
      `SELECT COUNT(*) FROM rank_tracking WHERE user_id = $1 AND checked_at >= date_trunc('month', now())`,
      [row.user_id]
    );
    const usedThisMonth = parseInt(usageResult.rows[0].count, 10);
    if (usedThisMonth >= plan.rankTrackingChecksPerMonth) {
      skipped += 1;
      continue;
    }

    try {
      const { position } = await rankTracking.checkPosition(row.keyword, row.domain);
      await pool.query(
        `INSERT INTO rank_tracking (user_id, domain, keyword, position, checked_at) VALUES ($1, $2, $3, $4, now())`,
        [row.user_id, row.domain, row.keyword, position]
      );
      checked += 1;
    } catch (err) {
      // A single keyword's SERP failure never blocks the rest of the run —
      // same resilience contract as every other audit category.
      console.error(`Rank check failed for "${row.keyword}" on ${row.domain}:`, err.response?.data || err.message);
      skipped += 1;
    }
  }

  return { checked, skipped, evaluated: due.rows.length };
}

module.exports = { runDueRankChecks, CHECK_INTERVAL_DAYS };

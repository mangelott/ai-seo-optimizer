const pool = require('../db/pool');
const { PLANS } = require('../config/plans');
// Required as a namespaced object (not destructured) so tests can mock
// checkQuery with node:test's t.mock.method — see jobs/recurringAudits.js /
// services/auditProcessor.js for the same pattern.
const aeoTracking = require('../services/aeoTracking');

// Weekly, not daily: an AI assistant's answer to the same query rarely
// changes day to day, and checking daily would burn through a plan's monthly
// quota (config/plans.js) in under a week. Overridable so tests can shrink it.
const CHECK_INTERVAL_DAYS = Number(process.env.AEO_CHECK_INTERVAL_DAYS) || 7;

// Google AI Overview isn't included here — services/aeoTracking.js's
// queryGoogleAiOverview always throws (not supported automatically yet).
const PROVIDERS = ['chatgpt', 'perplexity'];

async function runDueAeoChecks() {
  const due = await pool.query(
    `SELECT atq.id, atq.user_id, atq.domain, atq.query, u.plan
     FROM aeo_target_queries atq
     JOIN users u ON u.id = atq.user_id
     WHERE atq.last_checked_at IS NULL
        OR atq.last_checked_at <= now() - ($1 || ' days')::interval
     ORDER BY atq.last_checked_at ASC NULLS FIRST`,
    [CHECK_INTERVAL_DAYS]
  );

  let checked = 0;
  let skipped = 0;

  for (const row of due.rows) {
    const plan = PLANS[row.plan] || PLANS.free;

    // Always stamp last_checked_at, even on skip, so a user without AEO
    // tracking on their plan (or over quota) doesn't get re-evaluated every
    // single run — same reasoning as jobs/recurringAudits.js.
    await pool.query('UPDATE aeo_target_queries SET last_checked_at = now() WHERE id = $1', [row.id]);

    if (!plan.aeoQueriesPerMonth) {
      skipped += 1;
      continue;
    }

    const usageResult = await pool.query(
      `SELECT COUNT(*) FROM (
         SELECT DISTINCT domain, query, checked_at FROM aeo_queries
         WHERE user_id = $1 AND checked_at >= date_trunc('month', now())
       ) checks`,
      [row.user_id]
    );
    const usedThisMonth = parseInt(usageResult.rows[0].count, 10);
    if (usedThisMonth >= plan.aeoQueriesPerMonth) {
      skipped += 1;
      continue;
    }

    // Shared across both providers below so usage counting (the DISTINCT
    // checked_at query above) treats one check run as one quota unit,
    // regardless of how many providers actually returned a result.
    const checkedAt = new Date();

    const results = await Promise.all(
      PROVIDERS.map((provider) =>
        aeoTracking.checkQuery(row.query, row.domain, provider).catch((err) => {
          console.error(`AEO check failed (${provider}) for "${row.query}":`, err.response?.data || err.message);
          return null;
        })
      )
    );

    for (const result of results.filter(Boolean)) {
      await pool.query(
        `INSERT INTO aeo_queries (user_id, domain, query, provider, cited, response_snippet, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.user_id, row.domain, row.query, result.provider, result.cited, result.responseSnippet, checkedAt]
      );
    }

    checked += 1;
  }

  return { checked, skipped, evaluated: due.rows.length };
}

module.exports = { runDueAeoChecks, CHECK_INTERVAL_DAYS };

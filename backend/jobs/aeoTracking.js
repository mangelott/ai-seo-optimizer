const pool = require('../db/pool');
const { PLANS } = require('../config/plans');
// Required as a namespaced object (not destructured) so tests can mock
// checkQuery with node:test's t.mock.method — see jobs/recurringAudits.js /
// services/auditProcessor.js for the same pattern.
const aeoTracking = require('../services/aeoTracking');
const email = require('../services/email');

// Weekly, not daily: an AI assistant's answer to the same query rarely
// changes day to day, and checking daily would burn through a plan's monthly
// quota (config/plans.js) in under a week. Overridable so tests can shrink it.
const CHECK_INTERVAL_DAYS = Number(process.env.AEO_CHECK_INTERVAL_DAYS) || 7;

// Google AI Overview isn't included here — services/aeoTracking.js's
// queryGoogleAiOverview always throws (not supported automatically yet).
const PROVIDERS = ['chatgpt', 'perplexity'];

async function runDueAeoChecks() {
  const due = await pool.query(
    `SELECT atq.id, atq.user_id, atq.domain, atq.query, atq.competitor_domains, u.plan, u.email
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

    const competitorDomains = row.competitor_domains || [];

    const results = await Promise.all(
      PROVIDERS.map((provider) =>
        aeoTracking.checkQuery(row.query, row.domain, provider, competitorDomains).catch((err) => {
          console.error(`AEO check failed (${provider}) for "${row.query}":`, err.response?.data || err.message);
          return null;
        })
      )
    );

    // Newly-cited-while-the-user-isn't competitors across both providers for
    // this target query, collected so a row with several alerts sends one
    // email rather than one per competitor/provider.
    const newCompetitorCitations = [];

    for (const result of results.filter(Boolean)) {
      await pool.query(
        `INSERT INTO aeo_queries (user_id, domain, query, provider, cited, response_snippet, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.user_id, row.domain, row.query, result.provider, result.cited, result.responseSnippet, checkedAt]
      );

      for (const competitorDomain of competitorDomains) {
        const cited = result.competitorCitations?.[competitorDomain] ?? false;

        const previous = await pool.query(
          `SELECT cited FROM aeo_competitor_citations
           WHERE user_id = $1 AND domain = $2 AND query = $3 AND competitor_domain = $4 AND provider = $5
           ORDER BY checked_at DESC LIMIT 1`,
          [row.user_id, row.domain, row.query, competitorDomain, result.provider]
        );

        await pool.query(
          `INSERT INTO aeo_competitor_citations (user_id, domain, query, competitor_domain, provider, cited, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [row.user_id, row.domain, row.query, competitorDomain, result.provider, cited, checkedAt]
        );

        // Alert only on the transition into "competitor cited, user isn't" —
        // a competitor that was already cited last time doesn't re-alert on
        // every weekly check, and a first-ever check has nothing to compare
        // against, same as the score-drop alert in services/auditProcessor.js.
        const previouslyCited = previous.rows[0]?.cited;
        if (previouslyCited === false && cited && !result.cited) {
          newCompetitorCitations.push({ competitorDomain, provider: result.provider });
        }
      }
    }

    if (newCompetitorCitations.length && row.email) {
      try {
        const latestAudit = await pool.query(
          `SELECT id FROM audits WHERE user_id = $1 AND domain = $2 AND status = 'completed'
           ORDER BY completed_at DESC LIMIT 1`,
          [row.user_id, row.domain]
        );
        const reportUrl = latestAudit.rows[0]
          ? `${process.env.FRONTEND_URL}/audits/${latestAudit.rows[0].id}`
          : `${process.env.FRONTEND_URL}/dashboard`;

        await email.sendCompetitorCitationAlertEmail(row.email, {
          domain: row.domain,
          query: row.query,
          competitors: newCompetitorCitations,
          reportUrl,
        });
      } catch (err) {
        console.error('Failed to send competitor citation alert email:', err.message);
      }
    }

    checked += 1;
  }

  return { checked, skipped, evaluated: due.rows.length };
}

module.exports = { runDueAeoChecks, CHECK_INTERVAL_DAYS };

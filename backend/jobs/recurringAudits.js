const pool = require('../db/pool');
const { PLANS } = require('../config/plans');
const { checkPlanLimit } = require('../middleware/planLimit');
const { createAudit } = require('../services/auditRunner');

async function runDueRecurringAudits() {
  const due = await pool.query(
    `SELECT md.id, md.user_id, md.domain, md.recurring_delivery, u.plan
     FROM monitored_domains md
     JOIN users u ON u.id = md.user_id
     WHERE md.recurring_enabled = true
       AND md.recurring_interval_days IS NOT NULL
       AND (
         md.last_recurring_run_at IS NULL
         OR md.last_recurring_run_at <= now() - (md.recurring_interval_days || ' days')::interval
       )`
  );

  let started = 0;
  let skipped = 0;

  for (const row of due.rows) {
    const limitCheck = await checkPlanLimit(row.user_id, row.domain);
    // Always stamp last_recurring_run_at, even on skip, so a user stuck over
    // their plan limit doesn't get re-checked (and logged) every single run.
    await pool.query('UPDATE monitored_domains SET last_recurring_run_at = now() WHERE id = $1', [row.id]);

    if (!limitCheck.ok) {
      skipped += 1;
      continue;
    }

    const plan = PLANS[row.plan] || PLANS.free;
    await createAudit({
      userId: row.user_id,
      domain: row.domain,
      planKey: limitCheck.planKey,
      categories: plan.categories,
      notifyEmail: row.recurring_delivery === 'email',
    });
    started += 1;
  }

  return { started, skipped, checked: due.rows.length };
}

module.exports = { runDueRecurringAudits };

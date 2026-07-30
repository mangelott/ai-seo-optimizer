const pool = require('../db/pool');
const { PLANS } = require('../config/plans');

async function enforcePlanLimit(req, res, next) {
  const userResult = await pool.query(
    'SELECT plan, lifetime_free_audits_used FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = userResult.rows[0];
  const plan = PLANS[user.plan] || PLANS.free;

  if (user.plan === 'free') {
    if (user.lifetime_free_audits_used >= plan.lifetimeFullAudits) {
      return res.status(402).json({ error: 'Free audit already used. Upgrade to run another audit.' });
    }
  } else {
    const usageResult = await pool.query(
      `SELECT COUNT(*) FROM audits WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [req.user.id]
    );
    const usedThisMonth = parseInt(usageResult.rows[0].count, 10);
    if (plan.auditsPerMonth != null && usedThisMonth >= plan.auditsPerMonth) {
      return res.status(402).json({ error: 'Monthly audit limit reached. Upgrade your plan for more.' });
    }
  }

  if (plan.maxDomains != null) {
    const existingDomain = await pool.query(
      'SELECT 1 FROM audits WHERE user_id = $1 AND domain = $2 LIMIT 1',
      [req.user.id, req.body.domain]
    );
    if (!existingDomain.rows[0]) {
      const domainCountResult = await pool.query(
        'SELECT COUNT(DISTINCT domain) FROM audits WHERE user_id = $1',
        [req.user.id]
      );
      const domainCount = parseInt(domainCountResult.rows[0].count, 10);
      if (domainCount >= plan.maxDomains) {
        return res.status(402).json({
          error: `Your plan allows up to ${plan.maxDomains} domain(s). Upgrade to add more.`,
        });
      }
    }
  }

  req.plan = plan;
  req.planKey = user.plan;
  next();
}

module.exports = { enforcePlanLimit };

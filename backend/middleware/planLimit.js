const pool = require('../db/pool');
const { PLANS } = require('../config/plans');

async function checkPlanLimit(userId, domain) {
  const userResult = await pool.query(
    `SELECT u.plan, u.lifetime_free_audits_used, u.team_id, owner.plan AS team_owner_plan
     FROM users u
     LEFT JOIN teams t ON t.id = u.team_id
     LEFT JOIN users owner ON owner.id = t.owner_user_id
     WHERE u.id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return { ok: false, error: 'User not found' };

  // Team members share the team owner's plan/limits rather than their own individual plan.
  const effectivePlanKey = user.team_id && user.team_owner_plan ? user.team_owner_plan : user.plan;
  const plan = PLANS[effectivePlanKey] || PLANS.free;

  if (effectivePlanKey === 'free') {
    if (user.lifetime_free_audits_used >= plan.lifetimeFullAudits) {
      return { ok: false, error: 'Free audit already used. Upgrade to run another audit.' };
    }
  } else {
    const usageResult = await pool.query(
      `SELECT COUNT(*) FROM audits WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [userId]
    );
    const usedThisMonth = parseInt(usageResult.rows[0].count, 10);
    if (plan.auditsPerMonth != null && usedThisMonth >= plan.auditsPerMonth) {
      return { ok: false, error: 'Monthly audit limit reached. Upgrade your plan for more.' };
    }
  }

  if (plan.maxDomains != null) {
    const existingDomain = await pool.query(
      'SELECT 1 FROM audits WHERE user_id = $1 AND domain = $2 LIMIT 1',
      [userId, domain]
    );
    if (!existingDomain.rows[0]) {
      const domainCountResult = await pool.query(
        'SELECT COUNT(DISTINCT domain) FROM audits WHERE user_id = $1',
        [userId]
      );
      const domainCount = parseInt(domainCountResult.rows[0].count, 10);
      if (domainCount >= plan.maxDomains) {
        return { ok: false, error: `Your plan allows up to ${plan.maxDomains} domain(s). Upgrade to add more.` };
      }
    }
  }

  return { ok: true, plan, planKey: effectivePlanKey };
}

async function enforcePlanLimit(req, res, next) {
  const result = await checkPlanLimit(req.user.id, req.body.domain);
  if (!result.ok) return res.status(402).json({ error: result.error });

  req.plan = result.plan;
  req.planKey = result.planKey;
  next();
}

// Team members share the team owner's plan (see checkPlanLimit above) — used
// wherever a feature is gated on plan alone, without the audit/domain usage
// checks checkPlanLimit also does (e.g. routes/apiKeys.js gating API access
// to Agency).
async function getEffectivePlanKey(userId) {
  const userResult = await pool.query(
    `SELECT u.plan, u.team_id, owner.plan AS team_owner_plan
     FROM users u
     LEFT JOIN teams t ON t.id = u.team_id
     LEFT JOIN users owner ON owner.id = t.owner_user_id
     WHERE u.id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return null;
  return user.team_id && user.team_owner_plan ? user.team_owner_plan : user.plan;
}

module.exports = { enforcePlanLimit, checkPlanLimit, getEffectivePlanKey };

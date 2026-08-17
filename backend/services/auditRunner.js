const pool = require('../db/pool');
const { auditQueue } = require('../jobs/queue');

async function createAudit({ userId, domain, language, planKey, categories, notifyEmail = false }) {
  const result = await pool.query(
    'INSERT INTO audits (user_id, domain) VALUES ($1, $2) RETURNING id',
    [userId, domain]
  );
  const auditId = result.rows[0].id;

  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain) VALUES ($1, $2) ON CONFLICT (user_id, domain) DO NOTHING',
    [userId, domain]
  );

  if (planKey === 'free') {
    await pool.query(
      'UPDATE users SET lifetime_free_audits_used = lifetime_free_audits_used + 1 WHERE id = $1',
      [userId]
    );
  }

  await auditQueue.add('run-audit', {
    auditId,
    domain,
    categories,
    language: language || 'en',
    notifyEmail,
  });

  return auditId;
}

module.exports = { createAudit };

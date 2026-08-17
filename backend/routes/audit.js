const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { enforcePlanLimit } = require('../middleware/planLimit');
const { createAudit } = require('../services/auditRunner');
const { decryptSecret } = require('../services/encryption');
const { resolvePostId, applyField } = require('../services/wordpress');

const router = express.Router();

router.post('/', requireAuth, enforcePlanLimit, async (req, res) => {
  const { domain, language } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  const auditId = await createAudit({
    userId: req.user.id,
    domain,
    language,
    planKey: req.planKey,
    categories: req.plan.categories,
  });

  res.status(202).json({ auditId, status: 'pending' });
});

// Team members see each other's audits (shared agency workspace); solo
// users only ever match themselves, since NULL never equals NULL in SQL.
router.get('/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM audits WHERE id = $1
     AND user_id IN (SELECT id FROM users WHERE id = $2 OR team_id = (SELECT team_id FROM users WHERE id = $2))`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json(result.rows[0]);
});

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, domain, status, score, created_at, completed_at,
     jsonb_array_length(COALESCE(ai_recommendations, '[]'::jsonb)) AS issue_count
     FROM audits
     WHERE user_id IN (SELECT id FROM users WHERE id = $1 OR team_id = (SELECT team_id FROM users WHERE id = $1))
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

router.patch('/:id/share', requireAuth, async (req, res) => {
  const { shared } = req.body;
  const result = await pool.query(
    'UPDATE audits SET is_shared = $1 WHERE id = $2 AND user_id = $3 RETURNING is_shared, share_token',
    [!!shared, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json(result.rows[0]);
});

router.post('/:id/fixes/:index/apply', requireAuth, async (req, res) => {
  const auditResult = await pool.query('SELECT * FROM audits WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  const audit = auditResult.rows[0];
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  const fixes = Array.isArray(audit.ai_recommendations) ? audit.ai_recommendations : [];
  const index = parseInt(req.params.index, 10);
  const fix = fixes[index];
  if (!fix) return res.status(404).json({ error: 'Fix not found' });
  if (!fix.wpField) return res.status(400).json({ error: 'This fix cannot be auto-applied' });

  const domainResult = await pool.query(
    'SELECT * FROM monitored_domains WHERE user_id = $1 AND domain = $2',
    [req.user.id, audit.domain]
  );
  const domainRow = domainResult.rows[0];
  if (!domainRow?.auto_fix_enabled) {
    return res.status(400).json({ error: 'Auto-fix is not enabled for this domain' });
  }
  if (!domainRow.wp_url || !domainRow.wp_app_password_encrypted) {
    return res.status(400).json({ error: 'Connect a WordPress site to this domain first' });
  }

  try {
    const appPassword = await decryptSecret(domainRow.wp_app_password_encrypted);
    const postId = await resolvePostId(domainRow.wp_url, domainRow.wp_username, appPassword, audit.domain);
    await applyField(domainRow.wp_url, domainRow.wp_username, appPassword, {
      postId,
      field: fix.wpField,
      value: fix.wpValue,
      target: fix.wpTarget,
    });
  } catch (err) {
    console.error('WordPress auto-fix failed:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Could not apply this fix on WordPress. Check the connection and try again.' });
  }

  fixes[index] = { ...fix, applied: true, appliedAt: new Date().toISOString() };
  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [JSON.stringify(fixes), audit.id]);
  res.json({ ok: true, fix: fixes[index] });
});

module.exports = router;

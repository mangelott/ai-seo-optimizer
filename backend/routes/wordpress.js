const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { encryptSecret } = require('../services/encryption');
const { ping } = require('../services/wordpress');

const router = express.Router();

router.patch('/domains/:id/connect', requireAuth, async (req, res) => {
  const { wpUrl, wpUsername, wpAppPassword } = req.body;
  if (!wpUrl || !wpUsername || !wpAppPassword) {
    return res.status(400).json({ error: 'wpUrl, wpUsername and wpAppPassword are required' });
  }

  const owned = await pool.query('SELECT id FROM monitored_domains WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!owned.rows[0]) return res.status(404).json({ error: 'Domain not found' });

  try {
    await ping(wpUrl, wpUsername, wpAppPassword);
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(400).json({
        error: 'Could not reach the AI SEO Optimizer companion plugin on that site. Install and activate it first.',
      });
    }
    return res.status(400).json({
      error: 'Could not authenticate with that WordPress site. Check the URL, username, and Application Password.',
    });
  }

  const encrypted = await encryptSecret(wpAppPassword);
  const result = await pool.query(
    `UPDATE monitored_domains SET wp_url = $1, wp_username = $2, wp_app_password_encrypted = $3
     WHERE id = $4 AND user_id = $5
     RETURNING id, domain, wp_url, wp_username, auto_fix_enabled`,
    [wpUrl, wpUsername, encrypted, req.params.id, req.user.id]
  );
  res.json(result.rows[0]);
});

router.patch('/domains/:id/toggle', requireAuth, async (req, res) => {
  const { autoFixEnabled } = req.body;

  if (autoFixEnabled) {
    const check = await pool.query(
      'SELECT wp_url, wp_app_password_encrypted FROM monitored_domains WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Domain not found' });
    if (!check.rows[0].wp_url || !check.rows[0].wp_app_password_encrypted) {
      return res.status(400).json({ error: 'Connect a WordPress site to this domain before enabling auto-fix' });
    }
  }

  const result = await pool.query(
    `UPDATE monitored_domains SET auto_fix_enabled = $1 WHERE id = $2 AND user_id = $3
     RETURNING id, domain, auto_fix_enabled`,
    [!!autoFixEnabled, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Domain not found' });
  res.json(result.rows[0]);
});

router.delete('/domains/:id/disconnect', requireAuth, async (req, res) => {
  const result = await pool.query(
    `UPDATE monitored_domains
     SET wp_url = NULL, wp_username = NULL, wp_app_password_encrypted = NULL, auto_fix_enabled = false
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Domain not found' });
  res.json({ ok: true });
});

module.exports = router;

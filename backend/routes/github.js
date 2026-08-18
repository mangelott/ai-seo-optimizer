const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const github = require('../services/github');

const router = express.Router();

// Full-page redirect flow through GitHub's App installation screen, so the
// JWT travels as a query param and gets re-wrapped into a short-lived state
// token for the round trip — same pattern as the GSC connect flow.
router.get('/connect', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let user;
  try {
    user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const state = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  res.redirect(`https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new?state=${state}`);
});

router.get('/callback', async (req, res) => {
  const { installation_id: installationId, state } = req.query;
  if (!installationId || !state) return res.redirect(`${process.env.FRONTEND_URL}/settings?github=error`);

  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?github=error`);
  }

  await pool.query('UPDATE users SET github_installation_id = $1 WHERE id = $2', [installationId, decoded.userId]);
  res.redirect(`${process.env.FRONTEND_URL}/settings?github=connected`);
});

router.get('/status', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT github_installation_id FROM users WHERE id = $1', [req.user.id]);
  res.json({ connected: !!result.rows[0]?.github_installation_id });
});

router.get('/repos', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT github_installation_id FROM users WHERE id = $1', [req.user.id]);
  const installationId = result.rows[0]?.github_installation_id;
  if (!installationId) return res.status(400).json({ error: 'GitHub is not connected' });

  try {
    const repos = await github.listInstallationRepos(installationId);
    res.json(repos);
  } catch (err) {
    console.error('Failed to list GitHub repos:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not fetch repositories from GitHub' });
  }
});

router.patch('/domains/:id', requireAuth, async (req, res) => {
  const { repo, branch } = req.body;
  const result = await pool.query(
    `UPDATE monitored_domains SET github_repo = $1, github_branch = $2
     WHERE id = $3 AND user_id = $4
     RETURNING id, domain, github_repo, github_branch`,
    [repo ?? null, branch ?? null, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Domain not found' });
  res.json(result.rows[0]);
});

router.delete('/disconnect', requireAuth, async (req, res) => {
  await pool.query('UPDATE users SET github_installation_id = NULL WHERE id = $1', [req.user.id]);
  await pool.query('UPDATE monitored_domains SET github_repo = NULL, github_branch = NULL WHERE user_id = $1', [
    req.user.id,
  ]);
  res.json({ ok: true });
});

module.exports = router;

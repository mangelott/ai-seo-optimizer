const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getAuthUrl, exchangeCodeForTokens, refreshAccessToken, listSites } = require('../services/googleSearchConsole');

const router = express.Router();

// Full-page redirect flow, so the JWT travels as a query param (not a header) and
// gets re-wrapped into a short-lived state token for the round trip through Google.
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
  res.redirect(getAuthUrl(state));
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect(`${process.env.FRONTEND_URL}/settings?gsc=error`);

  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?gsc=error`);
  }

  try {
    const { accessToken, refreshToken } = await exchangeCodeForTokens(code);
    await pool.query(
      `UPDATE users SET gsc_access_token = $1, gsc_refresh_token = COALESCE($2, gsc_refresh_token), gsc_connected_at = now()
       WHERE id = $3`,
      [accessToken, refreshToken, decoded.userId]
    );
    res.redirect(`${process.env.FRONTEND_URL}/settings?gsc=connected`);
  } catch (err) {
    console.error('Google Search Console connect failed:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?gsc=error`);
  }
});

router.get('/status', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT gsc_connected_at FROM users WHERE id = $1', [req.user.id]);
  res.json({ connected: !!result.rows[0]?.gsc_connected_at });
});

router.get('/sites', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT gsc_refresh_token FROM users WHERE id = $1', [req.user.id]);
  const refreshToken = result.rows[0]?.gsc_refresh_token;
  if (!refreshToken) return res.status(400).json({ error: 'Google Search Console is not connected' });

  try {
    const accessToken = await refreshAccessToken(refreshToken);
    const sites = await listSites(accessToken);
    res.json(sites);
  } catch (err) {
    console.error('Failed to list GSC sites:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not fetch Search Console properties' });
  }
});

router.patch('/domains/:id', requireAuth, async (req, res) => {
  const { siteUrl } = req.body;
  const result = await pool.query(
    'UPDATE monitored_domains SET gsc_site_url = $1 WHERE id = $2 AND user_id = $3 RETURNING id, domain, gsc_site_url',
    [siteUrl ?? null, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Domain not found' });
  res.json(result.rows[0]);
});

router.delete('/disconnect', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE users SET gsc_access_token = NULL, gsc_refresh_token = NULL, gsc_connected_at = NULL WHERE id = $1',
    [req.user.id]
  );
  await pool.query('UPDATE monitored_domains SET gsc_site_url = NULL WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
});

module.exports = router;

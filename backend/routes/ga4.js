const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getAuthUrl, exchangeCodeForTokens, refreshAccessToken, listProperties } = require('../services/googleAnalytics');

const router = express.Router();

// Same full-page redirect flow as routes/gsc.js, for the same reason: the JWT
// travels as a query param (not a header) and gets re-wrapped into a
// short-lived state token for the round trip through Google.
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
  if (!code || !state) return res.redirect(`${process.env.FRONTEND_URL}/settings?ga4=error`);

  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?ga4=error`);
  }

  try {
    const { accessToken, refreshToken } = await exchangeCodeForTokens(code);
    await pool.query(
      `UPDATE users SET ga4_access_token = $1, ga4_refresh_token = COALESCE($2, ga4_refresh_token)
       WHERE id = $3`,
      [accessToken, refreshToken, decoded.userId]
    );
    res.redirect(`${process.env.FRONTEND_URL}/settings?ga4=connected`);
  } catch (err) {
    console.error('Google Analytics connect failed:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?ga4=error`);
  }
});

router.get('/status', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT ga4_refresh_token, ga4_property_id FROM users WHERE id = $1', [req.user.id]);
  const row = result.rows[0];
  res.json({ connected: !!row?.ga4_refresh_token, propertyId: row?.ga4_property_id || null });
});

router.get('/properties', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT ga4_refresh_token FROM users WHERE id = $1', [req.user.id]);
  const refreshToken = result.rows[0]?.ga4_refresh_token;
  if (!refreshToken) return res.status(400).json({ error: 'Google Analytics is not connected' });

  try {
    const accessToken = await refreshAccessToken(refreshToken);
    const properties = await listProperties(accessToken);
    res.json(properties);
  } catch (err) {
    console.error('Failed to list GA4 properties:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not fetch Google Analytics properties' });
  }
});

// TODO(altitude): this sets the property for the whole account, not per
// monitored domain — see the TODO on users.ga4_property_id in db/schema.sql.
router.patch('/property', requireAuth, async (req, res) => {
  const { propertyId } = req.body;
  // GA4 property IDs are plain numeric strings (e.g. "123456") — reject
  // anything else before it's stored and later interpolated into the GA4
  // Data API request path in services/googleAnalytics.js.
  if (propertyId != null && !/^\d+$/.test(propertyId)) {
    return res.status(400).json({ error: 'Invalid propertyId' });
  }
  const result = await pool.query(
    'UPDATE users SET ga4_property_id = $1 WHERE id = $2 RETURNING ga4_property_id',
    [propertyId || null, req.user.id]
  );
  res.json(result.rows[0]);
});

router.delete('/disconnect', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE users SET ga4_access_token = NULL, ga4_refresh_token = NULL, ga4_property_id = NULL WHERE id = $1',
    [req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;

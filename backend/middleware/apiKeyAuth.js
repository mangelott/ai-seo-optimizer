const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { API_KEY_PREFIX, hashApiKey } = require('../services/apiKeys');

// Alternative to middleware/auth.js's requireAuth: accepts either the web
// app's JWT or an Agency API key (Authorization: Bearer saeo_...) on the
// same routes, resolving to the same req.user shape ({id, email}) either
// way so route handlers (and enforcePlanLimit) don't need to know which one
// was used.
async function requireAuthOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = header.slice('Bearer '.length);

  if (token.startsWith(API_KEY_PREFIX)) {
    const result = await pool.query(
      `SELECT ak.id AS api_key_id, u.id AS user_id, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
      [hashApiKey(token)]
    );
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: 'Invalid or revoked API key' });

    pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.api_key_id]).catch(() => {});

    req.user = { id: row.user_id, email: row.email };
    req.apiKeyId = row.api_key_id;
    return next();
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Only throttles actual API-key traffic (`skip` lets JWT/web-app requests
// through exactly as before this feature existed) — keyed per key, not per
// IP, since an agency's own server calling this API from one IP shouldn't
// share a budget with every other API key.
const apiKeyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.apiKeyId),
  skip: (req) => !req.apiKeyId,
  message: { error: 'API rate limit exceeded. Try again later.' },
});

module.exports = { requireAuthOrApiKey, apiKeyRateLimit };

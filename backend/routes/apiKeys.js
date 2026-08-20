const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getEffectivePlanKey } = require('../middleware/planLimit');
const { generateApiKey, hashApiKey } = require('../services/apiKeys');

const router = express.Router();

// Key management itself always requires the web app's JWT session, never an
// API key — an API key can call the audit/domains API it was created for,
// but can't mint or revoke other keys.
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const effectivePlanKey = await getEffectivePlanKey(req.user.id);
  if (effectivePlanKey !== 'agency') {
    return res.status(402).json({ error: 'API access requires the Agency plan' });
  }

  const { key, keyPrefix } = generateApiKey();
  const result = await pool.query(
    'INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, created_at',
    [req.user.id, name.trim(), hashApiKey(key), keyPrefix]
  );

  // The plaintext key is only ever returned here, once — only its hash is stored.
  res.status(201).json({ ...result.rows[0], key });
});

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(result.rows);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'API key not found' });
  res.json({ ok: true });
});

module.exports = router;

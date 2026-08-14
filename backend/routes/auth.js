const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getAuthUrl, exchangeCodeForProfile } = require('../services/google');
const { sendPasswordResetEmail } = require('../services/email');

const router = express.Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  const { name, email, password, scanId } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name || null, email, passwordHash]
    );
    const user = result.rows[0];

    if (scanId) {
      await pool.query(
        'UPDATE quick_scans SET claimed_by_user_id = $1 WHERE id = $2 AND claimed_by_user_id IS NULL',
        [user.id, scanId]
      );
    }

    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];

  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({ token: signToken(user) });
});

router.get('/google', (req, res) => {
  const { scanId } = req.query;
  res.redirect(getAuthUrl(scanId));
});

router.get('/google/callback', async (req, res) => {
  const { code, state: scanId } = req.query;
  if (!code) return res.redirect(`${process.env.FRONTEND_URL}/login?error=google_auth_failed`);

  try {
    const profile = await exchangeCodeForProfile(code);

    let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [profile.googleId]);
    let user = result.rows[0];

    if (!user) {
      // A password account with the same email already exists: link Google to it.
      result = await pool.query('SELECT * FROM users WHERE email = $1', [profile.email]);
      user = result.rows[0];

      if (user) {
        await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.googleId, user.id]);
      } else {
        const inserted = await pool.query(
          'INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING *',
          [profile.name || null, profile.email, profile.googleId]
        );
        user = inserted.rows[0];
      }
    }

    if (scanId) {
      await pool.query(
        'UPDATE quick_scans SET claimed_by_user_id = $1 WHERE id = $2 AND claimed_by_user_id IS NULL',
        [user.id, scanId]
      );
    }

    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${signToken(user)}`);
  } catch (err) {
    console.error('Google auth failed:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=google_auth_failed`);
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const result = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
  const user = result.rows[0];

  // Always respond the same way whether or not the email exists, to avoid
  // leaking which addresses are registered.
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await pool.query('UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3', [
      hashToken(rawToken),
      expires,
      user.id,
    ]);

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${rawToken}`;
    try {
      await sendPasswordResetEmail(user.email, resetUrl);
    } catch (err) {
      console.error('Failed to send password reset email:', err.message);
    }
  }

  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  const result = await pool.query(
    'SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires > now()',
    [hashToken(token)]
  );
  const user = result.rows[0];
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query(
    'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2',
    [newHash, user.id]
  );
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, plan FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

router.patch('/me', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email) WHERE id = $3 RETURNING id, name, email',
      [name, email, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    res.status(500).json({ error: 'Update failed' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }

  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const user = result.rows[0];
  if (!user || !user.password_hash) {
    return res.status(400).json({ error: 'This account signed up with Google and has no password yet' });
  }
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
  res.json({ ok: true });
});

router.delete('/me', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

module.exports = router;

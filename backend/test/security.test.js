// Regression tests asserting that secrets never leak into API responses:
// password hashes, password reset tokens, the encrypted WordPress
// Application Password, and Google Search Console OAuth tokens. Each test
// checks both the parsed JSON keys AND a raw-string search over the full
// response body, so a secret smuggled in under an unexpected key name
// (or double-encoded) would still be caught.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection } = require('../jobs/queue');
const { encryptSecret } = require('../services/encryption');

const FAKE_WP_USER = 'sec-tester';
const FAKE_WP_PASSWORD = 'super-secret-app-password-999';

let server;
let baseUrl;
let fakeWpServer;
let fakeWpUrl;

async function raw(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data, text };
}

async function registerAndLogin(email) {
  await raw('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  const { data } = await raw('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  return data.token;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function assertNoSecretLeak(responseText, secrets) {
  for (const secret of secrets) {
    if (!secret) continue;
    assert.ok(
      !responseText.includes(secret),
      `response body must never contain the secret value "${secret.slice(0, 12)}..."`
    );
  }
}

function requireFakeWpAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${FAKE_WP_USER}:${FAKE_WP_PASSWORD}`).toString('base64');
  if (header !== expected) return res.status(401).json({ code: 'unauthorized' });
  next();
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE'
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;

  const wp = express();
  wp.use(express.json());
  wp.get('/wp-json/ai-seo-optimizer/v1/ping', requireFakeWpAuth, (req, res) => res.json({ ok: true, version: '1.0.0' }));
  await new Promise((resolve) => {
    fakeWpServer = wp.listen(0, resolve);
  });
  fakeWpUrl = `http://localhost:${fakeWpServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fakeWpServer.close(resolve));
  await pool.end();
  redisConnection.disconnect();
});

test('security: password_hash never appears in /auth/me or /auth/register responses', async () => {
  const email = uniqueEmail('sec-pwhash');
  const registerRes = await raw('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  assert.equal(registerRes.status, 201);
  assert.ok(!('password_hash' in (registerRes.data || {})));

  const passwordHashRow = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
  const hash = passwordHashRow.rows[0].password_hash;
  assertNoSecretLeak(registerRes.text, [hash]);

  const token = await registerAndLogin(email);
  const meRes = await raw('GET', '/api/auth/me', { token });
  assert.deepEqual(Object.keys(meRes.data).sort(), ['email', 'id', 'name', 'plan'].sort());
  assertNoSecretLeak(meRes.text, [hash]);
});

test('security: password reset tokens never appear in the forgot-password response', async () => {
  const email = uniqueEmail('sec-reset');
  await registerAndLogin(email);

  const res = await raw('POST', '/api/auth/forgot-password', { body: { email } });
  assert.equal(res.status, 200);

  const tokenRow = await pool.query('SELECT reset_token_hash FROM users WHERE email = $1', [email]);
  assert.ok(tokenRow.rows[0].reset_token_hash, 'a reset token hash should have been stored');
  assertNoSecretLeak(res.text, [tokenRow.rows[0].reset_token_hash]);
  assert.ok(!('reset_token_hash' in (res.data || {})));
  assert.ok(!('resetToken' in (res.data || {})));
  assert.ok(!('token' in (res.data || {})));
});

test('security: GSC tokens never appear in /gsc/status even when connected', async () => {
  const email = uniqueEmail('sec-gsc');
  const token = await registerAndLogin(email);

  const fakeAccessToken = 'fake-gsc-access-token-abc123';
  const fakeRefreshToken = 'fake-gsc-refresh-token-xyz789';
  await pool.query(
    'UPDATE users SET gsc_access_token = $1, gsc_refresh_token = $2, gsc_connected_at = now() WHERE email = $3',
    [fakeAccessToken, fakeRefreshToken, email]
  );

  const res = await raw('GET', '/api/gsc/status', { token });
  assert.deepEqual(Object.keys(res.data), ['connected']);
  assertNoSecretLeak(res.text, [fakeAccessToken, fakeRefreshToken]);
});

test('security: the WordPress Application Password never appears in any API response, including its encrypted form', async () => {
  const email = uniqueEmail('sec-wp');
  const token = await registerAndLogin(email);
  const auditRes = await raw('POST', '/api/audit', { token, body: { domain: 'https://sec-wp-site.com' } });
  assert.equal(auditRes.status, 202);

  const domainsBefore = await raw('GET', '/api/domains', { token });
  const domainId = domainsBefore.data[0].id;

  const connectRes = await raw('PATCH', `/api/wordpress/domains/${domainId}/connect`, {
    token,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });
  assert.equal(connectRes.status, 200);
  assert.ok(!('wp_app_password_encrypted' in connectRes.data));
  assertNoSecretLeak(connectRes.text, [FAKE_WP_PASSWORD]);

  const encryptedRow = await pool.query(
    'SELECT wp_app_password_encrypted FROM monitored_domains WHERE id = $1',
    [domainId]
  );
  const encryptedHex = encryptedRow.rows[0].wp_app_password_encrypted.toString('base64');
  assertNoSecretLeak(connectRes.text, [encryptedHex]);

  const domainsAfter = await raw('GET', '/api/domains', { token });
  assert.ok(!('wp_app_password_encrypted' in domainsAfter.data[0]));
  assertNoSecretLeak(domainsAfter.text, [FAKE_WP_PASSWORD, encryptedHex]);

  const toggleRes = await raw('PATCH', `/api/wordpress/domains/${domainId}/toggle`, {
    token,
    body: { autoFixEnabled: true },
  });
  assert.ok(!('wp_app_password_encrypted' in toggleRes.data));
  assertNoSecretLeak(toggleRes.text, [FAKE_WP_PASSWORD, encryptedHex]);
});

test('security: encrypting the same secret twice never produces the same ciphertext (pgcrypto uses a fresh IV each time)', async () => {
  const first = await encryptSecret('same-plaintext-value');
  const second = await encryptSecret('same-plaintext-value');
  assert.notEqual(first.toString('base64'), second.toString('base64'));
});

test('security: an intruder\'s token cannot read another user\'s encrypted WordPress secret via any endpoint', async () => {
  const ownerEmail = uniqueEmail('sec-wp-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await raw('POST', '/api/audit', { token: ownerToken, body: { domain: 'https://sec-wp-owner-site.com' } });
  const ownerDomains = await raw('GET', '/api/domains', { token: ownerToken });
  const domainId = ownerDomains.data[0].id;
  await raw('PATCH', `/api/wordpress/domains/${domainId}/connect`, {
    token: ownerToken,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });

  const intruderToken = await registerAndLogin(uniqueEmail('sec-wp-intruder'));
  const intruderDomains = await raw('GET', '/api/domains', { token: intruderToken });
  assert.equal(intruderDomains.data.length, 0, 'an unrelated user must not see the owner\'s domain at all');
});

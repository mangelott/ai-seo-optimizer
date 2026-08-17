// Integration tests for WordPress auto-fix: connecting a site, toggling it,
// and applying a fix. Runs a tiny fake "WordPress + companion plugin" HTTP
// server in-process so the happy path is exercised without a real WP site.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection } = require('../jobs/queue');

const FAKE_WP_USER = 'ai-seo-tester';
const FAKE_WP_PASSWORD = 'app-password-1234';
const FAKE_POST_ID = 42;

let server;
let baseUrl;
let fakeWpServer;
let fakeWpUrl;

async function json(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, data };
}

async function registerAndLogin(email) {
  await json('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  const { data } = await json('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  return data.token;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function requireFakeWpAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${FAKE_WP_USER}:${FAKE_WP_PASSWORD}`).toString('base64');
  if (header !== expected) return res.status(401).json({ code: 'unauthorized' });
  next();
}

function buildFakeWpApp() {
  const wp = express();
  wp.use(express.json());
  wp.get('/wp-json/ai-seo-optimizer/v1/ping', requireFakeWpAuth, (req, res) => {
    res.json({ ok: true, version: '1.0.0' });
  });
  wp.get('/wp-json/ai-seo-optimizer/v1/resolve', requireFakeWpAuth, (req, res) => {
    res.json({ postId: FAKE_POST_ID, postType: 'page' });
  });
  wp.post('/wp-json/ai-seo-optimizer/v1/apply', requireFakeWpAuth, (req, res) => {
    if (req.body.field === 'unsupported_field') {
      return res.status(400).json({ code: 'ai_seo_optimizer_unsupported_field' });
    }
    res.json({ ok: true });
  });
  return wp;
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE'
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;

  await new Promise((resolve) => {
    fakeWpServer = buildFakeWpApp().listen(0, resolve);
  });
  fakeWpUrl = `http://localhost:${fakeWpServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fakeWpServer.close(resolve));
  await pool.end();
  redisConnection.disconnect();
});

async function setupAuditedDomain(label, domain) {
  const token = await registerAndLogin(uniqueEmail(label));
  const created = await json('POST', '/api/audit', { token, body: { domain } });
  const domainsRes = await json('GET', '/api/domains', { token });
  return { token, auditId: created.data.auditId, domainRow: domainsRes.data[0] };
}

test('wordpress: connecting with wrong credentials is rejected and nothing is stored', async () => {
  const { token, domainRow } = await setupAuditedDomain('wp-badauth', 'https://wp-badauth-site.com');

  const res = await json('PATCH', `/api/wordpress/domains/${domainRow.id}/connect`, {
    token,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: 'wrong-password' },
  });
  assert.equal(res.status, 400);

  const after = await json('GET', '/api/domains', { token });
  assert.equal(after.data[0].wp_url, null);
});

test('wordpress: connect, toggle auto-fix, and apply a fix end-to-end', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('wp-happy', 'https://wp-happy-site.com');

  const connected = await json('PATCH', `/api/wordpress/domains/${domainRow.id}/connect`, {
    token,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.data.wp_url, fakeWpUrl);

  const toggled = await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, {
    token,
    body: { autoFixEnabled: true },
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.auto_fix_enabled, true);

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      {
        category: 'content',
        severity: 'high',
        title: 'Missing title tag',
        wpField: 'post_title',
        wpValue: 'A much better title',
        wpTarget: null,
      },
    ]),
    auditId,
  ]);

  const applied = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.fix.applied, true);

  const audit = await json('GET', `/api/audit/${auditId}`, { token });
  assert.equal(audit.data.ai_recommendations[0].applied, true);
});

test('wordpress: toggling auto-fix on without a connection is rejected', async () => {
  const { token, domainRow } = await setupAuditedDomain('wp-notoggle', 'https://wp-notoggle-site.com');
  const res = await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, {
    token,
    body: { autoFixEnabled: true },
  });
  assert.equal(res.status, 400);
});

test('wordpress: applying a fix is blocked when auto-fix is disabled', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('wp-disabled', 'https://wp-disabled-site.com');
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/connect`, {
    token,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });
  // auto-fix is connected but left disabled (default)

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([{ category: 'content', severity: 'low', title: 'x', wpField: 'post_title', wpValue: 'y' }]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 400);
});

test('wordpress: applying a fix with no wpField is rejected', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('wp-nofield', 'https://wp-nofield-site.com');
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/connect`, {
    token,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([{ category: 'keywords', severity: 'low', title: 'Add more backlinks', wpField: null }]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 400);
});

test('wordpress: connect, toggle, and disconnect are owner-scoped', async () => {
  const { domainRow } = await setupAuditedDomain('wp-owner', 'https://wp-owner-site.com');
  const intruderToken = await registerAndLogin(uniqueEmail('wp-intruder'));

  const stolenConnect = await json('PATCH', `/api/wordpress/domains/${domainRow.id}/connect`, {
    token: intruderToken,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });
  assert.equal(stolenConnect.status, 404);

  const stolenToggle = await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, {
    token: intruderToken,
    body: { autoFixEnabled: true },
  });
  assert.equal(stolenToggle.status, 404);

  const stolenDisconnect = await json('DELETE', `/api/wordpress/domains/${domainRow.id}/disconnect`, {
    token: intruderToken,
  });
  assert.equal(stolenDisconnect.status, 404);
});

test('wordpress: disconnect clears the connection and turns off auto-fix', async () => {
  const { token, domainRow } = await setupAuditedDomain('wp-disconnect', 'https://wp-disconnect-site.com');
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/connect`, {
    token,
    body: { wpUrl: fakeWpUrl, wpUsername: FAKE_WP_USER, wpAppPassword: FAKE_WP_PASSWORD },
  });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  const res = await json('DELETE', `/api/wordpress/domains/${domainRow.id}/disconnect`, { token });
  assert.equal(res.status, 200);

  const after = await json('GET', '/api/domains', { token });
  assert.equal(after.data[0].wp_url, null);
  assert.equal(after.data[0].auto_fix_enabled, false);
});

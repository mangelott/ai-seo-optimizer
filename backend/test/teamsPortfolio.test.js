// Integration tests for GET /api/teams/portfolio: one row per domain visible
// to the caller (own domains, or the whole team's), with the latest audit
// score, trend vs the previous audit, and score-drop alerts. Audits are
// inserted directly via SQL (same pattern as test/auditWorker.test.js's
// createAuditRow) instead of going through POST /api/audit, since no worker
// runs during `npm test` and the score/trend math only needs completed rows
// with a score, not a real audit run — no external API is ever called here.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection, auditQueue } = require('../jobs/queue');
const { SCORE_DROP_ALERT_THRESHOLD } = require('../services/auditProcessor');

let server;
let baseUrl;

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

async function setPlan(email, plan) {
  await pool.query('UPDATE users SET plan = $1 WHERE email = $2', [plan, email]);
}

async function addMonitoredDomain(userId, domain) {
  await pool.query('INSERT INTO monitored_domains (user_id, domain) VALUES ($1, $2)', [userId, domain]);
}

async function addAuditRow(userId, domain, score, createdAt) {
  await pool.query(
    `INSERT INTO audits (user_id, domain, status, score, created_at) VALUES ($1, $2, 'completed', $3, $4)`,
    [userId, domain, score, createdAt]
  );
}

function userIdFor(email) {
  return pool.query('SELECT id FROM users WHERE email = $1', [email]).then((r) => r.rows[0].id);
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE'
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await auditQueue.obliterate({ force: true });
  redisConnection.disconnect();
});

test('teams/portfolio: aggregates one row per domain with latest score, trend, and score-drop alerts', async () => {
  const ownerEmail = uniqueEmail('portfolio-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'PortfolioCo' } });
  const ownerId = await userIdFor(ownerEmail);

  // Domain A: score dropped from 80 to 60 — a 20-point drop, above
  // SCORE_DROP_ALERT_THRESHOLD (10), so it should carry an active alert.
  await addMonitoredDomain(ownerId, 'https://a-site.com');
  await addAuditRow(ownerId, 'https://a-site.com', 80, '2026-01-01T00:00:00Z');
  await addAuditRow(ownerId, 'https://a-site.com', 60, '2026-02-01T00:00:00Z');

  // Domain B: only ever audited once — no previous score, no trend, no alert.
  await addMonitoredDomain(ownerId, 'https://b-site.com');
  await addAuditRow(ownerId, 'https://b-site.com', 90, '2026-02-01T00:00:00Z');

  // Domain C: score improved from 50 to 55 — a small positive trend, no alert.
  await addMonitoredDomain(ownerId, 'https://c-site.com');
  await addAuditRow(ownerId, 'https://c-site.com', 50, '2026-01-01T00:00:00Z');
  await addAuditRow(ownerId, 'https://c-site.com', 55, '2026-02-01T00:00:00Z');

  const { status, data } = await json('GET', '/api/teams/portfolio', { token: ownerToken });
  assert.equal(status, 200);
  assert.equal(data.length, 3);

  const byDomain = Object.fromEntries(data.map((row) => [row.domain, row]));

  assert.equal(byDomain['https://a-site.com'].latestScore, 60);
  assert.equal(byDomain['https://a-site.com'].previousScore, 80);
  assert.equal(byDomain['https://a-site.com'].trend, -20);
  assert.equal(byDomain['https://a-site.com'].alerts.length, 1);
  assert.equal(byDomain['https://a-site.com'].alerts[0].type, 'score_drop');
  assert.ok(80 - 60 >= SCORE_DROP_ALERT_THRESHOLD);

  assert.equal(byDomain['https://b-site.com'].latestScore, 90);
  assert.equal(byDomain['https://b-site.com'].previousScore, null);
  assert.equal(byDomain['https://b-site.com'].trend, null);
  assert.deepEqual(byDomain['https://b-site.com'].alerts, []);

  assert.equal(byDomain['https://c-site.com'].latestScore, 55);
  assert.equal(byDomain['https://c-site.com'].previousScore, 50);
  assert.equal(byDomain['https://c-site.com'].trend, 5);
  assert.deepEqual(byDomain['https://c-site.com'].alerts, []);

  // Sorting is done client-side (Portfolio.jsx) off this same data — confirm
  // the aggregated rows carry what's needed to sort correctly by score and
  // by trend, in both directions.
  const byScoreDesc = [...data].sort((a, b) => b.latestScore - a.latestScore).map((r) => r.domain);
  assert.deepEqual(byScoreDesc, ['https://b-site.com', 'https://a-site.com', 'https://c-site.com']);

  const byTrendAsc = [...data]
    .filter((r) => r.trend != null)
    .sort((a, b) => a.trend - b.trend)
    .map((r) => r.domain);
  assert.deepEqual(byTrendAsc, ['https://a-site.com', 'https://c-site.com']);
});

test('teams/portfolio: shared with every team member, not visible to outsiders', async () => {
  const ownerEmail = uniqueEmail('portfolio-share-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'ShareCo' } });
  const ownerId = await userIdFor(ownerEmail);

  await addMonitoredDomain(ownerId, 'https://shared-site.com');
  await addAuditRow(ownerId, 'https://shared-site.com', 70, '2026-02-01T00:00:00Z');

  const memberEmail = uniqueEmail('portfolio-share-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  const memberResult = await json('GET', '/api/teams/portfolio', { token: memberToken });
  assert.ok(memberResult.data.some((r) => r.domain === 'https://shared-site.com' && r.latestScore === 70));

  const outsiderToken = await registerAndLogin(uniqueEmail('portfolio-share-outsider'));
  const outsiderResult = await json('GET', '/api/teams/portfolio', { token: outsiderToken });
  assert.ok(!outsiderResult.data.some((r) => r.domain === 'https://shared-site.com'));
});

// Integration tests for routes/trackedKeywords.js against the real Express
// app and Postgres, in the pattern of test/aeo.test.js. No DataForSEO
// credentials are exercised here — these routes only manage tracked_keywords
// and read back rank_tracking rows inserted directly by the test.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection, auditQueue } = require('../jobs/queue');

let server;
let baseUrl;

async function jsonReq(method, path, { token, body } = {}) {
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
    // ignore
  }
  return { status: res.status, data };
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAndLogin(email, opts = {}) {
  await jsonReq('POST', '/api/auth/register', { body: { email, password: 'password123', ...opts } });
  const { data } = await jsonReq('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  return data.token;
}

async function setPlan(email, plan) {
  await pool.query('UPDATE users SET plan = $1 WHERE email = $2', [plan, email]);
}

test.before(async () => {
  await pool.query(
    'TRUNCATE rank_tracking, tracked_keywords, quick_scans, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE'
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

test('POST /api/rank-tracking/keywords: rejects a plan without rank tracking included', async () => {
  const email = uniqueEmail('rank-free');
  const token = await registerAndLogin(email);
  await setPlan(email, 'free');

  const { status, data } = await jsonReq('POST', '/api/rank-tracking/keywords', {
    token,
    body: { domain: 'https://example.com', keyword: 'best coffee lisbon' },
  });
  assert.equal(status, 402);
  assert.match(data.error, /not included in your plan/);
});

test('POST /api/rank-tracking/keywords: adds a tracked keyword for a Pro-plan user', async () => {
  const email = uniqueEmail('rank-pro');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { status, data } = await jsonReq('POST', '/api/rank-tracking/keywords', {
    token,
    body: { domain: 'https://example.com', keyword: 'best coffee lisbon' },
  });
  assert.equal(status, 201);
  assert.equal(data.keyword, 'best coffee lisbon');
  assert.equal(data.last_checked_at, null);
});

test('POST /api/rank-tracking/keywords: rejects a duplicate keyword for the same domain', async () => {
  const email = uniqueEmail('rank-dup');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  await jsonReq('POST', '/api/rank-tracking/keywords', { token, body: { domain: 'https://dup.com', keyword: 'same keyword' } });
  const { status, data } = await jsonReq('POST', '/api/rank-tracking/keywords', {
    token,
    body: { domain: 'https://dup.com', keyword: 'same keyword' },
  });
  assert.equal(status, 409);
  assert.match(data.error, /already tracked/);
});

test('POST /api/rank-tracking/keywords: enforces the fixed per-domain keyword list cap (independent of plan)', async () => {
  const email = uniqueEmail('rank-cap');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  for (let i = 0; i < 10; i++) {
    const { status } = await jsonReq('POST', '/api/rank-tracking/keywords', {
      token,
      body: { domain: 'https://cap-site.com', keyword: `keyword ${i}` },
    });
    assert.equal(status, 201);
  }

  const { status, data } = await jsonReq('POST', '/api/rank-tracking/keywords', {
    token,
    body: { domain: 'https://cap-site.com', keyword: 'one too many' },
  });
  assert.equal(status, 400);
  assert.match(data.error, /up to 10 keywords/);
});

test('GET /api/rank-tracking/keywords: lists only the requesting user\'s keywords for that domain, with latest position', async () => {
  const emailA = uniqueEmail('rank-list-a');
  const tokenA = await registerAndLogin(emailA);
  await setPlan(emailA, 'pro');
  const emailB = uniqueEmail('rank-list-b');
  const tokenB = await registerAndLogin(emailB);
  await setPlan(emailB, 'pro');

  await jsonReq('POST', '/api/rank-tracking/keywords', { token: tokenA, body: { domain: 'https://list-site.com', keyword: 'keyword A' } });
  await jsonReq('POST', '/api/rank-tracking/keywords', { token: tokenB, body: { domain: 'https://list-site.com', keyword: 'keyword B' } });

  const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [emailA]);
  await pool.query(
    `INSERT INTO rank_tracking (user_id, domain, keyword, position, checked_at) VALUES
     ($1, 'https://list-site.com', 'keyword A', 9, now() - interval '1 day'),
     ($1, 'https://list-site.com', 'keyword A', 4, now())`,
    [userResult.rows[0].id]
  );

  const { data } = await jsonReq('GET', '/api/rank-tracking/keywords?domain=https://list-site.com', { token: tokenA });
  assert.equal(data.length, 1);
  assert.equal(data[0].keyword, 'keyword A');
  assert.equal(data[0].latest_position, 4);
});

test('DELETE /api/rank-tracking/keywords/:id: removes a keyword owned by the requesting user', async () => {
  const email = uniqueEmail('rank-del');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { data: created } = await jsonReq('POST', '/api/rank-tracking/keywords', {
    token,
    body: { domain: 'https://del-site.com', keyword: 'delete me' },
  });

  const { status } = await jsonReq('DELETE', `/api/rank-tracking/keywords/${created.id}`, { token });
  assert.equal(status, 200);

  const { data: listed } = await jsonReq('GET', '/api/rank-tracking/keywords?domain=https://del-site.com', { token });
  assert.equal(listed.length, 0);
});

test('DELETE /api/rank-tracking/keywords/:id: 404s for a keyword owned by another user', async () => {
  const emailA = uniqueEmail('rank-del-a');
  const tokenA = await registerAndLogin(emailA);
  await setPlan(emailA, 'pro');
  const emailB = uniqueEmail('rank-del-b');
  const tokenB = await registerAndLogin(emailB);
  await setPlan(emailB, 'pro');

  const { data: created } = await jsonReq('POST', '/api/rank-tracking/keywords', {
    token: tokenA,
    body: { domain: 'https://cross-user.com', keyword: 'not yours' },
  });

  const { status } = await jsonReq('DELETE', `/api/rank-tracking/keywords/${created.id}`, { token: tokenB });
  assert.equal(status, 404);
});

test('GET /api/rank-tracking/history: groups position points by keyword, ordered by checked_at', async () => {
  const email = uniqueEmail('rank-history');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');
  const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;

  await pool.query(
    `INSERT INTO rank_tracking (user_id, domain, keyword, position, checked_at) VALUES
     ($1, 'https://history-site.com', 'keyword A', 9, now() - interval '2 days'),
     ($1, 'https://history-site.com', 'keyword A', 4, now() - interval '1 day'),
     ($1, 'https://history-site.com', 'keyword B', null, now())`,
    [userId]
  );

  const { data } = await jsonReq('GET', '/api/rank-tracking/history?domain=https://history-site.com', { token });
  assert.equal(data.length, 2);

  const keywordA = data.find((k) => k.keyword === 'keyword A');
  assert.equal(keywordA.points.length, 2);
  assert.equal(keywordA.points[0].position, 9);
  assert.equal(keywordA.points[1].position, 4);

  const keywordB = data.find((k) => k.keyword === 'keyword B');
  assert.equal(keywordB.points[0].position, null);
});

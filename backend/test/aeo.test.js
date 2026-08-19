// Integration tests for routes/aeo.js against the real Express app and
// Postgres, in the pattern of test/api.test.js. No provider credentials are
// exercised here — these routes only manage aeo_target_queries and read back
// aeo_queries rows inserted directly by the test.
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
    'TRUNCATE aeo_competitor_citations, aeo_queries, aeo_target_queries, quick_scans, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE'
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

test('POST /api/aeo/queries: rejects a plan without AEO tracking included', async () => {
  const email = uniqueEmail('aeo-free');
  const token = await registerAndLogin(email);
  await setPlan(email, 'free');

  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://example.com', query: 'best coffee lisbon' },
  });
  assert.equal(status, 402);
  assert.match(data.error, /not included in your plan/);
});

test('POST /api/aeo/queries: adds a target query for a Pro-plan user', async () => {
  const email = uniqueEmail('aeo-pro');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://example.com', query: 'best coffee lisbon' },
  });
  assert.equal(status, 201);
  assert.equal(data.query, 'best coffee lisbon');
  assert.equal(data.last_checked_at, null);
});

test('POST /api/aeo/queries: rejects a duplicate query for the same domain', async () => {
  const email = uniqueEmail('aeo-dup');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  await jsonReq('POST', '/api/aeo/queries', { token, body: { domain: 'https://dup.com', query: 'same query' } });
  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://dup.com', query: 'same query' },
  });
  assert.equal(status, 409);
  assert.match(data.error, /already tracked/);
});

test('POST /api/aeo/queries: enforces the per-domain query cap', async () => {
  const email = uniqueEmail('aeo-cap');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  for (let i = 0; i < 10; i++) {
    const { status } = await jsonReq('POST', '/api/aeo/queries', {
      token,
      body: { domain: 'https://cap-site.com', query: `query ${i}` },
    });
    assert.equal(status, 201);
  }

  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://cap-site.com', query: 'one too many' },
  });
  assert.equal(status, 400);
  assert.match(data.error, /up to 10 queries/);
});

test('POST /api/aeo/queries: accepts competitorDomains and returns them', async () => {
  const email = uniqueEmail('aeo-competitors');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://example.com', query: 'best coffee lisbon', competitorDomains: ['https://rival.com'] },
  });
  assert.equal(status, 201);
  assert.deepEqual(data.competitor_domains, ['https://rival.com']);
});

test('POST /api/aeo/queries: rejects a competitorDomains list past the per-query cap', async () => {
  const email = uniqueEmail('aeo-competitor-cap');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: {
      domain: 'https://example.com',
      query: 'best coffee lisbon',
      competitorDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'],
    },
  });
  assert.equal(status, 400);
  assert.match(data.error, /up to 5 competitor domains/);
});

test('POST /api/aeo/queries: rejects a non-array/non-string competitorDomains value', async () => {
  const email = uniqueEmail('aeo-competitor-invalid');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { status, data } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://example.com', query: 'best coffee lisbon', competitorDomains: ['ok.com', ''] },
  });
  assert.equal(status, 400);
  assert.match(data.error, /array of non-empty strings/);
});

test('PATCH /api/aeo/queries/:id/competitors: updates the competitor list for a query owned by the requester', async () => {
  const email = uniqueEmail('aeo-patch-competitors');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const created = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://patch-site.com', query: 'best coffee lisbon' },
  });

  const { status, data } = await jsonReq('PATCH', `/api/aeo/queries/${created.data.id}/competitors`, {
    token,
    body: { competitorDomains: ['https://rival.com', 'https://other-rival.com'] },
  });
  assert.equal(status, 200);
  assert.deepEqual(data.competitor_domains, ['https://rival.com', 'https://other-rival.com']);
});

test('PATCH /api/aeo/queries/:id/competitors: 404s for a query owned by another user', async () => {
  const emailA = uniqueEmail('aeo-patch-a');
  const tokenA = await registerAndLogin(emailA);
  await setPlan(emailA, 'pro');
  const created = await jsonReq('POST', '/api/aeo/queries', {
    token: tokenA,
    body: { domain: 'https://patch-owner-site.com', query: 'best coffee lisbon' },
  });

  const emailB = uniqueEmail('aeo-patch-b');
  const tokenB = await registerAndLogin(emailB);
  await setPlan(emailB, 'pro');

  const { status } = await jsonReq('PATCH', `/api/aeo/queries/${created.data.id}/competitors`, {
    token: tokenB,
    body: { competitorDomains: ['https://rival.com'] },
  });
  assert.equal(status, 404);
});

test('GET /api/aeo/queries: lists only the requesting user\'s queries for that domain', async () => {
  const emailA = uniqueEmail('aeo-list-a');
  const tokenA = await registerAndLogin(emailA);
  await setPlan(emailA, 'pro');
  const emailB = uniqueEmail('aeo-list-b');
  const tokenB = await registerAndLogin(emailB);
  await setPlan(emailB, 'pro');

  await jsonReq('POST', '/api/aeo/queries', { token: tokenA, body: { domain: 'https://list-site.com', query: 'query A' } });
  await jsonReq('POST', '/api/aeo/queries', { token: tokenB, body: { domain: 'https://list-site.com', query: 'query B' } });

  const { data } = await jsonReq('GET', '/api/aeo/queries?domain=https://list-site.com', { token: tokenA });
  assert.equal(data.length, 1);
  assert.equal(data[0].query, 'query A');
});

test('DELETE /api/aeo/queries/:id: removes a query owned by the requesting user', async () => {
  const email = uniqueEmail('aeo-del');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');

  const { data: created } = await jsonReq('POST', '/api/aeo/queries', {
    token,
    body: { domain: 'https://del-site.com', query: 'delete me' },
  });

  const { status } = await jsonReq('DELETE', `/api/aeo/queries/${created.id}`, { token });
  assert.equal(status, 200);

  const { data: listed } = await jsonReq('GET', '/api/aeo/queries?domain=https://del-site.com', { token });
  assert.equal(listed.length, 0);
});

test('DELETE /api/aeo/queries/:id: 404s for a query owned by another user', async () => {
  const emailA = uniqueEmail('aeo-del-a');
  const tokenA = await registerAndLogin(emailA);
  await setPlan(emailA, 'pro');
  const emailB = uniqueEmail('aeo-del-b');
  const tokenB = await registerAndLogin(emailB);
  await setPlan(emailB, 'pro');

  const { data: created } = await jsonReq('POST', '/api/aeo/queries', {
    token: tokenA,
    body: { domain: 'https://cross-user.com', query: 'not yours' },
  });

  const { status } = await jsonReq('DELETE', `/api/aeo/queries/${created.id}`, { token: tokenB });
  assert.equal(status, 404);
});

test('GET /api/aeo/score: null score with no checks yet, and reflects citation results once checked', async () => {
  const email = uniqueEmail('aeo-score');
  const token = await registerAndLogin(email);
  await setPlan(email, 'pro');
  const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;

  await jsonReq('POST', '/api/aeo/queries', { token, body: { domain: 'https://score-site.com', query: 'cited query' } });
  await jsonReq('POST', '/api/aeo/queries', { token, body: { domain: 'https://score-site.com', query: 'uncited query' } });

  const { data: before } = await jsonReq('GET', '/api/aeo/score?domain=https://score-site.com', { token });
  assert.equal(before.score, null);
  assert.equal(before.queries.length, 2);

  await pool.query(
    `INSERT INTO aeo_queries (user_id, domain, query, provider, cited) VALUES
     ($1, 'https://score-site.com', 'cited query', 'chatgpt', true),
     ($1, 'https://score-site.com', 'cited query', 'perplexity', false),
     ($1, 'https://score-site.com', 'uncited query', 'chatgpt', false),
     ($1, 'https://score-site.com', 'uncited query', 'perplexity', false)`,
    [userId]
  );

  const { data: after } = await jsonReq('GET', '/api/aeo/score?domain=https://score-site.com', { token });
  assert.equal(after.score, 50); // 1 of 2 queries cited by at least one provider
  const citedEntry = after.queries.find((q) => q.query === 'cited query');
  assert.equal(citedEntry.citedByAny, true);
  assert.equal(citedEntry.results.length, 2);
  const uncitedEntry = after.queries.find((q) => q.query === 'uncited query');
  assert.equal(uncitedEntry.citedByAny, false);
});

// Integration tests for the AEO recurring-check job logic (jobs/aeoTracking.js).
// Requires the same Postgres infra as test/api.test.js. services/aeoTracking's
// checkQuery is mocked via node:test's t.mock.method — see
// test/auditWorker.test.js for the same pattern — so no real OpenAI/
// Perplexity credentials or network calls are involved.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { runDueAeoChecks } = require('../jobs/aeoTracking');
const aeoTracking = require('../services/aeoTracking');

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUser(plan = 'pro') {
  const passwordHash = await bcrypt.hash('password123', 10);
  const result = await pool.query('INSERT INTO users (email, password_hash, plan) VALUES ($1, $2, $3) RETURNING id', [
    uniqueEmail('aeo'),
    passwordHash,
    plan,
  ]);
  return result.rows[0].id;
}

async function addTargetQuery(userId, domain, query, { lastCheckedAt = null } = {}) {
  const result = await pool.query(
    `INSERT INTO aeo_target_queries (user_id, domain, query, last_checked_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, domain, query, lastCheckedAt]
  );
  return result.rows[0].id;
}

test.before(async () => {
  await pool.query('TRUNCATE aeo_queries, aeo_target_queries, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE');
});

test.after(async () => {
  await pool.end();
});

test('a query overdue for its check interval gets checked and logged for each provider', async (t) => {
  t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => ({
    provider,
    cited: provider === 'chatgpt',
    responseSnippet: `fake ${provider} response`,
  }));

  const userId = await createUser('pro');
  const queryId = await addTargetQuery(userId, 'https://overdue-site.com', 'best coffee lisbon', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueAeoChecks();
  assert.ok(summary.checked >= 1);

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1 ORDER BY provider', [userId]);
  assert.equal(rows.rows.length, 2);
  assert.deepEqual(rows.rows.map((r) => r.provider).sort(), ['chatgpt', 'perplexity']);
  assert.equal(rows.rows.find((r) => r.provider === 'chatgpt').cited, true);
  assert.equal(rows.rows.find((r) => r.provider === 'perplexity').cited, false);

  const queryRow = await pool.query('SELECT last_checked_at FROM aeo_target_queries WHERE id = $1', [queryId]);
  assert.ok(new Date(queryRow.rows[0].last_checked_at) > new Date(Date.now() - 60000));
});

test('a query not yet due is left alone', async (t) => {
  const mock = t.mock.method(aeoTracking, 'checkQuery', async () => ({ provider: 'chatgpt', cited: true, responseSnippet: 'x' }));

  const userId = await createUser('pro');
  await addTargetQuery(userId, 'https://not-due-site.com', 'some query', { lastCheckedAt: new Date() });

  await runDueAeoChecks();

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 0);
  assert.equal(mock.mock.calls.length, 0);
});

test('a user whose plan has no AEO quota is skipped, not crashed, and never calls the providers', async (t) => {
  const mock = t.mock.method(aeoTracking, 'checkQuery', async () => ({ provider: 'chatgpt', cited: true, responseSnippet: 'x' }));

  const userId = await createUser('starter');
  const queryId = await addTargetQuery(userId, 'https://starter-site.com', 'some query', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueAeoChecks();
  assert.ok(summary.skipped >= 1);
  assert.equal(mock.mock.calls.length, 0);

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 0);

  // Still stamped, so we don't re-check this domain every single daily run.
  const queryRow = await pool.query('SELECT last_checked_at FROM aeo_target_queries WHERE id = $1', [queryId]);
  assert.ok(queryRow.rows[0].last_checked_at);
});

test('a user who already used their monthly AEO quota is skipped', async (t) => {
  t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => ({
    provider,
    cited: false,
    responseSnippet: 'x',
  }));

  const userId = await createUser('pro'); // aeoQueriesPerMonth: 20
  const overQuotaQueries = [];
  for (let i = 0; i < 20; i++) {
    overQuotaQueries.push(
      pool.query(
        `INSERT INTO aeo_queries (user_id, domain, query, provider, cited, checked_at)
         VALUES ($1, 'https://quota-site.com', $2, 'chatgpt', false, now() - ($3 || ' hours')::interval)`,
        [userId, `already-checked-query-${i}`, i]
      )
    );
  }
  await Promise.all(overQuotaQueries);

  const queryId = await addTargetQuery(userId, 'https://quota-site.com', 'the 21st query', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueAeoChecks();
  assert.ok(summary.skipped >= 1);

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1 AND query = $2', [userId, 'the 21st query']);
  assert.equal(rows.rows.length, 0);

  const queryRow = await pool.query('SELECT last_checked_at FROM aeo_target_queries WHERE id = $1', [queryId]);
  assert.ok(queryRow.rows[0].last_checked_at);
});

test('a provider failure never blocks the other provider from being logged', async (t) => {
  t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => {
    if (provider === 'perplexity') throw new Error('rate limited');
    return { provider, cited: true, responseSnippet: 'x' };
  });

  const userId = await createUser('pro');
  await addTargetQuery(userId, 'https://partial-failure-site.com', 'resilience query', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueAeoChecks();
  assert.ok(summary.checked >= 1);

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].provider, 'chatgpt');
});

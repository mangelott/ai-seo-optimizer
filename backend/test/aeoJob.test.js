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
const email = require('../services/email');

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUser(plan = 'pro') {
  const passwordHash = await bcrypt.hash('password123', 10);
  const userEmail = uniqueEmail('aeo');
  const result = await pool.query('INSERT INTO users (email, password_hash, plan) VALUES ($1, $2, $3) RETURNING id', [
    userEmail,
    passwordHash,
    plan,
  ]);
  return { id: result.rows[0].id, email: userEmail };
}

async function addTargetQuery(userId, domain, query, { lastCheckedAt = null, competitorDomains = [] } = {}) {
  const result = await pool.query(
    `INSERT INTO aeo_target_queries (user_id, domain, query, last_checked_at, competitor_domains)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, domain, query, lastCheckedAt, competitorDomains]
  );
  return result.rows[0].id;
}

test.before(async () => {
  await pool.query(
    'TRUNCATE aeo_competitor_citations, aeo_queries, aeo_target_queries, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE'
  );
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

  const { id: userId } = await createUser('pro');
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

  const { id: userId } = await createUser('pro');
  await addTargetQuery(userId, 'https://not-due-site.com', 'some query', { lastCheckedAt: new Date() });

  await runDueAeoChecks();

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 0);
  assert.equal(mock.mock.calls.length, 0);
});

test('a user whose plan has no AEO quota is skipped, not crashed, and never calls the providers', async (t) => {
  const mock = t.mock.method(aeoTracking, 'checkQuery', async () => ({ provider: 'chatgpt', cited: true, responseSnippet: 'x' }));

  const { id: userId } = await createUser('starter');
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

  const { id: userId } = await createUser('pro'); // aeoQueriesPerMonth: 20
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

  const { id: userId } = await createUser('pro');
  await addTargetQuery(userId, 'https://partial-failure-site.com', 'resilience query', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueAeoChecks();
  assert.ok(summary.checked >= 1);

  const rows = await pool.query('SELECT * FROM aeo_queries WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].provider, 'chatgpt');
});

// Forces a target query to be picked up by runDueAeoChecks again, simulating
// the next scheduled pass without waiting out CHECK_INTERVAL_DAYS.
async function makeOverdue(queryId) {
  await pool.query('UPDATE aeo_target_queries SET last_checked_at = $1 WHERE id = $2', [
    new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    queryId,
  ]);
}

test('competitor citation alert: a competitor cited on the very first check establishes a baseline, no email yet', async (t) => {
  t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => ({
    provider,
    cited: false,
    responseSnippet: 'x',
    competitorCitations: { 'https://competitor.com': true },
  }));
  const alertMock = t.mock.method(email, 'sendCompetitorCitationAlertEmail', async () => {});

  const { id: userId } = await createUser('pro');
  await addTargetQuery(userId, 'https://baseline-site.com', 'best coffee lisbon', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    competitorDomains: ['https://competitor.com'],
  });

  await runDueAeoChecks();

  assert.equal(alertMock.mock.calls.length, 0);
  const rows = await pool.query('SELECT * FROM aeo_competitor_citations WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 2); // one per provider
  assert.ok(rows.rows.every((r) => r.cited === true));
});

test('competitor citation alert: fires once when a competitor newly becomes cited while the user is not', async (t) => {
  const mock = t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => ({
    provider,
    cited: false,
    responseSnippet: 'x',
    competitorCitations: { 'https://competitor.com': false },
  }));
  const alertMock = t.mock.method(email, 'sendCompetitorCitationAlertEmail', async () => {});

  const { id: userId, email: userEmail } = await createUser('pro');
  const queryId = await addTargetQuery(userId, 'https://transition-site.com', 'best coffee lisbon', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    competitorDomains: ['https://competitor.com'],
  });

  await runDueAeoChecks(); // establishes the not-cited baseline
  assert.equal(alertMock.mock.calls.length, 0);

  mock.mock.mockImplementation(async (query, domain, provider) => ({
    provider,
    cited: false,
    responseSnippet: 'x',
    competitorCitations: { 'https://competitor.com': true },
  }));
  await makeOverdue(queryId);

  await runDueAeoChecks();

  assert.equal(alertMock.mock.calls.length, 1);
  const [to, payload] = alertMock.mock.calls[0].arguments;
  assert.equal(to, userEmail);
  assert.equal(payload.domain, 'https://transition-site.com');
  assert.equal(payload.query, 'best coffee lisbon');
  assert.deepEqual(
    payload.competitors.map((c) => c.competitorDomain).sort(),
    ['https://competitor.com', 'https://competitor.com']
  );
  assert.deepEqual(payload.competitors.map((c) => c.provider).sort(), ['chatgpt', 'perplexity']);

  const rows = await pool.query(
    `SELECT cited FROM aeo_competitor_citations WHERE user_id = $1 ORDER BY checked_at DESC LIMIT 2`,
    [userId]
  );
  assert.ok(rows.rows.every((r) => r.cited === true));
});

test('competitor citation alert: no alert when the user is also cited alongside the competitor', async (t) => {
  const mock = t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => ({
    provider,
    cited: false,
    responseSnippet: 'x',
    competitorCitations: { 'https://competitor.com': false },
  }));
  const alertMock = t.mock.method(email, 'sendCompetitorCitationAlertEmail', async () => {});

  const { id: userId } = await createUser('pro');
  const queryId = await addTargetQuery(userId, 'https://both-cited-site.com', 'best coffee lisbon', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    competitorDomains: ['https://competitor.com'],
  });

  await runDueAeoChecks();

  mock.mock.mockImplementation(async (query, domain, provider) => ({
    provider,
    cited: true,
    responseSnippet: 'x',
    competitorCitations: { 'https://competitor.com': true },
  }));
  await makeOverdue(queryId);

  await runDueAeoChecks();

  assert.equal(alertMock.mock.calls.length, 0);
});

test('competitor citation alert: an already-cited competitor does not re-alert on the next check', async (t) => {
  t.mock.method(aeoTracking, 'checkQuery', async (query, domain, provider) => ({
    provider,
    cited: false,
    responseSnippet: 'x',
    competitorCitations: { 'https://competitor.com': true },
  }));
  const alertMock = t.mock.method(email, 'sendCompetitorCitationAlertEmail', async () => {});

  const { id: userId } = await createUser('pro');
  const queryId = await addTargetQuery(userId, 'https://already-cited-site.com', 'best coffee lisbon', {
    lastCheckedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    competitorDomains: ['https://competitor.com'],
  });

  await runDueAeoChecks(); // baseline: already cited, no prior row to compare -> no alert
  assert.equal(alertMock.mock.calls.length, 0);

  await makeOverdue(queryId);
  await runDueAeoChecks(); // still cited -> no new alert, it's not a transition

  assert.equal(alertMock.mock.calls.length, 0);
});

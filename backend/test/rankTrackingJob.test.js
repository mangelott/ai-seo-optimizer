// Integration tests for the rank-tracking recurring-check job logic
// (jobs/rankTracking.js). Requires the same Postgres infra as test/api.test.js.
// services/rankTracking's checkPosition is mocked via node:test's
// t.mock.method — see test/auditWorker.test.js / test/aeoJob.test.js for the
// same pattern — so no real DataForSEO credentials or network calls are involved.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { runDueRankChecks } = require('../jobs/rankTracking');
const rankTracking = require('../services/rankTracking');

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUser(plan = 'pro') {
  const passwordHash = await bcrypt.hash('password123', 10);
  const userEmail = uniqueEmail('rank');
  const result = await pool.query('INSERT INTO users (email, password_hash, plan) VALUES ($1, $2, $3) RETURNING id', [
    userEmail,
    passwordHash,
    plan,
  ]);
  return { id: result.rows[0].id, email: userEmail };
}

async function addTrackedKeyword(userId, domain, keyword, { lastCheckedAt = null } = {}) {
  const result = await pool.query(
    `INSERT INTO tracked_keywords (user_id, domain, keyword, last_checked_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, domain, keyword, lastCheckedAt]
  );
  return result.rows[0].id;
}

async function makeOverdue(keywordId) {
  await pool.query('UPDATE tracked_keywords SET last_checked_at = $1 WHERE id = $2', [
    new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    keywordId,
  ]);
}

test.before(async () => {
  await pool.query('TRUNCATE rank_tracking, tracked_keywords, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE');
});

test.after(async () => {
  await pool.end();
});

test('a keyword overdue for its check interval gets checked and logged', async (t) => {
  t.mock.method(rankTracking, 'checkPosition', async () => ({ position: 4 }));

  const { id: userId } = await createUser('pro');
  const keywordId = await addTrackedKeyword(userId, 'https://overdue-site.com', 'best coffee lisbon', {
    lastCheckedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueRankChecks();
  assert.ok(summary.checked >= 1);

  const rows = await pool.query('SELECT * FROM rank_tracking WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].position, 4);

  const keywordRow = await pool.query('SELECT last_checked_at FROM tracked_keywords WHERE id = $1', [keywordId]);
  assert.ok(new Date(keywordRow.rows[0].last_checked_at) > new Date(Date.now() - 60000));
});

test('a keyword not yet due is left alone', async (t) => {
  const mock = t.mock.method(rankTracking, 'checkPosition', async () => ({ position: 1 }));

  const { id: userId } = await createUser('pro');
  await addTrackedKeyword(userId, 'https://not-due-site.com', 'some keyword', { lastCheckedAt: new Date() });

  await runDueRankChecks();

  const rows = await pool.query('SELECT * FROM rank_tracking WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 0);
  assert.equal(mock.mock.calls.length, 0);
});

test('a user whose plan has no rank-tracking quota is skipped, not crashed, and never calls the SERP check', async (t) => {
  const mock = t.mock.method(rankTracking, 'checkPosition', async () => ({ position: 1 }));

  const { id: userId } = await createUser('starter');
  const keywordId = await addTrackedKeyword(userId, 'https://starter-site.com', 'some keyword', {
    lastCheckedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueRankChecks();
  assert.ok(summary.skipped >= 1);
  assert.equal(mock.mock.calls.length, 0);

  const rows = await pool.query('SELECT * FROM rank_tracking WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 0);

  // Still stamped, so we don't re-check this domain every single hourly tick.
  const keywordRow = await pool.query('SELECT last_checked_at FROM tracked_keywords WHERE id = $1', [keywordId]);
  assert.ok(keywordRow.rows[0].last_checked_at);
});

test('a user who already used their monthly rank-tracking quota is skipped', async (t) => {
  const mock = t.mock.method(rankTracking, 'checkPosition', async () => ({ position: 1 }));

  const { id: userId } = await createUser('pro'); // rankTrackingChecksPerMonth: 40
  const overQuotaChecks = [];
  for (let i = 0; i < 40; i++) {
    overQuotaChecks.push(
      pool.query(
        `INSERT INTO rank_tracking (user_id, domain, keyword, position, checked_at)
         VALUES ($1, 'https://quota-site.com', $2, 5, now() - ($3 || ' hours')::interval)`,
        [userId, `already-checked-keyword-${i}`, i]
      )
    );
  }
  await Promise.all(overQuotaChecks);

  const keywordId = await addTrackedKeyword(userId, 'https://quota-site.com', 'the 41st keyword', {
    lastCheckedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueRankChecks();
  assert.ok(summary.skipped >= 1);
  assert.equal(mock.mock.calls.length, 0);

  const rows = await pool.query('SELECT * FROM rank_tracking WHERE user_id = $1 AND keyword = $2', [userId, 'the 41st keyword']);
  assert.equal(rows.rows.length, 0);

  const keywordRow = await pool.query('SELECT last_checked_at FROM tracked_keywords WHERE id = $1', [keywordId]);
  assert.ok(keywordRow.rows[0].last_checked_at);
});

test('a SERP failure for one keyword is skipped, not crashed', async (t) => {
  t.mock.method(rankTracking, 'checkPosition', async () => {
    throw new Error('DataForSEO rate limited');
  });

  const { id: userId } = await createUser('pro');
  await addTrackedKeyword(userId, 'https://failure-site.com', 'flaky keyword', {
    lastCheckedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueRankChecks();
  assert.ok(summary.skipped >= 1);

  const rows = await pool.query('SELECT * FROM rank_tracking WHERE user_id = $1', [userId]);
  assert.equal(rows.rows.length, 0);
});

test('running the job twice with different mocked positions records two rows with distinct checked_at', async (t) => {
  const mock = t.mock.method(rankTracking, 'checkPosition', async () => ({ position: 8 }));

  const { id: userId } = await createUser('pro');
  const keywordId = await addTrackedKeyword(userId, 'https://twice-site.com', 'rank over time keyword', {
    lastCheckedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  await runDueRankChecks();

  mock.mock.mockImplementation(async () => ({ position: 3 }));
  await makeOverdue(keywordId);

  await runDueRankChecks();

  const rows = await pool.query(
    'SELECT position, checked_at FROM rank_tracking WHERE user_id = $1 ORDER BY checked_at ASC',
    [userId]
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].position, 8);
  assert.equal(rows.rows[1].position, 3);
  assert.notEqual(rows.rows[0].checked_at.getTime(), rows.rows[1].checked_at.getTime());
});

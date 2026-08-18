// Integration tests for the recurring-audits cron job logic.
// Requires the same Postgres/Redis infra as test/api.test.js.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { connection: redisConnection, auditQueue } = require('../jobs/queue');
const { runDueRecurringAudits } = require('../jobs/recurringAudits');

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUser(plan = 'starter') {
  const passwordHash = await bcrypt.hash('password123', 10);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, plan) VALUES ($1, $2, $3) RETURNING id',
    [uniqueEmail('recurring'), passwordHash, plan]
  );
  return result.rows[0].id;
}

async function addMonitoredDomain(userId, domain, overrides = {}) {
  const {
    recurringEnabled = true,
    intervalDays = 7,
    delivery = 'in_app',
    lastRunAt = null,
  } = overrides;

  const result = await pool.query(
    `INSERT INTO monitored_domains (user_id, domain, recurring_enabled, recurring_interval_days, recurring_delivery, last_recurring_run_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, domain, recurringEnabled, intervalDays, delivery, lastRunAt]
  );
  return result.rows[0].id;
}

test.before(async () => {
  await pool.query('TRUNCATE quick_scans, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE');
});

test.after(async () => {
  await pool.end();
  // The audits enqueued above (via runDueRecurringAudits -> createAudit) are
  // never consumed by a worker during `npm test`, so they'd otherwise pile
  // up in Redis and get drained with real API keys the next time the
  // worker (merged into server.js) actually starts.
  await auditQueue.obliterate({ force: true });
  redisConnection.disconnect();
});

test('a domain overdue for its recurring interval gets a new audit', async () => {
  const userId = await createUser('starter');
  const domainId = await addMonitoredDomain(userId, 'https://overdue-site.com', {
    intervalDays: 7,
    lastRunAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
  });

  const summary = await runDueRecurringAudits();
  assert.ok(summary.started >= 1);

  const audits = await pool.query('SELECT * FROM audits WHERE user_id = $1 AND domain = $2', [userId, 'https://overdue-site.com']);
  assert.equal(audits.rows.length, 1);

  const domainRow = await pool.query('SELECT last_recurring_run_at FROM monitored_domains WHERE id = $1', [domainId]);
  assert.ok(new Date(domainRow.rows[0].last_recurring_run_at) > new Date(Date.now() - 60000), 'last_recurring_run_at should be stamped to now');
});

test('a domain not yet due is left alone', async () => {
  const userId = await createUser('starter');
  await addMonitoredDomain(userId, 'https://not-due-site.com', {
    intervalDays: 7,
    lastRunAt: new Date(), // just ran
  });

  await runDueRecurringAudits();

  const audits = await pool.query('SELECT * FROM audits WHERE user_id = $1 AND domain = $2', [userId, 'https://not-due-site.com']);
  assert.equal(audits.rows.length, 0);
});

test('recurring_enabled = false is never picked up regardless of last run', async () => {
  const userId = await createUser('starter');
  await addMonitoredDomain(userId, 'https://disabled-site.com', {
    recurringEnabled: false,
    intervalDays: 1,
    lastRunAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });

  await runDueRecurringAudits();

  const audits = await pool.query('SELECT * FROM audits WHERE user_id = $1 AND domain = $2', [userId, 'https://disabled-site.com']);
  assert.equal(audits.rows.length, 0);
});

test('a free-plan user who already used their lifetime audit is skipped, not crashed', async () => {
  const userId = await createUser('free');
  await pool.query('UPDATE users SET lifetime_free_audits_used = 1 WHERE id = $1', [userId]);
  const domainId = await addMonitoredDomain(userId, 'https://maxed-out-free.com', {
    intervalDays: 1,
    lastRunAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const summary = await runDueRecurringAudits();
  assert.ok(summary.skipped >= 1);

  const audits = await pool.query('SELECT * FROM audits WHERE user_id = $1 AND domain = $2', [userId, 'https://maxed-out-free.com']);
  assert.equal(audits.rows.length, 0, 'no audit should be created once the plan limit is hit');

  // Still stamped, so we don't re-check (and re-log) this domain every single hourly tick.
  const domainRow = await pool.query('SELECT last_recurring_run_at FROM monitored_domains WHERE id = $1', [domainId]);
  assert.ok(domainRow.rows[0].last_recurring_run_at, 'last_recurring_run_at should still be stamped on skip');
});

test('a domain with recurring_interval_days = NULL is never picked up even if enabled', async () => {
  const userId = await createUser('starter');
  await pool.query(
    `INSERT INTO monitored_domains (user_id, domain, recurring_enabled, recurring_interval_days)
     VALUES ($1, $2, true, NULL)`,
    [userId, 'https://no-interval-site.com']
  );

  await runDueRecurringAudits();

  const audits = await pool.query('SELECT * FROM audits WHERE user_id = $1 AND domain = $2', [userId, 'https://no-interval-site.com']);
  assert.equal(audits.rows.length, 0);
});

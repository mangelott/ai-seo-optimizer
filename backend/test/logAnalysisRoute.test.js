// Integration tests for POST /api/log-analysis/upload and GET /api/log-analysis:
// plan gating (Agency only), the multipart/form-data file upload, and the
// comparison against a domain's crawled_pages. No external API is called —
// log parsing is pure local logic (services/logAnalysis.js, covered on its
// own in test/logAnalysis.test.js) and the only other work here is Postgres reads/writes.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection, auditQueue } = require('../jobs/queue');

let server;
let baseUrl;

const SAMPLE_LOG = [
  '66.249.66.1 - - [10/Aug/2026:13:55:36 +0000] "GET / HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '66.249.66.1 - - [10/Aug/2026:13:56:02 +0000] "GET /old-page HTTP/1.1" 404 512 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
].join('\n');

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

// Builds a real multipart/form-data request, the same shape a browser
// <input type="file"> submission would produce — same fields the route's
// TODO(frontend) comment tells the future UI to send. `text` omitted (vs.
// `''`) skips attaching the file field entirely, to test the "missing file" case.
async function uploadLog(path, { token, domain, text }) {
  const form = new FormData();
  if (domain !== undefined) form.append('domain', domain);
  if (text !== undefined) form.append('logFile', new Blob([text], { type: 'text/plain' }), 'access.log');

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
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

async function createCompletedAuditWithCrawledPages(email, domain, urls) {
  const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;
  const auditResult = await pool.query(
    `INSERT INTO audits (user_id, domain, status) VALUES ($1, $2, 'completed') RETURNING id`,
    [userId, domain]
  );
  const auditId = auditResult.rows[0].id;
  for (const url of urls) {
    await pool.query('INSERT INTO crawled_pages (audit_id, url, status_code) VALUES ($1, $2, 200)', [auditId, url]);
  }
  return auditId;
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, server_log_uploads, users RESTART IDENTITY CASCADE'
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

test('POST /api/log-analysis/upload requires the Agency plan', async () => {
  const email = uniqueEmail('log-free');
  const token = await registerAndLogin(email);

  const { status, data } = await uploadLog('/api/log-analysis/upload', { token, domain: 'free-site.com', text: SAMPLE_LOG });
  assert.equal(status, 402);
  assert.match(data.error, /Agency/);
});

test('POST /api/log-analysis/upload requires a domain field', async () => {
  const email = uniqueEmail('log-nodomain');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  const { status, data } = await uploadLog('/api/log-analysis/upload', { token, text: SAMPLE_LOG });
  assert.equal(status, 400);
  assert.match(data.error, /domain/);
});

test('POST /api/log-analysis/upload requires a logFile field', async () => {
  const email = uniqueEmail('log-nofile');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  const { status, data } = await uploadLog('/api/log-analysis/upload', { token, domain: 'no-file-site.com' });
  assert.equal(status, 400);
  assert.match(data.error, /logFile/);
});

test('POST /api/log-analysis/upload rejects an empty logFile', async () => {
  const email = uniqueEmail('log-empty');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  const { status, data } = await uploadLog('/api/log-analysis/upload', { token, domain: 'empty-site.com', text: '   ' });
  assert.equal(status, 400);
  assert.match(data.error, /empty/);
});

test('POST /api/log-analysis/upload parses bot hits and stores a null comparison when there is no completed audit yet', async () => {
  const email = uniqueEmail('log-noaudit');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  const { status, data } = await uploadLog('/api/log-analysis/upload', { token, domain: 'no-audit-site.com', text: SAMPLE_LOG });
  assert.equal(status, 201);
  assert.equal(data.audit_id, null);
  assert.equal(data.comparison_result, null);
  assert.equal(data.bot_hits.Googlebot.totalRequests, 2);
  assert.equal(data.lines_parsed, 2);
  assert.equal(data.lines_skipped, 0);
});

test('POST /api/log-analysis/upload compares bot hits against crawled_pages when a completed audit exists for the domain', async (t) => {
  const email = uniqueEmail('log-withaudit');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  const auditId = await createCompletedAuditWithCrawledPages(email, 'https://with-audit-site.com', [
    'https://with-audit-site.com/',
    'https://with-audit-site.com/contact', // crawled but never hit by Googlebot in SAMPLE_LOG
  ]);

  const { status, data } = await uploadLog('/api/log-analysis/upload', {
    token,
    domain: 'https://with-audit-site.com',
    text: SAMPLE_LOG,
  });
  assert.equal(status, 201);
  assert.equal(data.audit_id, auditId);
  assert.deepEqual(data.comparison_result.Googlebot.crawledButNeverVisited, ['/contact']);
  assert.deepEqual(data.comparison_result.Googlebot.visitedButNotCrawled, ['/old-page']);
});

test('GET /api/log-analysis lists uploads for the authenticated user, optionally filtered by domain', async () => {
  const email = uniqueEmail('log-list');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  await uploadLog('/api/log-analysis/upload', { token, domain: 'site-a.com', text: SAMPLE_LOG });
  await uploadLog('/api/log-analysis/upload', { token, domain: 'site-b.com', text: SAMPLE_LOG });

  const all = await json('GET', '/api/log-analysis', { token });
  assert.equal(all.status, 200);
  assert.equal(all.data.length, 2);

  const filtered = await json('GET', '/api/log-analysis?domain=site-a.com', { token });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].domain, 'site-a.com');
});

test('GET /api/log-analysis requires authentication', async () => {
  const { status } = await json('GET', '/api/log-analysis');
  assert.equal(status, 401);
});

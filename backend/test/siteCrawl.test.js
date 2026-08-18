// Integration tests for the Pro/Agency site-wide crawl path: DataForSEO's
// async on_page/task_post -> on_page/tasks_ready -> on_page/pages flow. Runs
// a fake DataForSEO server (in the pattern of test/wordpress.test.js and
// test/github.test.js) so the real request-building code in
// services/siteCrawl.js is exercised, not just stubbed. Free/Starter must
// keep using the old synchronous instant_pages path — that call is mocked
// the same way test/auditWorker.test.js mocks it, since only the crawl
// endpoints are faked here.
//
// DATAFORSEO_API_BASE_URL and the poll-timing overrides must be set before
// services/dataforseo.js (or anything requiring it, incl. auditProcessor) is
// first loaded, so everything is required inside test.before.
require('dotenv').config();
process.env.SITE_CRAWL_POLL_INITIAL_MS = '20';
process.env.SITE_CRAWL_POLL_MAX_MS = '50';
process.env.SITE_CRAWL_POLL_TIMEOUT_MS = '350';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');

let fakeDataForSeoServer;
let pool;
let dataforseo;
let contentAnalysis;
let claude;
let email;
let googleSearchConsole;
let processAuditJob;

// Home and About share the title "Home" (duplicate), /missing is a 404,
// /error is a 500, and /missing has no load_timing so it's excluded from the
// average — this fixture is shared by every "ready immediately" test.
const CRAWL_PAGES = [
  {
    url: 'https://crawl-site.com/',
    status_code: 200,
    meta: { title: 'Home', description: 'Homepage', htags: { h1: ['Welcome'] } },
    plain_text_word_count: 500,
    meta_canonical: 'https://crawl-site.com/',
    is_indexable: true,
    page_timing: { time_to_interactive: 900 },
  },
  {
    url: 'https://crawl-site.com/about',
    status_code: 200,
    meta: { title: 'Home', description: '', htags: { h1: [] } },
    plain_text_word_count: 120,
    meta_canonical: 'https://crawl-site.com/about',
    is_indexable: true,
    page_timing: { time_to_interactive: 1400 },
  },
  {
    url: 'https://crawl-site.com/missing',
    status_code: 404,
    meta: { title: null, description: null, htags: {} },
    plain_text_word_count: 0,
    meta_canonical: null,
    is_indexable: false,
    page_timing: {},
  },
  {
    url: 'https://crawl-site.com/error',
    status_code: 500,
    meta: { title: 'Error', description: null, htags: {} },
    plain_text_word_count: 10,
    meta_canonical: null,
    is_indexable: false,
    page_timing: { time_to_interactive: 3000 },
  },
];

// Readiness behaviour is derived from the target domain so each test can
// pick its own scenario without shared mutable state between tests:
// "timeout" never becomes ready, "slow" takes 3 polls, everything else is
// ready on the first poll.
function buildFakeDataForSeoServer() {
  const api = express();
  api.use(express.json());
  const tasks = new Map();
  let nextId = 1;

  api.post('/on_page/task_post', (req, res) => {
    const { target, max_crawl_pages } = req.body[0];
    const id = `crawl-task-${nextId++}`;
    const readyAfter = target.includes('timeout') ? Infinity : target.includes('slow') ? 3 : 1;
    tasks.set(id, { target, maxCrawlPages: max_crawl_pages, pollCount: 0, readyAfter });
    res.json({ tasks: [{ id, status_code: 20100 }] });
  });

  api.get('/on_page/tasks_ready', (req, res) => {
    const ready = [];
    for (const [id, t] of tasks) {
      t.pollCount += 1;
      if (t.pollCount >= t.readyAfter) ready.push({ id });
    }
    res.json({ tasks: [{ result: ready }] });
  });

  api.post('/on_page/pages', (req, res) => {
    const { id, limit, offset } = req.body[0];
    if (!tasks.has(id)) return res.json({ tasks: [{ result: [{ items: [], total_items_count: 0 }] }] });
    const items = CRAWL_PAGES.slice(offset, offset + limit);
    res.json({ tasks: [{ result: [{ items, total_items_count: CRAWL_PAGES.length }] }] });
  });

  return api;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUser(email_) {
  const hash = await bcrypt.hash('password123', 10);
  const result = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [
    email_,
    hash,
  ]);
  return result.rows[0].id;
}

async function createAuditRow(userId, domain) {
  const result = await pool.query(
    `INSERT INTO audits (user_id, domain, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [userId, domain]
  );
  return result.rows[0].id;
}

function stubNonTechnicalServices(t) {
  t.mock.method(contentAnalysis, 'analyzeContent', async () => ({ title: 'Some Title', imagesMissingAlt: 0 }));
  t.mock.method(claude, 'generateRecommendations', async () => []);
  t.mock.method(email, 'sendAuditReadyEmail', async () => {});
  t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});
  t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'fake-access-token');
  t.mock.method(googleSearchConsole, 'querySearchAnalytics', async () => ({}));
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeDataForSeoServer = buildFakeDataForSeoServer().listen(0, resolve);
  });
  process.env.DATAFORSEO_API_BASE_URL = `http://localhost:${fakeDataForSeoServer.address().port}`;

  pool = require('../db/pool');
  contentAnalysis = require('../services/contentAnalysis');
  dataforseo = require('../services/dataforseo');
  claude = require('../services/claude');
  email = require('../services/email');
  googleSearchConsole = require('../services/googleSearchConsole');
  ({ processAuditJob } = require('../services/auditProcessor'));

  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE'
  );
});

test.after(async () => {
  await pool.end();
  await new Promise((resolve) => fakeDataForSeoServer.close(resolve));
});

test('pro plan: technical audit goes through the site-wide crawl, not instant_pages', async (t) => {
  stubNonTechnicalServices(t);
  const technicalMock = t.mock.method(dataforseo, 'getOnPageAudit', async () => ({ statusCode: 200 }));

  const userId = await createUser(uniqueEmail('crawl-pro'));
  const auditId = await createAuditRow(userId, 'https://crawl-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://crawl-site.com', categories: ['technical'], planKey: 'pro' },
  });

  assert.equal(technicalMock.mock.callCount(), 0, 'instant_pages must not be called on a plan with siteWideCrawl');

  const auditRow = await pool.query(
    'SELECT status, crawl_status, pages_crawled_count, technical_result FROM audits WHERE id = $1',
    [auditId]
  );
  assert.equal(auditRow.rows[0].status, 'completed');
  assert.equal(auditRow.rows[0].crawl_status, 'completed');
  assert.equal(auditRow.rows[0].pages_crawled_count, 4);

  const summary = auditRow.rows[0].technical_result;
  assert.equal(summary.crawlType, 'site_wide');
  assert.equal(summary.pagesCrawled, 4);
  assert.equal(summary.pages4xx, 1);
  assert.equal(summary.pages5xx, 1);
  assert.equal(summary.pagesMissingTitle, 1);
  assert.equal(summary.avgLoadTimeMs, 1767); // (900 + 1400 + 3000) / 3, rounded
  assert.deepEqual(summary.duplicateTitles, [{ title: 'Home', count: 2 }]);

  const pagesRows = await pool.query('SELECT url, status_code, title FROM crawled_pages WHERE audit_id = $1 ORDER BY id', [
    auditId,
  ]);
  assert.equal(pagesRows.rows.length, 4);
  assert.equal(pagesRows.rows[0].url, 'https://crawl-site.com/');
  assert.equal(pagesRows.rows[2].status_code, 404);
});

test('free/starter plans: technical audit still uses instant_pages, no crawl rows are written', async (t) => {
  stubNonTechnicalServices(t);
  const technicalMock = t.mock.method(dataforseo, 'getOnPageAudit', async () => ({ statusCode: 200, someField: true }));

  const userId = await createUser(uniqueEmail('crawl-starter'));
  const auditId = await createAuditRow(userId, 'https://old-path-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://old-path-site.com', categories: ['technical'], planKey: 'starter' },
  });

  assert.equal(technicalMock.mock.callCount(), 1);

  const auditRow = await pool.query(
    'SELECT status, crawl_status, pages_crawled_count, technical_result FROM audits WHERE id = $1',
    [auditId]
  );
  assert.equal(auditRow.rows[0].status, 'completed');
  assert.equal(auditRow.rows[0].crawl_status, null);
  assert.equal(auditRow.rows[0].pages_crawled_count, null);
  assert.deepEqual(auditRow.rows[0].technical_result, { statusCode: 200, someField: true });

  const pagesRows = await pool.query('SELECT id FROM crawled_pages WHERE audit_id = $1', [auditId]);
  assert.equal(pagesRows.rows.length, 0);
});

test('a missing planKey defaults to the free plan and keeps the old instant_pages path', async (t) => {
  stubNonTechnicalServices(t);
  const technicalMock = t.mock.method(dataforseo, 'getOnPageAudit', async () => ({ statusCode: 200 }));

  const userId = await createUser(uniqueEmail('crawl-noplan'));
  const auditId = await createAuditRow(userId, 'https://no-plankey-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://no-plankey-site.com', categories: ['technical'] } });

  assert.equal(technicalMock.mock.callCount(), 1);
});

test('agency plan also goes through the site-wide crawl', async (t) => {
  stubNonTechnicalServices(t);
  const technicalMock = t.mock.method(dataforseo, 'getOnPageAudit', async () => ({}));

  const userId = await createUser(uniqueEmail('crawl-agency'));
  const auditId = await createAuditRow(userId, 'https://crawl-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://crawl-site.com', categories: ['technical'], planKey: 'agency' },
  });

  assert.equal(technicalMock.mock.callCount(), 0);
  const auditRow = await pool.query('SELECT crawl_status FROM audits WHERE id = $1', [auditId]);
  assert.equal(auditRow.rows[0].crawl_status, 'completed');
});

test('pro plan: a crawl that is not ready immediately is polled with backoff until it completes', async (t) => {
  stubNonTechnicalServices(t);
  t.mock.method(dataforseo, 'getOnPageAudit', async () => ({}));

  const userId = await createUser(uniqueEmail('crawl-slow'));
  const auditId = await createAuditRow(userId, 'https://crawl-slow-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://crawl-slow-site.com', categories: ['technical'], planKey: 'pro' },
  });

  const auditRow = await pool.query('SELECT crawl_status, technical_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(auditRow.rows[0].crawl_status, 'completed');
  assert.equal(auditRow.rows[0].technical_result.crawlType, 'site_wide');
});

test('pro plan: a crawl that never becomes ready times out, marks crawl_status failed, and the audit still completes', async (t) => {
  stubNonTechnicalServices(t);
  t.mock.method(dataforseo, 'getOnPageAudit', async () => ({}));

  const userId = await createUser(uniqueEmail('crawl-timeout'));
  const auditId = await createAuditRow(userId, 'https://crawl-timeout-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://crawl-timeout-site.com', categories: ['technical'], planKey: 'pro' },
  });

  const auditRow = await pool.query('SELECT status, crawl_status, technical_result FROM audits WHERE id = $1', [
    auditId,
  ]);
  assert.equal(auditRow.rows[0].status, 'completed', 'the overall audit must still complete despite the crawl failing');
  assert.equal(auditRow.rows[0].crawl_status, 'failed');
  assert.equal(auditRow.rows[0].technical_result, null);

  const pagesRows = await pool.query('SELECT id FROM crawled_pages WHERE audit_id = $1', [auditId]);
  assert.equal(pagesRows.rows.length, 0);
});

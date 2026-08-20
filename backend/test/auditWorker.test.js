// Exercises services/auditProcessor.js's processAuditJob directly — deliberately
// NOT via jobs/auditWorker.js, which wraps this same function in a live BullMQ
// Worker and would start consuming real jobs off Redis (including stray ones
// left by other test files) the moment it's required. No BullMQ/Redis queue
// is involved here at all; every external service (DataForSEO, Claude, Resend,
// Google Search Console) is mocked via node:test's t.mock.method. This is the
// only place the score-drop email threshold, the notifyEmail path, and the
// GSC-fetch-into-gsc_result wiring are actually exercised end-to-end.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { processAuditJob, SCORE_DROP_ALERT_THRESHOLD } = require('../services/auditProcessor');
const contentAnalysis = require('../services/contentAnalysis');
const dataforseo = require('../services/dataforseo');
const coreWebVitals = require('../services/coreWebVitals');
const crawlability = require('../services/crawlability');
const trustSignals = require('../services/trustSignals');
const serpAnalysis = require('../services/serpAnalysis');
const contentGap = require('../services/contentGap');
const claude = require('../services/claude');
const email = require('../services/email');
const googleSearchConsole = require('../services/googleSearchConsole');
const googleAnalytics = require('../services/googleAnalytics');

const NO_SERP_FEATURES = {
  featuredSnippet: { present: false, url: null, occupiedByUser: false },
  peopleAlsoAsk: { present: false, questions: [] },
  otherFeatures: [],
};

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUser(email_) {
  const hash = await bcrypt.hash('password123', 10);
  const result = await pool.query('INSERT INTO users (email, password_hash, plan) VALUES ($1, $2, $3) RETURNING id', [
    email_,
    hash,
    'starter',
  ]);
  return result.rows[0].id;
}

async function createAuditRow(userId, domain, { score = null, createdAt = null } = {}) {
  const result = await pool.query(
    `INSERT INTO audits (user_id, domain, status, score, created_at)
     VALUES ($1, $2, 'completed', $3, COALESCE($4, now())) RETURNING id`,
    [userId, domain, score, createdAt]
  );
  return result.rows[0].id;
}

function stubDefaults(t) {
  // Sensible no-op-ish defaults so tests only need to override what they care about.
  t.mock.method(dataforseo, 'getOnPageAudit', async () => ({ statusCode: 200 }));
  t.mock.method(dataforseo, 'getBacklinkSummary', async () => ({ totalBacklinks: 0 }));
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([]));
  t.mock.method(dataforseo, 'getBacklinkGap', async () => ([]));
  t.mock.method(coreWebVitals, 'getCoreWebVitals', async () => ({
    lcp: { value: 1800, rating: 'good' },
    inp: { value: 150, rating: 'good' },
    cls: { value: 0.05, rating: 'good' },
    performanceScore: 93,
  }));
  t.mock.method(crawlability, 'checkCrawlability', async () => ({
    robotsTxt: { exists: true, blocksHomepage: false, sitemapUrls: [], raw: 'User-agent: *\nAllow: /\n' },
    sitemap: { exists: true, wellFormed: true, rootElement: 'urlset', urlCount: 1, brokenSampleUrls: [] },
  }));
  t.mock.method(trustSignals, 'checkTrustSignals', async () => ({
    httpsActive: true,
    contactPage: { found: true, url: 'https://example.com/contact' },
    privacyPolicy: { found: true, url: 'https://example.com/privacy-policy' },
  }));
  t.mock.method(contentAnalysis, 'analyzeContent', async () => ({ title: 'Some Title', imagesMissingAlt: 0 }));
  t.mock.method(serpAnalysis, 'analyzeSerp', async () => ({ organicResults: [], serpFeatures: NO_SERP_FEATURES }));
  t.mock.method(contentGap, 'compareContent', async () => ([]));
  t.mock.method(claude, 'generateRecommendations', async () => ([]));
  t.mock.method(email, 'sendAuditReadyEmail', async () => {});
  t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});
  t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'fake-access-token');
  t.mock.method(googleSearchConsole, 'querySearchAnalytics', async () => ({ clicks: 1, impressions: 2, ctr: 0.5, position: 3 }));
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE'
  );
});

test.after(async () => {
  await pool.end();
});

test('processAuditJob: computes score from severity penalties and persists the completed audit', async (t) => {
  stubDefaults(t);
  t.mock.method(claude, 'generateRecommendations', async () => ([
    { category: 'content', severity: 'high', title: 'Missing title' }, // -15
    { category: 'content', severity: 'medium', title: 'Short description' }, // -7
    { category: 'content', severity: 'low', title: 'Minor issue' }, // -3
  ]));

  const userId = await createUser(uniqueEmail('worker-score'));
  const auditId = await createAuditRow(userId, 'https://worker-score-site.com');

  const result = await processAuditJob({ data: { auditId, domain: 'https://worker-score-site.com', categories: ['technical', 'content'] } });
  assert.equal(result.score, 75); // 100 - 15 - 7 - 3

  const row = await pool.query('SELECT status, score, ai_recommendations FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].score, 75);
  assert.equal(row.rows[0].ai_recommendations.length, 3);
});

test('processAuditJob: score never goes below 0 even with many high-severity fixes', async (t) => {
  stubDefaults(t);
  const manyFixes = Array.from({ length: 10 }, (_, i) => ({ category: 'content', severity: 'high', title: `Issue ${i}` }));
  t.mock.method(claude, 'generateRecommendations', async () => manyFixes);

  const userId = await createUser(uniqueEmail('worker-floor'));
  const auditId = await createAuditRow(userId, 'https://worker-floor-site.com');

  const result = await processAuditJob({ data: { auditId, domain: 'https://worker-floor-site.com' } });
  assert.equal(result.score, 0);
});

test('processAuditJob: a score drop of 10+ points sends the score-drop alert, not the audit-ready email', async (t) => {
  stubDefaults(t);
  t.mock.method(claude, 'generateRecommendations', async () => ([
    { category: 'content', severity: 'high', title: 'x' },
    { category: 'content', severity: 'high', title: 'y' },
  ])); // score = 70

  const scoreDropMock = t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});
  const readyMock = t.mock.method(email, 'sendAuditReadyEmail', async () => {});

  const userEmail = uniqueEmail('worker-drop');
  const userId = await createUser(userEmail);
  await createAuditRow(userId, 'https://worker-drop-site.com', { score: 85, createdAt: new Date(Date.now() - 60000) });
  const auditId = await createAuditRow(userId, 'https://worker-drop-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-drop-site.com' } });

  assert.equal(scoreDropMock.mock.callCount(), 1);
  assert.equal(readyMock.mock.callCount(), 0);
  const call = scoreDropMock.mock.calls[0];
  assert.equal(call.arguments[0], userEmail);
  assert.equal(call.arguments[1].previousScore, 85);
  assert.equal(call.arguments[1].score, 70);
});

test('processAuditJob: a score drop under the threshold sends no alert at all', async (t) => {
  stubDefaults(t);
  t.mock.method(claude, 'generateRecommendations', async () => ([{ category: 'content', severity: 'low', title: 'x' }])); // score = 97

  const scoreDropMock = t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});
  const readyMock = t.mock.method(email, 'sendAuditReadyEmail', async () => {});

  const userId = await createUser(uniqueEmail('worker-smalldrop'));
  await createAuditRow(userId, 'https://worker-smalldrop-site.com', { score: 100, createdAt: new Date(Date.now() - 60000) });
  const auditId = await createAuditRow(userId, 'https://worker-smalldrop-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-smalldrop-site.com' } });

  assert.equal(scoreDropMock.mock.callCount(), 0);
  assert.equal(readyMock.mock.callCount(), 0);
});

test('processAuditJob: a score drop of exactly the threshold (10) still triggers the alert (boundary)', async (t) => {
  stubDefaults(t);
  // medium (-7) + low (-3) = -10 penalty, so a perfect previous score of 100
  // drops to exactly 90 — a drop of precisely SCORE_DROP_ALERT_THRESHOLD.
  t.mock.method(claude, 'generateRecommendations', async () => ([
    { category: 'content', severity: 'medium', title: 'x' },
    { category: 'content', severity: 'low', title: 'y' },
  ]));

  const scoreDropMock = t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});

  const userId = await createUser(uniqueEmail('worker-boundary'));
  await createAuditRow(userId, 'https://worker-boundary-site.com', { score: 100, createdAt: new Date(Date.now() - 60000) });
  const auditId = await createAuditRow(userId, 'https://worker-boundary-site.com');

  const result = await processAuditJob({ data: { auditId, domain: 'https://worker-boundary-site.com' } });

  assert.equal(result.previousScore - result.score, SCORE_DROP_ALERT_THRESHOLD, 'test setup sanity check: drop must equal the threshold exactly');
  assert.equal(scoreDropMock.mock.callCount(), 1, 'a drop exactly at the threshold must still alert (>=, not >)');
});

test('processAuditJob: notifyEmail sends the audit-ready email when there is no score drop', async (t) => {
  stubDefaults(t);
  const readyMock = t.mock.method(email, 'sendAuditReadyEmail', async () => {});
  const scoreDropMock = t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});

  const userEmail = uniqueEmail('worker-notify');
  const userId = await createUser(userEmail);
  const auditId = await createAuditRow(userId, 'https://worker-notify-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-notify-site.com', notifyEmail: true } });

  assert.equal(readyMock.mock.callCount(), 1);
  assert.equal(readyMock.mock.calls[0].arguments[0], userEmail);
  assert.equal(scoreDropMock.mock.callCount(), 0);
});

test('processAuditJob: without notifyEmail and without a score drop, no email is sent at all', async (t) => {
  stubDefaults(t);
  const readyMock = t.mock.method(email, 'sendAuditReadyEmail', async () => {});
  const scoreDropMock = t.mock.method(email, 'sendScoreDropAlertEmail', async () => {});

  const userId = await createUser(uniqueEmail('worker-noemail'));
  const auditId = await createAuditRow(userId, 'https://worker-noemail-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-noemail-site.com', notifyEmail: false } });

  assert.equal(readyMock.mock.callCount(), 0);
  assert.equal(scoreDropMock.mock.callCount(), 0);
});

test('processAuditJob: a failing email provider is swallowed — the audit still completes', async (t) => {
  stubDefaults(t);
  t.mock.method(email, 'sendAuditReadyEmail', async () => {
    throw new Error('Resend is down');
  });

  const userId = await createUser(uniqueEmail('worker-emailfail'));
  const auditId = await createAuditRow(userId, 'https://worker-emailfail-site.com');

  await assert.doesNotReject(
    processAuditJob({ data: { auditId, domain: 'https://worker-emailfail-site.com', notifyEmail: true } })
  );

  const row = await pool.query('SELECT status FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
});

test('processAuditJob: fetches and persists GSC data when the domain is linked and the user is connected', async (t) => {
  stubDefaults(t);
  const refreshMock = t.mock.method(googleSearchConsole, 'refreshAccessToken', async (token) => {
    assert.equal(token, 'a-refresh-token');
    return 'an-access-token';
  });
  const queryMock = t.mock.method(googleSearchConsole, 'querySearchAnalytics', async (accessToken, siteUrl) => {
    assert.equal(accessToken, 'an-access-token');
    assert.equal(siteUrl, 'https://gsc-property.example/');
    return { clicks: 42, impressions: 100, ctr: 0.42, position: 4.5 };
  });

  const userId = await createUser(uniqueEmail('worker-gsc'));
  await pool.query('UPDATE users SET gsc_refresh_token = $1 WHERE id = $2', ['a-refresh-token', userId]);
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, gsc_site_url) VALUES ($1, $2, $3)',
    [userId, 'https://worker-gsc-site.com', 'https://gsc-property.example/']
  );
  const auditId = await createAuditRow(userId, 'https://worker-gsc-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-gsc-site.com' } });

  assert.equal(refreshMock.mock.callCount(), 1);
  assert.equal(queryMock.mock.callCount(), 1);

  const row = await pool.query('SELECT gsc_result FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].gsc_result, { clicks: 42, impressions: 100, ctr: 0.42, position: 4.5 });
});

test('processAuditJob: skips GSC entirely when the domain has no linked property', async (t) => {
  stubDefaults(t);
  const refreshMock = t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'x');
  const queryMock = t.mock.method(googleSearchConsole, 'querySearchAnalytics', async () => ({}));

  const userId = await createUser(uniqueEmail('worker-nogsc'));
  await pool.query('UPDATE users SET gsc_refresh_token = $1 WHERE id = $2', ['a-refresh-token', userId]);
  // Domain exists but gsc_site_url is not set.
  await pool.query('INSERT INTO monitored_domains (user_id, domain) VALUES ($1, $2)', [userId, 'https://worker-nogsc-site.com']);
  const auditId = await createAuditRow(userId, 'https://worker-nogsc-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-nogsc-site.com' } });

  assert.equal(refreshMock.mock.callCount(), 0);
  assert.equal(queryMock.mock.callCount(), 0);

  const row = await pool.query('SELECT gsc_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].gsc_result, null);
});

test('processAuditJob: skips GSC when the domain is linked but the user has since disconnected (no refresh token)', async (t) => {
  stubDefaults(t);
  const refreshMock = t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'x');

  const userId = await createUser(uniqueEmail('worker-gscdisconnected'));
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, gsc_site_url) VALUES ($1, $2, $3)',
    [userId, 'https://worker-gscdisc-site.com', 'https://gsc-property.example/']
  );
  const auditId = await createAuditRow(userId, 'https://worker-gscdisc-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-gscdisc-site.com' } });

  assert.equal(refreshMock.mock.callCount(), 0);
  const row = await pool.query('SELECT gsc_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].gsc_result, null);
});

test('processAuditJob: a GSC fetch failure is swallowed — gsc_result is null and the audit still completes', async (t) => {
  stubDefaults(t);
  t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => {
    throw new Error('invalid_grant');
  });

  const userId = await createUser(uniqueEmail('worker-gscfail'));
  await pool.query('UPDATE users SET gsc_refresh_token = $1 WHERE id = $2', ['a-refresh-token', userId]);
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, gsc_site_url) VALUES ($1, $2, $3)',
    [userId, 'https://worker-gscfail-site.com', 'https://gsc-property.example/']
  );
  const auditId = await createAuditRow(userId, 'https://worker-gscfail-site.com');

  await assert.doesNotReject(processAuditJob({ data: { auditId, domain: 'https://worker-gscfail-site.com' } }));

  const row = await pool.query('SELECT status, gsc_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].gsc_result, null);
});

test('processAuditJob: crosses GSC clicks with GA4 traffic quality by page when both are connected and linked', async (t) => {
  stubDefaults(t);
  const gscRefreshMock = t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'a-gsc-access-token');
  const topPagesMock = t.mock.method(googleSearchConsole, 'queryTopPages', async (accessToken, siteUrl) => {
    assert.equal(accessToken, 'a-gsc-access-token');
    assert.equal(siteUrl, 'https://gsc-property.example/');
    return [
      { page: 'https://worker-ga4-site.com/converts', clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
      { page: 'https://worker-ga4-site.com/not-in-ga4', clicks: 4, impressions: 40, ctr: 0.1, position: 6 },
    ];
  });
  const ga4RefreshMock = t.mock.method(googleAnalytics, 'refreshAccessToken', async (token) => {
    assert.equal(token, 'a-ga4-refresh-token');
    return 'a-ga4-access-token';
  });
  const trafficQualityMock = t.mock.method(googleAnalytics, 'getTrafficQuality', async (accessToken, propertyId) => {
    assert.equal(accessToken, 'a-ga4-access-token');
    assert.equal(propertyId, '123456');
    return [
      { hostName: 'worker-ga4-site.com', landingPage: '/converts', sessions: 30, engagementRate: 0.8, bounceRate: 0.2, conversions: 6 },
    ];
  });

  const userId = await createUser(uniqueEmail('worker-ga4'));
  await pool.query('UPDATE users SET gsc_refresh_token = $1, ga4_refresh_token = $2, ga4_property_id = $3 WHERE id = $4', [
    'a-refresh-token',
    'a-ga4-refresh-token',
    '123456',
    userId,
  ]);
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, gsc_site_url) VALUES ($1, $2, $3)',
    [userId, 'https://worker-ga4-site.com', 'https://gsc-property.example/']
  );
  const auditId = await createAuditRow(userId, 'https://worker-ga4-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-ga4-site.com' } });

  assert.equal(topPagesMock.mock.callCount(), 1);
  assert.equal(ga4RefreshMock.mock.callCount(), 1);
  assert.equal(trafficQualityMock.mock.callCount(), 1);
  // The gsc and ga4 tasks share one GSC token refresh instead of each
  // refreshing the same refresh token independently.
  assert.equal(gscRefreshMock.mock.callCount(), 1);

  const row = await pool.query('SELECT ga4_result FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].ga4_result, {
    propertyId: '123456',
    pages: [
      {
        page: 'https://worker-ga4-site.com/converts',
        clicks: 10,
        impressions: 100,
        sessions: 30,
        engagementRate: 0.8,
        bounceRate: 0.2,
        conversions: 6,
      },
    ],
  });
});

test('processAuditJob: skips GA4 when GSC is connected but GA4 is not', async (t) => {
  stubDefaults(t);
  t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'a-gsc-access-token');
  const trafficQualityMock = t.mock.method(googleAnalytics, 'getTrafficQuality', async () => []);

  const userId = await createUser(uniqueEmail('worker-noga4'));
  await pool.query('UPDATE users SET gsc_refresh_token = $1 WHERE id = $2', ['a-refresh-token', userId]);
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, gsc_site_url) VALUES ($1, $2, $3)',
    [userId, 'https://worker-noga4-site.com', 'https://gsc-property.example/']
  );
  const auditId = await createAuditRow(userId, 'https://worker-noga4-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-noga4-site.com' } });

  assert.equal(trafficQualityMock.mock.callCount(), 0);
  const row = await pool.query('SELECT ga4_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].ga4_result, null);
});

test('processAuditJob: skips GA4 when the user is connected but the domain has no linked GSC property', async (t) => {
  stubDefaults(t);
  const trafficQualityMock = t.mock.method(googleAnalytics, 'getTrafficQuality', async () => []);

  const userId = await createUser(uniqueEmail('worker-ga4nogsc'));
  await pool.query('UPDATE users SET ga4_refresh_token = $1, ga4_property_id = $2 WHERE id = $3', [
    'a-ga4-refresh-token',
    '123456',
    userId,
  ]);
  // Domain exists but has no gsc_site_url linked.
  await pool.query('INSERT INTO monitored_domains (user_id, domain) VALUES ($1, $2)', [userId, 'https://worker-ga4nogsc-site.com']);
  const auditId = await createAuditRow(userId, 'https://worker-ga4nogsc-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-ga4nogsc-site.com' } });

  assert.equal(trafficQualityMock.mock.callCount(), 0);
  const row = await pool.query('SELECT ga4_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].ga4_result, null);
});

test('processAuditJob: a GA4 fetch failure is swallowed — ga4_result is null and the audit still completes', async (t) => {
  stubDefaults(t);
  t.mock.method(googleSearchConsole, 'refreshAccessToken', async () => 'a-gsc-access-token');
  t.mock.method(googleSearchConsole, 'queryTopPages', async () => []);
  t.mock.method(googleAnalytics, 'refreshAccessToken', async () => {
    throw new Error('invalid_grant');
  });

  const userId = await createUser(uniqueEmail('worker-ga4fail'));
  await pool.query('UPDATE users SET gsc_refresh_token = $1, ga4_refresh_token = $2, ga4_property_id = $3 WHERE id = $4', [
    'a-refresh-token',
    'a-ga4-refresh-token',
    '123456',
    userId,
  ]);
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, gsc_site_url) VALUES ($1, $2, $3)',
    [userId, 'https://worker-ga4fail-site.com', 'https://gsc-property.example/']
  );
  const auditId = await createAuditRow(userId, 'https://worker-ga4fail-site.com');

  await assert.doesNotReject(processAuditJob({ data: { auditId, domain: 'https://worker-ga4fail-site.com' } }));

  const row = await pool.query('SELECT status, ga4_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].ga4_result, null);
});

test('processAuditJob: only calls the services for categories included in the plan', async (t) => {
  stubDefaults(t);
  const technicalMock = t.mock.method(dataforseo, 'getOnPageAudit', async () => ({}));
  const backlinksMock = t.mock.method(dataforseo, 'getBacklinkSummary', async () => ({}));
  const contentMock = t.mock.method(contentAnalysis, 'analyzeContent', async () => ({ title: 'T' }));
  const keywordsMock = t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([]));
  const cwvMock = t.mock.method(coreWebVitals, 'getCoreWebVitals', async () => null);
  const trustMock = t.mock.method(trustSignals, 'checkTrustSignals', async () => null);

  const userId = await createUser(uniqueEmail('worker-categories'));
  const auditId = await createAuditRow(userId, 'https://worker-categories-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-categories-site.com', categories: ['content'] } });

  assert.equal(contentMock.mock.callCount(), 1);
  assert.equal(technicalMock.mock.callCount(), 0, 'technical is not in the plan\'s categories');
  assert.equal(backlinksMock.mock.callCount(), 0, 'backlinks is not in the plan\'s categories');
  assert.equal(keywordsMock.mock.callCount(), 0, 'keywords is not in the plan\'s categories');
  assert.equal(cwvMock.mock.callCount(), 0, 'core web vitals is fetched alongside technical, so it is skipped too');
  assert.equal(trustMock.mock.callCount(), 0, 'trust signals are fetched alongside technical, so they are skipped too');
});

test('processAuditJob: Agency plan with competitor domains configured runs the backlink gap check and persists a fixed set of gap domains', async (t) => {
  stubDefaults(t);
  const gapMock = t.mock.method(dataforseo, 'getBacklinkGap', async (domain, competitors) => {
    assert.equal(domain, 'https://worker-backlinkgap-site.com');
    assert.deepEqual(competitors, ['https://competitor-a.com', 'https://competitor-b.com']);
    return ['gap-domain-one.com', 'gap-domain-two.com'];
  });

  const userId = await createUser(uniqueEmail('worker-backlinkgap'));
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, competitor_domains) VALUES ($1, $2, $3)',
    [userId, 'https://worker-backlinkgap-site.com', ['https://competitor-a.com', 'https://competitor-b.com']]
  );
  const auditId = await createAuditRow(userId, 'https://worker-backlinkgap-site.com');

  await processAuditJob({
    data: {
      auditId,
      domain: 'https://worker-backlinkgap-site.com',
      categories: ['content', 'backlinks'],
      planKey: 'agency',
    },
  });

  assert.equal(gapMock.mock.callCount(), 1);
  const row = await pool.query('SELECT backlink_gap_result FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].backlink_gap_result, ['gap-domain-one.com', 'gap-domain-two.com']);
});

test('processAuditJob: backlink gap check is skipped on non-Agency plans even with competitor domains set (plan gating)', async (t) => {
  stubDefaults(t);
  const gapMock = t.mock.method(dataforseo, 'getBacklinkGap', async () => (['should-not-appear.com']));

  const userId = await createUser(uniqueEmail('worker-backlinkgap-pro'));
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, competitor_domains) VALUES ($1, $2, $3)',
    [userId, 'https://worker-backlinkgap-pro-site.com', ['https://competitor-a.com']]
  );
  const auditId = await createAuditRow(userId, 'https://worker-backlinkgap-pro-site.com');

  await processAuditJob({
    data: {
      auditId,
      domain: 'https://worker-backlinkgap-pro-site.com',
      categories: ['content', 'backlinks'],
      planKey: 'pro',
    },
  });

  assert.equal(gapMock.mock.callCount(), 0);
  const row = await pool.query('SELECT backlink_gap_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].backlink_gap_result, null);
});

test('processAuditJob: backlink gap check is skipped when the domain has no competitor domains configured', async (t) => {
  stubDefaults(t);
  const gapMock = t.mock.method(dataforseo, 'getBacklinkGap', async () => (['should-not-appear.com']));

  const userId = await createUser(uniqueEmail('worker-backlinkgap-nocompetitors'));
  await pool.query('INSERT INTO monitored_domains (user_id, domain) VALUES ($1, $2)', [
    userId,
    'https://worker-backlinkgap-nocomp-site.com',
  ]);
  const auditId = await createAuditRow(userId, 'https://worker-backlinkgap-nocomp-site.com');

  await processAuditJob({
    data: {
      auditId,
      domain: 'https://worker-backlinkgap-nocomp-site.com',
      categories: ['content', 'backlinks'],
      planKey: 'agency',
    },
  });

  assert.equal(gapMock.mock.callCount(), 0);
});

test('processAuditJob: backlink gap check is skipped when "backlinks" is not an included category', async (t) => {
  stubDefaults(t);
  const gapMock = t.mock.method(dataforseo, 'getBacklinkGap', async () => (['should-not-appear.com']));

  const userId = await createUser(uniqueEmail('worker-backlinkgap-nocat'));
  await pool.query(
    'INSERT INTO monitored_domains (user_id, domain, competitor_domains) VALUES ($1, $2, $3)',
    [userId, 'https://worker-backlinkgap-nocat-site.com', ['https://competitor-a.com']]
  );
  const auditId = await createAuditRow(userId, 'https://worker-backlinkgap-nocat-site.com');

  await processAuditJob({
    data: {
      auditId,
      domain: 'https://worker-backlinkgap-nocat-site.com',
      categories: ['content'],
      planKey: 'agency',
    },
  });

  assert.equal(gapMock.mock.callCount(), 0);
});

test('processAuditJob: fetches Core Web Vitals alongside the technical category and persists them classified', async (t) => {
  stubDefaults(t);
  const cwvMock = t.mock.method(coreWebVitals, 'getCoreWebVitals', async (domain) => {
    assert.equal(domain, 'https://worker-cwv-site.com');
    return {
      lcp: { value: 4500, rating: 'poor' },
      inp: { value: 100, rating: 'good' },
      cls: { value: 0.3, rating: 'poor' },
      performanceScore: 35,
    };
  });

  const userId = await createUser(uniqueEmail('worker-cwv'));
  const auditId = await createAuditRow(userId, 'https://worker-cwv-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-cwv-site.com', categories: ['technical', 'content'] },
  });

  assert.equal(cwvMock.mock.callCount(), 1);
  const row = await pool.query('SELECT core_web_vitals FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].core_web_vitals, {
    lcp: { value: 4500, rating: 'poor' },
    inp: { value: 100, rating: 'good' },
    cls: { value: 0.3, rating: 'poor' },
    performanceScore: 35,
  });
});

test('processAuditJob: a Core Web Vitals failure is swallowed — core_web_vitals is null and the audit still completes', async (t) => {
  stubDefaults(t);
  t.mock.method(coreWebVitals, 'getCoreWebVitals', async () => {
    throw new Error('PageSpeed Insights is down');
  });

  const userId = await createUser(uniqueEmail('worker-cwvfail'));
  const auditId = await createAuditRow(userId, 'https://worker-cwvfail-site.com');

  await assert.doesNotReject(
    processAuditJob({ data: { auditId, domain: 'https://worker-cwvfail-site.com', categories: ['technical', 'content'] } })
  );

  const row = await pool.query('SELECT status, core_web_vitals FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].core_web_vitals, null);
});

test('processAuditJob: passes Core Web Vitals through to Claude for recommendation generation', async (t) => {
  stubDefaults(t);
  t.mock.method(coreWebVitals, 'getCoreWebVitals', async () => ({
    lcp: { value: 5000, rating: 'poor' },
    inp: null,
    cls: null,
    performanceScore: 20,
  }));
  const claudeMock = t.mock.method(claude, 'generateRecommendations', async (args) => {
    assert.deepEqual(args.coreWebVitals, { lcp: { value: 5000, rating: 'poor' }, inp: null, cls: null, performanceScore: 20 });
    return [];
  });

  const userId = await createUser(uniqueEmail('worker-cwvclaude'));
  const auditId = await createAuditRow(userId, 'https://worker-cwvclaude-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-cwvclaude-site.com', categories: ['technical', 'content'] },
  });

  assert.equal(claudeMock.mock.callCount(), 1);
});

test('processAuditJob: fetches trust signals alongside the technical category and persists them', async (t) => {
  stubDefaults(t);
  const trustMock = t.mock.method(trustSignals, 'checkTrustSignals', async (domain) => {
    assert.equal(domain, 'https://worker-trust-site.com');
    return {
      httpsActive: false,
      contactPage: { found: false, url: null },
      privacyPolicy: { found: true, url: 'https://worker-trust-site.com/privacy-policy' },
    };
  });

  const userId = await createUser(uniqueEmail('worker-trust'));
  const auditId = await createAuditRow(userId, 'https://worker-trust-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-trust-site.com', categories: ['technical', 'content'] },
  });

  assert.equal(trustMock.mock.callCount(), 1);
  const row = await pool.query('SELECT trust_signals_result FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].trust_signals_result, {
    httpsActive: false,
    contactPage: { found: false, url: null },
    privacyPolicy: { found: true, url: 'https://worker-trust-site.com/privacy-policy' },
  });
});

test('processAuditJob: trust signals are skipped when "technical" is not an included category', async (t) => {
  stubDefaults(t);
  const trustMock = t.mock.method(trustSignals, 'checkTrustSignals', async () => ({ httpsActive: true, contactPage: { found: true, url: 'x' }, privacyPolicy: { found: true, url: 'x' } }));

  const userId = await createUser(uniqueEmail('worker-trust-nocat'));
  const auditId = await createAuditRow(userId, 'https://worker-trust-nocat-site.com');

  await processAuditJob({ data: { auditId, domain: 'https://worker-trust-nocat-site.com', categories: ['content'] } });

  assert.equal(trustMock.mock.callCount(), 0);
  const row = await pool.query('SELECT trust_signals_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].trust_signals_result, null);
});

test('processAuditJob: a trust signals failure is swallowed — trust_signals_result is null and the audit still completes', async (t) => {
  stubDefaults(t);
  t.mock.method(trustSignals, 'checkTrustSignals', async () => {
    throw new Error('ECONNREFUSED');
  });

  const userId = await createUser(uniqueEmail('worker-trustfail'));
  const auditId = await createAuditRow(userId, 'https://worker-trustfail-site.com');

  await assert.doesNotReject(
    processAuditJob({ data: { auditId, domain: 'https://worker-trustfail-site.com', categories: ['technical', 'content'] } })
  );

  const row = await pool.query('SELECT status, trust_signals_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].trust_signals_result, null);
});

test('processAuditJob: passes trust signals through to Claude for recommendation generation', async (t) => {
  stubDefaults(t);
  t.mock.method(trustSignals, 'checkTrustSignals', async () => ({
    httpsActive: false,
    contactPage: { found: false, url: null },
    privacyPolicy: { found: false, url: null },
  }));
  const claudeMock = t.mock.method(claude, 'generateRecommendations', async (args) => {
    assert.deepEqual(args.trustSignals, {
      httpsActive: false,
      contactPage: { found: false, url: null },
      privacyPolicy: { found: false, url: null },
    });
    return [];
  });

  const userId = await createUser(uniqueEmail('worker-trustclaude'));
  const auditId = await createAuditRow(userId, 'https://worker-trustclaude-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-trustclaude-site.com', categories: ['technical', 'content'] },
  });

  assert.equal(claudeMock.mock.callCount(), 1);
});

test('processAuditJob: fetches keyword ideas from the content title only when "keywords" is an included category', async (t) => {
  stubDefaults(t);
  t.mock.method(contentAnalysis, 'analyzeContent', async () => ({ title: 'Best Coffee Shop' }));
  const keywordsMock = t.mock.method(dataforseo, 'getKeywordIdeas', async (title) => {
    assert.equal(title, 'Best Coffee Shop');
    return [{ keyword: 'coffee' }];
  });

  const userId = await createUser(uniqueEmail('worker-keywords'));
  const auditId = await createAuditRow(userId, 'https://worker-keywords-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-keywords-site.com', categories: ['content', 'keywords'] },
  });

  assert.equal(keywordsMock.mock.callCount(), 1);
  const row = await pool.query('SELECT keyword_result FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].keyword_result, [{ keyword: 'coffee' }]);
});

test('processAuditJob: content gap analysis caps at the top 3 highest-volume keyword ideas and persists identified subtopics', async (t) => {
  stubDefaults(t);
  t.mock.method(contentAnalysis, 'analyzeContent', async (url) => {
    if (url === 'https://worker-gap-site.com') return { title: 'Coffee shop guide', h1s: ['Coffee shop guide'], wordCount: 400 };
    return { title: `Competitor for ${url}`, h1s: [], wordCount: 900 };
  });
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([
    { keyword: 'kw-low', search_volume: 50 }, // excluded: 4th by volume, cap is 3
    { keyword: 'kw-mid', search_volume: 500 },
    { keyword: 'kw-high', search_volume: 900 },
    { keyword: 'kw-novolume', search_volume: 100 },
  ]));
  const serpMock = t.mock.method(serpAnalysis, 'analyzeSerp', async (keyword) => ({
    organicResults: [{ url: `https://competitor-for-${keyword}.example.com`, title: 'A', snippet: null, rank: 1 }],
    serpFeatures: NO_SERP_FEATURES,
  }));
  const compareMock = t.mock.method(contentGap, 'compareContent', async ({ keyword, userContent, competitorContents }) => {
    assert.equal(userContent.title, 'Coffee shop guide');
    assert.equal(competitorContents.length, 1);
    return [{ topic: `Topic for ${keyword}`, competitorsCovering: 1, competitorUrls: [competitorContents[0].url] }];
  });

  const userId = await createUser(uniqueEmail('worker-gap'));
  const auditId = await createAuditRow(userId, 'https://worker-gap-site.com');

  await processAuditJob({
    data: {
      auditId,
      domain: 'https://worker-gap-site.com',
      categories: ['content', 'keywords'],
      planKey: 'agency',
    },
  });

  assert.equal(serpMock.mock.callCount(), 3, 'only the top 3 by search volume are analyzed');
  assert.equal(compareMock.mock.callCount(), 3);
  const analyzedKeywords = serpMock.mock.calls.map((call) => call.arguments[0]).sort();
  assert.deepEqual(analyzedKeywords, ['kw-high', 'kw-mid', 'kw-novolume'], 'kw-low (lowest volume) is excluded by the cap');

  const row = await pool.query('SELECT content_gap_result FROM audits WHERE id = $1', [auditId]);
  const resultKeywords = row.rows[0].content_gap_result.map((entry) => entry.keyword).sort();
  assert.deepEqual(resultKeywords, ['kw-high', 'kw-mid', 'kw-novolume']);
  assert.deepEqual(
    row.rows[0].content_gap_result.find((entry) => entry.keyword === 'kw-high'),
    {
      keyword: 'kw-high',
      competitorCount: 1,
      missingSubtopics: [
        { topic: 'Topic for kw-high', competitorsCovering: 1, competitorUrls: ['https://competitor-for-kw-high.example.com'] },
      ],
      serpFeatures: NO_SERP_FEATURES,
    }
  );
});

test('processAuditJob: passes per-keyword SERP feature opportunities from the content gap flow through to Claude', async (t) => {
  stubDefaults(t);
  t.mock.method(contentAnalysis, 'analyzeContent', async (url) => {
    if (url === 'https://worker-serpfeat-site.com') return { title: 'Coffee shop guide', h1s: [], wordCount: 400 };
    return { title: `Competitor for ${url}`, h1s: [], wordCount: 900 };
  });
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([{ keyword: 'best coffee', search_volume: 500 }]));
  const occupiedByUser = {
    featuredSnippet: { present: true, url: 'https://worker-serpfeat-site.com/guide', occupiedByUser: false },
    peopleAlsoAsk: { present: true, questions: ['What is the best coffee shop?'] },
    otherFeatures: [],
  };
  t.mock.method(serpAnalysis, 'analyzeSerp', async () => ({
    organicResults: [{ url: 'https://competitor.example.com', title: 'A', snippet: null, rank: 1 }],
    serpFeatures: occupiedByUser,
  }));
  t.mock.method(contentGap, 'compareContent', async () => ([]));
  const claudeMock = t.mock.method(claude, 'generateRecommendations', async (args) => {
    assert.deepEqual(args.serpOpportunities, [{ keyword: 'best coffee', serpFeatures: occupiedByUser }]);
    return [];
  });

  const userId = await createUser(uniqueEmail('worker-serpfeat'));
  const auditId = await createAuditRow(userId, 'https://worker-serpfeat-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-serpfeat-site.com', categories: ['content', 'keywords'], planKey: 'agency' },
  });

  assert.equal(claudeMock.mock.callCount(), 1);
});

test('processAuditJob: skips content gap analysis entirely when "keywords" is not an included category', async (t) => {
  stubDefaults(t);
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([{ keyword: 'coffee', search_volume: 100 }]));
  const serpMock = t.mock.method(serpAnalysis, 'analyzeSerp', async () => ({ organicResults: [], serpFeatures: NO_SERP_FEATURES }));

  const userId = await createUser(uniqueEmail('worker-gap-nogate'));
  const auditId = await createAuditRow(userId, 'https://worker-gap-nogate-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-gap-nogate-site.com', categories: ['content'] },
  });

  assert.equal(serpMock.mock.callCount(), 0);
  const row = await pool.query('SELECT content_gap_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].content_gap_result, null);
});

test('processAuditJob: content gap analysis is skipped when there are no keyword ideas to target', async (t) => {
  stubDefaults(t);
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([]));
  const serpMock = t.mock.method(serpAnalysis, 'analyzeSerp', async () => ({ organicResults: [], serpFeatures: NO_SERP_FEATURES }));

  const userId = await createUser(uniqueEmail('worker-gap-noideas'));
  const auditId = await createAuditRow(userId, 'https://worker-gap-noideas-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-gap-noideas-site.com', categories: ['content', 'keywords'] },
  });

  assert.equal(serpMock.mock.callCount(), 0);
  const row = await pool.query('SELECT content_gap_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].content_gap_result, null);
});

test('processAuditJob: a content gap failure for one keyword does not block the others or the rest of the audit', async (t) => {
  stubDefaults(t);
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([
    { keyword: 'good keyword', search_volume: 100 },
    { keyword: 'bad keyword', search_volume: 900 },
  ]));
  t.mock.method(serpAnalysis, 'analyzeSerp', async (keyword) => {
    if (keyword === 'bad keyword') throw new Error('DataForSEO SERP timeout');
    return {
      organicResults: [{ url: 'https://ok-competitor.example.com', title: 'ok', snippet: null, rank: 1 }],
      serpFeatures: NO_SERP_FEATURES,
    };
  });
  t.mock.method(contentGap, 'compareContent', async () => ([{ topic: 'Topic X', competitorsCovering: 1, competitorUrls: [] }]));

  const userId = await createUser(uniqueEmail('worker-gap-partialfail'));
  const auditId = await createAuditRow(userId, 'https://worker-gap-partialfail-site.com');

  await assert.doesNotReject(
    processAuditJob({
      data: {
        auditId,
        domain: 'https://worker-gap-partialfail-site.com',
        categories: ['content', 'keywords'],
      },
    })
  );

  const row = await pool.query('SELECT status, content_gap_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.deepEqual(row.rows[0].content_gap_result, [
    {
      keyword: 'good keyword',
      competitorCount: 1,
      missingSubtopics: [{ topic: 'Topic X', competitorsCovering: 1, competitorUrls: [] }],
      serpFeatures: NO_SERP_FEATURES,
    },
  ]);
});

test('processAuditJob: a keyword with no competitor pages that could be analyzed is dropped from the results', async (t) => {
  stubDefaults(t);
  t.mock.method(dataforseo, 'getKeywordIdeas', async () => ([{ keyword: 'unreachable competitors', search_volume: 100 }]));
  t.mock.method(serpAnalysis, 'analyzeSerp', async () => ({
    organicResults: [{ url: 'https://down.example.com', title: null, snippet: null, rank: 1 }],
    serpFeatures: NO_SERP_FEATURES,
  }));
  t.mock.method(contentAnalysis, 'analyzeContent', async (url) => {
    if (url === 'https://down.example.com') throw new Error('ECONNREFUSED');
    return { title: 'Some Title', h1s: [], wordCount: 100 };
  });
  const compareMock = t.mock.method(contentGap, 'compareContent', async () => ([{ topic: 'Should not be called' }]));

  const userId = await createUser(uniqueEmail('worker-gap-nocompetitors'));
  const auditId = await createAuditRow(userId, 'https://worker-gap-nocompetitors-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-gap-nocompetitors-site.com', categories: ['content', 'keywords'] },
  });

  assert.equal(compareMock.mock.callCount(), 0);
  const row = await pool.query('SELECT content_gap_result FROM audits WHERE id = $1', [auditId]);
  assert.deepEqual(row.rows[0].content_gap_result, []);
});

test('processAuditJob: a Claude failure degrades to zero recommendations and a perfect score, without crashing', async (t) => {
  stubDefaults(t);
  t.mock.method(claude, 'generateRecommendations', async () => {
    throw new Error('anthropic API down');
  });

  const userId = await createUser(uniqueEmail('worker-claudefail'));
  const auditId = await createAuditRow(userId, 'https://worker-claudefail-site.com');

  const result = await processAuditJob({ data: { auditId, domain: 'https://worker-claudefail-site.com' } });
  assert.equal(result.score, 100);

  const row = await pool.query('SELECT status, ai_recommendations FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.deepEqual(row.rows[0].ai_recommendations, []);
});

test('processAuditJob: a DataForSEO failure for one category does not block the others', async (t) => {
  stubDefaults(t);
  t.mock.method(dataforseo, 'getOnPageAudit', async () => {
    throw new Error('DataForSEO timeout');
  });
  t.mock.method(contentAnalysis, 'analyzeContent', async () => ({ title: 'Still works' }));

  const userId = await createUser(uniqueEmail('worker-partialfail'));
  const auditId = await createAuditRow(userId, 'https://worker-partialfail-site.com');

  await processAuditJob({
    data: { auditId, domain: 'https://worker-partialfail-site.com', categories: ['technical', 'content'] },
  });

  const row = await pool.query('SELECT status, technical_result, content_result FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].technical_result, null);
  assert.deepEqual(row.rows[0].content_result, { title: 'Still works' });
});

test('processAuditJob: does not crash and sends no email when the audit\'s user_id is missing', async (t) => {
  stubDefaults(t);
  const readyMock = t.mock.method(email, 'sendAuditReadyEmail', async () => {});

  // No real user backing this audit — simulates a data-integrity edge case
  // rather than relying on a foreign key we'd have to bypass.
  const orphanResult = await pool.query(
    `INSERT INTO audits (user_id, domain, status) VALUES (NULL, 'https://worker-orphan-site.com', 'pending') RETURNING id`
  );
  const auditId = orphanResult.rows[0].id;

  await assert.doesNotReject(
    processAuditJob({ data: { auditId, domain: 'https://worker-orphan-site.com', notifyEmail: true } })
  );
  assert.equal(readyMock.mock.callCount(), 0);

  const row = await pool.query('SELECT status FROM audits WHERE id = $1', [auditId]);
  assert.equal(row.rows[0].status, 'completed');
});

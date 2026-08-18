require('dotenv').config();
const pool = require('../db/pool');
// Required as namespaced objects (not destructured) so tests can mock
// individual methods with node:test's t.mock.method — that only works when
// the call site does a live property lookup (services.foo()) rather than
// holding a destructured reference captured at require time.
const contentAnalysis = require('./contentAnalysis');
const dataforseo = require('./dataforseo');
const siteCrawl = require('./siteCrawl');
const claude = require('./claude');
const email = require('./email');
const googleSearchConsole = require('./googleSearchConsole');
const { PLANS } = require('../config/plans');

const SCORE_DROP_ALERT_THRESHOLD = 10;

// Pro/Agency site-wide crawl tuning. The poll timings are read from env so
// tests can shrink them to run the backoff/timeout logic in milliseconds
// instead of minutes (see services/dataforseo.js for the same pattern with
// DATAFORSEO_API_BASE_URL) — they must be set before this module first loads.
const MAX_CRAWL_PAGES = 200;
const POLL_INITIAL_INTERVAL_MS = Number(process.env.SITE_CRAWL_POLL_INITIAL_MS) || 5000;
const POLL_MAX_INTERVAL_MS = Number(process.env.SITE_CRAWL_POLL_MAX_MS) || 30000;
const POLL_TIMEOUT_MS = Number(process.env.SITE_CRAWL_POLL_TIMEOUT_MS) || 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilReady(taskId) {
  const start = Date.now();
  let interval = POLL_INITIAL_INTERVAL_MS;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (await siteCrawl.pollCrawlStatus(taskId)) return true;
    await sleep(interval);
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }

  return false;
}

function normalizeCrawledPage(raw) {
  return {
    url: raw.url,
    statusCode: raw.status_code ?? null,
    title: raw.meta?.title ?? null,
    metaDescription: raw.meta?.description ?? null,
    h1Count: raw.meta?.htags?.h1?.length ?? 0,
    wordCount: raw.plain_text_word_count ?? null,
    canonicalUrl: raw.meta_canonical ?? null,
    isIndexable: raw.is_indexable ?? null,
    loadTimeMs: raw.page_timing?.time_to_interactive ?? null,
  };
}

function summarizeCrawl(pages) {
  const pages4xx = pages.filter((p) => p.statusCode >= 400 && p.statusCode < 500).length;
  const pages5xx = pages.filter((p) => p.statusCode >= 500).length;
  const loadTimes = pages.map((p) => p.loadTimeMs).filter((ms) => ms != null);
  const avgLoadTimeMs = loadTimes.length
    ? Math.round(loadTimes.reduce((sum, ms) => sum + ms, 0) / loadTimes.length)
    : null;
  const pagesMissingTitle = pages.filter((p) => !p.title).length;

  const titleCounts = new Map();
  for (const p of pages) {
    if (!p.title) continue;
    titleCounts.set(p.title, (titleCounts.get(p.title) || 0) + 1);
  }
  const duplicateTitles = [...titleCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([title, count]) => ({ title, count }));

  return {
    crawlType: 'site_wide',
    pagesCrawled: pages.length,
    pages4xx,
    pages5xx,
    avgLoadTimeMs,
    pagesMissingTitle,
    duplicateTitles,
  };
}

async function runSiteWideCrawl(auditId, domain) {
  await pool.query(`UPDATE audits SET crawl_status = 'running' WHERE id = $1`, [auditId]);

  try {
    const taskId = await siteCrawl.startCrawl(domain, MAX_CRAWL_PAGES);
    const ready = await pollUntilReady(taskId);
    if (!ready) throw new Error('DataForSEO crawl did not finish within the timeout');

    const pages = (await siteCrawl.fetchCrawlResults(taskId)).map(normalizeCrawledPage);

    for (const page of pages) {
      await pool.query(
        `INSERT INTO crawled_pages
         (audit_id, url, status_code, title, meta_description, h1_count, word_count, canonical_url, is_indexable, load_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          auditId,
          page.url,
          page.statusCode,
          page.title,
          page.metaDescription,
          page.h1Count,
          page.wordCount,
          page.canonicalUrl,
          page.isIndexable,
          page.loadTimeMs,
        ]
      );
    }

    await pool.query(`UPDATE audits SET crawl_status = 'completed', pages_crawled_count = $1 WHERE id = $2`, [
      pages.length,
      auditId,
    ]);

    return summarizeCrawl(pages);
  } catch (err) {
    console.error('Site-wide crawl failed for audit', auditId, ':', err.response?.data || err.message);
    await pool.query(`UPDATE audits SET crawl_status = 'failed' WHERE id = $1`, [auditId]);
    return null;
  }
}

async function processAuditJob(job) {
  const {
    auditId,
    domain,
    categories = ['technical', 'content'],
    language = 'en',
    notifyEmail = false,
    planKey,
  } = job.data;
  const plan = PLANS[planKey] || PLANS.free;
  const useSiteCrawl = categories.includes('technical') && plan.siteWideCrawl;

  const auditRow = await pool.query('SELECT user_id FROM audits WHERE id = $1', [auditId]);
  const userId = auditRow.rows[0]?.user_id;

  const previousResult = await pool.query(
    `SELECT score FROM audits WHERE user_id = $1 AND domain = $2 AND id != $3 AND score IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, domain, auditId]
  );
  const previousScore = previousResult.rows[0]?.score ?? null;

  const gscLinkResult = await pool.query(
    `SELECT md.gsc_site_url, u.gsc_refresh_token
     FROM monitored_domains md JOIN users u ON u.id = md.user_id
     WHERE md.user_id = $1 AND md.domain = $2`,
    [userId, domain]
  );
  const gscLink = gscLinkResult.rows[0];

  const tasks = {
    technical: categories.includes('technical')
      ? useSiteCrawl
        ? runSiteWideCrawl(auditId, domain).catch(() => null)
        : dataforseo.getOnPageAudit(domain).catch(() => null)
      : Promise.resolve(null),
    content: categories.includes('content')
      ? contentAnalysis.analyzeContent(domain).catch(() => null)
      : Promise.resolve(null),
    backlinks: categories.includes('backlinks')
      ? dataforseo.getBacklinkSummary(domain).catch(() => null)
      : Promise.resolve(null),
    gsc:
      gscLink?.gsc_site_url && gscLink?.gsc_refresh_token
        ? googleSearchConsole
            .refreshAccessToken(gscLink.gsc_refresh_token)
            .then((accessToken) => googleSearchConsole.querySearchAnalytics(accessToken, gscLink.gsc_site_url))
            .catch((err) => {
              console.error('GSC fetch failed for audit', auditId, ':', err.response?.data || err.message);
              return null;
            })
        : Promise.resolve(null),
  };

  const [technical, content, backlinks, gscResult] = await Promise.all([
    tasks.technical,
    tasks.content,
    tasks.backlinks,
    tasks.gsc,
  ]);

  const keywords =
    categories.includes('keywords') && content?.title
      ? await dataforseo.getKeywordIdeas(content.title).catch(() => null)
      : null;

  const aiRecommendations = await claude
    .generateRecommendations({ domain, technical, content, keywords, backlinks, language })
    .catch(() => []);

  const penalty = aiRecommendations.reduce((sum, fix) => {
    if (fix.severity === 'high') return sum + 15;
    if (fix.severity === 'medium') return sum + 7;
    if (fix.severity === 'low') return sum + 3;
    return sum;
  }, 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  await pool.query(
    `UPDATE audits SET status = 'completed', technical_result = $1, content_result = $2,
     keyword_result = $3, backlink_result = $4, ai_recommendations = $5, score = $6, gsc_result = $7, completed_at = now()
     WHERE id = $8`,
    [technical, content, JSON.stringify(keywords), backlinks, JSON.stringify(aiRecommendations), score, JSON.stringify(gscResult), auditId]
  );

  if (userId && (notifyEmail || (previousScore != null && previousScore - score >= SCORE_DROP_ALERT_THRESHOLD))) {
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail = userResult.rows[0]?.email;
    const reportUrl = `${process.env.FRONTEND_URL}/audits/${auditId}`;

    if (userEmail) {
      try {
        if (previousScore != null && previousScore - score >= SCORE_DROP_ALERT_THRESHOLD) {
          await email.sendScoreDropAlertEmail(userEmail, { domain, previousScore, score, reportUrl });
        } else if (notifyEmail) {
          await email.sendAuditReadyEmail(userEmail, { domain, score, reportUrl });
        }
      } catch (err) {
        console.error('Failed to send audit notification email:', err.message);
      }
    }
  }

  return { score, previousScore, gscResult };
}

module.exports = { processAuditJob, SCORE_DROP_ALERT_THRESHOLD };

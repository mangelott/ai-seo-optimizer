require('dotenv').config();
const pool = require('../db/pool');
// Required as namespaced objects (not destructured) so tests can mock
// individual methods with node:test's t.mock.method — that only works when
// the call site does a live property lookup (services.foo()) rather than
// holding a destructured reference captured at require time.
const contentAnalysis = require('./contentAnalysis');
const dataforseo = require('./dataforseo');
const siteCrawl = require('./siteCrawl');
const linkGraph = require('./linkGraph');
const duplicateContent = require('./duplicateContent');
const coreWebVitals = require('./coreWebVitals');
const crawlability = require('./crawlability');
const serpAnalysis = require('./serpAnalysis');
const contentGap = require('./contentGap');
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

// Content-gap-vs-SERP analysis (Pro/Agency, "keywords" category): capped so
// one audit doesn't fire a paid SERP call plus a Claude call for every
// keyword idea returned — only the highest-volume target keywords get a gap
// analysis. Overridable so tests can exercise more than one keyword without
// a large fixture.
const CONTENT_GAP_MAX_KEYWORDS = Number(process.env.CONTENT_GAP_MAX_KEYWORDS) || 3;

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

function normalizeLink(raw) {
  return {
    fromUrl: raw.page_from ?? null,
    toUrl: raw.page_to ?? null,
    anchorText: raw.anchor ?? null,
    direction: raw.direction ?? null,
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
    const pageIdByUrl = new Map();

    for (const page of pages) {
      const inserted = await pool.query(
        `INSERT INTO crawled_pages
         (audit_id, url, status_code, title, meta_description, h1_count, word_count, canonical_url, is_indexable, load_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
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
      pageIdByUrl.set(linkGraph.normalizeUrlForCompare(page.url), inserted.rows[0].id);
    }

    const links = (await siteCrawl.fetchLinks(taskId)).map(normalizeLink).filter((l) => l.direction === 'internal' && l.fromUrl && l.toUrl);

    for (const link of links) {
      const fromPageId = pageIdByUrl.get(linkGraph.normalizeUrlForCompare(link.fromUrl));
      if (!fromPageId) continue; // link reported from a page outside this crawl's page set
      const toPageId = pageIdByUrl.get(linkGraph.normalizeUrlForCompare(link.toUrl)) ?? null;
      await pool.query(
        `INSERT INTO page_links (audit_id, from_page_id, to_page_id, to_url, anchor_text) VALUES ($1, $2, $3, $4, $5)`,
        [auditId, fromPageId, toPageId, link.toUrl, link.anchorText]
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

// Fetches the real top-10 Google results for one target keyword plus that
// same SERP's rich-result opportunities (featured snippet, People Also Ask —
// see services/serpAnalysis.js's analyzeSerp) in a single DataForSEO call,
// reuses contentAnalysis.analyzeContent (run in parallel, one failed
// competitor page never blocks the others) to extract each competitor's
// title/headings/word count, then asks Claude to name the subtopics most of
// them cover that the user's page doesn't. Returns null when there's nothing
// usable to compare against, so callers can filter it out rather than
// storing an empty entry — serpFeatures is fetched regardless of that, since
// it doesn't depend on competitor content being reachable.
async function analyzeContentGapForKeyword(keyword, domain, userContent, language) {
  const { organicResults: topResults, serpFeatures } = await serpAnalysis.analyzeSerp(keyword, domain);

  const competitorContents = (
    await Promise.all(
      topResults.map((result) =>
        contentAnalysis
          .analyzeContent(result.url)
          .then((c) => ({ url: result.url, title: c.title, h1s: c.h1s, wordCount: c.wordCount }))
          .catch(() => null)
      )
    )
  ).filter(Boolean);

  if (competitorContents.length === 0) return null;

  const missingSubtopics = await contentGap.compareContent({
    keyword,
    userContent: { title: userContent.title, h1s: userContent.h1s, wordCount: userContent.wordCount },
    competitorContents,
    language,
  });

  return { keyword, competitorCount: competitorContents.length, missingSubtopics, serpFeatures };
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

  const domainSettingsResult = await pool.query(
    `SELECT md.gsc_site_url, md.competitor_domains, u.gsc_refresh_token
     FROM monitored_domains md JOIN users u ON u.id = md.user_id
     WHERE md.user_id = $1 AND md.domain = $2`,
    [userId, domain]
  );
  const gscLink = domainSettingsResult.rows[0];
  const competitorDomains = domainSettingsResult.rows[0]?.competitor_domains ?? [];

  const tasks = {
    technical: categories.includes('technical')
      ? useSiteCrawl
        ? runSiteWideCrawl(auditId, domain).catch(() => null)
        : dataforseo.getOnPageAudit(domain).catch(() => null)
      : Promise.resolve(null),
    content: categories.includes('content')
      ? contentAnalysis.analyzeContent(domain, language).catch(() => null)
      : Promise.resolve(null),
    backlinks: categories.includes('backlinks')
      ? dataforseo.getBacklinkSummary(domain).catch(() => null)
      : Promise.resolve(null),
    // Backlink gap vs competitors (Agency only, see config/plans.js
    // backlinkGapAnalysis) — only fires when the user has actually set
    // competitor domains for this domain in Settings.
    backlinkGap: categories.includes('backlinks') && plan.backlinkGapAnalysis && competitorDomains.length
      ? dataforseo.getBacklinkGap(domain, competitorDomains).catch(() => null)
      : Promise.resolve(null),
    coreWebVitals: categories.includes('technical')
      ? coreWebVitals.getCoreWebVitals(domain).catch(() => null)
      : Promise.resolve(null),
    crawlability: categories.includes('technical')
      ? crawlability.checkCrawlability(domain).catch(() => null)
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

  const [technical, content, backlinks, backlinkGap, coreWebVitalsResult, crawlabilityResult, gscResult] = await Promise.all([
    tasks.technical,
    tasks.content,
    tasks.backlinks,
    tasks.backlinkGap,
    tasks.coreWebVitals,
    tasks.crawlability,
    tasks.gsc,
  ]);

  // Orphan-page/broken-internal-link detection needs both the crawl's own
  // page_links (from `technical`) and the sitemap's URL inventory (from
  // `crawlabilityResult`), so it can only run once both tasks above have
  // settled — never blocks the rest of the audit if it errors.
  if (technical?.crawlType === 'site_wide') {
    try {
      const sitemapUrls = crawlabilityResult?.sitemap?.urls ?? [];
      const graph = await linkGraph.buildLinkGraph(auditId);
      const orphanPages = linkGraph.detectOrphanPages(graph, sitemapUrls);
      const brokenInternalLinks = linkGraph.detectBrokenInternalLinks(graph);
      technical.orphanPagesCount = orphanPages.length;
      technical.orphanPages = orphanPages;
      technical.brokenInternalLinksCount = brokenInternalLinks.length;
      technical.brokenInternalLinks = brokenInternalLinks;
    } catch (err) {
      console.error('Link graph analysis failed for audit', auditId, ':', err.message);
    }

    try {
      const crawledPages = await duplicateContent.fetchCrawledPages(auditId);
      const thinContentPages = duplicateContent.flagThinContent(crawledPages);
      const duplicateContentGroups = duplicateContent.detectDuplicates(crawledPages);
      technical.thinContentCount = thinContentPages.length;
      technical.thinContentPages = thinContentPages;
      technical.duplicateContentGroupsCount = duplicateContentGroups.length;
      technical.duplicateContentGroups = duplicateContentGroups;
    } catch (err) {
      console.error('Thin/duplicate content analysis failed for audit', auditId, ':', err.message);
    }
  }

  const keywords =
    categories.includes('keywords') && content?.title
      ? await dataforseo.getKeywordIdeas(content.title).catch(() => null)
      : null;

  // Content gap vs SERP (Pro/Agency, "keywords" category only — it fires a
  // paid SERP call plus a Claude call per target keyword). Target keywords
  // are the highest-volume ideas already fetched above for this page, so
  // there's no separate "target keyword" input to collect from the user.
  // Each keyword is analyzed independently and a failure on one never blocks
  // the others or the rest of the audit.
  let contentGapResult = null;
  if (categories.includes('keywords') && content && keywords?.length) {
    const targetKeywords = [...keywords]
      .filter((k) => k.keyword)
      .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
      .slice(0, CONTENT_GAP_MAX_KEYWORDS)
      .map((k) => k.keyword);

    contentGapResult = (
      await Promise.all(
        targetKeywords.map((kw) =>
          analyzeContentGapForKeyword(kw, domain, content, language).catch((err) => {
            console.error('Content gap analysis failed for audit', auditId, 'keyword', kw, ':', err.response?.data || err.message);
            return null;
          })
        )
      )
    ).filter(Boolean);
  }

  // Same per-keyword serpFeatures gathered above (one DataForSEO SERP call,
  // no extra fetch here) is handed to Claude so it can suggest reformatting
  // toward an unoccupied featured snippet / People Also Ask, alongside the
  // rest of the audit's fixes.
  const serpOpportunities = contentGapResult?.length
    ? contentGapResult.map(({ keyword, serpFeatures }) => ({ keyword, serpFeatures }))
    : null;

  const aiRecommendations = await claude
    .generateRecommendations({
      domain,
      technical,
      content,
      keywords,
      backlinks,
      coreWebVitals: coreWebVitalsResult,
      crawlability: crawlabilityResult,
      serpOpportunities,
      language,
    })
    .catch(() => []);

  const penalty = aiRecommendations.reduce((sum, fix) => {
    if (fix.severity === 'high') return sum + 15;
    if (fix.severity === 'medium') return sum + 7;
    if (fix.severity === 'low') return sum + 3;
    return sum;
  }, 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  // The full sitemap URL list only exists to feed the orphan-page check
  // above — drop it before persisting so sitemap_result doesn't balloon on
  // sites with large sitemaps.
  const { urls: _sitemapUrls, ...sitemapForStorage } = crawlabilityResult?.sitemap ?? {};

  await pool.query(
    `UPDATE audits SET status = 'completed', technical_result = $1, content_result = $2,
     keyword_result = $3, backlink_result = $4, ai_recommendations = $5, score = $6, gsc_result = $7,
     core_web_vitals = $8, robots_txt_result = $9, sitemap_result = $10, content_gap_result = $11,
     backlink_gap_result = $12, completed_at = now()
     WHERE id = $13`,
    [
      technical,
      content,
      JSON.stringify(keywords),
      backlinks,
      JSON.stringify(aiRecommendations),
      score,
      JSON.stringify(gscResult),
      JSON.stringify(coreWebVitalsResult),
      JSON.stringify(crawlabilityResult?.robotsTxt ?? null),
      JSON.stringify(crawlabilityResult?.sitemap ? sitemapForStorage : null),
      JSON.stringify(contentGapResult),
      JSON.stringify(backlinkGap),
      auditId,
    ]
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

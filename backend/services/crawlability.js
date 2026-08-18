const axios = require('axios');
const cheerio = require('cheerio');

// Overridable so tests can check dead-link sampling against a small fixture
// sitemap without needing 10 distinct sample URLs.
const SITEMAP_SAMPLE_SIZE = Number(process.env.CRAWLABILITY_SITEMAP_SAMPLE_SIZE) || 10;

// String concatenation rather than `new URL('/robots.txt', base)`: a real
// domain is always passed as a bare origin, but this also lets tests use a
// path-prefixed base (e.g. http://localhost:PORT/site-a) to run several
// fixture "sites" off one fake server, since /robots.txt and /sitemap.xml
// must otherwise always live at the exact origin root.
function toBaseUrl(domain) {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  return base.replace(/\/+$/, '');
}

// Simple line-based robots.txt parser: groups Disallow/Allow directives by
// the User-agent group they belong to (a run of "User-agent:" lines starts
// a new group, ended by the first non-user-agent directive), and collects
// Sitemap directives regardless of group.
function parseRobotsTxt(raw) {
  const rules = [];
  const sitemapUrls = [];
  let currentUserAgents = [];
  let groupStarted = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      if (groupStarted) {
        currentUserAgents = [];
        groupStarted = false;
      }
      currentUserAgents.push(value.toLowerCase());
    } else if (directive === 'disallow' || directive === 'allow') {
      groupStarted = true;
      for (const userAgent of currentUserAgents) {
        rules.push({ userAgent, type: directive, path: value });
      }
    } else if (directive === 'sitemap') {
      sitemapUrls.push(value);
    }
  }

  return { rules, sitemapUrls };
}

// A bare "Disallow: /" for the wildcard group blocks the homepage, unless a
// matching "Allow: /" is also present (Allow wins on an exact-path tie).
function isHomepageBlocked(rules) {
  const rootRules = rules.filter((r) => r.userAgent === '*' && r.path === '/');
  if (rootRules.length === 0) return false;
  return rootRules.some((r) => r.type === 'disallow') && !rootRules.some((r) => r.type === 'allow');
}

async function checkRobotsTxt(domain) {
  const robotsUrl = `${toBaseUrl(domain)}/robots.txt`;

  let raw = null;
  try {
    const response = await axios.get(robotsUrl, { timeout: 10000, validateStatus: () => true });
    if (response.status === 200) raw = typeof response.data === 'string' ? response.data : String(response.data);
  } catch {
    raw = null;
  }

  if (raw == null) {
    return { exists: false, blocksHomepage: false, sitemapUrls: [], raw: null, url: robotsUrl };
  }

  const { rules, sitemapUrls } = parseRobotsTxt(raw);
  return { exists: true, blocksHomepage: isHomepageBlocked(rules), sitemapUrls, raw, url: robotsUrl };
}

// A sitemap is considered well-formed only when it has a matching open/close
// pair for <urlset> (a plain sitemap) or <sitemapindex> (a sitemap of
// sitemaps) — good enough to catch truncated responses or HTML error pages
// served with a 200 status, without pulling in a strict XML parser.
function detectRootElement(raw) {
  if (/<sitemapindex[\s>]/i.test(raw) && /<\/sitemapindex>/i.test(raw)) return 'sitemapindex';
  if (/<urlset[\s>]/i.test(raw) && /<\/urlset>/i.test(raw)) return 'urlset';
  return null;
}

async function findBrokenUrls(urls) {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await axios.get(url, { timeout: 8000, validateStatus: () => true });
        return response.status === 404 ? url : null;
      } catch {
        return url;
      }
    })
  );
  return results.filter(Boolean);
}

async function checkSitemap(sitemapUrl) {
  let raw = null;
  try {
    const response = await axios.get(sitemapUrl, { timeout: 10000, validateStatus: () => true });
    if (response.status === 200) raw = typeof response.data === 'string' ? response.data : String(response.data);
  } catch {
    raw = null;
  }

  if (raw == null) {
    return { exists: false, wellFormed: false, rootElement: null, urlCount: 0, brokenSampleUrls: [], url: sitemapUrl };
  }

  const rootElement = detectRootElement(raw);
  const wellFormed = rootElement !== null;

  const urls = wellFormed
    ? cheerio
        .load(raw, { xmlMode: true })('loc')
        .map((_, el) => el.children[0]?.data?.trim())
        .get()
        .filter(Boolean)
    : [];

  const sample = urls.slice(0, SITEMAP_SAMPLE_SIZE);
  const brokenSampleUrls = wellFormed ? await findBrokenUrls(sample) : [];

  return {
    exists: true,
    wellFormed,
    rootElement,
    urlCount: urls.length,
    sampledUrlCount: sample.length,
    brokenSampleUrls,
    url: sitemapUrl,
  };
}

async function checkCrawlability(domain) {
  const robotsTxt = await checkRobotsTxt(domain);
  const sitemapUrl = robotsTxt.sitemapUrls[0] || `${toBaseUrl(domain)}/sitemap.xml`;
  const sitemap = await checkSitemap(sitemapUrl);
  return { robotsTxt, sitemap };
}

module.exports = { checkRobotsTxt, checkSitemap, checkCrawlability, parseRobotsTxt, isHomepageBlocked };

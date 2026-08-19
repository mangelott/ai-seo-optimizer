const pool = require('../db/pool');

// Trailing-slash/case differences are the most common reason the same page
// shows up with two different URL spellings between the crawl, the sitemap,
// and links found on other pages — normalize before ever comparing URLs.
function normalizeUrlForCompare(url) {
  if (!url) return url;
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

async function buildLinkGraph(auditId) {
  const pagesResult = await pool.query('SELECT url, status_code FROM crawled_pages WHERE audit_id = $1', [auditId]);
  const linksResult = await pool.query(
    `SELECT cp.url AS from_url, pl.to_url, pl.anchor_text
     FROM page_links pl
     JOIN crawled_pages cp ON cp.id = pl.from_page_id
     WHERE pl.audit_id = $1`,
    [auditId]
  );

  return {
    pages: pagesResult.rows.map((p) => ({ url: p.url, statusCode: p.status_code })),
    links: linksResult.rows.map((l) => ({ fromUrl: l.from_url, toUrl: l.to_url, anchorText: l.anchor_text })),
  };
}

// Sitemap URLs with no internal link pointing to them anywhere in the graph.
function detectOrphanPages(graph, sitemapUrls) {
  const linkedUrls = new Set(graph.links.map((l) => normalizeUrlForCompare(l.toUrl)));
  return sitemapUrls.filter((url) => !linkedUrls.has(normalizeUrlForCompare(url)));
}

// Internal links whose target was crawled and came back 4xx/5xx.
function detectBrokenInternalLinks(graph) {
  const statusByUrl = new Map(
    graph.pages.filter((p) => p.statusCode >= 400).map((p) => [normalizeUrlForCompare(p.url), p.statusCode])
  );

  return graph.links
    .filter((l) => statusByUrl.has(normalizeUrlForCompare(l.toUrl)))
    .map((l) => ({
      fromUrl: l.fromUrl,
      toUrl: l.toUrl,
      anchorText: l.anchorText ?? null,
      statusCode: statusByUrl.get(normalizeUrlForCompare(l.toUrl)),
    }));
}

module.exports = { buildLinkGraph, detectOrphanPages, detectBrokenInternalLinks, normalizeUrlForCompare };

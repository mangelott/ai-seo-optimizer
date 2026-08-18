// Tests for services/crawlability.js. The pure parsing/grouping logic
// (parseRobotsTxt, isHomepageBlocked) is exercised directly with no network
// involved. checkRobotsTxt/checkSitemap/checkCrawlability are exercised
// against one local Express server (in the pattern of test/siteCrawl.test.js
// and test/coreWebVitals.test.js) with several fixture "sites" mounted at
// different path prefixes — robots.txt and sitemap.xml must always live at
// the exact origin root, so each fixture site gets its own prefix rather
// than its own port.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  checkRobotsTxt,
  checkSitemap,
  checkCrawlability,
  parseRobotsTxt,
  isHomepageBlocked,
} = require('../services/crawlability');

let fakeServer;
let baseUrl;

function buildFakeServer() {
  const api = express();

  // Blocks the entire site by mistake: a bare "Disallow: /" for everyone.
  api.get('/blocked-site/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  // Healthy site: robots.txt allows everything and points at a valid
  // sitemap with two live URLs.
  api.get('/healthy-site/robots.txt', (req, res) => {
    res
      .type('text/plain')
      .send(`User-agent: *\nDisallow:\n\nSitemap: http://${req.headers.host}/healthy-site/sitemap.xml\n`);
  });
  api.get('/healthy-site/sitemap.xml', (req, res) => {
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://${req.headers.host}/healthy-site/page-a</loc></url>
  <url><loc>http://${req.headers.host}/healthy-site/page-b</loc></url>
</urlset>`);
  });
  api.get('/healthy-site/page-a', (req, res) => res.send('ok'));
  api.get('/healthy-site/page-b', (req, res) => res.send('ok'));

  // Sitemap references a URL that 404s.
  api.get('/deadlinks-site/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\n');
  });
  api.get('/deadlinks-site/sitemap.xml', (req, res) => {
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://${req.headers.host}/deadlinks-site/ok</loc></url>
  <url><loc>http://${req.headers.host}/deadlinks-site/gone</loc></url>
</urlset>`);
  });
  api.get('/deadlinks-site/ok', (req, res) => res.send('ok'));
  api.get('/deadlinks-site/gone', (req, res) => res.status(404).send('not found'));

  // Sitemap URL responds 200 but with an HTML error page instead of XML —
  // a common real-world case (e.g. a CMS 404 page served without a 404 status).
  api.get('/malformed-site/sitemap.xml', (req, res) => {
    res.type('text/html').send('<html><body>Not Found</body></html>');
  });

  // /missing-site/* has no routes at all: robots.txt and sitemap.xml both 404.

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeServer = buildFakeServer().listen(0, resolve);
  });
  baseUrl = `http://localhost:${fakeServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
});

test('parseRobotsTxt: groups Disallow/Allow by the preceding User-agent lines and collects Sitemap directives', () => {
  const raw = `# comment
User-agent: *
Disallow: /admin

User-agent: Googlebot
User-agent: Bingbot
Disallow: /private
Allow: /private/public-page

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml`;

  const { rules, sitemapUrls } = parseRobotsTxt(raw);

  assert.deepEqual(
    rules.filter((r) => r.userAgent === '*'),
    [{ userAgent: '*', type: 'disallow', path: '/admin' }]
  );
  assert.deepEqual(
    rules.filter((r) => r.userAgent === 'googlebot'),
    [
      { userAgent: 'googlebot', type: 'disallow', path: '/private' },
      { userAgent: 'googlebot', type: 'allow', path: '/private/public-page' },
    ]
  );
  assert.deepEqual(
    rules.filter((r) => r.userAgent === 'bingbot'),
    [
      { userAgent: 'bingbot', type: 'disallow', path: '/private' },
      { userAgent: 'bingbot', type: 'allow', path: '/private/public-page' },
    ]
  );
  assert.deepEqual(sitemapUrls, ['https://example.com/sitemap.xml', 'https://example.com/sitemap-news.xml']);
});

test('isHomepageBlocked: true when "*" has a bare "Disallow: /" and no matching "Allow: /"', () => {
  const { rules } = parseRobotsTxt('User-agent: *\nDisallow: /\n');
  assert.equal(isHomepageBlocked(rules), true);
});

test('isHomepageBlocked: false when "*" only disallows a specific subpath', () => {
  const { rules } = parseRobotsTxt('User-agent: *\nDisallow: /admin\n');
  assert.equal(isHomepageBlocked(rules), false);
});

test('isHomepageBlocked: false when an "Allow: /" for "*" overrides the "Disallow: /"', () => {
  const { rules } = parseRobotsTxt('User-agent: *\nDisallow: /\nAllow: /\n');
  assert.equal(isHomepageBlocked(rules), false);
});

test('isHomepageBlocked: false when the blocking rule targets a specific bot, not "*"', () => {
  const { rules } = parseRobotsTxt('User-agent: SomeBot\nDisallow: /\n');
  assert.equal(isHomepageBlocked(rules), false);
});

test('checkRobotsTxt: detects a homepage blocked by mistake and extracts sitemap URLs', async () => {
  const result = await checkRobotsTxt(`${baseUrl}/blocked-site`);
  assert.equal(result.exists, true);
  assert.equal(result.blocksHomepage, true);
  assert.deepEqual(result.sitemapUrls, []);
});

test('checkRobotsTxt: healthy site is not blocked and its Sitemap directive is extracted', async () => {
  const result = await checkRobotsTxt(`${baseUrl}/healthy-site`);
  assert.equal(result.exists, true);
  assert.equal(result.blocksHomepage, false);
  assert.deepEqual(result.sitemapUrls, [`${baseUrl}/healthy-site/sitemap.xml`]);
});

test('checkRobotsTxt: missing robots.txt reports exists: false without throwing', async () => {
  const result = await checkRobotsTxt(`${baseUrl}/missing-site`);
  assert.equal(result.exists, false);
  assert.equal(result.blocksHomepage, false);
});

test('checkSitemap: well-formed sitemap with all-live URLs reports no broken links', async () => {
  const result = await checkSitemap(`${baseUrl}/healthy-site/sitemap.xml`);
  assert.equal(result.exists, true);
  assert.equal(result.wellFormed, true);
  assert.equal(result.rootElement, 'urlset');
  assert.equal(result.urlCount, 2);
  assert.deepEqual(result.brokenSampleUrls, []);
});

test('checkSitemap: flags a 404 URL found in the sampled sitemap entries', async () => {
  const result = await checkSitemap(`${baseUrl}/deadlinks-site/sitemap.xml`);
  assert.equal(result.wellFormed, true);
  assert.equal(result.urlCount, 2);
  assert.deepEqual(result.brokenSampleUrls, [`${baseUrl}/deadlinks-site/gone`]);
});

test('checkSitemap: a 200 response that is not valid sitemap XML is reported as not well-formed', async () => {
  const result = await checkSitemap(`${baseUrl}/malformed-site/sitemap.xml`);
  assert.equal(result.exists, true);
  assert.equal(result.wellFormed, false);
  assert.equal(result.rootElement, null);
  assert.equal(result.urlCount, 0);
});

test('checkSitemap: a missing sitemap.xml reports exists: false without throwing', async () => {
  const result = await checkSitemap(`${baseUrl}/missing-site/sitemap.xml`);
  assert.equal(result.exists, false);
  assert.equal(result.wellFormed, false);
});

test('checkCrawlability: uses the Sitemap URL declared in robots.txt when present', async () => {
  const result = await checkCrawlability(`${baseUrl}/healthy-site`);
  assert.equal(result.robotsTxt.blocksHomepage, false);
  assert.equal(result.sitemap.url, `${baseUrl}/healthy-site/sitemap.xml`);
  assert.equal(result.sitemap.wellFormed, true);
});

test('checkCrawlability: falls back to /sitemap.xml when robots.txt declares none', async () => {
  const result = await checkCrawlability(`${baseUrl}/deadlinks-site`);
  assert.deepEqual(result.robotsTxt.sitemapUrls, []);
  assert.equal(result.sitemap.url, `${baseUrl}/deadlinks-site/sitemap.xml`);
  assert.deepEqual(result.sitemap.brokenSampleUrls, [`${baseUrl}/deadlinks-site/gone`]);
});

test('checkCrawlability: a site with neither robots.txt nor sitemap.xml degrades cleanly', async () => {
  const result = await checkCrawlability(`${baseUrl}/missing-site`);
  assert.equal(result.robotsTxt.exists, false);
  assert.equal(result.sitemap.exists, false);
});

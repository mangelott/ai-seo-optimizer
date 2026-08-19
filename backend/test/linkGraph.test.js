// Tests for services/linkGraph.js's pure detection logic (detectOrphanPages,
// detectBrokenInternalLinks, normalizeUrlForCompare) against a small synthetic
// graph — no database, no network. buildLinkGraph itself (the DB-touching
// part) is exercised end-to-end via test/siteCrawl.test.js instead, in the
// pattern of how crawlability.test.js splits pure parsing tests from the
// network-backed checkRobotsTxt/checkSitemap tests.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectOrphanPages, detectBrokenInternalLinks, normalizeUrlForCompare } = require('../services/linkGraph');

// A 6-page synthetic site: home links to about/blog/broken-target, blog
// links to post-1, and post-1 links back to home. /contact is in the
// sitemap but nothing links to it (the orphan case). /broken-target is
// linked from home but crawled as a 404 (the broken-link case).
const PAGES = [
  { url: 'https://site.com/', statusCode: 200 },
  { url: 'https://site.com/about', statusCode: 200 },
  { url: 'https://site.com/blog', statusCode: 200 },
  { url: 'https://site.com/blog/post-1', statusCode: 200 },
  { url: 'https://site.com/broken-target', statusCode: 404 },
  { url: 'https://site.com/contact', statusCode: 200 },
];

const LINKS = [
  { fromUrl: 'https://site.com/', toUrl: 'https://site.com/about', anchorText: 'About' },
  { fromUrl: 'https://site.com/', toUrl: 'https://site.com/blog', anchorText: 'Blog' },
  { fromUrl: 'https://site.com/', toUrl: 'https://site.com/broken-target', anchorText: 'Old page' },
  { fromUrl: 'https://site.com/blog', toUrl: 'https://site.com/blog/post-1', anchorText: 'Post 1' },
  { fromUrl: 'https://site.com/blog/post-1', toUrl: 'https://site.com/', anchorText: 'Home' },
];

const SITEMAP_URLS = [
  'https://site.com/',
  'https://site.com/about',
  'https://site.com/blog',
  'https://site.com/blog/post-1',
  'https://site.com/contact',
];

function buildGraph() {
  return { pages: PAGES, links: LINKS };
}

test('normalizeUrlForCompare: strips trailing slashes, lowercases, and trims whitespace', () => {
  assert.equal(normalizeUrlForCompare('https://Site.com/About/'), 'https://site.com/about');
  assert.equal(normalizeUrlForCompare(' https://site.com/about '), 'https://site.com/about');
  assert.equal(normalizeUrlForCompare(null), null);
});

test('detectOrphanPages: finds the exact sitemap URL with no incoming internal link', () => {
  const orphans = detectOrphanPages(buildGraph(), SITEMAP_URLS);
  assert.deepEqual(orphans, ['https://site.com/contact']);
});

test('detectOrphanPages: a trailing-slash mismatch between sitemap and link target still counts as linked', () => {
  const graph = {
    pages: PAGES,
    links: [{ fromUrl: 'https://site.com/', toUrl: 'https://site.com/about/', anchorText: 'About' }],
  };
  const orphans = detectOrphanPages(graph, ['https://site.com/about']);
  assert.deepEqual(orphans, []);
});

test('detectOrphanPages: returns an empty list when every sitemap URL is linked', () => {
  const orphans = detectOrphanPages(buildGraph(), SITEMAP_URLS.filter((u) => u !== 'https://site.com/contact'));
  assert.deepEqual(orphans, []);
});

test('detectBrokenInternalLinks: finds the exact link pointing at a 4xx/5xx crawled page', () => {
  const broken = detectBrokenInternalLinks(buildGraph());
  assert.deepEqual(broken, [
    { fromUrl: 'https://site.com/', toUrl: 'https://site.com/broken-target', anchorText: 'Old page', statusCode: 404 },
  ]);
});

test('detectBrokenInternalLinks: ignores links to pages that crawled cleanly', () => {
  const graph = { pages: PAGES, links: LINKS.filter((l) => l.toUrl !== 'https://site.com/broken-target') };
  assert.deepEqual(detectBrokenInternalLinks(graph), []);
});

test('detectBrokenInternalLinks: a link to a URL that was never crawled is not reported as broken', () => {
  const graph = {
    pages: PAGES,
    links: [{ fromUrl: 'https://site.com/', toUrl: 'https://site.com/never-crawled', anchorText: 'External-ish' }],
  };
  assert.deepEqual(detectBrokenInternalLinks(graph), []);
});

test('detectBrokenInternalLinks: multiple links to the same broken page are all reported', () => {
  const graph = {
    pages: PAGES,
    links: [
      { fromUrl: 'https://site.com/', toUrl: 'https://site.com/broken-target', anchorText: 'Link A' },
      { fromUrl: 'https://site.com/about', toUrl: 'https://site.com/broken-target', anchorText: 'Link B' },
    ],
  };
  const broken = detectBrokenInternalLinks(graph);
  assert.equal(broken.length, 2);
  assert.deepEqual(broken.map((b) => b.anchorText).sort(), ['Link A', 'Link B']);
});

// Tests for services/logAnalysis.js's pure parsing/comparison logic against
// a small synthetic Combined Log Format fixture — no database, no network.
// The DB-touching part (routes/logAnalysis.js: fetching crawled_pages,
// persisting the upload) is exercised end-to-end via test/logAnalysisRoute.test.js
// instead, same split as linkGraph.test.js vs siteCrawl.test.js.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyBot, parseLogLine, parseLogContent, compareWithCrawledPages, normalizePath } = require('../services/logAnalysis');

// A handful of Combined Log Format lines: two known bots (Googlebot hits
// /, /about twice, /old-page which the crawl no longer knows about; Bingbot
// hits / once), one regular browser request (must be ignored — not a bot),
// and one malformed line (must be counted as skipped, not crash parsing).
const SAMPLE_LOG = [
  '66.249.66.1 - - [10/Aug/2026:13:55:36 +0000] "GET / HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '66.249.66.1 - - [10/Aug/2026:13:56:02 +0000] "GET /about HTTP/1.1" 200 980 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '66.249.66.1 - - [11/Aug/2026:09:12:44 +0000] "GET /about/ HTTP/1.1" 200 980 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '66.249.66.1 - - [11/Aug/2026:09:14:10 +0000] "GET /old-page HTTP/1.1" 404 512 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '157.55.39.2 - - [10/Aug/2026:14:02:19 +0000] "GET / HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"',
  '203.0.113.9 - - [10/Aug/2026:14:10:00 +0000] "GET /about HTTP/1.1" 200 980 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
  'this is not a valid access log line',
].join('\n');

test('classifyBot: matches known bot user agents, ignores regular browsers', () => {
  assert.equal(classifyBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot');
  assert.equal(classifyBot('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'), 'Bingbot');
  assert.equal(classifyBot('Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)'), 'GPTBot');
  assert.equal(classifyBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), null);
  assert.equal(classifyBot(null), null);
});

test('parseLogLine: extracts fields from a Combined Log Format line', () => {
  const entry = parseLogLine(
    '66.249.66.1 - - [10/Aug/2026:13:55:36 +0000] "GET /about HTTP/1.1" 200 980 "-" "Googlebot/2.1"'
  );
  assert.equal(entry.ip, '66.249.66.1');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.path, '/about');
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.userAgent, 'Googlebot/2.1');
});

test('parseLogLine: returns null for a malformed line instead of throwing', () => {
  assert.equal(parseLogLine('this is not a valid access log line'), null);
});

test('normalizePath: strips trailing slash and query string', () => {
  assert.equal(normalizePath('/about/'), '/about');
  assert.equal(normalizePath('/about?utm_source=x'), '/about');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
});

test('parseLogContent: buckets hits by bot, normalizes paths, skips malformed/non-bot lines', () => {
  const { linesParsed, linesSkipped, botHitsSummary } = parseLogContent(SAMPLE_LOG);

  // 6 well-formed lines (bot and non-bot), 1 malformed line skipped.
  assert.equal(linesParsed, 6);
  assert.equal(linesSkipped, 1);

  assert.equal(botHitsSummary.Googlebot.totalRequests, 4);
  // /about and /about/ normalize to the same path, so uniquePaths is 3 (/, /about, /old-page), not 4.
  assert.equal(botHitsSummary.Googlebot.uniquePaths, 3);
  assert.equal(botHitsSummary.Googlebot.paths['/about'].count, 2);
  assert.deepEqual(botHitsSummary.Googlebot.paths['/old-page'].statusCodes, [404]);

  assert.equal(botHitsSummary.Bingbot.totalRequests, 1);
  assert.equal(botHitsSummary.Bingbot.uniquePaths, 1);

  // The regular browser request must not show up as any bot's traffic.
  assert.equal(Object.keys(botHitsSummary).length, 2);
});

test('compareWithCrawledPages: finds crawled pages never visited by the bot, and bot paths outside the crawl', () => {
  const { botHitsSummary } = parseLogContent(SAMPLE_LOG);
  const crawledPages = [
    { url: 'https://example.com/' },
    { url: 'https://example.com/about' },
    { url: 'https://example.com/contact' }, // crawled but Googlebot never hit it
  ];

  const comparison = compareWithCrawledPages(botHitsSummary, crawledPages);

  assert.deepEqual(comparison.Googlebot.crawledButNeverVisited, ['/contact']);
  // /old-page was requested by Googlebot but the crawl doesn't know about it.
  assert.deepEqual(comparison.Googlebot.visitedButNotCrawled, ['/old-page']);
  assert.equal(comparison.Googlebot.mostVisitedPaths[0].path, '/about');
  assert.equal(comparison.Googlebot.mostVisitedPaths[0].count, 2);

  assert.deepEqual(comparison.Bingbot.crawledButNeverVisited, ['/about', '/contact']);
  assert.deepEqual(comparison.Bingbot.visitedButNotCrawled, []);
});

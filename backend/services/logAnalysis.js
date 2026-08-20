// Pure parsing/comparison logic for server access-log uploads (Agency plan,
// see routes/logAnalysis.js). No network calls and no DB access here — the
// route handles fetching crawled_pages and persisting the result, the same
// split as services/linkGraph.js (buildLinkGraph touches the DB, detection
// functions are pure) and services/crawlability.js.

// Matches the Combined Log Format used by Apache/Nginx by default:
//   1.2.3.4 - - [10/Aug/2026:13:55:36 +0000] "GET /path HTTP/1.1" 200 1234 "-" "Mozilla/5.0 ..."
const LOG_LINE_REGEX = /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/;

// Matched against the request's User-Agent header, case-insensitively.
// Order doesn't matter — each pattern is specific enough not to collide.
const KNOWN_BOTS = [
  { name: 'Googlebot', pattern: /googlebot/i },
  { name: 'Bingbot', pattern: /bingbot/i },
  { name: 'GPTBot', pattern: /gptbot/i },
  { name: 'ClaudeBot', pattern: /claudebot/i },
  { name: 'PerplexityBot', pattern: /perplexitybot/i },
  { name: 'Applebot', pattern: /applebot/i },
];

function classifyBot(userAgent) {
  if (!userAgent) return null;
  const bot = KNOWN_BOTS.find((b) => b.pattern.test(userAgent));
  return bot ? bot.name : null;
}

function parseLogLine(line) {
  const match = LOG_LINE_REGEX.exec(line.trim());
  if (!match) return null;
  const [, ip, timestamp, method, path, statusCode, userAgent] = match;
  return { ip, timestamp, method, path, statusCode: parseInt(statusCode, 10), userAgent };
}

// Trailing-slash differences are the most common reason the same page shows
// up under two different path spellings between the log and crawled_pages —
// same normalization approach as services/linkGraph.js's normalizeUrlForCompare.
function normalizePath(path) {
  if (!path) return '/';
  const withoutQuery = path.split('?')[0];
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function urlToPath(url) {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return normalizePath(url);
  }
}

// Parses raw access-log text and buckets requests by known bot. Lines that
// don't match the Combined Log Format, and lines from non-bot traffic
// (regular browsers, unknown user agents), are counted but not kept —
// keeping every raw request would make bot_hits grow unbounded with real
// site traffic instead of just the sliver worth comparing against a crawl.
function parseLogContent(content) {
  const lines = content.split('\n').filter((line) => line.trim());

  let linesParsed = 0;
  let linesSkipped = 0;
  const botHits = new Map(); // botName -> Map(normalizedPath -> { count, statusCodes: Set, lastSeenAt })

  for (const line of lines) {
    const entry = parseLogLine(line);
    if (!entry) {
      linesSkipped += 1;
      continue;
    }
    linesParsed += 1;

    const botName = classifyBot(entry.userAgent);
    if (!botName) continue;

    if (!botHits.has(botName)) botHits.set(botName, new Map());
    const paths = botHits.get(botName);
    const path = normalizePath(entry.path);
    const existing = paths.get(path) || { count: 0, statusCodes: new Set(), lastSeenAt: null };
    existing.count += 1;
    existing.statusCodes.add(entry.statusCode);
    existing.lastSeenAt = entry.timestamp;
    paths.set(path, existing);
  }

  const botHitsSummary = {};
  for (const [botName, paths] of botHits.entries()) {
    const pathEntries = {};
    let totalRequests = 0;
    for (const [path, hit] of paths.entries()) {
      pathEntries[path] = { count: hit.count, statusCodes: [...hit.statusCodes], lastSeenAt: hit.lastSeenAt };
      totalRequests += hit.count;
    }
    botHitsSummary[botName] = { totalRequests, uniquePaths: paths.size, paths: pathEntries };
  }

  return { linesParsed, linesSkipped, botHitsSummary };
}

// Compares what each bot actually requested against what the Phase 1
// site-wide crawl (services/siteCrawl.js) found for the domain — per bot,
// which crawled pages it never actually visited, which paths it visited
// that the crawl never found, and its most-requested paths by frequency.
function compareWithCrawledPages(botHitsSummary, crawledPages) {
  const crawledPaths = new Set(crawledPages.map((p) => urlToPath(p.url)));

  const comparison = {};
  for (const [botName, hit] of Object.entries(botHitsSummary)) {
    const visitedPaths = Object.keys(hit.paths);
    const visitedSet = new Set(visitedPaths.map(normalizePath));

    comparison[botName] = {
      totalRequests: hit.totalRequests,
      uniquePaths: hit.uniquePaths,
      crawledButNeverVisited: [...crawledPaths].filter((p) => !visitedSet.has(p)).sort(),
      visitedButNotCrawled: visitedPaths.filter((p) => !crawledPaths.has(normalizePath(p))).sort(),
      mostVisitedPaths: visitedPaths
        .map((path) => ({ path, count: hit.paths[path].count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }
  return comparison;
}

module.exports = { classifyBot, parseLogLine, parseLogContent, compareWithCrawledPages, normalizePath, urlToPath, KNOWN_BOTS };

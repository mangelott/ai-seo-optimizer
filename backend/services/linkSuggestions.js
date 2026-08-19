const linkGraph = require('./linkGraph');
const duplicateContent = require('./duplicateContent');

const MAX_SUGGESTIONS = 5;

// No keyword extraction exists anywhere in the codebase (contentAnalysis.js's
// h1s/wordCount only cover a single fetched page, not the whole site-wide
// crawl) — the only per-page topic signal available for every crawled page is
// its <title>. So "topical similarity" here is plain word overlap between
// titles: strip accents/punctuation, drop stopwords and short words, and
// compare what's left as sets. Crude, but the same "good enough for the
// obvious cases" tradeoff duplicateContent.js makes for its title shingles.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'are', 'this', 'that', 'your', 'you', 'how', 'what', 'why', 'from',
  'para', 'com', 'como', 'que', 'este', 'esta', 'dos', 'das', 'uma', 'um', 'sobre', 'mais',
]);

function tokenizeTitle(title) {
  if (!title) return new Set();
  const normalized = title
    .toLowerCase()
    .normalize('NFD')
    // Combining diacritical marks left behind by NFD normalization (e.g. the
    // accent split off of "e" in "ténis"): strip anything outside printable
    // ASCII/whitespace before collapsing remaining punctuation.
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return new Set(normalized.split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

function titleTopicOverlap(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return 0;
  const shared = [...tokensA].filter((t) => tokensB.has(t)).length;
  if (!shared) return 0;
  const union = new Set([...tokensA, ...tokensB]).size;
  return Math.round((shared / union) * 100) / 100;
}

const BOILERPLATE_MIN_PAGES = 5;
const BOILERPLATE_TOKEN_RATIO = 0.8;

// CMS-generated titles are commonly "Page Topic | Site Name" — the site-name
// part repeats on nearly every page and, left in, inflates the overlap score
// between otherwise unrelated pages (e.g. "About Us | Acme Shop" would look
// 33% similar to "Running Shoes Guide | Acme Shop" on "acme"/"shop" alone).
// Rather than guess at a "| Site Name" pattern with a separator regex (too
// easy to misfire on a title whose real topic contains a hyphen or pipe),
// treat any token appearing in most crawled titles as structural noise and
// exclude it from every comparison. Requires a decent sample so a small site
// genuinely focused on one topic doesn't have its real keywords stripped.
function findBoilerplateTokens(titleTokenSets) {
  if (titleTokenSets.length < BOILERPLATE_MIN_PAGES) return new Set();
  const pageCountByToken = new Map();
  for (const tokens of titleTokenSets) {
    for (const t of tokens) pageCountByToken.set(t, (pageCountByToken.get(t) ?? 0) + 1);
  }
  const threshold = titleTokenSets.length * BOILERPLATE_TOKEN_RATIO;
  return new Set([...pageCountByToken].filter(([, count]) => count >= threshold).map(([t]) => t));
}

function withoutTokens(tokens, exclude) {
  if (!exclude.size) return tokens;
  return new Set([...tokens].filter((t) => !exclude.has(t)));
}

// Pure logic, given an already-built link graph (linkGraph.buildLinkGraph)
// and crawled-page rows (duplicateContent.fetchCrawledPages): for one target
// page, find other pages on the site that are topically related but don't
// already link to it, ranked by relevance.
function computeInternalLinkSuggestions(graph, crawledPages, targetPageUrl, maxSuggestions = MAX_SUGGESTIONS) {
  const normalizedTarget = linkGraph.normalizeUrlForCompare(targetPageUrl);
  const targetPage = crawledPages.find((p) => linkGraph.normalizeUrlForCompare(p.url) === normalizedTarget);
  if (!targetPage || !targetPage.title) return [];

  const boilerplateTokens = findBoilerplateTokens(crawledPages.filter((p) => p.title).map((p) => tokenizeTitle(p.title)));

  const targetTokens = withoutTokens(tokenizeTitle(targetPage.title), boilerplateTokens);
  if (!targetTokens.size) return [];

  const statusByUrl = new Map(graph.pages.map((p) => [linkGraph.normalizeUrlForCompare(p.url), p.statusCode]));
  const alreadyLinkedFrom = new Set(
    graph.links
      .filter((l) => linkGraph.normalizeUrlForCompare(l.toUrl) === normalizedTarget)
      .map((l) => linkGraph.normalizeUrlForCompare(l.fromUrl))
  );

  const candidates = crawledPages
    .filter((p) => linkGraph.normalizeUrlForCompare(p.url) !== normalizedTarget)
    .filter((p) => !alreadyLinkedFrom.has(linkGraph.normalizeUrlForCompare(p.url)))
    .filter((p) => (statusByUrl.get(linkGraph.normalizeUrlForCompare(p.url)) ?? 200) < 400)
    .map((p) => ({
      page: p,
      relevanceScore: titleTopicOverlap(targetTokens, withoutTokens(tokenizeTitle(p.title), boilerplateTokens)),
    }))
    .filter((c) => c.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || a.page.url.localeCompare(b.page.url));

  return candidates.slice(0, maxSuggestions).map(({ page, relevanceScore }) => ({
    fromUrl: page.url,
    fromTitle: page.title,
    toUrl: targetPage.url,
    toTitle: targetPage.title,
    relevanceScore,
    suggestedAnchorText: targetPage.title,
    suggestedFix: `Add an internal link from "${page.title}" (${page.url}) to "${targetPage.title}" (${targetPage.url}), using anchor text like "${targetPage.title}".`,
  }));
}

async function suggestInternalLinks(auditId, targetPageUrl, maxSuggestions = MAX_SUGGESTIONS) {
  const [graph, crawledPages] = await Promise.all([
    linkGraph.buildLinkGraph(auditId),
    duplicateContent.fetchCrawledPages(auditId),
  ]);
  return computeInternalLinkSuggestions(graph, crawledPages, targetPageUrl, maxSuggestions);
}

module.exports = {
  suggestInternalLinks,
  computeInternalLinkSuggestions,
  tokenizeTitle,
  titleTopicOverlap,
  findBoilerplateTokens,
};

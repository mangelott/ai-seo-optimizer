const { client } = require('./dataforseo');

// Matches getKeywordIdeas' defaults in services/dataforseo.js (Portugal / pt)
// so a keyword's SERP is analyzed for the same market its search volume was
// pulled for.
const DEFAULT_LOCATION_CODE = 2620;
const DEFAULT_LANGUAGE_CODE = 'pt';

// SERP item types (besides "organic", "featured_snippet", "people_also_ask")
// worth flagging to the user as "something else is occupying this SERP" —
// not exhaustively acted on, just surfaced.
const OTHER_FEATURE_TYPES = new Set([
  'video', 'images', 'top_stories', 'local_pack', 'knowledge_graph', 'related_searches', 'shopping',
]);

// Same bare-host normalization as services/rankTracking.js / services/aeoTracking.js's
// normalizeDomain + hostMatchesDomain, duplicated locally rather than shared —
// both are five-line pure functions used for a single domain-identity comparison each.
function normalizeDomain(domain) {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function hostMatchesDomain(url, bareDomain) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  return host === bareDomain || host.endsWith(`.${bareDomain}`);
}

async function fetchSerpItems(keyword, locationCode, languageCode) {
  const { data } = await client.post('/serp/google/organic/live/regular', [
    { keyword, location_code: locationCode, language_code: languageCode, depth: 10 },
  ]);
  return data.tasks?.[0]?.result?.[0]?.items ?? [];
}

function extractOrganicResults(items) {
  return items
    .filter((item) => item.type === 'organic' && item.url)
    .slice(0, 10)
    .map((item) => ({
      url: item.url,
      title: item.title ?? null,
      snippet: item.description ?? null,
      rank: item.rank_absolute ?? null,
    }));
}

// Reads the same SERP items extractOrganicResults filters down, looking for
// rich results instead of organic listings: is there a featured snippet for
// this keyword and, if so, does the user's own domain already hold it; are
// there People Also Ask questions to target; what other feature types (video,
// local pack, etc.) are competing for attention on this SERP. `userDomain` is
// optional — when omitted, featuredSnippet.occupiedByUser is always false.
function extractSerpFeatures(items, userDomain) {
  const bareDomain = userDomain ? normalizeDomain(userDomain) : null;

  const featuredSnippetItem = items.find((item) => item.type === 'featured_snippet');
  const featuredSnippet = {
    present: Boolean(featuredSnippetItem),
    url: featuredSnippetItem?.url ?? null,
    occupiedByUser: Boolean(
      bareDomain && featuredSnippetItem?.url && hostMatchesDomain(featuredSnippetItem.url, bareDomain)
    ),
  };

  const paaItem = items.find((item) => item.type === 'people_also_ask');
  const peopleAlsoAsk = {
    present: Boolean(paaItem),
    questions: (paaItem?.items ?? []).map((q) => q.title).filter(Boolean),
  };

  const otherFeatures = [...new Set(items.filter((item) => OTHER_FEATURE_TYPES.has(item.type)).map((item) => item.type))];

  return { featuredSnippet, peopleAlsoAsk, otherFeatures };
}

async function getTopResults(keyword, locationCode = DEFAULT_LOCATION_CODE, languageCode = DEFAULT_LANGUAGE_CODE) {
  const items = await fetchSerpItems(keyword, locationCode, languageCode);
  return extractOrganicResults(items);
}

// Combines getTopResults + extractSerpFeatures into a single SERP call, for
// callers (services/auditProcessor.js's content-gap flow) that need both the
// organic competitor set and the rich-result opportunities for the same
// keyword — avoids paying for the same DataForSEO SERP call twice.
async function analyzeSerp(keyword, userDomain, locationCode = DEFAULT_LOCATION_CODE, languageCode = DEFAULT_LANGUAGE_CODE) {
  const items = await fetchSerpItems(keyword, locationCode, languageCode);
  return {
    organicResults: extractOrganicResults(items),
    serpFeatures: extractSerpFeatures(items, userDomain),
  };
}

module.exports = { getTopResults, analyzeSerp, extractSerpFeatures };

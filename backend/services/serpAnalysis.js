const { client } = require('./dataforseo');

// Matches getKeywordIdeas' defaults in services/dataforseo.js (Portugal / pt)
// so a keyword's SERP is analyzed for the same market its search volume was
// pulled for.
const DEFAULT_LOCATION_CODE = 2620;
const DEFAULT_LANGUAGE_CODE = 'pt';

async function getTopResults(keyword, locationCode = DEFAULT_LOCATION_CODE, languageCode = DEFAULT_LANGUAGE_CODE) {
  const { data } = await client.post('/serp/google/organic/live/regular', [
    { keyword, location_code: locationCode, language_code: languageCode, depth: 10 },
  ]);
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];

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

module.exports = { getTopResults };

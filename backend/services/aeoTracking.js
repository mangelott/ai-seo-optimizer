const axios = require('axios');

// Overridable so tests can point these at a local fake server instead of
// stubbing every method — same pattern as DATAFORSEO_API_BASE_URL in
// services/dataforseo.js.
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
const PERPLEXITY_API_BASE_URL = process.env.PERPLEXITY_API_BASE_URL || 'https://api.perplexity.ai';

async function queryChatGPT(query) {
  const { data } = await axios.post(
    `${OPENAI_API_BASE_URL}/chat/completions`,
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: query }] },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return data.choices?.[0]?.message?.content ?? '';
}

async function queryPerplexity(query) {
  const { data } = await axios.post(
    `${PERPLEXITY_API_BASE_URL}/chat/completions`,
    { model: 'sonar', messages: [{ role: 'user', content: query }] },
    { headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` } }
  );
  return data.choices?.[0]?.message?.content ?? '';
}

// Google's AI Overview has no official API. DataForSEO's SERP endpoints
// (services/dataforseo.js, services/serpAnalysis.js) only cover organic
// results, not the AI Overview module content, so this project doesn't
// currently have a source for it through a provider it already pays for.
// Building an unofficial scraper against Google's own results page is a
// meaningfully different (and riskier, ToS-wise) undertaking than calling
// ChatGPT/Perplexity's own APIs, so it's deliberately left unimplemented:
// this throws instead of silently returning an empty/false result, so
// callers surface "not supported" rather than reporting a false "not cited".
async function queryGoogleAiOverview() {
  throw new Error(
    'Google AI Overview tracking is not supported automatically: Google has no official API for it, ' +
      'and no SERP provider already used in this project (DataForSEO) exposes it yet.'
  );
}

function normalizeDomain(domain) {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

// A citation is the domain appearing in the response text — as a link or a
// plain-text mention. This catches the common cases (the assistant names the
// site, or links to it) without a second call to compare paraphrased
// mentions against the page's own content, which would double the API cost
// of every check for a much rarer case.
function detectCitation(responseText, domain) {
  if (!responseText) return false;
  const bareDomain = normalizeDomain(domain);
  if (!bareDomain) return false;
  return responseText.toLowerCase().includes(bareDomain.toLowerCase());
}

function snippet(responseText, maxLength = 500) {
  if (!responseText) return null;
  return responseText.length > maxLength ? `${responseText.slice(0, maxLength)}…` : responseText;
}

const PROVIDERS = {
  chatgpt: queryChatGPT,
  perplexity: queryPerplexity,
};

async function checkQuery(query, domain, provider) {
  const queryFn = PROVIDERS[provider];
  if (!queryFn) throw new Error(`Unknown AEO provider: ${provider}`);

  const responseText = await queryFn(query);
  return {
    provider,
    cited: detectCitation(responseText, domain),
    responseSnippet: snippet(responseText),
  };
}

module.exports = {
  queryChatGPT,
  queryPerplexity,
  queryGoogleAiOverview,
  detectCitation,
  checkQuery,
  PROVIDERS,
};

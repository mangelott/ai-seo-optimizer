const axios = require('axios');

// Overridable so integration tests can point this at a local fake DataForSEO
// API instead of stubbing every method — exercises the real request-building
// code in this file and in services/siteCrawl.js (which reuses this client).
const DATAFORSEO_API = process.env.DATAFORSEO_API_BASE_URL || 'https://api.dataforseo.com/v3';

const client = axios.create({
  baseURL: DATAFORSEO_API,
  auth: {
    username: process.env.DATAFORSEO_LOGIN,
    password: process.env.DATAFORSEO_PASSWORD,
  },
});

async function getOnPageAudit(domain) {
  const { data } = await client.post('/on_page/instant_pages', [
    { url: domain, enable_javascript: true },
  ]);
  return data.tasks?.[0]?.result?.[0] ?? null;
}

async function getKeywordIdeas(keyword, locationCode = 2620, languageCode = 'pt') {
  const { data } = await client.post('/keywords_data/google_ads/keywords_for_keywords/live', [
    { keywords: [keyword], location_code: locationCode, language_code: languageCode },
  ]);
  return data.tasks?.[0]?.result ?? [];
}

async function getBacklinkSummary(domain) {
  const { data } = await client.post('/backlinks/summary/live', [{ target: domain }]);
  return data.tasks?.[0]?.result?.[0] ?? null;
}

// Backlink gap vs competitors: domains that link to at least one competitor
// but not to targetDomain. Uses DataForSEO's Domain Intersection endpoint,
// which takes targets as an object keyed "1", "2", ... — targetDomain is
// always key "1" — and returns one item per referring domain, with
// intersection_result[i] set to that domain's backlink data for targets[i+1]
// (null when that referring domain has no backlink to that target).
async function getBacklinkGap(targetDomain, competitorDomains) {
  const targets = { 1: targetDomain };
  competitorDomains.forEach((domain, i) => {
    targets[i + 2] = domain;
  });

  const { data } = await client.post('/backlinks/domain_intersection/live', [{ targets }]);
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];

  return items
    .filter((item) => item.intersection_result?.[0] == null && item.intersection_result?.some((r, i) => i > 0 && r != null))
    .map((item) => item.domain);
}

module.exports = { getOnPageAudit, getKeywordIdeas, getBacklinkSummary, getBacklinkGap, client };

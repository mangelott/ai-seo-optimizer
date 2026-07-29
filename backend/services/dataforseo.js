const axios = require('axios');

const client = axios.create({
  baseURL: 'https://api.dataforseo.com/v3',
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

module.exports = { getOnPageAudit, getKeywordIdeas, getBacklinkSummary };

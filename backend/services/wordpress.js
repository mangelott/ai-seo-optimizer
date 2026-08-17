const axios = require('axios');

function authHeader(username, appPassword) {
  const token = Buffer.from(`${username}:${appPassword}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function baseUrl(wpUrl) {
  return wpUrl.replace(/\/$/, '');
}

async function ping(wpUrl, username, appPassword) {
  const { data } = await axios.get(`${baseUrl(wpUrl)}/wp-json/ai-seo-optimizer/v1/ping`, {
    headers: authHeader(username, appPassword),
    timeout: 8000,
  });
  return data;
}

async function resolvePostId(wpUrl, username, appPassword, pageUrl) {
  const { data } = await axios.get(`${baseUrl(wpUrl)}/wp-json/ai-seo-optimizer/v1/resolve`, {
    params: { url: pageUrl },
    headers: authHeader(username, appPassword),
    timeout: 8000,
  });
  return data.postId;
}

async function applyField(wpUrl, username, appPassword, { postId, field, value, target }) {
  const { data } = await axios.post(
    `${baseUrl(wpUrl)}/wp-json/ai-seo-optimizer/v1/apply`,
    { postId, field, value, target },
    { headers: authHeader(username, appPassword), timeout: 8000 }
  );
  return data;
}

module.exports = { ping, resolvePostId, applyField };

const axios = require('axios');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GSC_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GSC_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return { accessToken: data.access_token, refreshToken: data.refresh_token || null };
}

async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data.access_token;
}

async function listSites(accessToken) {
  const { data } = await axios.get(SITES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (data.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

async function querySearchAnalytics(accessToken, siteUrl) {
  const end = new Date();
  end.setDate(end.getDate() - 3); // GSC data typically lags 2-3 days
  const start = new Date(end);
  start.setDate(start.getDate() - 28);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const { data } = await axios.post(
    `${SITES_URL}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { startDate: fmt(start), endDate: fmt(end), dimensions: [] },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const row = data.rows?.[0];
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position };
}

module.exports = { getAuthUrl, exchangeCodeForTokens, refreshAccessToken, listSites, querySearchAnalytics };

const axios = require('axios');

// TODO(reuse): getAuthUrl/exchangeCodeForTokens/refreshAccessToken below are a
// third near-verbatim copy of the same OAuth authorization_code/refresh_token
// grant exchange in services/google.js and services/googleSearchConsole.js.
// Left duplicated for now (this feature was asked to follow the GSC pattern
// exactly, and extracting a shared services/googleOAuth.js touches working
// GSC/login code beyond this diff's scope) — worth its own follow-up.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// Overridable so integration tests can point these at a local fake Google
// OAuth/GA4 API instead of stubbing every method — exercises the real
// request-building code (see services/github.js's GITHUB_API_BASE_URL for
// the same pattern). TOKEN_URL is scoped to this file only (not shared with
// services/google.js / googleSearchConsole.js) so faking it in GA4 tests
// can't affect unrelated login/GSC code paths.
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const ADMIN_API = process.env.GOOGLE_ANALYTICS_ADMIN_API_BASE_URL || 'https://analyticsadmin.googleapis.com';
const DATA_API = process.env.GOOGLE_ANALYTICS_DATA_API_BASE_URL || 'https://analyticsdata.googleapis.com';

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GA4_REDIRECT_URI,
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
      redirect_uri: process.env.GA4_REDIRECT_URI,
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

// Flattens the Admin API's accountSummaries (accounts, each with nested
// propertySummaries) into one list the frontend can show as a flat picker —
// mirrors googleSearchConsole.js's listSites shape (id + human label).
async function listProperties(accessToken) {
  const { data } = await axios.get(`${ADMIN_API}/v1beta/accountSummaries`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return (data.accountSummaries || []).flatMap((account) =>
    (account.propertySummaries || []).map((p) => ({
      propertyId: p.property.replace(/^properties\//, ''),
      displayName: p.displayName,
      accountName: account.displayName,
    }))
  );
}

// Organic-search traffic quality per landing page, for the last 28 days
// ending 3 days ago — same window as googleSearchConsole.js's
// querySearchAnalytics, so the two can be crossed by page in auditProcessor.js.
// Includes hostName alongside landingPage (see crossWithGscPages below) since
// the GA4 property linked here lives on the user, not the domain being
// audited — a user auditing several domains could have this property pointed
// at any one of them, and path-only matching would silently cross-attribute
// one domain's traffic onto another's report if their paths happen to collide.
// Ordered by sessions descending and capped well above GSC's own top-pages
// cap (queryTopPages's default of 20) so the pages that matter are never
// excluded by GA4's otherwise-unbounded, arbitrarily-ordered row set on a
// large property.
// TODO(reuse): this end/start/fmt block is now duplicated a third time
// (querySearchAnalytics and queryTopPages in googleSearchConsole.js each have
// their own copy). A shared getReportingWindow() helper would guarantee the
// GSC and GA4 windows this feature depends on matching never drift apart.
async function getTrafficQuality(accessToken, propertyId) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - 28);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const { data } = await axios.post(
    `${DATA_API}/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      dateRanges: [{ startDate: fmt(start), endDate: fmt(end) }],
      dimensions: [{ name: 'hostName' }, { name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'engagementRate' }, { name: 'bounceRate' }, { name: 'conversions' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { value: 'Organic Search' },
        },
      },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 250,
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return (data.rows || []).map((row) => ({
    hostName: row.dimensionValues[0].value,
    landingPage: row.dimensionValues[1].value,
    sessions: Number(row.metricValues[0].value),
    engagementRate: Number(row.metricValues[1].value),
    bounceRate: Number(row.metricValues[2].value),
    conversions: Number(row.metricValues[3].value),
  }));
}

function normalizeHost(host) {
  return (host || '').toLowerCase().replace(/^www\./, '');
}

function pageKey(hostname, pathname) {
  return `${normalizeHost(hostname)}|${pathname}`;
}

function extractPageKey(url) {
  try {
    const parsed = new URL(url);
    return pageKey(parsed.hostname, parsed.pathname);
  } catch {
    return pageKey(null, url);
  }
}

// Crosses GSC's per-page clicks/impressions (volume) with GA4's per-landing-page
// quality (sessions/engagement/bounce/conversions) by matching (host, path) —
// the piece auditProcessor.js needs to answer "which pages bring clicks that
// don't convert" instead of just "which pages bring clicks". Matching on host
// as well as path (not path alone) matters here specifically because the GA4
// property is linked per-user, not per-domain (see getTrafficQuality above):
// without a host check, auditing two different domains that happen to share a
// path (e.g. both have "/blog/pricing") would silently attribute one
// domain's GA4 traffic to the other's report. Pages GSC reports with no
// matching GA4 (host, path) — no organic sessions in the window, GA4 not
// tracking that path, or the linked property being for a different site
// entirely — are dropped rather than shown with quality missing.
function crossWithGscPages(gscPages, ga4Pages) {
  const ga4ByKey = new Map(ga4Pages.map((p) => [pageKey(p.hostName, p.landingPage.split('?')[0]), p]));

  return gscPages
    .map((gscPage) => {
      const ga4Page = ga4ByKey.get(extractPageKey(gscPage.page));
      if (!ga4Page) return null;
      return {
        page: gscPage.page,
        clicks: gscPage.clicks,
        impressions: gscPage.impressions,
        sessions: ga4Page.sessions,
        engagementRate: ga4Page.engagementRate,
        bounceRate: ga4Page.bounceRate,
        conversions: ga4Page.conversions,
      };
    })
    .filter(Boolean);
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listProperties,
  getTrafficQuality,
  crossWithGscPages,
};

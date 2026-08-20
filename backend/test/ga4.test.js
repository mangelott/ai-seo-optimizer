// Integration tests for the GA4 integration: connection status, listing
// properties, linking a property, and disconnecting — plus direct tests of
// the request-building service code (services/googleAnalytics.js) against a
// fake Express server imitating Google's OAuth token endpoint, the GA4 Admin
// API (accountSummaries) and the GA4 Data API (runReport), so the real HTTP
// calls are exercised — not just stubbed. Mirrors test/wordpress.test.js and
// test/github.test.js. GOOGLE_OAUTH_TOKEN_URL / GOOGLE_ANALYTICS_ADMIN_API_BASE_URL
// / GOOGLE_ANALYTICS_DATA_API_BASE_URL must be set before services/googleAnalytics.js
// (or anything that requires it) is first loaded, so they're set at the very top.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const FAKE_ACCESS_TOKEN = 'fake-ga4-access-token';
const FAKE_REFRESH_TOKEN = 'a-ga4-refresh-token';
const FAKE_PROPERTY_ID = '123456';

let fakeGoogleServer;
let app;
let pool;
let googleAnalytics;
let redisConnection;
let auditQueue;
let baseUrl;

function buildFakeGoogleServer() {
  const g = express();
  g.use(express.json());
  g.use(express.urlencoded({ extended: true }));

  g.post('/token', (req, res) => {
    if (req.body.grant_type === 'refresh_token') {
      if (req.body.refresh_token !== FAKE_REFRESH_TOKEN) return res.status(400).json({ error: 'invalid_grant' });
      return res.json({ access_token: FAKE_ACCESS_TOKEN, expires_in: 3600 });
    }
    if (req.body.grant_type === 'authorization_code') {
      if (req.body.code !== 'valid-code') return res.status(400).json({ error: 'invalid_grant' });
      return res.json({ access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN, expires_in: 3600 });
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  function requireBearer(req, res, next) {
    if (req.headers.authorization !== `Bearer ${FAKE_ACCESS_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
    next();
  }

  g.get('/v1beta/accountSummaries', requireBearer, (req, res) => {
    res.json({
      accountSummaries: [
        {
          displayName: 'Acme Inc',
          propertySummaries: [{ property: `properties/${FAKE_PROPERTY_ID}`, displayName: 'Acme Site' }],
        },
      ],
    });
  });

  // Real GA4 Data API path is /v1beta/properties/{propertyId}:runReport — the
  // colon is a literal path character, not an Express route-param delimiter,
  // so it's captured as one segment and split apart here.
  g.post('/v1beta/properties/:idAndAction', requireBearer, (req, res) => {
    const [propertyId, action] = req.params.idAndAction.split(':');
    if (action !== 'runReport' || propertyId !== FAKE_PROPERTY_ID) return res.status(404).json({});

    const dimensionNames = (req.body.dimensions || []).map((d) => d.name);
    const metricNames = (req.body.metrics || []).map((m) => m.name);
    if (dimensionNames.join(',') !== 'hostName,landingPage') return res.status(400).json({ error: 'unexpected dimensions' });
    if (metricNames.join(',') !== 'sessions,engagementRate,bounceRate,conversions') {
      return res.status(400).json({ error: 'unexpected metrics' });
    }
    if (req.body.dimensionFilter?.filter?.fieldName !== 'sessionDefaultChannelGroup') {
      return res.status(400).json({ error: 'missing organic-search filter' });
    }
    if (req.body.dimensionFilter?.filter?.stringFilter?.value !== 'Organic Search') {
      return res.status(400).json({ error: 'wrong organic-search filter value' });
    }

    res.json({
      rows: [
        {
          dimensionValues: [{ value: 'example.com' }, { value: '/blog/converts-well' }],
          metricValues: [{ value: '40' }, { value: '0.7' }, { value: '0.3' }, { value: '5' }],
        },
        {
          dimensionValues: [{ value: 'example.com' }, { value: '/blog/no-clicks' }],
          metricValues: [{ value: '2' }, { value: '0.5' }, { value: '0.5' }, { value: '0' }],
        },
      ],
    });
  });

  return g;
}

async function json(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, data };
}

async function registerAndLogin(email) {
  await json('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  const { data } = await json('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  return data.token;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function connectGa4(userId, { propertyId = null } = {}) {
  await pool.query('UPDATE users SET ga4_refresh_token = $1, ga4_property_id = $2 WHERE id = $3', [
    FAKE_REFRESH_TOKEN,
    propertyId,
    userId,
  ]);
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeGoogleServer = buildFakeGoogleServer().listen(0, resolve);
  });
  const fakeBaseUrl = `http://localhost:${fakeGoogleServer.address().port}`;
  process.env.GOOGLE_OAUTH_TOKEN_URL = `${fakeBaseUrl}/token`;
  process.env.GOOGLE_ANALYTICS_ADMIN_API_BASE_URL = fakeBaseUrl;
  process.env.GOOGLE_ANALYTICS_DATA_API_BASE_URL = fakeBaseUrl;

  // Required only after the env overrides above are set, so services/googleAnalytics.js picks them up.
  app = require('../app');
  pool = require('../db/pool');
  googleAnalytics = require('../services/googleAnalytics');
  ({ connection: redisConnection, auditQueue } = require('../jobs/queue'));

  await pool.query('TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

let server;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fakeGoogleServer.close(resolve));
  await pool.end();
  // No worker runs during `npm test`, so any audits enqueued via POST /api/audit
  // above just sit in Redis — obliterate them so they don't get drained with
  // real API keys the next time the worker (merged into server.js) actually
  // starts. See test/github.test.js for the same pattern.
  await auditQueue.obliterate({ force: true });
  redisConnection.disconnect();
});

test('ga4: status reflects the connection, and disconnect clears it', async (t) => {
  const email = uniqueEmail('ga4-status');
  const token = await registerAndLogin(email);

  const before = await json('GET', '/api/ga4/status', { token });
  assert.equal(before.data.connected, false);
  assert.equal(before.data.propertyId, null);

  const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  await connectGa4(userRow.rows[0].id, { propertyId: FAKE_PROPERTY_ID });

  const after = await json('GET', '/api/ga4/status', { token });
  assert.equal(after.data.connected, true);
  assert.equal(after.data.propertyId, FAKE_PROPERTY_ID);

  const disconnect = await json('DELETE', '/api/ga4/disconnect', { token });
  assert.equal(disconnect.status, 200);
  const afterDisconnect = await json('GET', '/api/ga4/status', { token });
  assert.equal(afterDisconnect.data.connected, false);
  assert.equal(afterDisconnect.data.propertyId, null);
});

test('ga4: /properties requires a connected account and lists what the fake Admin API returns', async () => {
  const email = uniqueEmail('ga4-props');
  const token = await registerAndLogin(email);

  const blocked = await json('GET', '/api/ga4/properties', { token });
  assert.equal(blocked.status, 400);

  const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  await connectGa4(userRow.rows[0].id);

  const properties = await json('GET', '/api/ga4/properties', { token });
  assert.equal(properties.status, 200);
  assert.deepEqual(properties.data, [
    { propertyId: FAKE_PROPERTY_ID, displayName: 'Acme Site', accountName: 'Acme Inc' },
  ]);
});

test('ga4: PATCH /property links (and unlinks) a property to the current user', async () => {
  const email = uniqueEmail('ga4-link');
  const token = await registerAndLogin(email);
  const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  await connectGa4(userRow.rows[0].id);

  const linked = await json('PATCH', '/api/ga4/property', { token, body: { propertyId: FAKE_PROPERTY_ID } });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.ga4_property_id, FAKE_PROPERTY_ID);

  const unlinked = await json('PATCH', '/api/ga4/property', { token, body: { propertyId: null } });
  assert.equal(unlinked.data.ga4_property_id, null);
});

test('ga4: getTrafficQuality fetches organic landing-page quality from the real Data API request shape', async () => {
  const pages = await googleAnalytics.getTrafficQuality(FAKE_ACCESS_TOKEN, FAKE_PROPERTY_ID);
  assert.deepEqual(pages, [
    { hostName: 'example.com', landingPage: '/blog/converts-well', sessions: 40, engagementRate: 0.7, bounceRate: 0.3, conversions: 5 },
    { hostName: 'example.com', landingPage: '/blog/no-clicks', sessions: 2, engagementRate: 0.5, bounceRate: 0.5, conversions: 0 },
  ]);
});

test('ga4: crossWithGscPages joins GSC clicks with GA4 quality by (host, path), dropping pages with no GA4 match', () => {
  const gscPages = [
    { page: 'https://example.com/blog/converts-well', clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
    { page: 'https://example.com/blog/not-tracked-in-ga4', clicks: 5, impressions: 50, ctr: 0.1, position: 5 },
    // Same path as the first page, but on a different host — must not match
    // (this is the case that matters since the GA4 property is linked
    // per-user, not per-domain: it could belong to any monitored domain).
    { page: 'https://other-domain.example/blog/converts-well', clicks: 7, impressions: 70, ctr: 0.1, position: 4 },
  ];
  const ga4Pages = [
    { hostName: 'example.com', landingPage: '/blog/converts-well', sessions: 40, engagementRate: 0.7, bounceRate: 0.3, conversions: 5 },
  ];

  const crossed = googleAnalytics.crossWithGscPages(gscPages, ga4Pages);
  assert.deepEqual(crossed, [
    {
      page: 'https://example.com/blog/converts-well',
      clicks: 10,
      impressions: 100,
      sessions: 40,
      engagementRate: 0.7,
      bounceRate: 0.3,
      conversions: 5,
    },
  ]);
});

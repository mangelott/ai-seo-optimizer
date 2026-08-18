// Integration tests for services/coreWebVitals.js: DataForSEO's Lighthouse
// endpoint is tried first, falling back to PageSpeed Insights when the
// account doesn't have Lighthouse access (in the pattern of
// test/siteCrawl.test.js — fake Express servers instead of stubbing every
// method, so the real request-building/response-parsing code runs).
//
// DATAFORSEO_API_BASE_URL and PAGESPEED_API_BASE_URL must be set before
// services/dataforseo.js / services/coreWebVitals.js are first required, so
// everything is required inside test.before.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let fakeDataForSeoServer;
let fakePageSpeedServer;
let coreWebVitals;

function lighthouseAudits({ lcp, inp, cls }) {
  const audits = {};
  if (lcp != null) audits['largest-contentful-paint'] = { numericValue: lcp };
  if (inp != null) audits['interaction-to-next-paint'] = { numericValue: inp };
  if (cls != null) audits['cumulative-layout-shift'] = { numericValue: cls };
  return audits;
}

// "no-access.com" simulates a DataForSEO account without Lighthouse access
// (empty result, no audits); "slow.com" simulates a target whose Lighthouse
// audits are otherwise fine, used as a control for the happy path.
function buildFakeDataForSeoServer() {
  const api = express();
  api.use(express.json());

  api.post('/on_page/lighthouse/live/json', (req, res) => {
    const { url } = req.body[0];
    if (url.includes('no-lighthouse-access.com')) {
      return res.json({ tasks: [{ result: [{}] }] });
    }
    res.json({
      tasks: [
        {
          result: [
            {
              audits: lighthouseAudits({ lcp: 1800, inp: 150, cls: 0.05 }),
              categories: { performance: { score: 0.93 } },
            },
          ],
        },
      ],
    });
  });

  return api;
}

function buildFakePageSpeedServer() {
  const api = express();

  api.get('/runPagespeed', (req, res) => {
    const { url } = req.query;

    if (url.includes('field-data-site.com')) {
      return res.json({
        loadingExperience: {
          metrics: {
            LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4200 },
            INTERACTION_TO_NEXT_PAINT: { percentile: 550 },
            CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 30 },
          },
        },
        lighthouseResult: {
          audits: lighthouseAudits({ lcp: 3000, inp: 300, cls: 0.15 }),
          categories: { performance: { score: 0.4 } },
        },
      });
    }

    if (url.includes('lab-only-site.com')) {
      return res.json({
        lighthouseResult: {
          audits: lighthouseAudits({ lcp: 2000, inp: 100, cls: 0.02 }),
          categories: { performance: { score: 0.99 } },
        },
      });
    }

    res.status(500).json({ error: 'psi failure' });
  });

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeDataForSeoServer = buildFakeDataForSeoServer().listen(0, resolve);
  });
  await new Promise((resolve) => {
    fakePageSpeedServer = buildFakePageSpeedServer().listen(0, resolve);
  });
  process.env.DATAFORSEO_API_BASE_URL = `http://localhost:${fakeDataForSeoServer.address().port}`;
  process.env.PAGESPEED_API_BASE_URL = `http://localhost:${fakePageSpeedServer.address().port}`;

  coreWebVitals = require('../services/coreWebVitals');
});

test.after(async () => {
  await new Promise((resolve) => fakeDataForSeoServer.close(resolve));
  await new Promise((resolve) => fakePageSpeedServer.close(resolve));
});

test('classify: buckets values into good / needs-improvement / poor at Google\'s published thresholds', () => {
  assert.equal(coreWebVitals.classify('lcp', 2500), 'good');
  assert.equal(coreWebVitals.classify('lcp', 2501), 'needs-improvement');
  assert.equal(coreWebVitals.classify('lcp', 4000), 'needs-improvement');
  assert.equal(coreWebVitals.classify('lcp', 4001), 'poor');

  assert.equal(coreWebVitals.classify('inp', 200), 'good');
  assert.equal(coreWebVitals.classify('inp', 500), 'needs-improvement');
  assert.equal(coreWebVitals.classify('inp', 501), 'poor');

  assert.equal(coreWebVitals.classify('cls', 0.1), 'good');
  assert.equal(coreWebVitals.classify('cls', 0.25), 'needs-improvement');
  assert.equal(coreWebVitals.classify('cls', 0.26), 'poor');

  assert.equal(coreWebVitals.classify('lcp', null), null);
});

test('uses DataForSEO Lighthouse when it returns audits, classified against the thresholds', async () => {
  const result = await coreWebVitals.getCoreWebVitals('https://good-lighthouse-site.com');
  assert.deepEqual(result, {
    lcp: { value: 1800, rating: 'good' },
    inp: { value: 150, rating: 'good' },
    cls: { value: 0.05, rating: 'good' },
    performanceScore: 93,
  });
});

test('falls back to PageSpeed Insights when DataForSEO has no Lighthouse access, preferring field (CrUX) data', async () => {
  const result = await coreWebVitals.getCoreWebVitals('https://no-lighthouse-access.com/field-data-site.com');
  assert.deepEqual(result, {
    lcp: { value: 4200, rating: 'poor' },
    inp: { value: 550, rating: 'poor' },
    cls: { value: 0.3, rating: 'poor' },
    performanceScore: 40,
  });
});

test('PageSpeed Insights falls back to lab (Lighthouse) data when no field/CrUX data is available', async () => {
  const result = await coreWebVitals.getCoreWebVitals('https://no-lighthouse-access.com/lab-only-site.com');
  assert.deepEqual(result, {
    lcp: { value: 2000, rating: 'good' },
    inp: { value: 100, rating: 'good' },
    cls: { value: 0.02, rating: 'good' },
    performanceScore: 99,
  });
});

test('rejects when both DataForSEO and PageSpeed Insights fail, so the caller can decide how to degrade', async () => {
  await assert.rejects(coreWebVitals.getCoreWebVitals('https://no-lighthouse-access.com/totally-unknown-site.com'));
});

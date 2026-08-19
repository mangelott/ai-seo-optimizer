// Integration test for services/dataforseo.js's getBacklinkGap: exercises the
// real request-building/response-parsing code against a fake DataForSEO
// server (pattern from test/coreWebVitals.test.js), rather than mocking the
// dataforseo module itself. DATAFORSEO_API_BASE_URL must be set before
// services/dataforseo.js is first required, so it's required inside test.before.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let fakeDataForSeoServer;
let dataforseo;

// A fixed set of gap domains: "linked-to-competitor-only.com" links to a
// competitor but not the target (a real gap); "linked-to-both.com" links to
// both, so it's not a gap; "linked-to-target-only.com" only links to the
// target, also not a gap.
function buildFakeDataForSeoServer() {
  const api = express();
  api.use(express.json());

  api.post('/backlinks/domain_intersection/live', (req, res) => {
    const { targets } = req.body[0];
    assert.deepEqual(targets, { 1: 'https://my-site.com', 2: 'https://competitor-one.com', 3: 'https://competitor-two.com' });

    res.json({
      tasks: [
        {
          result: [
            {
              items: [
                { domain: 'linked-to-competitor-only.com', intersection_result: [null, { rank: 10 }, null] },
                { domain: 'linked-to-both.com', intersection_result: [{ rank: 5 }, { rank: 8 }, null] },
                { domain: 'linked-to-target-only.com', intersection_result: [{ rank: 3 }, null, null] },
                { domain: 'linked-to-neither.com', intersection_result: [null, null, null] },
                { domain: 'linked-to-second-competitor-only.com', intersection_result: [null, null, { rank: 12 }] },
              ],
            },
          ],
        },
      ],
    });
  });

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeDataForSeoServer = buildFakeDataForSeoServer().listen(0, resolve);
  });
  process.env.DATAFORSEO_API_BASE_URL = `http://localhost:${fakeDataForSeoServer.address().port}`;

  dataforseo = require('../services/dataforseo');
});

test.after(async () => {
  await new Promise((resolve) => fakeDataForSeoServer.close(resolve));
});

test('getBacklinkGap: returns domains that link to a competitor but not the target', async () => {
  const gap = await dataforseo.getBacklinkGap('https://my-site.com', ['https://competitor-one.com', 'https://competitor-two.com']);
  assert.deepEqual(gap.sort(), ['linked-to-competitor-only.com', 'linked-to-second-competitor-only.com'].sort());
});

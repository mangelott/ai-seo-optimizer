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

  api.post('/backlinks/backlinks/live', (req, res) => {
    const { target } = req.body[0];
    assert.equal(target, 'https://my-site.com');

    res.json({
      tasks: [
        {
          result: [
            {
              items: [
                { domain_from: 'spammy-link-farm.com', url_from: 'https://spammy-link-farm.com/page', backlink_spam_score: 85 },
                { domain_from: 'another-toxic-site.com', url_from: 'https://another-toxic-site.com/x', backlink_spam_score: 61 },
                { domain_from: 'reputable-blog.com', url_from: 'https://reputable-blog.com/post', backlink_spam_score: 20 },
                { domain_from: 'right-at-threshold.com', url_from: 'https://right-at-threshold.com/', backlink_spam_score: 60 },
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

test('getBacklinkSpamScore: only aggregates backlinks with a spam score above the risk threshold', async () => {
  const result = await dataforseo.getBacklinkSpamScore('https://my-site.com');

  assert.equal(result.totalBacklinksChecked, 4);
  assert.equal(result.toxicBacklinksCount, 2);
  assert.deepEqual(
    result.toxicBacklinks.map((b) => b.domainFrom).sort(),
    ['another-toxic-site.com', 'spammy-link-farm.com'].sort()
  );
  // a score exactly at the threshold is not toxic, and a clean backlink never shows up
  assert.ok(!result.toxicBacklinks.some((b) => ['right-at-threshold.com', 'reputable-blog.com'].includes(b.domainFrom)));
});

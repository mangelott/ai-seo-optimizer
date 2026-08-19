// Integration test for services/serpAnalysis.js against a fake DataForSEO
// server (in the pattern of test/coreWebVitals.test.js), so the real
// request-building/response-parsing code runs, not a stub. Fixture data
// mixes an organic result in with non-organic SERP item types (people_also_ask,
// featured_snippet) to confirm getTopResults filters those out.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let fakeServer;
let serpAnalysis;
let lastRequestBody;

function buildFakeServer() {
  const api = express();
  api.use(express.json());

  api.post('/serp/google/organic/live/regular', (req, res) => {
    lastRequestBody = req.body[0];
    const { keyword } = req.body[0];

    if (keyword === 'no-results-keyword') {
      return res.json({ tasks: [{ result: [{ items: [] }] }] });
    }

    const items = [
      { type: 'people_also_ask', rank_absolute: 1 },
      { type: 'organic', rank_absolute: 2, url: 'https://a.example.com', title: 'A', description: 'Snippet A' },
      { type: 'organic', rank_absolute: 3, url: 'https://b.example.com', title: 'B', description: 'Snippet B' },
      { type: 'featured_snippet', rank_absolute: 4 },
    ];
    // Pad to 12 organic results to confirm the 10-result cap.
    for (let i = 5; i <= 14; i++) {
      items.push({ type: 'organic', rank_absolute: i, url: `https://pad-${i}.example.com`, title: `Pad ${i}`, description: null });
    }

    res.json({ tasks: [{ result: [{ items }] }] });
  });

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeServer = buildFakeServer().listen(0, resolve);
  });
  process.env.DATAFORSEO_API_BASE_URL = `http://localhost:${fakeServer.address().port}`;

  serpAnalysis = require('../services/serpAnalysis');
});

test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
});

test('getTopResults: filters out non-organic SERP items and keeps url/title/snippet/rank', async () => {
  const results = await serpAnalysis.getTopResults('some keyword');
  assert.equal(results[0].url, 'https://a.example.com');
  assert.equal(results[0].title, 'A');
  assert.equal(results[0].snippet, 'Snippet A');
  assert.equal(results[0].rank, 2);
  assert.equal(results[1].url, 'https://b.example.com');
});

test('getTopResults: caps the result set at 10 even when more organic items are returned', async () => {
  const results = await serpAnalysis.getTopResults('some keyword');
  assert.equal(results.length, 10);
});

test('getTopResults: returns an empty array when the SERP has no results', async () => {
  const results = await serpAnalysis.getTopResults('no-results-keyword');
  assert.deepEqual(results, []);
});

test('getTopResults: sends the keyword and location/language codes in the request body', async () => {
  await serpAnalysis.getTopResults('coffee shops lisbon', 2620, 'pt');
  assert.equal(lastRequestBody.keyword, 'coffee shops lisbon');
  assert.equal(lastRequestBody.location_code, 2620);
  assert.equal(lastRequestBody.language_code, 'pt');
});

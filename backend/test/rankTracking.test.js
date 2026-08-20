// Integration test for services/rankTracking.js against a fake DataForSEO
// server (in the pattern of test/serpAnalysis.test.js), so the real
// request-building/response-parsing and position-matching code runs, not a
// stub.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let fakeServer;
let rankTracking;
let items;

function buildFakeServer() {
  const api = express();
  api.use(express.json());

  api.post('/serp/google/organic/live/regular', (req, res) => {
    res.json({ tasks: [{ result: [{ items }] }] });
  });

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeServer = buildFakeServer().listen(0, resolve);
  });
  process.env.DATAFORSEO_API_BASE_URL = `http://localhost:${fakeServer.address().port}`;

  rankTracking = require('../services/rankTracking');
});

test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
});

test('checkPosition: reports the domain\'s rank when it appears in the top 10', async () => {
  items = [
    { type: 'organic', rank_absolute: 1, url: 'https://competitor.com/page' },
    { type: 'organic', rank_absolute: 2, url: 'https://mysite.com/blog/post' },
  ];
  const result = await rankTracking.checkPosition('best coffee lisbon', 'https://mysite.com');
  assert.deepEqual(result, { position: 2 });
});

test('checkPosition: matches regardless of protocol/www on the tracked domain', async () => {
  items = [{ type: 'organic', rank_absolute: 5, url: 'https://www.mysite.com/page' }];
  const result = await rankTracking.checkPosition('best coffee lisbon', 'mysite.com');
  assert.deepEqual(result, { position: 5 });
});

test('checkPosition: matches a subdomain of the tracked domain', async () => {
  items = [{ type: 'organic', rank_absolute: 3, url: 'https://blog.mysite.com/post' }];
  const result = await rankTracking.checkPosition('best coffee lisbon', 'https://mysite.com');
  assert.deepEqual(result, { position: 3 });
});

test('checkPosition: does not match an unrelated domain that merely contains the tracked one', async () => {
  items = [{ type: 'organic', rank_absolute: 1, url: 'https://notmysite.com/page' }];
  const result = await rankTracking.checkPosition('best coffee lisbon', 'https://mysite.com');
  assert.deepEqual(result, { position: null });
});

test('checkPosition: returns a null position when the domain is not in the top 10 at all', async () => {
  items = [{ type: 'organic', rank_absolute: 1, url: 'https://competitor.com/page' }];
  const result = await rankTracking.checkPosition('best coffee lisbon', 'https://mysite.com');
  assert.deepEqual(result, { position: null });
});

test('checkPosition: returns a null position when the SERP has no organic results', async () => {
  items = [];
  const result = await rankTracking.checkPosition('best coffee lisbon', 'https://mysite.com');
  assert.deepEqual(result, { position: null });
});

test('normalizeDomain: strips protocol, www, and trailing slash', () => {
  assert.equal(rankTracking.normalizeDomain('https://www.mysite.com/'), 'mysite.com');
  assert.equal(rankTracking.normalizeDomain('mysite.com'), 'mysite.com');
});

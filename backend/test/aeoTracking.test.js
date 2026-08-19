// Integration test for services/aeoTracking.js against fake OpenAI/Perplexity
// servers (in the pattern of test/serpAnalysis.test.js and
// test/coreWebVitals.test.js), so the real request-building/response-parsing
// and citation-detection code runs, not a stub.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let fakeServer;
let aeoTracking;
let lastOpenAiBody;
let lastPerplexityBody;
let openAiReply = 'Great question — check out https://example.com for a good answer.';
let perplexityReply = 'I have no idea who covers that topic.';

function buildFakeServer() {
  const api = express();
  api.use(express.json());

  api.post('/v1/chat/completions', (req, res) => {
    lastOpenAiBody = req.body;
    res.json({ choices: [{ message: { content: openAiReply } }] });
  });

  api.post('/chat/completions', (req, res) => {
    lastPerplexityBody = req.body;
    res.json({ choices: [{ message: { content: perplexityReply } }] });
  });

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeServer = buildFakeServer().listen(0, resolve);
  });
  process.env.OPENAI_API_BASE_URL = `http://localhost:${fakeServer.address().port}/v1`;
  process.env.PERPLEXITY_API_BASE_URL = `http://localhost:${fakeServer.address().port}`;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.PERPLEXITY_API_KEY = 'test-perplexity-key';

  aeoTracking = require('../services/aeoTracking');
});

test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
});

test('detectCitation: true when the bare domain appears in the response text', () => {
  assert.equal(aeoTracking.detectCitation('You should visit example.com for this.', 'https://example.com'), true);
});

test('detectCitation: true regardless of protocol/www in either the response or the domain', () => {
  assert.equal(aeoTracking.detectCitation('See www.example.com', 'example.com'), true);
  assert.equal(aeoTracking.detectCitation('See example.com', 'https://www.example.com/'), true);
});

test('detectCitation: false when the domain never appears', () => {
  assert.equal(aeoTracking.detectCitation('Try competitor.com instead.', 'https://example.com'), false);
});

test('detectCitation: false for empty/missing response text', () => {
  assert.equal(aeoTracking.detectCitation('', 'https://example.com'), false);
  assert.equal(aeoTracking.detectCitation(null, 'https://example.com'), false);
});

test('detectCitation: case-insensitive', () => {
  assert.equal(aeoTracking.detectCitation('Visit EXAMPLE.COM today', 'https://example.com'), true);
});

test('queryGoogleAiOverview: always rejects, documenting that it is not supported', async () => {
  await assert.rejects(aeoTracking.queryGoogleAiOverview(), /not supported automatically/);
});

test('checkQuery: chatgpt provider sends the query to OpenAI and reports a citation', async () => {
  openAiReply = 'Check out https://example.com — they cover this well.';
  const result = await aeoTracking.checkQuery('best coffee lisbon', 'https://example.com', 'chatgpt');
  assert.equal(result.provider, 'chatgpt');
  assert.equal(result.cited, true);
  assert.match(result.responseSnippet, /example\.com/);
  assert.equal(lastOpenAiBody.messages[0].content, 'best coffee lisbon');
});

test('checkQuery: perplexity provider sends the query to Perplexity and reports no citation', async () => {
  perplexityReply = 'I would recommend competitor.com for this.';
  const result = await aeoTracking.checkQuery('best coffee lisbon', 'https://example.com', 'perplexity');
  assert.equal(result.provider, 'perplexity');
  assert.equal(result.cited, false);
  assert.equal(lastPerplexityBody.messages[0].content, 'best coffee lisbon');
});

test('checkQuery: throws on an unknown provider', async () => {
  await assert.rejects(aeoTracking.checkQuery('q', 'https://example.com', 'bing-chat'), /Unknown AEO provider/);
});

test('checkQuery: reports competitor citations from the same response, without an extra API call', async () => {
  openAiReply = 'Try competitor.com for this — example.com does not cover it.';
  const result = await aeoTracking.checkQuery('best coffee lisbon', 'https://example.com', 'chatgpt', [
    'https://competitor.com',
    'https://other.com',
  ]);
  assert.equal(result.cited, true);
  assert.deepEqual(result.competitorCitations, {
    'https://competitor.com': true,
    'https://other.com': false,
  });
});

test('checkQuery: truncates long responses in the stored snippet', async () => {
  openAiReply = 'x'.repeat(600);
  const result = await aeoTracking.checkQuery('q', 'https://example.com', 'chatgpt');
  assert.equal(result.responseSnippet.length, 501); // 500 chars + ellipsis
  assert.ok(result.responseSnippet.endsWith('…'));
});

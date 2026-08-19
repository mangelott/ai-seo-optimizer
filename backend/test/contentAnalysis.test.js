// Tests for services/contentAnalysis.js structured-data detection. The pure
// parsing/validation logic (extractStructuredData against a cheerio object)
// is exercised directly with no network involved, plus one end-to-end check
// of analyzeContent() against a local Express fixture server (same pattern
// as test/crawlability.test.js) to confirm the field is wired into the
// overall content result.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cheerio = require('cheerio');
const { analyzeContent, extractStructuredData } = require('../services/contentAnalysis');

function loadStructuredData(html) {
  const $ = cheerio.load(html);
  return extractStructuredData($);
}

test('extractStructuredData: valid Article JSON-LD reports valid: true with no errors', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'A great article',
    image: 'https://example.com/photo.jpg',
    datePublished: '2026-01-01',
    author: { '@type': 'Person', name: 'Jane Doe' },
  })}</script></head><body></body></html>`;

  const [result] = loadStructuredData(html);
  assert.equal(result.type, 'Article');
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.raw, /"headline"/);
});

test('extractStructuredData: Article missing required fields reports valid: false with specific errors', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Missing bits',
  })}</script></head><body></body></html>`;

  const [result] = loadStructuredData(html);
  assert.equal(result.type, 'Article');
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Missing required field "image" for type "Article"',
    'Missing required field "datePublished" for type "Article"',
    'Missing required field "author" for type "Article"',
  ]);
});

test('extractStructuredData: malformed JSON reports valid: false with a parse error, not a throw', () => {
  const html = `<html><head><script type="application/ld+json">{ not valid json ]</script></head><body></body></html>`;

  const [result] = loadStructuredData(html);
  assert.equal(result.type, null);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /Invalid JSON/);
});

test('extractStructuredData: no JSON-LD script tags returns an empty array', () => {
  const html = `<html><head><title>No schema here</title></head><body><p>Nothing to see.</p></body></html>`;
  assert.deepEqual(loadStructuredData(html), []);
});

test('extractStructuredData: FAQPage validates question/answer completeness', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'What is this?', acceptedAnswer: { '@type': 'Answer', text: 'A thing.' } },
      { '@type': 'Question', name: 'Missing answer?' },
    ],
  })}</script></head><body></body></html>`;

  const [result] = loadStructuredData(html);
  assert.equal(result.type, 'FAQPage');
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ['FAQ question at index 1 is missing "acceptedAnswer.text"']);
});

test('extractStructuredData: Product without offers/review/aggregateRating is flagged', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    name: 'Widget',
    image: 'https://example.com/widget.jpg',
  })}</script></head><body></body></html>`;

  const [result] = loadStructuredData(html);
  assert.equal(result.type, 'Product');
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ['Product must have at least one of "offers", "review", or "aggregateRating"']);
});

test('extractStructuredData: an @graph of multiple nodes rolls up into one entry per script tag', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Acme', url: 'https://acme.example' },
      { '@type': 'Product', name: 'Widget' },
    ],
  })}</script></head><body></body></html>`;

  const [result] = loadStructuredData(html);
  assert.equal(result.type, 'Organization, Product');
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Missing required field "image" for type "Product"',
    'Product must have at least one of "offers", "review", or "aggregateRating"',
  ]);
});

let fakeServer;
let baseUrl;

function buildFakeServer() {
  const api = express();

  api.get('/valid-jsonld', (req, res) => {
    res.send(`<html><head><title>Valid page</title>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'A great article',
        image: 'https://example.com/photo.jpg',
        datePublished: '2026-01-01',
        author: { '@type': 'Person', name: 'Jane Doe' },
      })}</script>
      </head><body><h1>Hello</h1></body></html>`);
  });

  api.get('/invalid-jsonld', (req, res) => {
    res.send(`<html><head><title>Invalid page</title>
      <script type="application/ld+json">{ this is not json }</script>
      </head><body><h1>Hello</h1></body></html>`);
  });

  api.get('/no-jsonld', (req, res) => {
    res.send(`<html><head><title>No schema page</title></head><body><h1>Hello</h1></body></html>`);
  });

  api.get('/easy-en', (req, res) => {
    res.send(`<html><head><title>Easy page</title></head><body>
      <p>The cat sat on the mat. The dog ran fast. Birds sing songs. I like cake.</p>
      <script>var junk = "this is not prose and should not affect the score";</script>
      </body></html>`);
  });

  api.get('/easy-pt', (req, res) => {
    res.send(`<html><head><title>Página fácil</title></head><body>
      <p>O cão é bom. O sol é forte. Eu vou lá. Ela tem pão.</p>
      </body></html>`);
  });

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeServer = buildFakeServer().listen(0, resolve);
  });
  baseUrl = `http://localhost:${fakeServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
});

test('analyzeContent: valid JSON-LD comes through in structuredData', async () => {
  const result = await analyzeContent(`${baseUrl}/valid-jsonld`);
  assert.equal(result.structuredData.length, 1);
  assert.equal(result.structuredData[0].type, 'Article');
  assert.equal(result.structuredData[0].valid, true);
});

test('analyzeContent: invalid JSON-LD comes through as an error entry', async () => {
  const result = await analyzeContent(`${baseUrl}/invalid-jsonld`);
  assert.equal(result.structuredData.length, 1);
  assert.equal(result.structuredData[0].valid, false);
  assert.match(result.structuredData[0].errors[0], /Invalid JSON/);
});

test('analyzeContent: page with no JSON-LD returns an empty structuredData array', async () => {
  const result = await analyzeContent(`${baseUrl}/no-jsonld`);
  assert.deepEqual(result.structuredData, []);
});

test('analyzeContent: wires readabilityScore/readabilityLabel for English content, ignoring script text', async () => {
  const result = await analyzeContent(`${baseUrl}/easy-en`, 'en');
  assert.equal(result.readabilityLabel, 'easy');
  assert.ok(result.readabilityScore >= 60, `expected readabilityScore >= 60, got ${result.readabilityScore}`);
});

test('analyzeContent: wires readabilityScore/readabilityLabel for Portuguese content (no numeric score)', async () => {
  const result = await analyzeContent(`${baseUrl}/easy-pt`, 'pt');
  assert.equal(result.readabilityLabel, 'easy');
  assert.equal(result.readabilityScore, null);
});

test('analyzeContent: defaults to English readability scoring when no language is passed', async () => {
  const result = await analyzeContent(`${baseUrl}/easy-en`);
  assert.equal(result.readabilityLabel, 'easy');
});

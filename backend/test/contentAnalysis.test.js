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
const {
  analyzeContent,
  extractStructuredData,
  extractQuestionHeadings,
  extractFirstParagraphs,
  extractAuthorshipSignals,
} = require('../services/contentAnalysis');

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

test('extractQuestionHeadings: picks up h2/h3/h4 headings phrased as a question', () => {
  const html = `<html><body><h2>What is this product?</h2><h3>Not a question</h3><h4>How does it work?</h4></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractQuestionHeadings($), ['What is this product?', 'How does it work?']);
});

test('extractQuestionHeadings: returns an empty array when no heading is phrased as a question', () => {
  const html = `<html><body><h2>Product Overview</h2><h3>Features</h3></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractQuestionHeadings($), []);
});

test('extractFirstParagraphs: returns the first 3 non-empty paragraphs, trimmed', () => {
  const html = `<html><body>
    <p>  First paragraph.  </p>
    <p></p>
    <p>Second paragraph.</p>
    <p>Third paragraph.</p>
    <p>Fourth paragraph (should be excluded).</p>
  </body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractFirstParagraphs($), ['First paragraph.', 'Second paragraph.', 'Third paragraph.']);
});

test('extractAuthorshipSignals: Article with an author JSON-LD object is detected via schema, no byline needed', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'A great article',
    author: { '@type': 'Person', name: 'Jane Doe' },
  })}</script></head><body><p>No visible byline here.</p></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractAuthorshipSignals($), { hasAuthorSchema: true, hasVisibleByline: false, hasAnySignal: true });
});

test('extractAuthorshipSignals: standalone Person JSON-LD node (not nested under "author") also counts as schema', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Person',
    name: 'Jane Doe',
  })}</script></head><body></body></html>`;
  const $ = cheerio.load(html);
  assert.equal(extractAuthorshipSignals($).hasAuthorSchema, true);
});

test('extractAuthorshipSignals: rel="author" link with text is detected as a visible byline, no schema needed', () => {
  const html = `<html><body><p>By <a rel="author" href="/about/jane">Jane Doe</a></p></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractAuthorshipSignals($), { hasAuthorSchema: false, hasVisibleByline: true, hasAnySignal: true });
});

test('extractAuthorshipSignals: a class mentioning "author" or "byline" (case-insensitive) is detected', () => {
  const withAuthorClass = cheerio.load('<html><body><span class="Post-Author-Name">Jane Doe</span></body></html>');
  assert.equal(extractAuthorshipSignals(withAuthorClass).hasVisibleByline, true);

  const withBylineClass = cheerio.load('<html><body><div class="article-byline">Jane Doe</div></body></html>');
  assert.equal(extractAuthorshipSignals(withBylineClass).hasVisibleByline, true);
});

test('extractAuthorshipSignals: an <address> element with text is detected as a visible byline', () => {
  const html = `<html><body><article><address>Written by Jane Doe</address></article></body></html>`;
  const $ = cheerio.load(html);
  assert.equal(extractAuthorshipSignals($).hasVisibleByline, true);
});

test('extractAuthorshipSignals: empty author-like elements (no text) do not count', () => {
  const html = `<html><body><a rel="author"></a><span class="author"></span><address></address></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractAuthorshipSignals($), { hasAuthorSchema: false, hasVisibleByline: false, hasAnySignal: false });
});

test('extractAuthorshipSignals: no schema and no byline reports hasAnySignal: false', () => {
  const html = `<html><head><title>No author here</title></head><body><h1>Title</h1><p>Just some prose, no author identified anywhere.</p></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractAuthorshipSignals($), { hasAuthorSchema: false, hasVisibleByline: false, hasAnySignal: false });
});

test('extractAuthorshipSignals: malformed JSON-LD is ignored rather than thrown, byline still detected', () => {
  const html = `<html><head><script type="application/ld+json">{ not valid json ]</script></head><body><span class="byline">Jane Doe</span></body></html>`;
  const $ = cheerio.load(html);
  assert.deepEqual(extractAuthorshipSignals($), { hasAuthorSchema: false, hasVisibleByline: true, hasAnySignal: true });
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

  // A long-form article with no explicit Q&A structure: no heading phrased
  // as a question, no FAQPage/HowTo schema, and the direct answer to the
  // page's topic buried past the first 3 paragraphs — exactly the signals
  // services/claude.js uses to decide whether to propose an "aeo" fix.
  api.get('/no-qa-structure', (req, res) => {
    res.send(`<html><head><title>Complete Guide to Widgets</title></head><body>
      <h1>Complete Guide to Widgets</h1>
      <p>Widgets have a long and interesting history dating back many decades of industrial design.</p>
      <p>This section covers the manufacturing process in detail, including sourcing of raw materials.</p>
      <p>Distribution networks for widgets vary significantly across different global markets.</p>
      <h2>Manufacturing Process</h2>
      <p>The direct answer to how widgets actually work is buried here, far from the top of the article.</p>
      </body></html>`);
  });

  // A long-form editorial article with no author schema and no visible
  // byline anywhere — the case services/claude.js should flag with a
  // "content" fix recommending a byline + Person structured data.
  api.get('/no-authorship', (req, res) => {
    res.send(`<html><head><title>Complete Guide to Widgets</title></head><body>
      <h1>Complete Guide to Widgets</h1>
      <p>Widgets have a long and interesting history dating back many decades of industrial design.</p>
      <p>This section covers the manufacturing process in detail, including sourcing of raw materials.</p>
      <p>Distribution networks for widgets vary significantly across different global markets.</p>
      </body></html>`);
  });

  // Same shape of article, but with a visible byline and no JSON-LD.
  api.get('/with-byline', (req, res) => {
    res.send(`<html><head><title>Complete Guide to Widgets</title></head><body>
      <h1>Complete Guide to Widgets</h1>
      <p class="byline">By Jane Doe</p>
      <p>Widgets have a long and interesting history dating back many decades of industrial design.</p>
      </body></html>`);
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

test('analyzeContent: page without Q&A structure reports no question headings, no FAQPage/HowTo schema, and no early direct answer', async () => {
  const result = await analyzeContent(`${baseUrl}/no-qa-structure`);
  assert.deepEqual(result.questionHeadings, []);
  assert.deepEqual(result.structuredData, []);
  assert.deepEqual(result.firstParagraphs, [
    'Widgets have a long and interesting history dating back many decades of industrial design.',
    'This section covers the manufacturing process in detail, including sourcing of raw materials.',
    'Distribution networks for widgets vary significantly across different global markets.',
  ]);
  assert.ok(
    !result.firstParagraphs.join(' ').includes('direct answer'),
    'the direct answer should be buried past the first 3 paragraphs, not present in them'
  );
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

test('analyzeContent: article with no author schema and no visible byline reports authorshipSignals.hasAnySignal: false', async () => {
  const result = await analyzeContent(`${baseUrl}/no-authorship`);
  assert.deepEqual(result.authorshipSignals, { hasAuthorSchema: false, hasVisibleByline: false, hasAnySignal: false });
});

test('analyzeContent: article with a visible byline reports authorshipSignals.hasAnySignal: true', async () => {
  const result = await analyzeContent(`${baseUrl}/with-byline`);
  assert.deepEqual(result.authorshipSignals, { hasAuthorSchema: false, hasVisibleByline: true, hasAnySignal: true });
});

test('analyzeContent: page with author JSON-LD reports authorshipSignals.hasAuthorSchema: true', async () => {
  const result = await analyzeContent(`${baseUrl}/valid-jsonld`);
  assert.equal(result.authorshipSignals.hasAuthorSchema, true);
  assert.equal(result.authorshipSignals.hasAnySignal, true);
});

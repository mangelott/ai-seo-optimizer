// Tests for services/linkSuggestions.js's pure logic (computeInternalLinkSuggestions,
// tokenizeTitle, titleTopicOverlap) against a small synthetic site — no database,
// no network. suggestInternalLinks itself (the DB-touching part, which just wires
// linkGraph.buildLinkGraph + duplicateContent.fetchCrawledPages together) isn't
// separately unit-tested here, in the pattern of linkGraph.test.js.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeInternalLinkSuggestions,
  tokenizeTitle,
  titleTopicOverlap,
  findBoilerplateTokens,
} = require('../services/linkSuggestions');

// A small synthetic shoe shop: /shoes/running and /shoes/trail are clearly
// about the same topic but nothing links /shoes/trail -> /shoes/running (the
// obvious missing-link case). Home already links to /shoes/running, so it
// must not be suggested again despite being topically related too.
// /about and /contact share no title words with the target and must not be
// suggested. /shoes/discontinued crawled as a 404 and must be excluded even
// though its title is a good topical match.
const PAGES = [
  { url: 'https://shop.com/', title: 'Home | Shop', wordCount: 200 },
  { url: 'https://shop.com/shoes/running', title: 'Running Shoes Guide', wordCount: 800 },
  { url: 'https://shop.com/shoes/trail', title: 'Trail Running Shoes', wordCount: 750 },
  { url: 'https://shop.com/shoes/discontinued', title: 'Running Shoes Clearance', wordCount: 300 },
  { url: 'https://shop.com/about', title: 'About Us', wordCount: 150 },
  { url: 'https://shop.com/contact', title: 'Contact', wordCount: 90 },
];

const GRAPH = {
  pages: [
    { url: 'https://shop.com/', statusCode: 200 },
    { url: 'https://shop.com/shoes/running', statusCode: 200 },
    { url: 'https://shop.com/shoes/trail', statusCode: 200 },
    { url: 'https://shop.com/shoes/discontinued', statusCode: 404 },
    { url: 'https://shop.com/about', statusCode: 200 },
    { url: 'https://shop.com/contact', statusCode: 200 },
  ],
  links: [
    { fromUrl: 'https://shop.com/', toUrl: 'https://shop.com/shoes/running', anchorText: 'Running shoes' },
    { fromUrl: 'https://shop.com/', toUrl: 'https://shop.com/shoes/trail', anchorText: 'Trail shoes' },
    { fromUrl: 'https://shop.com/', toUrl: 'https://shop.com/about', anchorText: 'About' },
  ],
};

test('tokenizeTitle: lowercases, strips accents/punctuation, drops short words and stopwords', () => {
  assert.deepEqual(tokenizeTitle('Guia de Ténis de Corrida'), new Set(['guia', 'tenis', 'corrida']));
  assert.deepEqual(tokenizeTitle('The Best Running Shoes for You'), new Set(['best', 'running', 'shoes']));
  assert.deepEqual(tokenizeTitle(null), new Set());
});

test('titleTopicOverlap: scores shared-word ratio, zero when no overlap or either side is empty', () => {
  assert.equal(titleTopicOverlap(tokenizeTitle('Running Shoes Guide'), tokenizeTitle('Trail Running Shoes')), 0.5);
  assert.equal(titleTopicOverlap(tokenizeTitle('Running Shoes Guide'), tokenizeTitle('About Us')), 0);
  assert.equal(titleTopicOverlap(new Set(), tokenizeTitle('Running Shoes Guide')), 0);
});

test('computeInternalLinkSuggestions: suggests the obvious missing link between topically related pages', () => {
  const suggestions = computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/shoes/running');
  const fromUrls = suggestions.map((s) => s.fromUrl);
  assert.ok(fromUrls.includes('https://shop.com/shoes/trail'));
});

test('computeInternalLinkSuggestions: does not suggest a page that already links to the target', () => {
  const suggestions = computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/shoes/running');
  assert.ok(!suggestions.some((s) => s.fromUrl === 'https://shop.com/'));
});

test('computeInternalLinkSuggestions: excludes a topically-related page that crawled as a 404', () => {
  const suggestions = computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/shoes/running');
  assert.ok(!suggestions.some((s) => s.fromUrl === 'https://shop.com/shoes/discontinued'));
});

test('computeInternalLinkSuggestions: does not suggest topically unrelated pages', () => {
  const suggestions = computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/shoes/running');
  assert.ok(!suggestions.some((s) => s.fromUrl === 'https://shop.com/about'));
  assert.ok(!suggestions.some((s) => s.fromUrl === 'https://shop.com/contact'));
});

test('computeInternalLinkSuggestions: returns a suggestedFix and anchor text describing where to link from/to', () => {
  const [suggestion] = computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/shoes/running');
  assert.equal(suggestion.toUrl, 'https://shop.com/shoes/running');
  assert.equal(suggestion.toTitle, 'Running Shoes Guide');
  assert.equal(suggestion.suggestedAnchorText, 'Running Shoes Guide');
  assert.ok(suggestion.suggestedFix.includes(suggestion.fromUrl));
  assert.ok(suggestion.suggestedFix.includes(suggestion.toUrl));
});

test('computeInternalLinkSuggestions: results are ranked by relevance score, most relevant first', () => {
  const suggestions = computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/shoes/running');
  const scores = suggestions.map((s) => s.relevanceScore);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('computeInternalLinkSuggestions: caps results at maxSuggestions', () => {
  const manyPages = [
    { url: 'https://shop.com/shoes/running', title: 'Running Shoes Guide', wordCount: 800 },
    ...Array.from({ length: 8 }, (_, i) => ({
      url: `https://shop.com/shoes/running-${i}`,
      title: `Running Shoes Review ${i}`,
      wordCount: 500,
    })),
    // Unrelated filler so "running"/"shoes" stay under the boilerplate
    // detector's site-wide-frequency threshold (9 of 13 pages, ~69%).
    { url: 'https://shop.com/about', title: 'About Us', wordCount: 150 },
    { url: 'https://shop.com/contact', title: 'Contact', wordCount: 90 },
    { url: 'https://shop.com/shipping', title: 'Shipping Info', wordCount: 180 },
    { url: 'https://shop.com/returns', title: 'Returns Policy', wordCount: 200 },
  ];
  const manyGraph = { pages: manyPages.map((p) => ({ url: p.url, statusCode: 200 })), links: [] };
  const suggestions = computeInternalLinkSuggestions(manyGraph, manyPages, 'https://shop.com/shoes/running', 3);
  assert.equal(suggestions.length, 3);
});

test('computeInternalLinkSuggestions: returns an empty list for an untitled or unknown target page', () => {
  assert.deepEqual(computeInternalLinkSuggestions(GRAPH, PAGES, 'https://shop.com/does-not-exist'), []);
  assert.deepEqual(
    computeInternalLinkSuggestions(GRAPH, [...PAGES, { url: 'https://shop.com/untitled', title: null, wordCount: 50 }], 'https://shop.com/untitled'),
    []
  );
});

// Every title below is templated as "<Topic> | Acme Shop", the way most CMSes
// generate titles. Without excluding the shared "acme"/"shop" tokens, unrelated
// pages would look artificially similar just for carrying the same brand suffix.
const BRANDED_PAGES = [
  { url: 'https://shop.com/shoes/running', title: 'Running Shoes Guide | Acme Shop', wordCount: 800 },
  { url: 'https://shop.com/shoes/trail', title: 'Trail Running Shoes | Acme Shop', wordCount: 750 },
  { url: 'https://shop.com/about', title: 'About Us | Acme Shop', wordCount: 150 },
  { url: 'https://shop.com/contact', title: 'Contact | Acme Shop', wordCount: 90 },
  { url: 'https://shop.com/returns', title: 'Returns Policy | Acme Shop', wordCount: 200 },
  { url: 'https://shop.com/shipping', title: 'Shipping Info | Acme Shop', wordCount: 180 },
];
const BRANDED_GRAPH = { pages: BRANDED_PAGES.map((p) => ({ url: p.url, statusCode: 200 })), links: [] };

test('findBoilerplateTokens: flags tokens present in most titles, ignores anything below the min-page sample size', () => {
  const tokenSets = BRANDED_PAGES.map((p) => tokenizeTitle(p.title));
  assert.deepEqual(findBoilerplateTokens(tokenSets), new Set(['acme', 'shop']));
  assert.deepEqual(findBoilerplateTokens(tokenSets.slice(0, 3)), new Set());
});

test('computeInternalLinkSuggestions: a shared brand suffix alone does not make unrelated pages look related', () => {
  const suggestions = computeInternalLinkSuggestions(BRANDED_GRAPH, BRANDED_PAGES, 'https://shop.com/shoes/running');
  const fromUrls = suggestions.map((s) => s.fromUrl);
  assert.ok(fromUrls.includes('https://shop.com/shoes/trail'));
  assert.ok(!fromUrls.includes('https://shop.com/about'));
  assert.ok(!fromUrls.includes('https://shop.com/contact'));
  assert.ok(!fromUrls.includes('https://shop.com/returns'));
  assert.ok(!fromUrls.includes('https://shop.com/shipping'));
});

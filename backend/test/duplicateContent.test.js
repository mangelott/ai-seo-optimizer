// Tests for services/duplicateContent.js's pure detection logic
// (flagThinContent, detectDuplicates, normalizeTitle) against synthetic
// crawledPages fixtures — no database, no network. fetchCrawledPages itself
// (the DB-touching part) mirrors linkGraph.buildLinkGraph and isn't
// separately unit-tested here, in the pattern of linkGraph.test.js.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { flagThinContent, detectDuplicates, normalizeTitle } = require('../services/duplicateContent');

// A 5-page synthetic site: two clearly-duplicated category pages (identical
// title, near-identical word count), one clearly-thin page, and two
// unrelated normal pages that shouldn't be flagged by either check.
const PAGES = [
  { url: 'https://shop.com/category/shoes?page=1', title: 'Shoes | Shop', wordCount: 420 },
  { url: 'https://shop.com/category/shoes?page=2', title: 'Shoes | Shop', wordCount: 415 },
  { url: 'https://shop.com/blog/thin-post', title: 'A Quick Note', wordCount: 45 },
  { url: 'https://shop.com/about', title: 'About Us', wordCount: 600 },
  { url: 'https://shop.com/contact', title: 'Contact', wordCount: 350 },
];

test('flagThinContent: flags pages below the word-count threshold', () => {
  const thin = flagThinContent(PAGES, 300);
  assert.deepEqual(thin, [{ url: 'https://shop.com/blog/thin-post', wordCount: 45 }]);
});

test('flagThinContent: respects a custom threshold', () => {
  const thin = flagThinContent(PAGES, 500);
  assert.deepEqual(
    thin.map((p) => p.url).sort(),
    ['https://shop.com/blog/thin-post', 'https://shop.com/category/shoes?page=1', 'https://shop.com/category/shoes?page=2', 'https://shop.com/contact']
  );
});

test('flagThinContent: ignores pages with no word count', () => {
  const thin = flagThinContent([{ url: 'https://shop.com/x', title: 'X', wordCount: null }], 300);
  assert.deepEqual(thin, []);
});

test('normalizeTitle: lowercases, trims, collapses whitespace', () => {
  assert.equal(normalizeTitle('  Shoes   |  Shop  '), 'shoes | shop');
  assert.equal(normalizeTitle(null), '');
});

test('normalizeTitle: strips trailing page-number markers', () => {
  assert.equal(normalizeTitle('Shoes - Page 2'), 'shoes');
  assert.equal(normalizeTitle('Shoes (page 3)'), 'shoes');
  assert.equal(normalizeTitle('Shoes - 2'), 'shoes');
});

test('normalizeTitle: does not strip a trailing number with no separator, so it never merges distinct titles that legitimately end in a number', () => {
  assert.equal(normalizeTitle('iPhone 15'), 'iphone 15');
  assert.equal(normalizeTitle('Best Hats 2024'), 'best hats 2024');
  assert.equal(normalizeTitle('Season 4: Episode 12'), 'season 4: episode 12');
});

test('detectDuplicates: does not flag distinct product pages whose titles happen to end in different model numbers', () => {
  const pages = [
    { url: 'https://shop.com/iphone-15', title: 'iPhone 15', wordCount: 500 },
    { url: 'https://shop.com/iphone-16', title: 'iPhone 16', wordCount: 500 },
  ];
  assert.deepEqual(detectDuplicates(pages), []);
});

test('detectDuplicates: finds the exact-title duplicate pair', () => {
  const groups = detectDuplicates(PAGES);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'identical_title');
  assert.deepEqual(
    groups[0].pages.map((p) => p.url).sort(),
    ['https://shop.com/category/shoes?page=1', 'https://shop.com/category/shoes?page=2']
  );
});

test('detectDuplicates: does not flag unrelated pages with distinct titles', () => {
  const groups = detectDuplicates(PAGES.filter((p) => !p.url.includes('shoes')));
  assert.deepEqual(groups, []);
});

test('detectDuplicates: catches a near-duplicate pair with distinct titles that are still almost entirely the same wording', () => {
  const pages = [
    { url: 'https://shop.com/blog/winter', title: 'Winter Running Shoes Guide for Choosing the Best', wordCount: 500 },
    { url: 'https://shop.com/blog/summer', title: 'Summer Running Shoes Guide for Choosing the Best', wordCount: 510 },
    { url: 'https://shop.com/unrelated', title: 'Totally Different Page', wordCount: 500 },
  ];
  const groups = detectDuplicates(pages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'similar_title_and_length');
  assert.deepEqual(
    groups[0].pages.map((p) => p.url).sort(),
    ['https://shop.com/blog/summer', 'https://shop.com/blog/winter']
  );
});

test('detectDuplicates: does not flag similarly-titled pages whose word counts diverge a lot', () => {
  const pages = [
    { url: 'https://shop.com/blog/winter', title: 'Winter Running Shoes Guide for Choosing the Best', wordCount: 100 },
    { url: 'https://shop.com/blog/summer', title: 'Summer Running Shoes Guide for Choosing the Best', wordCount: 900 },
  ];
  assert.deepEqual(detectDuplicates(pages), []);
});

test('detectDuplicates: ignores pages with no title', () => {
  const pages = [
    { url: 'https://shop.com/a', title: null, wordCount: 200 },
    { url: 'https://shop.com/b', title: null, wordCount: 200 },
  ];
  assert.deepEqual(detectDuplicates(pages), []);
});

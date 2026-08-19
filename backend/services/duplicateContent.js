const pool = require('../db/pool');

const DEFAULT_THIN_THRESHOLD = 300;
const SHINGLE_SIZE = 2;
const TITLE_SIMILARITY_THRESHOLD = 0.7;
const WORD_COUNT_TOLERANCE_RATIO = 0.15;

async function fetchCrawledPages(auditId) {
  const result = await pool.query('SELECT url, title, word_count FROM crawled_pages WHERE audit_id = $1', [auditId]);
  return result.rows.map((r) => ({ url: r.url, title: r.title, wordCount: r.word_count }));
}

function flagThinContent(crawledPages, threshold = DEFAULT_THIN_THRESHOLD) {
  return crawledPages
    .filter((p) => p.wordCount != null && p.wordCount < threshold)
    .map((p) => ({ url: p.url, wordCount: p.wordCount }));
}

// Collapses whitespace/case differences and strips trailing page-number
// markers (", Page 2", "- 2", "(page 3)") so paginated listing pages that
// share one CMS-generated title collapse to the same key. The bare-number
// strip requires an explicit separator (-, –, |, :) before the digits, not
// just whitespace — otherwise titles that legitimately end in a number
// ("iPhone 15", "Best Hats 2024") would collapse into each other too.
function normalizeTitle(title) {
  if (!title) return '';
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–|:]*\(?page\s*\d+\)?\s*$/i, '')
    .replace(/\s*[\-–|:]+\s*\d+\s*$/, '')
    .trim();
}

function titleShingles(title, size = SHINGLE_SIZE) {
  const words = title.split(' ').filter(Boolean);
  if (words.length < size) return new Set(words.length ? [words.join(' ')] : []);

  const shingles = new Set();
  for (let i = 0; i <= words.length - size; i++) {
    shingles.add(words.slice(i, i + size).join(' '));
  }
  return shingles;
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const intersectionSize = [...a].filter((shingle) => b.has(shingle)).length;
  const unionSize = new Set([...a, ...b]).size;
  return intersectionSize / unionSize;
}

function wordCountsClose(a, b, tolerance = WORD_COUNT_TOLERANCE_RATIO) {
  if (a == null || b == null) return false;
  if (a === 0 && b === 0) return true;
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

// No full page text is available from the crawl (DataForSEO's on_page
// endpoint only gives us title/meta/word_count here, see
// auditProcessor.normalizeCrawledPage) — so instead of shingling actual body
// text, this approximates a content hash with title shingles plus word-count
// closeness. Good enough to catch the obvious cases (paginated category
// pages, a page duplicated under two URLs) without claiming to be exact.
function detectDuplicates(crawledPages) {
  const pages = crawledPages.filter((p) => p.title);
  const groups = new Map();

  for (const page of pages) {
    const key = normalizeTitle(page.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }

  const duplicateGroups = [];
  const groupedUrls = new Set();

  for (const [normalizedTitle, group] of groups) {
    if (group.length < 2) continue;
    duplicateGroups.push({
      reason: 'identical_title',
      normalizedTitle,
      pages: group.map((p) => ({ url: p.url, title: p.title, wordCount: p.wordCount ?? null })),
    });
    group.forEach((p) => groupedUrls.add(p.url));
  }

  // Near-duplicate pass over whatever didn't already match on exact
  // normalized title: pages whose titles are still highly similar in
  // wording and close in length (e.g. a page-number suffix that survived
  // normalization because it wasn't in one of the expected formats).
  const remaining = pages.filter((p) => !groupedUrls.has(p.url));
  const used = new Set();

  for (let i = 0; i < remaining.length; i++) {
    if (used.has(remaining[i].url)) continue;
    const shinglesI = titleShingles(normalizeTitle(remaining[i].title));
    const cluster = [remaining[i]];

    for (let j = i + 1; j < remaining.length; j++) {
      if (used.has(remaining[j].url)) continue;
      const shinglesJ = titleShingles(normalizeTitle(remaining[j].title));
      const similarity = jaccardSimilarity(shinglesI, shinglesJ);
      if (similarity >= TITLE_SIMILARITY_THRESHOLD && wordCountsClose(remaining[i].wordCount, remaining[j].wordCount)) {
        cluster.push(remaining[j]);
        used.add(remaining[j].url);
      }
    }

    if (cluster.length > 1) {
      used.add(remaining[i].url);
      duplicateGroups.push({
        reason: 'similar_title_and_length',
        normalizedTitle: normalizeTitle(remaining[i].title),
        pages: cluster.map((p) => ({ url: p.url, title: p.title, wordCount: p.wordCount ?? null })),
      });
    }
  }

  return duplicateGroups;
}

module.exports = { fetchCrawledPages, flagThinContent, detectDuplicates, normalizeTitle };

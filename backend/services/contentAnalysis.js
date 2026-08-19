const axios = require('axios');
const cheerio = require('cheerio');
const { scoreReadability } = require('./readability');

// Minimal required-field checklist per schema.org type, just enough to catch
// the most common authoring mistakes (missing required properties) — not a
// full schema.org/Google Rich Results validator.
const REQUIRED_FIELDS = {
  Article: ['headline', 'image', 'datePublished', 'author'],
  NewsArticle: ['headline', 'image', 'datePublished', 'author'],
  BlogPosting: ['headline', 'image', 'datePublished', 'author'],
  Product: ['name', 'image'],
  FAQPage: ['mainEntity'],
  LocalBusiness: ['name', 'address'],
  Organization: ['name', 'url'],
  BreadcrumbList: ['itemListElement'],
  WebSite: ['name', 'url'],
};

function isEmptyValue(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function normalizeType(node) {
  const type = node?.['@type'];
  if (!type) return null;
  return Array.isArray(type) ? type[0] : type;
}

// Validates a single JSON-LD node (an object with an "@type"), returning the
// errors found — missing required fields for known types, plus a couple of
// type-specific checks (FAQPage questions/answers, Product needing at least
// one of offers/review/aggregateRating per Google's Rich Results guidance).
function validateNode(node) {
  const errors = [];
  const type = normalizeType(node);

  if (!type) {
    errors.push('Missing "@type"');
    return { type: null, errors };
  }

  const requiredFields = REQUIRED_FIELDS[type];
  if (requiredFields) {
    for (const field of requiredFields) {
      if (isEmptyValue(node[field])) errors.push(`Missing required field "${field}" for type "${type}"`);
    }
  }

  if (type === 'FAQPage' && Array.isArray(node.mainEntity)) {
    node.mainEntity.forEach((question, i) => {
      if (isEmptyValue(question?.name)) errors.push(`FAQ question at index ${i} is missing "name"`);
      if (isEmptyValue(question?.acceptedAnswer?.text)) {
        errors.push(`FAQ question at index ${i} is missing "acceptedAnswer.text"`);
      }
    });
  }

  if (type === 'Product' && node.offers == null && node.review == null && node.aggregateRating == null) {
    errors.push('Product must have at least one of "offers", "review", or "aggregateRating"');
  }

  return { type, errors };
}

// Extracts every <script type="application/ld+json"> block, parses it, and
// validates its contents. A block can hold a single node, an array of nodes,
// or an "@graph" of nodes — all are validated and rolled up into one result
// per <script> tag (so "raw" stays the exact source text of that block, for
// callers that want to locate/replace it in the page source).
function extractStructuredData($) {
  return $('script[type="application/ld+json"]')
    .map((_, el) => {
      const raw = ($(el).html() || '').trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return { type: null, valid: false, errors: [`Invalid JSON: ${err.message}`], raw };
      }

      const nodes = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed];
      const results = nodes.map(validateNode);
      const types = [...new Set(results.map((r) => r.type).filter(Boolean))];
      const errors = results.flatMap((r) => r.errors);

      return { type: types.join(', ') || null, valid: errors.length === 0, errors, raw };
    })
    .get();
}

// AEO (Answer Engine Optimization) signals: whether the page already has
// explicit question/answer structure an LLM can lift verbatim, and whether
// its opening paragraphs read as a direct answer rather than burying it
// further down. Heuristics only, same spirit as the rest of this file —
// the actual judgment call ("is this a good direct answer?") is left to
// Claude, which receives these alongside structuredData (services/claude.js).
function extractQuestionHeadings($) {
  return $('h2, h3, h4')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((text) => text.endsWith('?'));
}

function extractFirstParagraphs($, count = 3) {
  return $('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean)
    .slice(0, count);
}

async function analyzeContent(url, language = 'en') {
  const { data: html } = await axios.get(url, { timeout: 10000 });
  const $ = cheerio.load(html);

  const title = $('title').text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get();
  const wordCount = $('body').text().trim().split(/\s+/).length;
  const images = $('img');
  const imagesMissingAltSrcs = images
    .filter((_, el) => !$(el).attr('alt'))
    .map((_, el) => $(el).attr('src'))
    .get()
    .filter(Boolean);
  const structuredData = extractStructuredData($);
  const questionHeadings = extractQuestionHeadings($);
  const firstParagraphs = extractFirstParagraphs($);

  // Script/style content isn't prose, so it's excluded here even though the
  // existing wordCount above (kept as-is, for compatibility) doesn't bother.
  const bodyText = $('body').clone().find('script, style').remove().end().text();
  const readability = scoreReadability(bodyText, language);

  return {
    title,
    titleLength: title.length,
    metaDescription,
    metaDescriptionLength: metaDescription.length,
    h1Count: h1s.length,
    h1s,
    wordCount,
    imageCount: images.length,
    imagesMissingAlt: imagesMissingAltSrcs.length,
    imagesMissingAltSrcs,
    structuredData,
    questionHeadings,
    firstParagraphs,
    readabilityScore: readability?.score ?? null,
    readabilityLabel: readability?.label ?? null,
  };
}

module.exports = { analyzeContent, extractStructuredData, validateNode, extractQuestionHeadings, extractFirstParagraphs };

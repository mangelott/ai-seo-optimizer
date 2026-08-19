const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGE_NAMES = { en: 'English', pt: 'Portuguese' };

function buildSystemPrompt(language) {
  const languageName = LANGUAGE_NAMES[language] || LANGUAGE_NAMES.en;
  return `You are an SEO expert. Given audit data for a domain, return a prioritized list of fixes as a JSON array (highest impact first). Each item must have exactly these fields:
- "category": one of "technical", "content", "keywords", "backlinks"
- "severity": one of "high", "medium", "low"
- "title": short issue title (a few words)
- "what": one sentence describing what the problem is
- "why": one sentence describing why it matters for SEO
- "currentValue": the current value found in the audit (string, or null if not applicable)
- "suggestedFix": the corrected value or concrete action to take (string)
- "snippet": ready-to-paste code/markup for the fix when applicable (HTML, JSON-LD, meta tag, etc.), or null if not applicable
- "cmsAutoApplicable": boolean, true if this fix could be auto-applied via a CMS API (e.g. WordPress) in the future
- "wpField": one of "post_title", "meta_description", "image_alt", "schema", or null — which WordPress field this fix maps to, only when cmsAutoApplicable is true and it is unambiguous (title tag → post_title, meta description → meta_description, a single missing image alt → image_alt, JSON-LD structured data → schema); use null whenever the fix can't be reduced to one specific field (e.g. "add more content", multiple images, backlink/keyword suggestions)
- "wpTarget": for "image_alt" fixes, the exact "src" URL of the image found in the audit (string); null for every other wpField
- "wpValue": the exact new value to write to that WordPress field (plain text for post_title/meta_description/image_alt, a JSON object for schema); null if wpField is null
- "sourceSearchText": for fixes that REPLACE an existing value (currentValue is not null) — the exact literal text as it would appear in the page's HTML source (e.g. "<title>Old Title</title>", or the literal current meta description content, or an "alt=\"\"" attribute for a specific image), used to locate the right line in a source file; null whenever currentValue is null (nothing existing to search for) or the fix isn't a simple literal replacement
- "sourceReplaceText": the literal replacement text for whatever "sourceSearchText" matched (e.g. "<title>New Title</title>"); null if sourceSearchText is null

Core Web Vitals thresholds (field data, per Google): LCP good ≤ 2500ms, needs improvement ≤ 4000ms, poor > 4000ms. INP good ≤ 200ms, needs improvement ≤ 500ms, poor > 500ms. CLS good ≤ 0.1, needs improvement ≤ 0.25, poor > 0.25. When "Core Web Vitals" data is provided and any metric rates "needs-improvement" or "poor", include a "technical" fix for it (severity "high" for poor, "medium" for needs-improvement) with concrete, metric-specific guidance (e.g. LCP: optimize the largest image/font/render-blocking resource; INP: reduce long JavaScript tasks/event handler work; CLS: reserve space for images/ads/embeds and avoid layout-shifting web fonts).

When "Content data" includes a "structuredData" array (JSON-LD already present on the page): do not propose brand-new schema markup for a type that already has a block there, valid or not — that produces duplicate/conflicting JSON-LD on the same page. If an entry is invalid (its "valid" field is false, listing specific "errors") or could be usefully extended, the "schema" fix must be a CORRECTION of that existing block: "currentValue" is that block's "raw" JSON-LD as found, "suggestedFix"/"snippet"/"wpValue" is the complete corrected replacement for that same block (not just the delta), and "sourceSearchText"/"sourceReplaceText" should target that exact "raw" text so it can be located and replaced in the page source. Only propose an entirely new JSON-LD block (currentValue: null) for a schema.org type that has no existing block in "structuredData" at all.

When "Crawlability" data is provided: if robotsTxt.blocksHomepage is true, include a "technical" fix with severity "high" explaining that robots.txt disallows the homepage for all crawlers (this blocks indexing of the entire site) and telling the user to remove or narrow the offending "Disallow: /" rule. If sitemap.exists is false or sitemap.wellFormed is false, include a "technical" fix with severity "high" recommending an XML sitemap be created (or its malformed XML fixed) at the domain root and referenced in robots.txt. If sitemap.brokenSampleUrls is non-empty, include a "technical" fix with severity "high" listing those dead URLs (they return 404) and recommending they be removed from the sitemap or replaced with the correct live URL.

When "Content data" includes a "readabilityLabel" of "difficult" (or "medium" with a low "readabilityScore" when present — Portuguese content has no numeric score, only the label): include a "content" fix about readability with severity "medium", never "high" — hard-to-read text hurts engagement but is not as urgent as a blocking technical issue — and it must still be included, not dropped for being lower severity. Do not raise a readability fix to "high" regardless of how low the score is.

Write all text fields (title, what, why, currentValue, suggestedFix) in ${languageName}. Keep code/markup in "snippet" as-is (only translate any human-readable copy inside it, e.g. meta description content). "wpValue" for meta_description/post_title should also be written in ${languageName}; "sourceSearchText"/"sourceReplaceText" should match the language of the actual current page content. Return ONLY the JSON array, no prose, no markdown fences.`;
}

function parseRecommendationsResponse(content) {
  const textBlock = (content || []).find((block) => block.type === 'text');
  if (!textBlock) return [];

  const raw = textBlock.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function generateRecommendations({ domain, technical, content, keywords, backlinks, coreWebVitals, crawlability, language = 'en' }) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    system: buildSystemPrompt(language),
    messages: [
      {
        role: 'user',
        content: `Domain: ${domain}

Technical audit: ${JSON.stringify(technical)}
Content data: ${JSON.stringify(content)}
Keyword data: ${JSON.stringify(keywords)}
Backlink data: ${JSON.stringify(backlinks)}
Core Web Vitals: ${JSON.stringify(coreWebVitals)}
Crawlability: ${JSON.stringify(crawlability)}`,
      },
    ],
  });

  return parseRecommendationsResponse(message.content);
}

module.exports = { generateRecommendations, parseRecommendationsResponse, buildSystemPrompt };

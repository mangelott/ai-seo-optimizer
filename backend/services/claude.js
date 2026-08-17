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

Write all text fields (title, what, why, currentValue, suggestedFix) in ${languageName}. Keep code/markup in "snippet" as-is (only translate any human-readable copy inside it, e.g. meta description content). "wpValue" for meta_description/post_title should also be written in ${languageName}. Return ONLY the JSON array, no prose, no markdown fences.`;
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

async function generateRecommendations({ domain, technical, content, keywords, backlinks, language = 'en' }) {
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
Backlink data: ${JSON.stringify(backlinks)}`,
      },
    ],
  });

  return parseRecommendationsResponse(message.content);
}

module.exports = { generateRecommendations, parseRecommendationsResponse, buildSystemPrompt };

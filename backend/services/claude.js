const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an SEO expert. Given audit data for a domain, return a prioritized list of fixes as a JSON array (highest impact first). Each item must have exactly these fields:
- "category": one of "technical", "content", "keywords", "backlinks"
- "severity": one of "high", "medium", "low"
- "issue": short description of the problem
- "currentValue": the current value found in the audit (string, or null if not applicable)
- "suggestedFix": the corrected value or concrete action to take (string)
- "snippet": ready-to-paste code/markup for the fix when applicable (HTML, JSON-LD, meta tag, etc.), or null if not applicable
- "cmsAutoApplicable": boolean, true if this fix could be auto-applied via a CMS API (e.g. WordPress) in the future

Return ONLY the JSON array, no prose, no markdown fences.`;

async function generateRecommendations({ domain, technical, content, keywords, backlinks }) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
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

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock) return [];

  const raw = textBlock.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

module.exports = { generateRecommendations };

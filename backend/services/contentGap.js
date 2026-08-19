const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGE_NAMES = { en: 'English', pt: 'Portuguese' };

// Distinct from services/claude.js's fix-generation prompt: this is a
// semantic comparison against real competitor content (which subtopics/
// entities the top-ranking pages cover that the user's page doesn't), not a
// list of ready-to-apply fixes, so it gets its own prompt and its own JSON
// schema rather than being folded into buildSystemPrompt there.
function buildSystemPrompt(language) {
  const languageName = LANGUAGE_NAMES[language] || LANGUAGE_NAMES.en;
  return `You are an SEO content strategist. Given a target keyword, the user's page content, and the content of the pages currently ranking in the top 10 Google results for that keyword, identify subtopics or entities that most competitors cover but the user's page does not.

Only include a subtopic when it is covered by more than half of the competitor pages provided AND is not already covered by the user's page (check the user's title, headings, and general topic — not just exact wording). Return a JSON array where each item has exactly these fields:
- "topic": short label for the missing subtopic or entity (a few words, in ${languageName})
- "competitorsCovering": integer, how many of the competitor pages provided cover this subtopic
- "competitorUrls": array of the specific competitor URLs (from the ones provided) that cover it

Return ONLY the JSON array, no prose, no markdown fences.`;
}

function parseGapResponse(content) {
  const textBlock = (content || []).find((block) => block.type === 'text');
  if (!textBlock) return [];

  const raw = textBlock.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // Sorted defensively rather than trusting prompt-only ordering, since the
  // report tab prioritizes subtopics by how many competitors cover them.
  return [...parsed].sort((a, b) => (b.competitorsCovering ?? 0) - (a.competitorsCovering ?? 0));
}

async function compareContent({ keyword, userContent, competitorContents, language = 'en' }) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    system: buildSystemPrompt(language),
    messages: [
      {
        role: 'user',
        content: `Target keyword: ${keyword}

User page: ${JSON.stringify(userContent)}

Competitor pages (top ${competitorContents.length} Google results for this keyword): ${JSON.stringify(competitorContents)}`,
      },
    ],
  });

  return parseGapResponse(message.content);
}

module.exports = { compareContent, parseGapResponse, buildSystemPrompt };

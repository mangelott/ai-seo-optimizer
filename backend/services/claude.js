const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateRecommendations({ domain, technical, content, keywords, backlinks }) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `You are an SEO expert. Given the following audit data for ${domain}, produce a prioritized list of actionable SEO recommendations (highest impact first). Return concise bullet points grouped by category (technical, content, keywords, backlinks).

Technical audit: ${JSON.stringify(technical)}
Content data: ${JSON.stringify(content)}
Keyword data: ${JSON.stringify(keywords)}
Backlink data: ${JSON.stringify(backlinks)}`,
      },
    ],
  });

  return message.content[0].text;
}

module.exports = { generateRecommendations };

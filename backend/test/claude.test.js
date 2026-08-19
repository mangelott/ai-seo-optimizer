const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRecommendationsResponse, buildSystemPrompt } = require('../services/claude');

const SAMPLE_FIX = {
  category: 'content',
  severity: 'high',
  title: 'Missing meta description',
  what: 'The page has no meta description.',
  why: 'Hurts click-through rate from search results.',
  currentValue: '',
  suggestedFix: 'Add a 150-160 character meta description.',
  snippet: '<meta name="description" content="...">',
  cmsAutoApplicable: true,
};

test('parses a plain text block containing a JSON array', () => {
  const content = [{ type: 'text', text: JSON.stringify([SAMPLE_FIX]) }];
  const result = parseRecommendationsResponse(content);
  assert.deepEqual(result, [SAMPLE_FIX]);
});

test('regression: skips a leading "thinking" block and finds the text block', () => {
  // claude-sonnet-5 can return an extended-thinking block before the actual
  // text response; content[0].text used to be read blindly, which broke this.
  const content = [
    { type: 'thinking', thinking: '', signature: 'abc123' },
    { type: 'text', text: JSON.stringify([SAMPLE_FIX]) },
  ];
  const result = parseRecommendationsResponse(content);
  assert.deepEqual(result, [SAMPLE_FIX]);
});

test('strips markdown code fences if the model wraps the JSON anyway', () => {
  const content = [{ type: 'text', text: '```json\n' + JSON.stringify([SAMPLE_FIX]) + '\n```' }];
  const result = parseRecommendationsResponse(content);
  assert.deepEqual(result, [SAMPLE_FIX]);
});

test('returns an empty array when no text block is present', () => {
  const content = [{ type: 'thinking', thinking: '', signature: 'abc123' }];
  assert.deepEqual(parseRecommendationsResponse(content), []);
});

test('returns an empty array on invalid JSON instead of throwing', () => {
  const content = [{ type: 'text', text: 'not valid json{{{' }];
  assert.deepEqual(parseRecommendationsResponse(content), []);
});

test('returns an empty array if the model returns a JSON object instead of an array', () => {
  const content = [{ type: 'text', text: JSON.stringify({ oops: 'not an array' }) }];
  assert.deepEqual(parseRecommendationsResponse(content), []);
});

test('returns an empty array for undefined/null content', () => {
  assert.deepEqual(parseRecommendationsResponse(undefined), []);
  assert.deepEqual(parseRecommendationsResponse(null), []);
});

test('system prompt instructs the model to correct existing structured data instead of duplicating it', () => {
  assert.match(buildSystemPrompt('en'), /structuredData/);
  assert.match(buildSystemPrompt('en'), /CORRECTION/);
});

test('system prompt caps readability fixes at medium severity and requires they still be included', () => {
  const prompt = buildSystemPrompt('en');
  assert.match(prompt, /readabilityLabel/);
  assert.match(prompt, /severity "medium"/);
  assert.match(prompt, /never "high"/);
});

test('system prompt defines a distinct "aeo" category, separate from technical/content', () => {
  const prompt = buildSystemPrompt('en');
  assert.match(prompt, /"technical", "content", "keywords", "backlinks", "aeo"/);
  assert.match(prompt, /own "aeo" category/);
});

test('system prompt uses questionHeadings/firstParagraphs/structuredData to judge AEO readiness', () => {
  const prompt = buildSystemPrompt('en');
  assert.match(prompt, /"questionHeadings"/);
  assert.match(prompt, /"firstParagraphs"/);
  assert.match(prompt, /FAQPage.*HowTo|HowTo.*FAQPage/);
});

test('system prompt requests the correct output language', () => {
  assert.match(buildSystemPrompt('pt'), /Portuguese/);
  assert.match(buildSystemPrompt('en'), /English/);
  // unsupported language codes fall back to English rather than throwing
  assert.match(buildSystemPrompt('xx'), /English/);
});

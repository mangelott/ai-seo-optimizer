const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGapResponse, buildSystemPrompt } = require('../services/contentGap');

const SAMPLE_SUBTOPICS = [
  { topic: 'Pricing', competitorsCovering: 4, competitorUrls: ['https://a.example.com', 'https://b.example.com'] },
  { topic: 'Delivery times', competitorsCovering: 8, competitorUrls: ['https://a.example.com'] },
  { topic: 'Return policy', competitorsCovering: 6, competitorUrls: [] },
];

test('parses a plain text block containing a JSON array, sorted by competitorsCovering descending', () => {
  const content = [{ type: 'text', text: JSON.stringify(SAMPLE_SUBTOPICS) }];
  const result = parseGapResponse(content);
  assert.deepEqual(
    result.map((r) => r.topic),
    ['Delivery times', 'Return policy', 'Pricing']
  );
});

test('strips markdown code fences if the model wraps the JSON anyway', () => {
  const content = [{ type: 'text', text: '```json\n' + JSON.stringify(SAMPLE_SUBTOPICS) + '\n```' }];
  const result = parseGapResponse(content);
  assert.equal(result.length, 3);
  assert.equal(result[0].topic, 'Delivery times');
});

test('skips a leading "thinking" block and finds the text block', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'abc123' },
    { type: 'text', text: JSON.stringify(SAMPLE_SUBTOPICS) },
  ];
  const result = parseGapResponse(content);
  assert.equal(result.length, 3);
});

test('returns an empty array when no text block is present', () => {
  const content = [{ type: 'thinking', thinking: '', signature: 'abc123' }];
  assert.deepEqual(parseGapResponse(content), []);
});

test('returns an empty array on invalid JSON instead of throwing', () => {
  const content = [{ type: 'text', text: 'not valid json{{{' }];
  assert.deepEqual(parseGapResponse(content), []);
});

test('returns an empty array if the model returns a JSON object instead of an array', () => {
  const content = [{ type: 'text', text: JSON.stringify({ oops: 'not an array' }) }];
  assert.deepEqual(parseGapResponse(content), []);
});

test('returns an empty array for undefined/null content', () => {
  assert.deepEqual(parseGapResponse(undefined), []);
  assert.deepEqual(parseGapResponse(null), []);
});

test('treats a missing competitorsCovering as zero when sorting, rather than throwing', () => {
  const content = [
    {
      type: 'text',
      text: JSON.stringify([
        { topic: 'No count', competitorUrls: [] },
        { topic: 'Has count', competitorsCovering: 3, competitorUrls: [] },
      ]),
    },
  ];
  const result = parseGapResponse(content);
  assert.deepEqual(
    result.map((r) => r.topic),
    ['Has count', 'No count']
  );
});

test('system prompt requests the correct output language', () => {
  assert.match(buildSystemPrompt('pt'), /Portuguese/);
  assert.match(buildSystemPrompt('en'), /English/);
  // unsupported language codes fall back to English rather than throwing
  assert.match(buildSystemPrompt('xx'), /English/);
});

test('system prompt only asks for subtopics covered by a majority of competitors', () => {
  assert.match(buildSystemPrompt('en'), /more than half/);
});

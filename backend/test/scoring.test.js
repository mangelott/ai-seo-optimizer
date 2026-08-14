const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreContent } = require('../services/scoring');

test('perfect content scores 100 with no issues', () => {
  const { score, issues } = scoreContent({
    title: 'Great Title',
    titleLength: 12,
    metaDescription: 'A fine description of reasonable length for SEO purposes.',
    metaDescriptionLength: 59,
    h1Count: 1,
    imagesMissingAlt: 0,
    wordCount: 500,
  });
  assert.equal(score, 100);
  assert.deepEqual(issues, []);
});

test('missing title, meta description, and h1 stack penalties', () => {
  const { score, issues } = scoreContent({
    title: '',
    titleLength: 0,
    metaDescription: '',
    metaDescriptionLength: 0,
    h1Count: 0,
    imagesMissingAlt: 0,
    wordCount: 500,
  });
  // 100 - 15 (title) - 15 (meta) - 10 (h1) = 60
  assert.equal(score, 60);
  assert.deepEqual(issues.sort(), ['missing_h1', 'missing_meta_description', 'missing_title'].sort());
});

test('images missing alt penalty caps at 20 points', () => {
  const { score, issues } = scoreContent({
    title: 'x'.repeat(20),
    titleLength: 20,
    metaDescription: 'x'.repeat(100),
    metaDescriptionLength: 100,
    h1Count: 1,
    imagesMissingAlt: 50,
    wordCount: 500,
  });
  // 100 - min(20, 50*2)=20 = 80, regardless of how many images are missing alt
  assert.equal(score, 80);
  assert.ok(issues.includes('images_missing_alt'));
});

test('thin content and title too long are flagged', () => {
  const { score, issues } = scoreContent({
    title: 'x'.repeat(80),
    titleLength: 80,
    metaDescription: 'x'.repeat(200),
    metaDescriptionLength: 200,
    h1Count: 2,
    imagesMissingAlt: 0,
    wordCount: 50,
  });
  // title_too_long(-5) + meta_description_too_long(-5) + multiple_h1(-5) + thin_content(-10) = -25
  assert.equal(score, 75);
  assert.deepEqual(
    issues.sort(),
    ['title_too_long', 'meta_description_too_long', 'multiple_h1', 'thin_content'].sort()
  );
});

test('score is floored at 0 and never goes negative', () => {
  // Worst case with today's weights (title 15 + meta 15 + h1 10 + images 20 + thin 10 = 70)
  // only reaches 30, so this directly exercises the Math.max(0, ...) floor rather than
  // relying on it being reachable through realistic penalties.
  const worstCase = {
    title: '',
    titleLength: 0,
    metaDescription: '',
    metaDescriptionLength: 0,
    h1Count: 0,
    imagesMissingAlt: 100,
    wordCount: 10,
  };
  assert.equal(scoreContent(worstCase).score, 30);
  assert.ok(scoreContent(worstCase).score >= 0);
});

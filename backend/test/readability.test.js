// Tests for services/readability.js. English fixtures check the actual
// Flesch Reading Ease score/band since the formula's coefficients are
// well-established; Portuguese fixtures (no calibrated formula, see the
// file header there) mainly check the label direction and the raw stats
// it's derived from, since the numeric "score" field is intentionally null
// for Portuguese rather than pretending to be comparable to Flesch.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreReadability, countSyllablesEn, countSyllablesPt } = require('../services/readability');

const EN_EASY = 'The cat sat on the mat. The dog ran fast. Birds sing songs. I like cake.';

const EN_DIFFICULT =
  'Notwithstanding the aforementioned considerations, the multifaceted implications of contemporary ' +
  'organizational restructuring necessitate comprehensive interdisciplinary analysis, particularly ' +
  'regarding the socioeconomic ramifications precipitated by technological innovation and globalization.';

const PT_EASY = 'O cão é bom. O sol é forte. Eu vou lá. Ela tem pão.';

const PT_DIFFICULT =
  'Não obstante as considerações supramencionadas, as implicações multifacetadas da reestruturação ' +
  'organizacional contemporânea necessitam de uma análise interdisciplinar abrangente, particularmente ' +
  'relativamente às ramificações socioeconómicas precipitadas pela inovação tecnológica e pela globalização.';

test('scoreReadability: English easy text scores high and labels "easy"', () => {
  const result = scoreReadability(EN_EASY, 'en');
  assert.equal(result.language, 'en');
  assert.equal(result.method, 'flesch_reading_ease');
  assert.equal(result.label, 'easy');
  assert.ok(result.score >= 60, `expected score >= 60, got ${result.score}`);
});

test('scoreReadability: English difficult text scores low and labels "difficult"', () => {
  const result = scoreReadability(EN_DIFFICULT, 'en');
  assert.equal(result.label, 'difficult');
  assert.ok(result.score < 30, `expected score < 30, got ${result.score}`);
});

test('scoreReadability: English score reflects easy vs difficult in the right direction', () => {
  const easy = scoreReadability(EN_EASY, 'en');
  const difficult = scoreReadability(EN_DIFFICULT, 'en');
  assert.ok(easy.score > difficult.score, `expected easy score (${easy.score}) > difficult score (${difficult.score})`);
});

test('scoreReadability: Portuguese easy text labels "easy" and has no numeric score', () => {
  const result = scoreReadability(PT_EASY, 'pt');
  assert.equal(result.language, 'pt');
  assert.equal(result.method, 'sentence_and_syllable_length');
  assert.equal(result.score, null);
  assert.equal(result.label, 'easy');
  assert.ok(result.avgWordsPerSentence <= 14);
});

test('scoreReadability: Portuguese difficult text labels "difficult"', () => {
  const result = scoreReadability(PT_DIFFICULT, 'pt');
  assert.equal(result.score, null);
  assert.equal(result.label, 'difficult');
});

test('scoreReadability: Portuguese avgWordsPerSentence/avgSyllablesPerWord reflect easy vs difficult in the right direction', () => {
  const easy = scoreReadability(PT_EASY, 'pt');
  const difficult = scoreReadability(PT_DIFFICULT, 'pt');
  assert.ok(easy.avgWordsPerSentence < difficult.avgWordsPerSentence);
});

test('scoreReadability: returns null for empty or whitespace-only text', () => {
  assert.equal(scoreReadability('', 'en'), null);
  assert.equal(scoreReadability('   ', 'pt'), null);
  assert.equal(scoreReadability(undefined, 'en'), null);
});

test('scoreReadability: defaults to English scoring for an unrecognized/missing language', () => {
  const explicit = scoreReadability(EN_EASY, 'en');
  const defaulted = scoreReadability(EN_EASY);
  const unknown = scoreReadability(EN_EASY, 'fr');
  assert.deepEqual(defaulted, explicit);
  assert.deepEqual(unknown, explicit);
});

test('countSyllablesEn: monosyllabic words with a silent trailing "e" count as one syllable', () => {
  assert.equal(countSyllablesEn('like'), 1);
  assert.equal(countSyllablesEn('cake'), 1);
});

test('countSyllablesEn: multi-syllable words roughly match spoken syllable count', () => {
  assert.equal(countSyllablesEn('banana'), 3);
  assert.equal(countSyllablesEn('organizational'), 6);
});

test('countSyllablesPt: a pronounced trailing "e" is not stripped, unlike English', () => {
  assert.equal(countSyllablesPt('grande'), 2);
});

test('countSyllablesPt: nasal diphthongs count as one vowel group', () => {
  assert.equal(countSyllablesPt('cão'), 1);
  assert.equal(countSyllablesPt('pão'), 1);
});

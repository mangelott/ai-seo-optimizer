// Readability scoring, calibrated per language. Sentence/word/syllable
// splitting here is a heuristic (same idea as most JS syllable counters,
// e.g. the "syllable" npm package) — good enough to separate "clearly easy"
// from "clearly hard" text, not a linguistic parser.
//
// English uses the standard Flesch Reading Ease formula. Its coefficients
// (206.835 / 1.015 / 84.6) were fit specifically to English prose and don't
// transfer to other languages: Portuguese words simply average more
// syllables than English ones, so running Portuguese text through the same
// formula reports it as harder than it actually is.
//
// There are published "Flesch adapted for Portuguese" formulas in the
// literature, but this project has no reliable npm package implementing one
// and no way to verify a hand-copied set of recalibrated coefficients
// against a trustworthy source — shipping an unverified formula dressed up
// as "Flesch-Vieira" would be less honest than admitting we don't have it.
// So for Portuguese this falls back to the two raw inputs a Flesch-style
// formula is built from (average words per sentence, average syllables per
// word) and buckets those directly against plain-language rules of thumb.
// Cruder than a calibrated formula, but it doesn't claim precision it
// doesn't have.

const SENTENCE_SPLIT_RE = /[.!?]+(?:\s+|$)/;
const WORD_RE = /\p{L}+/gu;
const VOWELS_EN_RE = /[aeiouy]+/g;
const VOWELS_PT_RE = /[aeiouáàâãéêíóôõú]+/g;

function splitSentences(text) {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitWords(text) {
  return text.match(WORD_RE) || [];
}

// English vowel-group heuristic with the usual corrections: a trailing
// silent "e" (e.g. "like") and a leading "y" acting as a consonant don't
// count as syllable nuclei.
function countSyllablesEn(word) {
  const w = word.toLowerCase();
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^aeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const matches = stripped.match(VOWELS_EN_RE);
  return matches ? Math.max(1, matches.length) : 1;
}

// Portuguese doesn't get the English corrections above — a trailing "e" is
// pronounced ("grande" is 2 syllables, not 1), so stripping it would
// undercount. Plain vowel-group counting (including accented vowels).
function countSyllablesPt(word) {
  const matches = word.toLowerCase().match(VOWELS_PT_RE);
  return matches ? Math.max(1, matches.length) : 1;
}

function computeStats(text, countSyllables) {
  const sentences = splitSentences(text);
  const words = splitWords(text);
  if (sentences.length === 0 || words.length === 0) return null;

  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return {
    avgWordsPerSentence: words.length / sentences.length,
    avgSyllablesPerWord: syllableCount / words.length,
  };
}

function fleschReadingEase(avgWordsPerSentence, avgSyllablesPerWord) {
  return 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
}

// Standard Flesch bands (0-100, higher = easier), collapsed to three labels:
// 60+ is the commonly-cited "Plain English" threshold, under 30 is widely
// cited as very hard to follow without effort.
function labelFromFleschScore(rawScore) {
  if (rawScore >= 60) return 'easy';
  if (rawScore >= 30) return 'medium';
  return 'difficult';
}

// No calibrated formula for Portuguese (see file header) — bucket the two
// raw stats directly against a plain-language rule of thumb: short
// sentences of short words read easy, long sentences of long words read
// hard. Not a validated scale, just an honest approximation.
function labelFromRawStats(avgWordsPerSentence, avgSyllablesPerWord) {
  if (avgWordsPerSentence <= 14 && avgSyllablesPerWord <= 1.8) return 'easy';
  if (avgWordsPerSentence <= 22 && avgSyllablesPerWord <= 2.2) return 'medium';
  return 'difficult';
}

function scoreReadability(text, language = 'en') {
  const normalized = (text || '').trim();
  if (!normalized) return null;

  if (language === 'pt') {
    const stats = computeStats(normalized, countSyllablesPt);
    if (!stats) return null;
    return {
      language: 'pt',
      method: 'sentence_and_syllable_length',
      score: null,
      label: labelFromRawStats(stats.avgWordsPerSentence, stats.avgSyllablesPerWord),
      avgWordsPerSentence: stats.avgWordsPerSentence,
      avgSyllablesPerWord: stats.avgSyllablesPerWord,
    };
  }

  const stats = computeStats(normalized, countSyllablesEn);
  if (!stats) return null;
  const rawScore = fleschReadingEase(stats.avgWordsPerSentence, stats.avgSyllablesPerWord);
  return {
    language: 'en',
    method: 'flesch_reading_ease',
    score: Math.max(0, Math.min(100, Math.round(rawScore))),
    label: labelFromFleschScore(rawScore),
    avgWordsPerSentence: stats.avgWordsPerSentence,
    avgSyllablesPerWord: stats.avgSyllablesPerWord,
  };
}

module.exports = { scoreReadability, countSyllablesEn, countSyllablesPt };

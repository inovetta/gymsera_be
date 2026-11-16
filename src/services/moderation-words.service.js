'use strict';
/**
 * NEW-256: the word filter on chat messages and reviews (App Store 1.2, Google Play UGC policy).
 *
 * The list lives in `moderation_words` (seeded by platform migration p031, edited by platform
 * admins in the CMS). A word matches as a whole word, case-insensitive, in any script. A message
 * or review that contains one is refused with 422 `content_blocked`; nothing is stored.
 *
 * The list is cached in this process for CACHE_MS and dropped at once when an admin saves it.
 */
const { sequelize } = require('../database/platform');
const { ModerationWord } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const { WORD_LIST_LIMITS, BLOCKED_WORDS_MESSAGE } = require('../constants/moderation');

const CACHE_MS = 60 * 1000;
let cache = null; // { words: string[], pattern: RegExp|null, at: number }

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lower-case, trimmed, inner spaces collapsed. */
const normalizeWord = (w) => String(w ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const buildPattern = (words) => {
  if (!words.length) return null;
  const alternatives = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  // Whole words: no letter or digit right before or after (works for any script).
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'iu');
};

const clearCache = () => {
  cache = null;
};

const getWords = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.words;
  const rows = await ModerationWord.findAll({ attributes: ['word'], order: [['word', 'ASC']] });
  const words = rows.map((r) => r.word);
  cache = { words, pattern: buildPattern(words), at: Date.now() };
  return words;
};

/** True when the text contains a listed word. */
const containsBlockedWord = async (text) => {
  if (typeof text !== 'string' || !text.trim()) return false;
  await getWords();
  return cache.pattern ? cache.pattern.test(text) : false;
};

/**
 * Throws 422 `content_blocked` when any of the texts contains a listed word. Called before a
 * chat message or a review is stored.
 */
const assertClean = async (...texts) => {
  for (const text of texts) {
    if (await containsBlockedWord(text)) {
      throw createError(BLOCKED_WORDS_MESSAGE, 422, 'content_blocked');
    }
  }
};

/**
 * Replaces the whole list (CMS: Moderation › Word list). Returns the saved list, sorted.
 * Words are trimmed and lower-cased; duplicates are dropped; each is 2-50 characters.
 */
const replaceWords = async (input) => {
  if (!Array.isArray(input)) throw createError('words must be a list', 422, 'validation_error');
  const words = [...new Set(input.map(normalizeWord).filter(Boolean))];
  const { maxWords, minLength, maxLength } = WORD_LIST_LIMITS;
  if (words.length > maxWords) throw createError(`At most ${maxWords} words`, 422, 'validation_error');
  const bad = words.filter((w) => w.length < minLength || w.length > maxLength);
  if (bad.length) {
    throw createError(`Each word must be ${minLength}-${maxLength} characters: ${bad.slice(0, 5).join(', ')}`, 422, 'validation_error');
  }
  await sequelize.transaction(async (transaction) => {
    await ModerationWord.destroy({ where: {}, transaction });
    if (words.length) await ModerationWord.bulkCreate(words.map((word) => ({ word })), { transaction });
  });
  clearCache();
  return getWords();
};

module.exports = {
  getWords,
  containsBlockedWord,
  assertClean,
  replaceWords,
  clearCache,
  normalizeWord,
};

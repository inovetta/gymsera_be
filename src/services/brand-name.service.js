/**
 * R-112 (spec §13 "R-112", C1): the brand / organisation name (tenants.business_name) the host types in
 * Become a Host Step 2 and in Edit.
 *
 * Reuses the area-name rules where they fit (NEW-265 A2): the same cleaning, the same link rule and the
 * same word filter (NEW-256). The area names' character whitelist and "two letters" rule are not used, so
 * real brands such as "F45", "Gold's Gym", "24/7 Fitness" or "Fit+ Club" pass. Markup characters are
 * refused because platform e-mails print the brand inside HTML.
 */
const { createError } = require('../utils/response.utils');
const { cleanAreaName, LINK } = require('./area-requests.service');
const moderationWords = require('./moderation-words.service');

const BRAND_MIN = 3;
const BRAND_MAX = 60;
const INVALID_MESSAGE = 'Brand names are 3 to 60 characters and can\'t be a link or a phone number.';
const BLOCKED_MESSAGE = 'Please choose a different name.';

// eslint-disable-next-line no-control-regex
const MARKUP_OR_CONTROL = /[<>\u0000-\u001f\u007f]/u;

/** Throws 422 `brand_name_invalid` / `brand_name_blocked` (the word is never echoed); returns the cleaned name. */
const validateBrandName = async (name) => {
  const invalid = () => createError(INVALID_MESSAGE, 422, 'brand_name_invalid');
  if (typeof name !== 'string') throw invalid();
  if (MARKUP_OR_CONTROL.test(name)) throw invalid();
  const clean = cleanAreaName(name);
  if (clean.length < BRAND_MIN || clean.length > BRAND_MAX) throw invalid();
  if (!/\p{L}/u.test(clean)) throw invalid();
  if (/\p{Nd}{7,}/u.test(clean.replace(/[\s-]/g, ''))) throw invalid();
  if (LINK.test(clean)) throw invalid();
  if (await moderationWords.containsBlockedWord(clean)) throw createError(BLOCKED_MESSAGE, 422, 'brand_name_blocked');
  return clean;
};

module.exports = { validateBrandName, BRAND_MIN, BRAND_MAX };

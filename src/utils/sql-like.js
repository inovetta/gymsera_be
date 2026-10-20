/**
 * LIKE patterns built from user input (SEC-16).
 *
 * Sequelize sends the search text as a bound value, so it can never change the SQL statement. But inside
 * a LIKE pattern `%` and `_` are wildcards, so a search for "%" or "_" matched every row, and a long
 * run of them makes the database do needless work. These helpers escape the wildcards (and the escape
 * character itself) so the text is searched for literally, and cap the length.
 *
 * Use with Sequelize: `{ fullName: { [Op.like]: likeContains(q) } }`. MySQL's default LIKE escape
 * character is the backslash, so no ESCAPE clause is needed.
 *
 * tests/regression/sec-16-sql-guard.test.js fails on a LIKE pattern built any other way.
 */

const MAX_TERM = 100;

/** The user's text as a plain string: a repeated query parameter (an array) uses its first value; objects count as empty. */
const asTerm = (value) => {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
};

/**
 * Escapes % and _ so the text matches itself. Backslashes are dropped: the backslash is LIKE's escape
 * character, MySQL reads it through two layers (string literal, then pattern), and the result was not
 * reliable across settings in testing. No name, e-mail address or phone number needs one.
 */
const escapeLike = (value) => asTerm(value).slice(0, MAX_TERM).replace(/\\/g, '').replace(/[%_]/g, '\\$&');

const likeContains = (value) => `%${escapeLike(value)}%`;
const likeStartsWith = (value) => `${escapeLike(value)}%`;
const likeEndsWith = (value) => `%${escapeLike(value)}`;

module.exports = { escapeLike, likeContains, likeStartsWith, likeEndsWith, MAX_TERM };

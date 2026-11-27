/**
 * Rename helpers for platform and tenant migrations (R-120, NEW-305; docs/NAMING_AND_DATA_DICTIONARY.md §3.4).
 *
 * MySQL 5.7 has no RENAME COLUMN: a column is renamed with CHANGE COLUMN and its full definition, which these
 * helpers read from information_schema and restate exactly (type, character set, collation, NULL, default,
 * extra), so a foreign key on the column survives and the table is not rebuilt. Every ALTER ends with
 * ALGORITHM=INPLACE, LOCK=NONE: if MySQL would have to copy the table, it refuses instead.
 *
 * Each helper is idempotent and handles the four states a database can be in:
 *   only the old name        → rename
 *   only the new name        → nothing to do (already renamed, or a fresh database built by sync)
 *   both, the new one empty  → drop the new one, then rename (new code booted before the migration and
 *                              development sync({ alter: true }) created an empty copy)
 *   both, both with data     → nothing is changed; the result says why (`skipped`), like _addNullableColumn
 *
 * Every helper returns { statements, skipped? }. With { dryRun: true } it only returns the statements.
 */
const { QueryTypes } = require('sequelize');

const INPLACE = 'ALGORITHM=INPLACE, LOCK=NONE';
const q = (name) => `\`${String(name).replace(/`/g, '``')}\``;

const select = (seq, sql, replacements) => seq.query(sql, { replacements, type: QueryTypes.SELECT });

const tableExists = async (seq, table) =>
  (await select(seq, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])).length > 0;

const columnInfo = async (seq, table, column) => {
  const [col] = await select(
    seq,
    'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra, ' +
      'CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_COMMENT AS comment ' +
      'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return col || null;
};

const indexExists = async (seq, table, index) =>
  (await select(
    seq,
    'SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, index]
  )).length > 0;

const foreignKeysOn = (seq, table, column) =>
  select(
    seq,
    'SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() ' +
      'AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
    [table, column]
  );

const countWhereNotNull = async (seq, table, column) => {
  const [{ n }] = await select(seq, `SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${q(column)} IS NOT NULL`);
  return Number(n);
};

const countRows = async (seq, table) => {
  const [{ n }] = await select(seq, `SELECT COUNT(*) AS n FROM ${q(table)}`);
  return Number(n);
};

const run = async (seq, statements, dryRun) => {
  if (!dryRun) for (const s of statements) await seq.query(s);
  return { statements };
};

/** The column definition exactly as it is, for CHANGE / MODIFY COLUMN. */
const definitionOf = (col, comment) => {
  const parts = [col.type];
  if (col.charset) parts.push(`CHARACTER SET ${col.charset}`);
  if (col.collation) parts.push(`COLLATE ${col.collation}`);
  parts.push(col.nullable === 'YES' ? 'NULL' : 'NOT NULL');
  if (col.dflt !== null && col.dflt !== undefined) {
    const isExpr = /^current_timestamp(\(\d*\))?$/i.test(col.dflt);
    parts.push(`DEFAULT ${isExpr ? col.dflt : `'${String(col.dflt).replace(/'/g, '\'\'')}'`}`);
  } else if (col.nullable === 'YES' && !/^(tinytext|text|mediumtext|longtext|tinyblob|blob|mediumblob|longblob|json|geometry)/i.test(col.type)) {
    parts.push('DEFAULT NULL');
  }
  if (col.extra && !/^DEFAULT_GENERATED$/i.test(col.extra)) parts.push(col.extra.replace(/DEFAULT_GENERATED\s*/i, ''));
  const text = comment !== undefined ? comment : col.comment;
  if (text) parts.push(`COMMENT '${String(text).replace(/'/g, '\'\'')}'`);
  return parts.join(' ');
};

/** Renames `from` to `to` in `table` (four states). `comment` replaces the column comment when given. */
const renameColumn = async (seq, { table, from, to, comment, dryRun = false }) => {
  if (!(await tableExists(seq, table))) return { statements: [] };
  const oldCol = await columnInfo(seq, table, from);
  if (!oldCol) return { statements: [] };
  const statements = [];
  if (await columnInfo(seq, table, to)) {
    if ((await countWhereNotNull(seq, table, to)) > 0) {
      return { statements: [], skipped: { reason: 'both_columns_have_data', table, from, to } };
    }
    statements.push(`ALTER TABLE ${q(table)} DROP COLUMN ${q(to)}`);
  }
  statements.push(`ALTER TABLE ${q(table)} CHANGE COLUMN ${q(from)} ${q(to)} ${definitionOf(oldCol, comment)}, ${INPLACE}`);
  return run(seq, statements, dryRun);
};

/** Sets a column's comment without changing anything else. */
const setColumnComment = async (seq, { table, column, comment, dryRun = false }) => {
  const col = (await tableExists(seq, table)) ? await columnInfo(seq, table, column) : null;
  if (!col || col.comment === comment) return { statements: [] };
  return run(seq, [`ALTER TABLE ${q(table)} MODIFY COLUMN ${q(column)} ${definitionOf(col, comment)}, ${INPLACE}`], dryRun);
};

/** Renames table `from` to `to` (four states). `comment` sets the table comment when given. */
const renameTable = async (seq, { from, to, comment, dryRun = false }) => {
  const [hasOld, hasNew] = [await tableExists(seq, from), await tableExists(seq, to)];
  const statements = [];
  if (hasOld) {
    if (hasNew) {
      if ((await countRows(seq, to)) > 0) return { statements: [], skipped: { reason: 'both_tables_have_data', from, to } };
      statements.push(`DROP TABLE ${q(to)}`);
    }
    statements.push(`RENAME TABLE ${q(from)} TO ${q(to)}`);
  }
  if (comment !== undefined && (hasOld || hasNew)) statements.push(`ALTER TABLE ${q(to)} COMMENT = '${String(comment).replace(/'/g, '\'\'')}'`);
  if (statements.length === 0) return { statements: [] };
  try {
    return await run(seq, statements, dryRun);
  } catch (err) {
    // An empty copy that other tables already reference cannot be dropped: report, change nothing more.
    if (hasNew && /foreign key|referenced/i.test(err.message)) return { statements: [], skipped: { reason: 'new_table_referenced', from, to } };
    throw err;
  }
};

/** Renames an index (metadata only). If both names exist, the old-named duplicate is dropped. */
const renameIndex = async (seq, { table, from, to, dryRun = false }) => {
  if (!(await tableExists(seq, table)) || !(await indexExists(seq, table, from))) return { statements: [] };
  if (await indexExists(seq, table, to)) return run(seq, [`ALTER TABLE ${q(table)} DROP INDEX ${q(from)}, ${INPLACE}`], dryRun);
  return run(seq, [`ALTER TABLE ${q(table)} RENAME INDEX ${q(from)} TO ${q(to)}, ${INPLACE}`], dryRun);
};

/** Drops a column (and first any foreign key on it). Already gone → nothing. */
const dropColumn = async (seq, { table, column, dryRun = false }) => {
  if (!(await tableExists(seq, table)) || !(await columnInfo(seq, table, column))) return { statements: [] };
  const statements = (await foreignKeysOn(seq, table, column)).map((fk) => `ALTER TABLE ${q(table)} DROP FOREIGN KEY ${q(fk.name)}`);
  statements.push(`ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}, ${INPLACE}`);
  return run(seq, statements, dryRun);
};

const enumValuesOf = (type) => [...String(type).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, '\''));
const enumType = (values) => `enum(${values.map((v) => `'${v.replace(/'/g, '\'\'')}'`).join(',')})`;

/**
 * Renames stored ENUM values: widen to old + new values, UPDATE the rows, narrow to `values` (the final list).
 * NULL / NOT NULL, the default (mapped through `rename`) and the comment are kept. Refuses (skipped) when a
 * row holds a value that is neither in `values` nor renamed.
 */
const renameEnumValues = async (seq, { table, column, rename, values, dryRun = false }) => {
  const col = (await tableExists(seq, table)) ? await columnInfo(seq, table, column) : null;
  if (!col) return { statements: [] };
  const current = enumValuesOf(col.type);
  if (current.length === values.length && current.every((v, i) => v === values[i])) return { statements: [] };
  const rows = await select(seq, `SELECT DISTINCT ${q(column)} AS v FROM ${q(table)} WHERE ${q(column)} IS NOT NULL`);
  const unknown = rows.map((r) => r.v).filter((v) => !values.includes(v) && !(v in rename));
  if (unknown.length > 0) return { statements: [], skipped: { reason: 'unknown_enum_values', table, column, unknown } };
  const wide = [...current, ...values.filter((v) => !current.includes(v))];
  const dflt = col.dflt !== null && col.dflt !== undefined ? (rename[col.dflt] || col.dflt) : null;
  const statements = [`ALTER TABLE ${q(table)} MODIFY COLUMN ${q(column)} ${definitionOf({ ...col, type: enumType(wide) })}`];
  for (const [from, to] of Object.entries(rename)) {
    statements.push(`UPDATE ${q(table)} SET ${q(column)} = '${to.replace(/'/g, '\'\'')}' WHERE ${q(column)} = '${from.replace(/'/g, '\'\'')}'`);
  }
  statements.push(`ALTER TABLE ${q(table)} MODIFY COLUMN ${q(column)} ${definitionOf({ ...col, type: enumType(values), dflt })}`);
  return run(seq, statements, dryRun);
};

/** Renames stored string values of a VARCHAR column (no type change). */
const renameStringValues = async (seq, { table, column, rename, dryRun = false }) => {
  if (!(await tableExists(seq, table)) || !(await columnInfo(seq, table, column))) return { statements: [] };
  const statements = Object.entries(rename).map(([from, to]) =>
    `UPDATE ${q(table)} SET ${q(column)} = '${to.replace(/'/g, '\'\'')}' WHERE ${q(column)} = '${from.replace(/'/g, '\'\'')}'`);
  return run(seq, statements, dryRun);
};

/**
 * Widens a VARCHAR column to `length` (never narrows). Everything else about the column is kept.
 * In place when the length prefix stays one byte (utf8mb4: up to 63 characters).
 */
const widenVarchar = async (seq, { table, column, length, dryRun = false }) => {
  const col = (await tableExists(seq, table)) ? await columnInfo(seq, table, column) : null;
  const m = col && /^varchar\((\d+)\)$/i.exec(col.type);
  if (!m || Number(m[1]) >= length) return { statements: [] };
  return run(seq, [`ALTER TABLE ${q(table)} MODIFY COLUMN ${q(column)} ${definitionOf({ ...col, type: `varchar(${length})` })}, ${INPLACE}`], dryRun);
};

/** Runs a list of helper calls in order; collects statements and skips (a skip stops nothing else). */
const applyAll = async (seq, steps, { dryRun = false } = {}) => {
  const out = { statements: [], skipped: [] };
  for (const [fn, args] of steps) {
    const r = await fn(seq, { ...args, dryRun });
    out.statements.push(...r.statements);
    if (r.skipped) out.skipped.push(r.skipped);
  }
  return out;
};

module.exports = {
  renameColumn,
  renameTable,
  renameIndex,
  dropColumn,
  setColumnComment,
  renameEnumValues,
  renameStringValues,
  widenVarchar,
  applyAll,
  // for tests and probes
  tableExists,
  columnInfo,
  indexExists,
  definitionOf,
};

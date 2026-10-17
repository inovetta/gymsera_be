/**
 * Makes a model append-only (OBS-07, spec §12.12): rows can be created and read, never changed or
 * removed through the model, one at a time or in bulk. Same four hooks, same wording, as
 * `LedgerAdjustment` (the ledger pattern), written once for the audit models.
 *
 * Hooks see model calls only. Raw SQL is outside them, so
 * tests/regression/obs-07-audit-immutable.test.js also scans the source for raw SQL on the audit
 * tables. Retention or archival of an audit table is a deliberate, separate job, never an
 * UPDATE / DELETE from application code.
 */
const makeAppendOnly = (Model, label) => {
  const cannot = (verb) => () => {
    throw new Error(`${label} is append-only and cannot be ${verb}`);
  };
  Model.beforeUpdate(cannot('updated'));
  Model.beforeBulkUpdate(cannot('updated'));
  Model.beforeDestroy(cannot('deleted'));
  Model.beforeBulkDestroy(cannot('deleted'));
  return Model;
};

module.exports = makeAppendOnly;

/**
 * Invoice Sequence Service (spec §12.4, PAY-05)
 *
 * Implements gapless, per-branch invoice number generation using
 * SELECT ... FOR UPDATE on the tenant's `invoice_sequences` table.
 *
 * Invariant:
 * - Sequential: 000001, 000002, 000003...
 * - Gapless: each transaction obtains the counter under row lock.
 * - Per-branch: separate counters per branchId (or GLOBAL for org-level).
 * - Existing invoices keep their historical numbers.
 */
const { QueryTypes } = require('sequelize');

/**
 * Resolves the underlying Sequelize instance from various caller contexts.
 */
const resolveSequelize = (target) => {
  if (!target) throw new Error('[InvoiceSequence] Database or Sequelize instance is required');
  if (typeof target.query === 'function' && typeof target.transaction === 'function') {
    return target;
  }
  if (target.sequelize && typeof target.sequelize.query === 'function') {
    return target.sequelize;
  }
  if (target.models?.Invoice?.sequelize) {
    return target.models.Invoice.sequelize;
  }
  if (target.Invoice?.sequelize) {
    return target.Invoice.sequelize;
  }
  throw new Error('[InvoiceSequence] Unable to resolve Sequelize instance from db target');
};

/**
 * Derives the default prefix for a sequence row.
 */
const deriveDefaultPrefix = (branchKey) => {
  if (!branchKey || branchKey === 'GLOBAL') {
    return 'INV-ORG';
  }
  const clean = branchKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `INV-${clean || 'BRANCH'}`;
};

/**
 * Generates the next sequential invoice number for a branch.
 *
 * @param {object} dbTarget - Sequelize instance, tenantDb wrapper, or models dict
 * @param {string|null} branchId - Branch UUID, or null/'GLOBAL'
 * @param {object|null} transaction - Active Sequelize transaction, or null
 * @returns {Promise<string>} e.g. "INV-C3D528B3-000001"
 */
const ensureSequenceRow = async (sequelize, branchKey, defaultPrefix) => {
  await sequelize.query(
    `INSERT IGNORE INTO invoice_sequences (branch_id, prefix, next_number, created_at, updated_at)
     VALUES (?, ?, 1, NOW(), NOW())`,
    {
      replacements: [branchKey, defaultPrefix],
    }
  ).catch(() => {});
};

/**
 * Generates the next sequential invoice number for a branch.
 *
 * @param {object} dbTarget - Sequelize instance, tenantDb wrapper, or models dict
 * @param {string|null} branchId - Branch UUID, or null/'GLOBAL'
 * @param {object|null} transaction - Active Sequelize transaction, or null
 * @returns {Promise<string>} e.g. "INV-C3D528B3-000001"
 */
const getNextInvoiceNumber = async (dbTarget, branchId = null, transaction = null) => {
  const sequelize = resolveSequelize(dbTarget);
  const branchKey = branchId || 'GLOBAL';
  const defaultPrefix = deriveDefaultPrefix(branchKey);

  // Ensure row exists outside the lock-seeking transaction to prevent S-lock deadlocks in InnoDB
  await ensureSequenceRow(sequelize, branchKey, defaultPrefix);

  const runWithLock = async (t) => {
    // 1. Lock the counter row exclusively
    const rows = await sequelize.query(
      `SELECT branch_id, prefix, next_number
       FROM invoice_sequences
       WHERE branch_id = ?
       FOR UPDATE`,
      {
        replacements: [branchKey],
        transaction: t,
        type: QueryTypes.SELECT,
      }
    );

    let seqRow = Array.isArray(rows) ? rows[0] : rows;
    if (!seqRow) {
      await sequelize.query(
        `INSERT INTO invoice_sequences (branch_id, prefix, next_number, created_at, updated_at)
         VALUES (?, ?, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        {
          replacements: [branchKey, defaultPrefix],
          transaction: t,
        }
      );
      const refetched = await sequelize.query(
        `SELECT branch_id, prefix, next_number
         FROM invoice_sequences
         WHERE branch_id = ?
         FOR UPDATE`,
        {
          replacements: [branchKey],
          transaction: t,
          type: QueryTypes.SELECT,
        }
      );
      seqRow = Array.isArray(refetched) ? refetched[0] : refetched;
    }

    const currentNumber = seqRow ? Number(seqRow.next_number) : 1;
    const prefix = (seqRow && seqRow.prefix) ? seqRow.prefix : defaultPrefix;

    // 2. Increment the counter for the next caller
    await sequelize.query(
      `UPDATE invoice_sequences
       SET next_number = next_number + 1, updated_at = NOW()
       WHERE branch_id = ?`,
      {
        replacements: [branchKey],
        transaction: t,
      }
    );

    // 3. Return formatted gapless invoice number
    return `${prefix}-${String(currentNumber).padStart(6, '0')}`;
  };

  const executeWithRetry = async (attempt = 1) => {
    try {
      if (transaction) {
        return await runWithLock(transaction);
      }
      return await sequelize.transaction(async (t) => {
        return await runWithLock(t);
      });
    } catch (err) {
      const isDeadlock = err.parent?.code === 'ER_LOCK_DEADLOCK' || err.message?.includes('Deadlock');
      if (isDeadlock && attempt <= 5 && !transaction) {
        const delay = Math.floor(Math.random() * 50) + attempt * 20;
        await new Promise((res) => setTimeout(res, delay));
        return executeWithRetry(attempt + 1);
      }
      throw err;
    }
  };

  return executeWithRetry();
};

module.exports = {
  getNextInvoiceNumber,
  deriveDefaultPrefix,
};

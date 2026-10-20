#!/usr/bin/env node
/**
 * Re-encrypts every value protected by TENANT_CONN_ENCRYPTION_KEY with a new key (SEC-05).
 * Procedure and rollback: docs/runbooks/secrets-rotation.md
 *
 * Covers: tenants.connection_string_encrypted, users.apple_refresh_token_encrypted.
 *
 * Usage (dry run is the default and writes nothing):
 *   TENANT_CONN_ENCRYPTION_KEY_OLD=<64 hex> TENANT_CONN_ENCRYPTION_KEY_NEW=<64 hex> \
 *     node src/scripts/rotate-encryption-key.js
 *   ... node src/scripts/rotate-encryption-key.js --apply
 *
 * Every value is decrypted with the old key and re-encrypted, and the new ciphertext is decrypted again
 * with the new key and compared before anything is written. One bad value stops the run with nothing
 * changed (all updates happen in one transaction).
 */
const { decrypt, encrypt } = require('../utils/crypto.utils');

const TARGETS = [
  { model: 'Tenant', field: 'connectionStringEncrypted', label: 'tenants.connection_string_encrypted', skip: (v) => v === 'PENDING_PROVISIONING' },
  { model: 'User', field: 'appleRefreshTokenEncrypted', label: 'users.apple_refresh_token_encrypted', skip: () => false },
];

/** Returns the value encrypted under newKey. Throws if oldKey cannot read it or the round trip differs. */
const rotateValue = (value, oldKey, newKey) => {
  const plain = decrypt(value, oldKey);
  const next = encrypt(plain, newKey);
  if (decrypt(next, newKey) !== plain) throw new Error('Round trip with the new key did not match');
  return next;
};

/** Pure planning step: { updates: [{ id, next }], skipped, failures: [{ id, error }] } for a list of rows. */
const planRotation = (rows, field, skip, oldKey, newKey) => {
  const updates = [];
  const failures = [];
  let skipped = 0;
  for (const row of rows) {
    const value = row[field];
    if (!value || skip(value)) { skipped += 1; continue; }
    try {
      updates.push({ id: row.id, next: rotateValue(value, oldKey, newKey) });
    } catch (err) {
      failures.push({ id: row.id, error: err.message });
    }
  }
  return { updates, skipped, failures };
};

async function main() {
  require('dotenv').config();
  const oldKey = process.env.TENANT_CONN_ENCRYPTION_KEY_OLD;
  const newKey = process.env.TENANT_CONN_ENCRYPTION_KEY_NEW;
  const apply = process.argv.includes('--apply');
  if (!oldKey || !newKey) throw new Error('Set TENANT_CONN_ENCRYPTION_KEY_OLD and TENANT_CONN_ENCRYPTION_KEY_NEW');
  if (oldKey === newKey) throw new Error('The new key must differ from the old key');

  const { sequelize } = require('../database/platform');
  const models = require('../models/platform');
  await sequelize.authenticate();

  console.log(`Encryption key rotation (${apply ? 'APPLY' : 'DRY-RUN'})`);
  const plans = [];
  for (const t of TARGETS) {
    const rows = await models[t.model].findAll({ attributes: ['id', t.field] });
    const plan = planRotation(rows.map((r) => ({ id: r.id, [t.field]: r[t.field] })), t.field, t.skip, oldKey, newKey);
    plans.push({ ...t, ...plan });
    console.log(`  ${t.label}: ${plan.updates.length} to re-encrypt, ${plan.skipped} skipped, ${plan.failures.length} unreadable with the old key`);
    for (const f of plan.failures) console.log(`    - ${f.id}: ${f.error}`);
  }

  const failed = plans.reduce((n, p) => n + p.failures.length, 0);
  if (failed) throw new Error(`${failed} value(s) cannot be read with the old key; nothing was changed`);
  if (!apply) { console.log('Dry run only. Nothing was written. Re-run with --apply.'); await sequelize.close(); return; }

  await sequelize.transaction(async (transaction) => {
    for (const p of plans) {
      for (const u of p.updates) {
        await models[p.model].update({ [p.field]: u.next }, { where: { id: u.id }, transaction, hooks: false });
      }
    }
  });
  console.log('Done. Now set TENANT_CONN_ENCRYPTION_KEY to the new key and restart the API (runbook step 5).');
  await sequelize.close();
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('Rotation stopped:', err.message); process.exit(1); });
}

module.exports = { rotateValue, planRotation, TARGETS };

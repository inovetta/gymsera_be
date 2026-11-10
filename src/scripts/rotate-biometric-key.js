#!/usr/bin/env node
/**
 * Re-encrypts biometric data under the current BIOMETRIC_DATA_KEY (the FIRST entry), for every
 * tenant: member_biometrics.template_enc and the photo files of member_biometric_photos.
 * Procedure and rollback: docs/runbooks/secrets-rotation.md section 3c.
 *
 * Usage (dry run is the default and writes nothing):
 *   BIOMETRIC_DATA_KEY=<new version>:<new hex>,<old version>:<old hex> node src/scripts/rotate-biometric-key.js
 *   ... node src/scripts/rotate-biometric-key.js --apply
 *
 * Every value is decrypted with its own key version and re-encrypted, and the result decrypted again
 * and compared before it is written. If any value of a tenant cannot be read, nothing of that tenant
 * is written (the report says `unreadable`): a key it was written with is missing from the list.
 * Never prints a value or a key.
 */
const { QueryTypes } = require('sequelize');
const bioCrypto = require('../utils/biometric-crypto');

const select = (db, sql, rep) => db.sequelize.query(sql, { replacements: rep, type: QueryTypes.SELECT });

/** → { templates, photos, rotated, unreadable } for one tenant. */
async function rotateTenant(db, { apply = false } = {}) {
  const current = bioCrypto.currentVersion();
  const storage = require('../services/kyc-storage.service');
  const templates = await select(db, 'SELECT id, template_enc FROM member_biometrics WHERE key_version <> ?', [current]);
  const photos = await select(db, 'SELECT id, storage_key FROM member_biometric_photos WHERE key_version <> ?', [current]);
  const plan = { templates: [], photos: [] };
  let unreadable = 0;
  const check = (enc) => {
    const plain = bioCrypto.decrypt(enc);
    const next = bioCrypto.encrypt(plain);
    if (!bioCrypto.decrypt(next).equals(plain)) throw new Error('round trip did not match');
    return next;
  };
  for (const t of templates) {
    try {
      plan.templates.push({ id: t.id, next: check(t.template_enc) });
    } catch (_) {
      unreadable += 1;
    }
  }
  for (const p of photos) {
    try {
      const file = await storage.getKycStream(p.storage_key);
      const chunks = [];
      for await (const c of file.stream) chunks.push(Buffer.from(c));
      plan.photos.push({ id: p.id, key: p.storage_key, next: check(Buffer.concat(chunks)) });
    } catch (_) {
      unreadable += 1;
    }
  }
  const report = { templates: templates.length, photos: photos.length, rotated: 0, unreadable };
  if (!apply || unreadable) return report;
  await db.sequelize.transaction(async (transaction) => {
    for (const t of plan.templates) {
      await db.sequelize.query('UPDATE member_biometrics SET template_enc = ?, key_version = ? WHERE id = ?', { replacements: [t.next, current, t.id], transaction });
    }
  });
  report.rotated += plan.templates.length;
  for (const p of plan.photos) {
    await storage.putPrivateObject({ buffer: p.next, mimetype: 'application/octet-stream', key: p.key });
    await db.sequelize.query('UPDATE member_biometric_photos SET key_version = ? WHERE id = ?', { replacements: [current, p.id] });
    report.rotated += 1;
  }
  return report;
}

async function main() {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  const { connect, sequelize } = require('../database/platform');
  await connect();
  const { Tenant } = require('../models/platform');
  const TenantDbManager = require('../database/TenantDbManager');
  const tenants = await Tenant.findAll({ attributes: ['id', 'tenantCode', 'connectionStringEncrypted'] });
  let failed = 0;
  console.log(`[rotate-biometric-key] ${apply ? 'APPLY' : 'dry run'}; current key version ${bioCrypto.currentVersion()}`);
  for (const t of tenants) {
    if (!t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    try {
      const db = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
      const r = await rotateTenant(db, { apply });
      if (r.unreadable) failed += 1;
      console.log(`  ${t.tenantCode}: ${r.templates} templates, ${r.photos} photos on an older key; ${r.rotated} rotated; ${r.unreadable} unreadable`);
    } catch (err) {
      failed += 1;
      console.log(`  ${t.tenantCode}: skipped (${err.message})`);
    }
  }
  await sequelize.close().catch(() => {});
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[rotate-biometric-key] failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { rotateTenant };

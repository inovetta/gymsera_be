/**
 * Biometric data and consent (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §6.2, §7.5, §14 points 1, 2, 6).
 *
 * - Templates: AES-256-GCM in member_biometrics (utils/biometric-crypto.js, BIOMETRIC_DATA_KEY).
 * - Photos (comparison `biophoto`, profile `userpic`): encrypted the same way, then written to the
 *   private store (kyc-storage putPrivateObject: the private R2 bucket, or private local disk in
 *   development and tests) under biometrics/<tenant>/<member>/. Never a public URL.
 * - Consent (member_biometric_consents): data from a member without consent is kept "pending" for
 *   DEVICE_CONSENT_PENDING_DAYS (7) and only on the device that enrolled it; then deleted here and
 *   on that device. Withdrawal deletes everything at once (and from every device, via the reconciler).
 * - Retention (D-4): DEVICE_BIO_RETENTION_DAYS (90) after the member's last package ended.
 *
 * Nothing here logs or returns a template, a photo or a key. `db` = { sequelize, models }.
 */
const { utc } = require('./sql-time');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const bioCrypto = require('../../utils/biometric-crypto');
const { getDeviceConfig } = require('../../config/devices.config');

const select = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT });
const affected = (meta) => (typeof meta === 'number' ? meta : meta?.affectedRows || 0);

// ── Consent ───────────────────────────────────────────────────────────────────
async function activeConsent(db, memberId) {
  const [row] = await select(
    db,
    'SELECT id, member_id, consented_at, consented_by_user_id, method FROM member_biometric_consents WHERE member_id = ? AND revoked_at IS NULL ORDER BY consented_at DESC LIMIT 1',
    [memberId]
  );
  return row || null;
}

const METHODS = ['in_person', 'app'];

/**
 * Records consent (idempotent: an active consent is returned as is) and releases data that was
 * waiting for it. → { consent, created, released }.
 */
async function recordConsent(db, { memberId, byUserId = null, method = 'in_person', now = new Date() }) {
  if (!METHODS.includes(method)) throw Object.assign(new Error('method must be in_person or app'), { status: 422, code: 'invalid_consent_method' });
  const existing = await activeConsent(db, memberId);
  let created = false;
  if (!existing) {
    await db.sequelize.query(
      `INSERT INTO member_biometric_consents (id, member_id, consented_at, consented_by_user_id, method, revoked_at, revoked_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      { replacements: utc([crypto.randomUUID(), memberId, now, byUserId, method, now, now]) }
    );
    created = true;
  }
  const [, m1] = await db.sequelize.query(
    'UPDATE member_biometrics SET consent_pending = 0, pending_until = NULL, updated_at = ? WHERE member_id = ? AND consent_pending = 1',
    { replacements: utc([now, memberId]) }
  );
  const [, m2] = await db.sequelize.query(
    'UPDATE member_biometric_photos SET consent_pending = 0, pending_until = NULL, updated_at = ? WHERE member_id = ? AND consent_pending = 1',
    { replacements: utc([now, memberId]) }
  );
  return { consent: await activeConsent(db, memberId), created, released: affected(m1) + affected(m2) };
}

/** Withdrawal (§14 point 6): consent revoked, every template and photo deleted now. */
async function withdrawConsent(db, { memberId, byUserId = null, now = new Date() }) {
  const [, meta] = await db.sequelize.query(
    'UPDATE member_biometric_consents SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ? WHERE member_id = ? AND revoked_at IS NULL',
    { replacements: utc([now, byUserId, now, memberId]) }
  );
  const deleted = await deleteMemberBiometrics(db, memberId);
  return { revoked: affected(meta), ...deleted };
}

/** Consent state for a member screen: never any template data. */
async function consentStatus(db, memberId) {
  const consent = await activeConsent(db, memberId);
  const [counts] = await select(
    db,
    'SELECT COUNT(*) AS total, COALESCE(SUM(consent_pending), 0) AS pending FROM member_biometrics WHERE member_id = ?',
    [memberId]
  );
  return {
    consented: Boolean(consent),
    consentedAt: consent?.consented_at || null,
    method: consent?.method || null,
    templates: Number(counts.total),
    waitingForConsent: Number(counts.pending),
  };
}

// ── Templates ─────────────────────────────────────────────────────────────────
/**
 * Templates a device sent (§7.5): encrypted, one row per (member, type, no, index), replaced when
 * the device sends the slot again. Without consent they are pending (kept on `deviceId` only).
 * → { stored, pending, typesStored: [types] }
 */
async function storeTemplates(db, { memberId, deviceId, templates, now = new Date() }) {
  if (!templates.length) return { stored: 0, pending: 0, typesStored: [] };
  const cfg = getDeviceConfig();
  const consented = Boolean(await activeConsent(db, memberId));
  const pendingUntil = consented ? null : new Date(now.getTime() + cfg.consentPendingDays * 86400000);
  const types = new Set();
  for (const t of templates) {
    const enc = bioCrypto.encrypt(t.tmp);
    await db.sequelize.query(
      `INSERT INTO member_biometrics (id, member_id, bio_type, bio_no, bio_index, major_ver, minor_ver, format, duress, valid,
         template_enc, key_version, template_sha256, template_size, source_device_id, consent_pending, pending_until, enrolled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE major_ver = VALUES(major_ver), minor_ver = VALUES(minor_ver), format = VALUES(format), duress = VALUES(duress),
         valid = VALUES(valid), template_enc = VALUES(template_enc), key_version = VALUES(key_version), template_sha256 = VALUES(template_sha256),
         template_size = VALUES(template_size), source_device_id = VALUES(source_device_id), enrolled_at = VALUES(enrolled_at),
         consent_pending = IF(consent_pending = 0, 0, VALUES(consent_pending)), pending_until = IF(consent_pending = 0, NULL, VALUES(pending_until)),
         updated_at = VALUES(updated_at)`,
      {
        replacements: utc([
          crypto.randomUUID(), memberId, t.type, t.no, t.index, String(t.majorVer).slice(0, 8), String(t.minorVer).slice(0, 8), t.format,
          t.duress ? 1 : 0, t.valid === 0 ? 0 : 1, enc, bioCrypto.versionOf(enc), bioCrypto.sha256(t.tmp), t.tmp.length,
          deviceId || null, consented ? 0 : 1, pendingUntil, now, now, now,
        ]),
      }
    );
    types.add(t.type);
  }
  return { stored: consented ? templates.length : 0, pending: consented ? 0 : templates.length, typesStored: [...types] };
}

/**
 * Templates and photos a device may hold for these members: consented ones, plus pending ones on
 * the device that enrolled them (kept there until consent or the 7 days end).
 * → { biometrics: Map(memberId → rows without template data), photos: Map(memberId → rows) }
 */
async function usableFor(db, memberIds, deviceId) {
  const biometrics = new Map();
  const photos = new Map();
  if (!memberIds.length) return { biometrics, photos };
  const bio = await select(
    db,
    `SELECT id, member_id, bio_type, bio_no, bio_index, major_ver, minor_ver, format, duress, valid, template_sha256
       FROM member_biometrics WHERE member_id IN (?) AND (consent_pending = 0 OR source_device_id = ?)`,
    [memberIds, deviceId]
  );
  for (const r of bio) {
    if (!biometrics.has(r.member_id)) biometrics.set(r.member_id, []);
    biometrics.get(r.member_id).push(r);
  }
  const ph = await select(
    db,
    'SELECT id, member_id, kind, bio_type, sha256 FROM member_biometric_photos WHERE member_id IN (?) AND (consent_pending = 0 OR source_device_id = ?)',
    [memberIds, deviceId]
  );
  for (const r of ph) {
    if (!photos.has(r.member_id)) photos.set(r.member_id, []);
    photos.get(r.member_id).push(r);
  }
  return { biometrics, photos };
}

/** Decrypted templates for a command (in memory only, at delivery). → [{ id, ...fields, tmp }] */
async function templatesForDelivery(db, ids) {
  if (!ids.length) return [];
  const rows = await select(
    db,
    'SELECT id, member_id, bio_type, bio_no, bio_index, major_ver, minor_ver, format, duress, valid, template_enc FROM member_biometrics WHERE id IN (?)',
    [ids]
  );
  return rows.map((r) => ({
    id: r.id, type: Number(r.bio_type), no: Number(r.bio_no), index: Number(r.bio_index), majorVer: r.major_ver, minorVer: r.minor_ver,
    format: Number(r.format), duress: Number(r.duress), valid: Number(r.valid), tmp: bioCrypto.decryptText(r.template_enc),
  }));
}

// ── Photos ────────────────────────────────────────────────────────────────────
const storage = () => require('../kyc-storage.service');

/** A photo a device sent: encrypted, private store, one per (member, kind, type). → row id */
async function storePhoto(db, { tenantId, memberId, deviceId, photo, now = new Date() }) {
  const cfg = getDeviceConfig();
  const consented = Boolean(await activeConsent(db, memberId));
  // The base64 text exactly as the device sent it (what a device gets back), encrypted.
  const bytes = Buffer.from(photo.content, 'utf8');
  const enc = bioCrypto.encrypt(bytes);
  const key = `biometrics/${tenantId}/${memberId}/${photo.kind}-${photo.type}-${crypto.randomUUID()}.bin`;
  await storage().putPrivateObject({ buffer: enc, mimetype: 'application/octet-stream', key });
  const [old] = await select(db, 'SELECT id, storage_key FROM member_biometric_photos WHERE member_id = ? AND kind = ? AND bio_type = ?', [memberId, photo.kind, photo.type]);
  const pendingUntil = consented ? null : new Date(now.getTime() + cfg.consentPendingDays * 86400000);
  const id = old ? old.id : crypto.randomUUID();
  if (old) {
    await db.sequelize.query(
      `UPDATE member_biometric_photos SET storage_key = ?, key_version = ?, sha256 = ?, size = ?, source_device_id = ?,
         consent_pending = IF(consent_pending = 0, 0, ?), pending_until = IF(consent_pending = 0, NULL, ?), updated_at = ? WHERE id = ?`,
      { replacements: utc([key, bioCrypto.versionOf(enc), bioCrypto.sha256(bytes), bytes.length, deviceId || null, consented ? 0 : 1, pendingUntil, now, id]) }
    );
    await storage().deleteKycFile(old.storage_key).catch(() => {});
  } else {
    await db.sequelize.query(
      `INSERT INTO member_biometric_photos (id, member_id, kind, bio_type, storage_key, key_version, sha256, size, source_device_id, consent_pending, pending_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: utc([id, memberId, photo.kind, photo.type, key, bioCrypto.versionOf(enc), bioCrypto.sha256(bytes), bytes.length, deviceId || null, consented ? 0 : 1, pendingUntil, now, now]) }
    );
  }
  return id;
}

/** Base64 of a stored photo, for a command (in memory only). null when it is gone. */
async function photoForDelivery(db, id) {
  const [row] = await select(db, 'SELECT storage_key FROM member_biometric_photos WHERE id = ?', [id]);
  if (!row) return null;
  const stream = await storage().getKycStream(row.storage_key);
  const chunks = [];
  for await (const c of stream.stream || stream.Body || stream) chunks.push(Buffer.from(c));
  return bioCrypto.decrypt(Buffer.concat(chunks)).toString('utf8');
}

// ── Deletion and retention ────────────────────────────────────────────────────
async function deleteRows(db, where, replacements) {
  const photos = await select(db, `SELECT id, storage_key FROM member_biometric_photos WHERE ${where}`, replacements);
  for (const p of photos) await storage().deleteKycFile(p.storage_key).catch(() => {});
  const [, m1] = await db.sequelize.query(`DELETE FROM member_biometric_photos WHERE ${where}`, { replacements: utc(replacements) });
  const [, m2] = await db.sequelize.query(`DELETE FROM member_biometrics WHERE ${where}`, { replacements: utc(replacements) });
  return { templatesDeleted: affected(m2), photosDeleted: affected(m1) };
}

/** Every template and photo of a member (deletion, withdrawal, retention). */
const deleteMemberBiometrics = (db, memberId) => deleteRows(db, 'member_id = ?', [memberId]);

/**
 * The retention rules of one tenant (D-4, §7.5). → { pendingExpired: [memberIds], retained: [memberIds] }
 * - pending (no consent) past pending_until: deleted;
 * - members whose last package ended more than DEVICE_BIO_RETENTION_DAYS ago (or who never had one
 *   and enrolled that long ago), unless they still have a running package or staff device access.
 * The caller reconciles the returned members so their devices drop the data too.
 */
async function retentionSweep(db, now = new Date()) {
  const cfg = getDeviceConfig();
  const pendingMembers = (await select(
    db,
    `SELECT DISTINCT member_id FROM member_biometrics WHERE consent_pending = 1 AND pending_until < ?
     UNION SELECT DISTINCT member_id FROM member_biometric_photos WHERE consent_pending = 1 AND pending_until < ?`,
    [now, now]
  )).map((r) => r.member_id);
  for (const m of pendingMembers) {
    await deleteRows(db, 'member_id = ? AND consent_pending = 1 AND pending_until < ?', [m, now]);
  }

  const cutoff = new Date(now.getTime() - cfg.bioRetentionDays * 86400000).toISOString().slice(0, 10);
  const holders = (await select(
    db,
    'SELECT DISTINCT member_id FROM member_biometrics UNION SELECT DISTINCT member_id FROM member_biometric_photos',
    []
  )).map((r) => r.member_id);
  const retained = [];
  if (holders.length) {
    const subs = await select(
      db,
      'SELECT user_id, MAX(end_date) AS last_end, MAX(status IN (\'ACTIVE\', \'FROZEN\', \'PENDING\')) AS running FROM member_subscriptions WHERE user_id IN (?) GROUP BY user_id',
      [holders]
    );
    const byMember = new Map(subs.map((s) => [s.user_id, s]));
    const staff = new Set((await select(
      db,
      'SELECT DISTINCT user_id FROM gym_staff WHERE user_id IN (?) AND device_access = 1 AND employment_status = \'ACTIVE\'',
      [holders]
    ).catch(() => [])).map((r) => r.user_id));
    for (const m of holders) {
      if (staff.has(m)) continue;
      const s = byMember.get(m);
      if (s && Number(s.running)) continue;
      const lastEnd = s?.last_end ? String(s.last_end instanceof Date ? s.last_end.toISOString() : s.last_end).slice(0, 10) : null;
      if (lastEnd && lastEnd >= cutoff) continue;
      if (!lastEnd) {
        const [{ newest }] = await select(db, 'SELECT MAX(enrolled_at) AS newest FROM member_biometrics WHERE member_id = ?', [m]);
        if (newest && new Date(newest).toISOString().slice(0, 10) >= cutoff) continue;
      }
      await deleteMemberBiometrics(db, m);
      retained.push(m);
    }
  }
  return { pendingExpired: pendingMembers, retained };
}

module.exports = {
  activeConsent,
  recordConsent,
  withdrawConsent,
  consentStatus,
  storeTemplates,
  usableFor,
  templatesForDelivery,
  storePhoto,
  photoForDelivery,
  deleteMemberBiometrics,
  retentionSweep,
};

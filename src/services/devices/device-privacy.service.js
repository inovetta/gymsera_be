/**
 * Member-level device operations with privacy effects (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §7.6,
 * §8.2, §14 points 1 and 6; owner decision D-4).
 *
 *   forgetMember     member deleted: templates and photos deleted now, PIN retired (held 180 days),
 *                    removed from every device now (no exit grace)
 *   giveConsent      consent recorded; waiting data released; the member's devices updated
 *   withdrawConsent  consent revoked; templates and photos deleted now and from every device
 *   requestEnrollment  ENROLL_BIO on one device (consent first; the result arrives as BioData)
 *
 * `db` = { sequelize, models }.
 */
const { utc } = require('./sql-time');
const biometrics = require('./biometric.service');
const identity = require('./device-identity.service');
const triggers = require('./device-triggers');
const { createError } = require('../../utils/response.utils');

async function forgetMember(db, memberId) {
  const deleted = await biometrics.deleteMemberBiometrics(db, memberId);
  await db.sequelize.query('UPDATE member_biometric_consents SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE member_id = ?', {
    replacements: utc([new Date(), new Date(), memberId]),
  });
  await identity.retire(db, memberId);
  await triggers.enqueue(db.sequelize, { memberIds: [memberId], reason: 'member_deleted', noGrace: true });
  return deleted;
}

async function giveConsent(db, { memberId, byUserId, method }) {
  const res = await biometrics.recordConsent(db, { memberId, byUserId, method });
  await triggers.enqueue(db.sequelize, { memberIds: [memberId], reason: 'consent_given' });
  return res;
}

async function withdrawConsent(db, { memberId, byUserId }) {
  const res = await biometrics.withdrawConsent(db, { memberId, byUserId });
  await triggers.enqueue(db.sequelize, { memberIds: [memberId], reason: 'consent_withdrawn', noGrace: true });
  return res;
}

const ENROLL_TYPES = [1, 2, 6, 7, 8, 9, 10];

/**
 * ENROLL_BIO on one device (§7.6). Needs consent first, a PIN, and a device that has not answered
 * -708 to it. → { commandId, pin }
 */
async function requestEnrollment(db, { deviceId, memberId, type = 9, no = 0 }) {
  if (!ENROLL_TYPES.includes(Number(type))) throw createError('Choose a biometric type the device supports.', 422, 'invalid_bio_type');
  if (!(await biometrics.activeConsent(db, memberId))) {
    throw createError('Record the member\'s biometric consent before enrolling.', 409, 'biometric_consent_required');
  }
  const sync = require('./device-sync.service');
  const [device] = await sync.devicesOf(db, { deviceId });
  if (!device) throw createError('Device not found.', 404, 'device_not_found');
  if ((device.caps._unsupported || []).includes('enroll_bio')) {
    const pin = await identity.ensurePin(db, memberId);
    const err = createError(`This device cannot enrol remotely. Enrol on the device menu with PIN ${pin}.`, 409, 'enroll_not_supported');
    err.data = { pin };
    throw err;
  }
  const pin = await identity.ensurePin(db, memberId);
  const now = new Date();
  await db.sequelize.query(
    `INSERT INTO device_commands (device_id, member_id, kind, args_json, priority, status, attempts, not_before, expires_at, created_at, updated_at)
     VALUES (?, ?, 'enroll_bio', ?, 0, 'queued', 0, ?, ?, ?, ?)`,
    { replacements: utc([deviceId, memberId, JSON.stringify({ pin: String(pin), type: Number(type), no: Number(no) }), new Date(now.getTime() - 1000), new Date(now.getTime() + 120000), now, now]) }
  );
  const [row] = await db.sequelize.query('SELECT MAX(id) AS id FROM device_commands WHERE device_id = ? AND member_id = ? AND kind = \'enroll_bio\'', {
    replacements: utc([deviceId, memberId]), type: require('sequelize').QueryTypes.SELECT,
  });
  return { commandId: Number(row.id), pin };
}

module.exports = { forgetMember, giveConsent, withdrawConsent, requestEnrollment };

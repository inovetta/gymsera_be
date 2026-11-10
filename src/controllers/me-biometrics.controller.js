/**
 * A member's own biometric consent, per gym (ZKTeco spec §14 point 1 and 6: withdrawal at any time,
 * data deleted here and from every device). API only in Phase 3; the app screen comes after the
 * 2026-12-05 store release.
 *
 *   GET    /me/biometric-consents            gyms where the member has consent or biometric data
 *   DELETE /me/biometric-consents/:tenantId  withdraw at that gym (templates and photos deleted,
 *                                            removed from every device of that gym)
 *
 * Only the caller's own records: the member id is always the authenticated user. Never template data.
 */
const { QueryTypes } = require('sequelize');
const { sendSuccess, createError } = require('../utils/response.utils');

const userIdOf = (req) => req.user?.id || req.user?.sub || null;

/** Gyms that have access devices and know this member (consent row or stored templates). */
async function gymsOf(userId) {
  const { tenantsWithDevices } = require('../jobs/device-jobs');
  const biometrics = require('../services/devices/biometric.service');
  const { Tenant } = require('../models/platform');
  const out = [];
  for (const t of await tenantsWithDevices()) {
    const [seen] = await t.db.sequelize.query(
      'SELECT (SELECT COUNT(*) FROM member_biometric_consents WHERE member_id = ?) + (SELECT COUNT(*) FROM member_biometrics WHERE member_id = ?) AS n',
      { replacements: [userId, userId], type: QueryTypes.SELECT }
    ).catch(() => [{ n: 0 }]);
    if (!Number(seen?.n)) continue;
    const tenant = await Tenant.findByPk(t.tenantId, { attributes: ['id', 'gymName'] });
    out.push({ tenantId: t.tenantId, gymName: tenant?.gymName || null, db: t.db, consent: await biometrics.consentStatus(t.db, userId) });
  }
  return out;
}

const list = async (req, res, next) => {
  try {
    const gyms = await gymsOf(userIdOf(req));
    return sendSuccess(res, { gyms: gyms.map((g) => ({ tenantId: g.tenantId, gymName: g.gymName, consent: g.consent })) });
  } catch (err) {
    return next(err);
  }
};

const withdraw = async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const gym = (await gymsOf(userId)).find((g) => g.tenantId === req.params.tenantId);
    if (!gym) throw createError('No biometric consent at this gym.', 404, 'consent_not_found');
    const result = await require('../services/devices/device-privacy.service').withdrawConsent(gym.db, { memberId: userId, byUserId: userId });
    const audit = require('../services/audit.service');
    await audit.record({ tenantDb: gym.db, userId, req }, {
      action: 'biometrics.consent_withdrawn_by_member', targetType: 'member', targetId: userId,
      after: { templatesDeleted: result.templatesDeleted, photosDeleted: result.photosDeleted },
    });
    return sendSuccess(res, { tenantId: gym.tenantId, templatesDeleted: result.templatesDeleted, photosDeleted: result.photosDeleted },
      'Consent withdrawn. Your face, fingerprint and palm data is deleted at this gym and from its devices.');
  } catch (err) {
    return next(err);
  }
};

module.exports = { list, withdraw };

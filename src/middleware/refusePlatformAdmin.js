/**
 * refusePlatformAdmin(code, message): answers a platform admin 403 with `code`, before tenant
 * context, body validation and re-authentication, so the answer is the same with or without
 * X-Tenant-Id and with any body. Everyone else passes through unchanged.
 *
 * For the owner's money routes a platform admin must never use, even with a gym selected
 * (`hasAllBranches` lets an admin through `can()` everywhere else): NEW-228 payout account
 * writes, NEW-232 payout requests (spec §14 R-97, R-98).
 */
const refusePlatformAdmin = (code, message) => (req, _res, next) => {
  if (req.user?.role !== 'PLATFORM_ADMIN') return next();
  const err = new Error(message);
  err.statusCode = 403;
  err.code = code;
  return next(err);
};

refusePlatformAdmin.payoutAccountWrite = refusePlatformAdmin(
  'payout_account_owner_only',
  'Only the gym owner can change payout details.'
);
refusePlatformAdmin.payoutRequest = refusePlatformAdmin(
  'payout_request_not_for_platform_admins',
  'Platform admins cannot request a payout for a gym. Payouts are requested by the gym\'s own team.'
);

// ZKTeco spec §12: platform admins read device health for support; they never add, change or remove a device.
refusePlatformAdmin.deviceWrite = refusePlatformAdmin(
  'devices_read_only_for_platform_admins',
  'Platform admins can see a gym\'s devices but not change them.'
);

module.exports = refusePlatformAdmin;

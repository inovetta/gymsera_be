/**
 * can(permissionKey, opts) — permission-based authorization middleware.
 *
 * Replaces `authorize('GYM_HOST', 'BRANCH_MANAGER')`. The difference is not
 * cosmetic: role checks hardcode today's org chart into ~40 route definitions, so
 * adding a Trainer means editing all of them. A permission check keeps working
 * when a host invents a role you never shipped.
 *
 * Usage:
 *   router.post('/branches/:branchId/members',
 *     authenticate,
 *     tenantContext,
 *     can('members.create', { branch: 'params.branchId' }),
 *     controller.create
 *   );
 *
 * On success the resolved Grants object is attached as `req.grants`, so the
 * controller can branch on approval tier without resolving a second time:
 *
 *   req.grants.tierFor('members.create')  // 'DIRECT' | 'REQUEST' | 'OFF'
 *
 * Requires `authenticate` and `tenantContext` to have run first.
 */
const accessService = require('../services/access.service');
const { createError } = require('../utils/response.utils');
const { getPermission } = require('../constants/permissions');

/**
 * Read a dotted path off the request: 'params.branchId', 'body.branch_id'.
 * @returns {string|null}
 */
const readPath = (req, path) => {
  if (!path) return null;
  const value = path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), req);
  return value == null ? null : String(value);
};

/**
 * Work out which branch this request is about.
 *
 * Explicit `opts.branch` wins. Otherwise fall back to the usual places a branch ID
 * turns up, so most routes need no configuration at all.
 */
const resolveBranchId = (req, opts) => {
  if (opts.branch) return readPath(req, opts.branch);
  return (
    req.params.branchId ||
    req.query.branchId ||
    (req.body && (req.body.branchId || req.body.branch_id)) ||
    null
  );
};

/**
 * Resolve the caller's grants and attach them to the request without enforcing.
 *
 * For endpoints that decide their own shape from the grant set — a dashboard that
 * hides revenue widgets, a list that filters by data scope.
 */
const attachGrants = (opts = {}) => async (req, _res, next) => {
  try {
    if (!req.user) return next(createError('Unauthorized', 401));
    if (!req.tenantDb) return next(createError('This route requires a tenant context', 400));

    const userId = req.user.id || req.user.sub;
    const tenantId = req.tenantDb.tenantId || req.user.tenantId;
    const branchId = resolveBranchId(req, opts);

    req.grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
    req.branchId = branchId;
    req.tenantId = tenantId;
    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * Enforce a permission.
 *
 * @param {string} permissionKey  e.g. 'members.create'
 * @param {object} [opts]
 * @param {string} [opts.branch]      dotted request path to the branch ID
 * @param {boolean} [opts.orgWide]    resolve org-scope grants, ignoring any branch
 * @param {boolean} [opts.requireDirect]  demand the `.direct` twin, not just the base
 */
const can = (permissionKey, opts = {}) => async (req, _res, next) => {
  try {
    if (!req.user) return next(createError('Unauthorized', 401));
    if (!req.tenantDb) return next(createError('This route requires a tenant context', 400));

    const userId = req.user.id || req.user.sub;
    const tenantId = req.tenantDb.tenantId || req.user.tenantId;
    const branchId = opts.orgWide ? null : resolveBranchId(req, opts);

    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);

    const required = opts.requireDirect ? `${permissionKey}.direct` : permissionKey;
    if (!grants.has(required)) {
      const perm = getPermission(permissionKey);
      const label = perm ? perm.label.toLowerCase() : permissionKey;
      return next(createError(`You do not have permission to ${label} here`, 403));
    }

    req.grants = grants;
    req.branchId = branchId;
    req.tenantId = tenantId;
    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * Pass if the caller holds ANY of these permissions.
 *
 * For list endpoints that serve several roles through one route — an approvals
 * screen readable by both a decider and an auditor, say.
 */
can.any = (permissionKeys, opts = {}) => async (req, _res, next) => {
  try {
    if (!req.user) return next(createError('Unauthorized', 401));
    if (!req.tenantDb) return next(createError('This route requires a tenant context', 400));

    const userId = req.user.id || req.user.sub;
    const tenantId = req.tenantDb.tenantId || req.user.tenantId;
    const branchId = opts.orgWide ? null : resolveBranchId(req, opts);

    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
    if (!permissionKeys.some((k) => grants.has(k))) {
      return next(createError('You do not have permission to access this resource', 403));
    }

    req.grants = grants;
    req.branchId = branchId;
    req.tenantId = tenantId;
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = can;
module.exports.can = can;
module.exports.attachGrants = attachGrants;

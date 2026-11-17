/**
 * NEW-265 Part A (A6): CMS › Cities & Areas › Unmatched areas. Platform admins only (admin router).
 */
const areaRequests = require('../services/area-requests.service');
const { sendSuccess } = require('../utils/response.utils');

const adminId = (req) => req.user.sub || req.user.id;
const wrap = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return next(err);
  }
};

// GET /admin/area-requests
const list = wrap(async (req, res) => {
  const { status, cityId, page, limit } = req.query;
  return sendSuccess(res, await areaRequests.listForAdmin({ status: status || 'pending_review', cityId, page, limit }));
});

// POST /admin/area-requests/:id/approve
const approve = wrap(async (req, res) => sendSuccess(res, await areaRequests.approve(req.params.id, req.body, adminId(req)), 'Area approved'));

// POST /admin/area-requests/:id/merge
const merge = wrap(async (req, res) => sendSuccess(res, await areaRequests.merge(req.params.id, req.body, adminId(req)), 'Area merged'));

// POST /admin/area-requests/:id/reject
const reject = wrap(async (req, res) => sendSuccess(res, await areaRequests.reject(req.params.id, req.body, adminId(req)), 'Area rejected'));

// POST /admin/area-requests/:id/retry
const retry = wrap(async (req, res) => sendSuccess(res, await areaRequests.retry(req.params.id)));

// GET /admin/areas/:areaId/aliases
const listAliases = wrap(async (req, res) => sendSuccess(res, await areaRequests.listAliases(req.params.areaId)));

// DELETE /admin/area-aliases/:id
const deleteAlias = wrap(async (req, res) => sendSuccess(res, await areaRequests.deleteAlias(req.params.id, adminId(req)), 'Alias deleted'));

module.exports = { list, approve, merge, reject, retry, listAliases, deleteAlias };

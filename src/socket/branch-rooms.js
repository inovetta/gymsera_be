/**
 * src/socket/branch-rooms.js
 *
 * Branch-scoped realtime rooms (NEW-84, spec §9.2). The server computes them
 * from the user's live role assignments; clients never name a room.
 *
 *  - tenant:{tid}:branch:{bid}  a branch the user holds an assignment on
 *  - tenant:{tid}:org           the user holds an ORG-scoped assignment, which
 *                               covers every branch, including future ones
 *  - tenant owners join neither: they are reached through their `user:{id}`
 *    room (see emitToBranch), so a new branch can never be missed
 */
const branchRoom = (tenantId, branchId) => `tenant:${tenantId}:branch:${branchId}`;
const orgRoom = (tenantId) => `tenant:${tenantId}:org`;

const isScopedRoom = (room, tenantId) =>
  room === orgRoom(tenantId) || room.startsWith(`tenant:${tenantId}:branch:`);

/** The set of scoped rooms this user should be in right now. */
const desiredRooms = async (userId, tenantId) => {
  const { Tenant } = require('../models/platform');
  const { userBelongsToTenant } = require('../middleware/tenantContext');
  const TenantDbManager = require('../database/TenantDbManager');
  const accessService = require('../services/access.service');

  // A token outlives a revoked role: no membership, no rooms.
  if (!(await userBelongsToTenant(userId, tenantId))) return new Set();

  const tenant = await Tenant.findByPk(tenantId, {
    attributes: ['id', 'ownerUserId', 'connectionStringEncrypted'],
  });
  if (!tenant || tenant.ownerUserId === userId) return new Set();
  if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
    return new Set();
  }

  const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
  const { orgWide, branchIds } = await accessService.branchCoverage(tenantDb, userId);
  return new Set(orgWide ? [orgRoom(tenantId)] : branchIds.map((b) => branchRoom(tenantId, b)));
};

/**
 * Make `socket` (a local Socket or a RemoteSocket) hold exactly the scoped
 * rooms it should. Safe to call repeatedly.
 */
const syncBranchRooms = async (socket, userId, tenantId) => {
  if (!userId || !tenantId) return;
  const desired = await desiredRooms(userId, tenantId);
  for (const room of socket.rooms) {
    if (isScopedRoom(room, tenantId) && !desired.has(room)) await socket.leave(room);
  }
  for (const room of desired) {
    if (!socket.rooms.has(room)) await socket.join(room);
  }
};

module.exports = { branchRoom, orgRoom, syncBranchRooms };

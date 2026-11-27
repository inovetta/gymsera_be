/**
 * src/socket/branch-rooms.js
 *
 * Branch-scoped realtime rooms (NEW-84, spec §9.2). The server computes them
 * from the user's live role assignments; clients never name a room.
 *
 *  - organization:{tid}:branch:{bid}  a branch the user holds an assignment on
 *  - organization:{tid}:org           the user holds an ORG-scoped assignment, which
 *                               covers every branch, including future ones
 *  - tenant owners join neither: they are reached through their `user:{id}`
 *    room (see emitToBranch), so a new branch can never be missed
 */
const branchRoom = (organizationId, branchId) => `organization:${organizationId}:branch:${branchId}`;
const orgRoom = (organizationId) => `organization:${organizationId}:org`;

const tenantRoom = (organizationId) => `organization:${organizationId}`;

/**
 * Every room this module manages is `organization:{id}` or `organization:{id}:...`. Other
 * rooms (`user:`, `conversation:`) are never touched here.
 */
const isTenantRoom = (room) => typeof room === 'string' && room.startsWith('organization:');

/**
 * The tenants whose staff rooms this user may be in (NEW-86). Derived from
 * verified relationships, never from a token claim: a team member's token has
 * `organizationId: null`, and a claim can name a tenant the user left.
 *
 *  - candidates: tenants they own, plus their ACTIVE org-index rows (as
 *    /me/context lists them);
 *  - each is confirmed with userIsTenantStaff (owner, org index or a live role
 *    assignment; never a gym-member row, NEW-85);
 *  - a handshake `organizationId` only narrows: a tenant they are not staff of is
 *    dropped, no error.
 */
const staffTenantIds = async (userId, selector = null) => {
  const { userIsTenantStaff } = require('../middleware/tenantContext');
  const membershipService = require('../services/membership.service');
  if (!userId) return [];

  if (selector) {
    return typeof selector === 'string' && (await userIsTenantStaff(userId, selector)) ? [selector] : [];
  }

  const [owned, memberships] = await Promise.all([
    membershipService.listOwnedTenants(userId),
    membershipService.listUserTenants(userId, { activeOnly: true }),
  ]);
  const candidates = [...new Set([...owned.map((t) => t.id), ...memberships.map((m) => m.organizationId)])];
  const checks = await Promise.all(candidates.map((id) => userIsTenantStaff(userId, id)));
  return candidates.filter((_, i) => checks[i]);
};

/** Scoped (branch / org) rooms for one tenant the user is verified staff of. */
const scopedRooms = async (userId, organizationId) => {
  const { Tenant } = require('../models/platform');
  const TenantDbManager = require('../database/TenantDbManager');
  const accessService = require('../services/access.service');

  const tenant = await Tenant.findByPk(organizationId, {
    attributes: ['id', 'ownerUserId', 'connectionStringEncrypted'],
  });
  if (!tenant || tenant.ownerUserId === userId) return [];
  if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
    return [];
  }

  const tenantDb = await TenantDbManager.getConnection(organizationId, tenant.connectionStringEncrypted);
  const { orgWide, branchIds } = await accessService.branchCoverage(tenantDb, userId);
  return orgWide ? [orgRoom(organizationId)] : branchIds.map((b) => branchRoom(organizationId, b));
};

/**
 * Every `organization:*` room this user should be in right now: the tenant room of
 * each org they are staff of, plus their branch / org rooms there.
 */
const desiredRooms = async (userId, selector = null) => {
  const desired = new Set();
  for (const organizationId of await staffTenantIds(userId, selector)) {
    desired.add(tenantRoom(organizationId));
    try {
      for (const room of await scopedRooms(userId, organizationId)) desired.add(room);
    } catch (err) {
      // One unreachable tenant must not cost the user the others.
      console.warn(`[Socket] Branch rooms for tenant ${organizationId} unavailable:`, err.message);
    }
  }
  return desired;
};

/**
 * Make `socket` (a local Socket or a RemoteSocket) hold exactly the tenant
 * rooms it should. Safe to call repeatedly.
 */
const syncTenantRooms = async (socket, userId, selector = null) => {
  if (!userId) return;
  const desired = await desiredRooms(userId, selector);
  if (socket.connected === false) return; // dropped while we were reading
  for (const room of socket.rooms) {
    if (isTenantRoom(room) && !desired.has(room)) await socket.leave(room);
  }
  for (const room of desired) {
    if (!socket.rooms.has(room)) await socket.join(room);
  }
};

module.exports = { branchRoom, orgRoom, tenantRoom, staffTenantIds, syncTenantRooms };

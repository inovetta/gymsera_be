const { User } = require('../models/platform');

/**
 * Resolve creator role from user role and tenant GymStaff record
 *
 * @param {object} tenantDb - Tenant database sequelize instance
 * @param {string} userId - User UUID
 * @param {string} userRole - User's role in req.user ('GYM_HOST', 'BRANCH_MANAGER', 'MEMBER', etc.)
 * @param {string} [branchId] - Branch UUID
 * @returns {Promise<string>} 'HOST' | 'ADMIN' | 'STAFF' | 'MEMBER' | 'SYSTEM'
 */
const resolveCreatorRole = async (tenantDb, userId, userRole, branchId = null) => {
  if (!userRole && !userId) return 'SYSTEM';

  if (userRole === 'GYM_HOST' || userRole === 'HOST') {
    return 'HOST';
  }

  if (userRole === 'MEMBER') {
    // Check if user has active staff designation in this tenant
    if (tenantDb && tenantDb.models && tenantDb.models.GymStaff && userId) {
      try {
        const staffWhere = { userId, status: 'active' };
        if (branchId) staffWhere.branchId = branchId;
        const staff = await tenantDb.models.GymStaff.findOne({ where: staffWhere });
        if (staff) {
          const designation = (staff.designation || '').trim().toLowerCase();
          return designation === 'admin' ? 'ADMIN' : 'STAFF';
        }
      } catch (_) {
        // Fallback to MEMBER
      }
    }
    return 'MEMBER';
  }

  if (userRole === 'BRANCH_MANAGER' || userRole === 'STAFF' || userRole === 'ADMIN') {
    if (tenantDb && tenantDb.models && tenantDb.models.GymStaff && userId) {
      try {
        const staffWhere = { userId, status: 'active' };
        if (branchId) staffWhere.branchId = branchId;
        const staff = await tenantDb.models.GymStaff.findOne({ where: staffWhere });
        if (staff) {
          const designation = (staff.designation || '').trim().toLowerCase();
          return designation === 'admin' ? 'ADMIN' : 'STAFF';
        }
      } catch (_) {
        // Fallback
      }
    }
    return userRole === 'ADMIN' ? 'ADMIN' : 'STAFF';
  }

  return 'STAFF';
};

/**
 * Format role label for display
 */
const getRoleLabel = (role) => {
  switch ((role || '').toUpperCase()) {
    case 'HOST':
    case 'GYM_HOST':
      return 'Host / Owner';
    case 'ADMIN':
      return 'Admin';
    case 'STAFF':
    case 'BRANCH_MANAGER':
      return 'Staff';
    case 'MEMBER':
    case 'USER':
      return 'Member / User';
    case 'SYSTEM':
      return 'System Generated';
    default:
      return role || 'Staff';
  }
};

/**
 * Format platform source name
 */
const getSourcePlatform = (role, sourceChannel) => {
  if (sourceChannel === 'ONLINE') return 'User Application';
  switch ((role || '').toUpperCase()) {
    case 'HOST':
    case 'GYM_HOST':
      return 'Host Management Area';
    case 'ADMIN':
      return 'Admin Panel';
    case 'STAFF':
    case 'BRANCH_MANAGER':
      return 'Staff App';
    case 'MEMBER':
    case 'USER':
      return 'User Application';
    case 'SYSTEM':
      return 'System Generated';
    default:
      return 'Gym Management Hub';
  }
};

/**
 * Enrich an array of items (Subscriptions, Payments, Invoices) with Creator and Verifier details
 *
 * @param {object} tenantDb - Tenant database sequelize instance
 * @param {Array<object>} items - Plain JSON objects
 * @returns {Promise<Array<object>>} Enriched items
 */
const enrichAuditDetails = async (tenantDb, items) => {
  if (!items || !items.length) return items;

  // Collect all unique user IDs for lookup
  const userIdsToFetch = new Set();

  for (const item of items) {
    if (item.userId) userIdsToFetch.add(item.userId);
    if (item.createdBy) userIdsToFetch.add(item.createdBy);
    if (item.verifiedBy) userIdsToFetch.add(item.verifiedBy);
    if (item.staffCollectedBy) userIdsToFetch.add(item.staffCollectedBy);
  }

  const idList = [...userIdsToFetch].filter(Boolean);
  let userMap = {};
  if (idList.length > 0) {
    try {
      const users = await User.findAll({
        where: { id: idList },
        attributes: ['id', 'fullName', 'email', 'phone', 'role', 'profileImageUrl'],
      });
      userMap = Object.fromEntries(users.map((u) => [u.id, u.toJSON()]));
    } catch (err) {
      console.warn('[AuditUtils] Failed to fetch users:', err.message);
    }
  }

  // Fetch GymStaff designations for creator user IDs
  let staffMap = {};
  if (idList.length > 0 && tenantDb?.models?.GymStaff) {
    try {
      const staffMembers = await tenantDb.models.GymStaff.findAll({
        where: { userId: idList, status: 'active' },
        attributes: ['id', 'userId', 'branchId', 'designation', 'role'],
      });
      for (const s of staffMembers) {
        staffMap[s.userId] = s.toJSON();
      }
    } catch (err) {
      console.warn('[AuditUtils] Failed to fetch staff info:', err.message);
    }
  }

  return items.map((rawItem) => {
    const item = typeof rawItem.toJSON === 'function' ? rawItem.toJSON() : { ...rawItem };

    // 1. Member user
    const memberUser = userMap[item.userId] || item.user || null;

    // 2. Creator resolution
    let creator = null;
    const creatorUser = item.createdBy ? userMap[item.createdBy] : null;

    if (creatorUser) {
      let role = (item.createdByRole || creatorUser.role || '').toUpperCase();
      const staffInfo = staffMap[creatorUser.id];
      const designation = staffInfo?.designation || null;

      if (role === 'GYM_HOST' || role === 'HOST') {
        role = 'HOST';
      } else if (role === 'BRANCH_MANAGER' || role === 'STAFF' || role === 'ADMIN') {
        if (designation && designation.toLowerCase() === 'admin') {
          role = 'ADMIN';
        } else {
          role = 'STAFF';
        }
      } else if (role === 'MEMBER' || creatorUser.id === item.userId) {
        role = 'MEMBER';
      }

      creator = {
        id: creatorUser.id,
        fullName: creatorUser.fullName,
        email: creatorUser.email,
        phone: creatorUser.phone,
        profileImageUrl: creatorUser.profileImageUrl,
        role,
        roleLabel: getRoleLabel(role),
        designation: designation || getRoleLabel(role),
        sourcePlatform: getSourcePlatform(role, item.sourceChannel),
      };
    } else if (item.sourceChannel === 'ONLINE' || item.createdByRole === 'MEMBER') {
      // Member requested directly via User App
      creator = {
        id: memberUser?.id || item.userId || null,
        fullName: memberUser?.fullName || 'Member',
        email: memberUser?.email || null,
        role: 'MEMBER',
        roleLabel: 'Member / User',
        designation: 'Member',
        sourcePlatform: 'User Application',
      };
    } else if (item.createdByRole) {
      const role = item.createdByRole.toUpperCase();
      creator = {
        id: item.createdBy || null,
        fullName: getRoleLabel(role),
        role,
        roleLabel: getRoleLabel(role),
        designation: getRoleLabel(role),
        sourcePlatform: getSourcePlatform(role, item.sourceChannel),
      };
    }

    // 3. Verifier resolution
    let verifier = null;
    const verifierUser = item.verifiedBy ? userMap[item.verifiedBy] : null;
    if (verifierUser) {
      verifier = {
        id: verifierUser.id,
        fullName: verifierUser.fullName,
        email: verifierUser.email,
        role: 'HOST',
        roleLabel: 'Host / Owner',
        verifiedAt: item.verifiedAt || null,
      };
    } else if (item.verifiedBy) {
      verifier = {
        id: item.verifiedBy,
        fullName: 'Host / Owner',
        role: 'HOST',
        roleLabel: 'Host / Owner',
        verifiedAt: item.verifiedAt || null,
      };
    }

    // 4. Staff collector resolution (for cash collection step)
    let collector = null;
    const collectorUser = item.staffCollectedBy ? userMap[item.staffCollectedBy] : null;
    if (collectorUser) {
      collector = {
        id: collectorUser.id,
        fullName: collectorUser.fullName,
        role: 'STAFF',
        roleLabel: 'Staff',
        collectedAt: item.collectedAt || null,
      };
    }

    return {
      ...item,
      user: memberUser,
      creator,
      createdByName: creator?.fullName || null,
      createdByRole: creator?.role || item.createdByRole || null,
      sourcePlatform: creator?.sourcePlatform || getSourcePlatform(item.createdByRole, item.sourceChannel),
      verifier,
      verifiedByName: verifier?.fullName || null,
      collector,
    };
  });
};

module.exports = {
  resolveCreatorRole,
  getRoleLabel,
  getSourcePlatform,
  enrichAuditDetails,
};

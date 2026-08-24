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

  // Check if user has active staff/admin designation in this tenant
  if (tenantDb && tenantDb.models && tenantDb.models.GymStaff && userId) {
    try {
      const staffMembers = await tenantDb.models.GymStaff.findAll({
        where: { userId, status: 'active' },
      });
      if (staffMembers && staffMembers.length > 0) {
        const isAdmin = staffMembers.some(
          (s) => (s.designation || '').trim().toLowerCase() === 'admin'
        );
        return isAdmin ? 'ADMIN' : 'STAFF';
      }
    } catch (_) {
      // Fallback
    }
  }

  if (userRole === 'ADMIN') return 'ADMIN';
  if (userRole === 'MEMBER') return 'MEMBER';
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
  if (sourceChannel === 'ONLINE') return 'User App';
  switch ((role || '').toUpperCase()) {
    case 'HOST':
    case 'GYM_HOST':
      return 'Host Management Area';
    case 'ADMIN':
      return 'Admin App';
    case 'STAFF':
    case 'BRANCH_MANAGER':
      return 'Staff App';
    case 'MEMBER':
    case 'USER':
      return 'User App';
    case 'SYSTEM':
      return 'System Generated';
    default:
      return 'Not Available';
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

  // 1. Backward compatibility: if Payment has no createdBy, try to get it from linked MemberSubscription
  if (tenantDb?.models?.MemberSubscription) {
    const missingSubIds = items
      .filter((it) => !it.createdBy && (it.paymentFor === 'MEMBERSHIP' || it.referenceEntityId))
      .map((it) => it.referenceEntityId)
      .filter(Boolean);

    if (missingSubIds.length > 0) {
      try {
        const subs = await tenantDb.models.MemberSubscription.findAll({
          where: { id: missingSubIds },
          attributes: ['id', 'createdBy', 'createdByRole'],
        });
        const subMap = Object.fromEntries(subs.map((s) => [s.id, s]));
        for (const it of items) {
          if (!it.createdBy && it.referenceEntityId && subMap[it.referenceEntityId]) {
            const sub = subMap[it.referenceEntityId];
            if (sub.createdBy) {
              it.createdBy = sub.createdBy;
              if (sub.createdByRole) it.createdByRole = sub.createdByRole;
            }
          }
        }
      } catch (_) {}
    }
  }

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

  // Fetch GymStaff designations for creator user IDs and emails
  let staffMap = {};
  if (idList.length > 0 && tenantDb?.models?.GymStaff) {
    try {
      const emailsToFetch = idList.map((id) => userMap[id]?.email?.toLowerCase().trim()).filter(Boolean);
      const staffMembers = await tenantDb.models.GymStaff.findAll({
        where: {
          [Op.or]: [
            { userId: idList },
            ...(emailsToFetch.length > 0 ? [{ email: emailsToFetch }] : []),
          ],
          status: 'active',
        },
        attributes: ['id', 'userId', 'email', 'branchId', 'designation', 'role'],
      });
      for (const s of staffMembers) {
        const staffJson = s.toJSON();
        const isAdmin = (staffJson.designation || '').trim().toLowerCase() === 'admin';
        if (staffJson.userId) {
          if (!staffMap[staffJson.userId] || isAdmin) {
            staffMap[staffJson.userId] = staffJson;
          }
        }
        if (staffJson.email) {
          const e = staffJson.email.toLowerCase().trim();
          if (!staffMap[e] || isAdmin) {
            staffMap[e] = staffJson;
          }
        }
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
      const staffInfo = staffMap[creatorUser.id] || staffMap[creatorUser.email?.toLowerCase().trim()];
      const designation = (staffInfo?.designation || '').trim().toLowerCase();
      let role = (item.createdByRole || '').toUpperCase();

      if (role === 'GYM_HOST' || role === 'HOST' || creatorUser.role === 'GYM_HOST' || creatorUser.role === 'HOST') {
        role = 'HOST';
      } else if (role === 'ADMIN' || designation === 'admin' || creatorUser.role === 'ADMIN') {
        role = 'ADMIN';
      } else if (role === 'BRANCH_MANAGER' || role === 'STAFF' || staffInfo || creatorUser.role === 'BRANCH_MANAGER') {
        role = 'STAFF';
      } else if (role === 'MEMBER' && creatorUser.id === item.userId) {
        role = 'MEMBER';
      } else {
        role = designation === 'admin' ? 'ADMIN' : (staffInfo ? 'STAFF' : (role || 'STAFF'));
      }

      creator = {
        id: creatorUser.id,
        fullName: creatorUser.fullName,
        email: creatorUser.email,
        phone: creatorUser.phone,
        profileImageUrl: creatorUser.profileImageUrl,
        role,
        roleLabel: getRoleLabel(role),
        designation: staffInfo?.designation || getRoleLabel(role),
        sourcePlatform: getSourcePlatform(role, item.sourceChannel),
      };
    } else if (item.sourceChannel === 'ONLINE') {
      // Member requested directly via User App
      creator = {
        id: memberUser?.id || item.userId || null,
        fullName: memberUser?.fullName || 'Member',
        email: memberUser?.email || null,
        role: 'MEMBER',
        roleLabel: 'Member / User',
        designation: 'Member',
        sourcePlatform: 'User App',
      };
    } else if (item.createdByRole && item.createdByRole !== 'STAFF' && item.createdByRole !== 'UNKNOWN') {
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
        email: collectorUser.email,
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
      createdByEmail: creator?.email || null,
      createdByRole: creator?.role || null,
      sourcePlatform: creator?.sourcePlatform || (item.sourceChannel === 'ONLINE' ? 'User App' : null),
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

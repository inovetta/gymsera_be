/**
 * Roles.
 *
 * Two distinct things live here, and conflating them is the bug this file exists
 * to prevent:
 *
 *   UserRole   — the *platform* account type. Global, coarse, and on its way to
 *                being just PLATFORM_ADMIN vs USER. It says nothing about what
 *                someone may do inside a gym.
 *
 *   ROLE_KEY   — an *organization* role, held through a role_assignment scoped to
 *                an org or a set of branches. This is what the Team & Access
 *                screen assigns, and what carries permissions.
 *
 * One person may hold several ROLE_KEYs across several organizations while their
 * UserRole stays MEMBER forever. That is the whole point: hiring a traveler as a
 * trainer must not cost them their traveler account.
 *
 * Role presets are derived from the permission catalogue's `tiers` arrays, so the
 * catalogue is the only place a default is ever edited. Nothing here is
 * hand-maintained in parallel.
 */
const {
  CATALOGUE,
  ROLE_ORDER,
  TIER,
  GRANTING_TIERS,
  DIRECT_TIERS,
  SCOPE,
  directKeyFor,
} = require('./permissions');

/**
 * Platform account type. Kept as-is for backwards compatibility with the
 * `users.role` ENUM; do not add gym roles here.
 */
const UserRole = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  GYM_HOST: 'GYM_HOST',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  TRAINER: 'TRAINER',
  MEMBER: 'MEMBER',
};

/** Organization role keys. */
const RoleKey = {
  OWNER: 'OWNER',
  ORG_ADMIN: 'ORG_ADMIN',
  MANAGER: 'MANAGER',
  BR_ADMIN: 'BR_ADMIN',
  DESK: 'DESK',
  TRAINER: 'TRAINER',
  SUPPORT: 'SUPPORT',
};

/**
 * Role levels.
 *
 * Levels exist for exactly one reason: to stop privilege escalation. A user may
 * only assign a role strictly below their own level, and may only grant
 * permissions they themselves hold. Both rules are enforced server-side in
 * access.service.js — never in the UI alone.
 */
const ROLE_META = {
  OWNER: {
    level: 100,
    name: 'Owner',
    displayName: 'Owner / Host',
    charter:
      'Created the organization. Implicit full access. Sole holder of billing, payouts, bank details, ownership transfer and org deletion. Cannot be removed.',
    assignable: false, // granted by creating the org, never from the Team screen
    defaultScope: 'ORG',
  },
  ORG_ADMIN: {
    level: 80,
    name: 'Org Admin',
    displayName: 'Gym Admin',
    charter: 'Full operations across every branch. No payouts, no bank details, no owner removal, no org deletion.',
    assignable: true,
    defaultScope: 'ORG',
  },
  MANAGER: {
    level: 60,
    name: 'Branch Manager',
    displayName: 'Branch Manager',
    charter:
      'Full operations on assigned branches, including financial approvals and end-of-shift cash reconciliation. May invite roles below level 60.',
    assignable: true,
    defaultScope: 'BRANCH',
  },
  BR_ADMIN: {
    level: 40,
    name: 'Branch Admin',
    displayName: 'Branch Admin',
    charter: 'Day-to-day operations on assigned branches, minus financial approval and team invites.',
    assignable: true,
    defaultScope: 'BRANCH',
  },
  DESK: {
    level: 20,
    name: 'Front Desk',
    displayName: 'Front Desk / Staff',
    charter:
      'Check-ins, member onboarding by request, records payments into the collection box. No approvals, no money out.',
    assignable: true,
    defaultScope: 'BRANCH',
  },
  TRAINER: {
    level: 20,
    name: 'Trainer',
    displayName: 'Trainer',
    charter: 'Own classes and assigned members, with progress notes. Zero financial access.',
    assignable: true,
    defaultScope: 'BRANCH',
  },
  SUPPORT: {
    level: 5,
    name: 'Support',
    displayName: 'Support / Cleaner',
    charter: 'Schedule visibility and facility tasks only. No member contact details, ever.',
    assignable: true,
    defaultScope: 'BRANCH',
  },
};

/**
 * Expand the catalogue's tier matrix into one grant map per role.
 *
 * A grant is `{ scope, tier }` keyed by permission key. An approvable permission
 * at DIRECT or FULL tier also emits its `.direct` twin, which is what lets the
 * approval engine branch without knowing anything about the module.
 *
 * @returns {Record<string, Record<string, {scope: string, tier: string}>>}
 */
const buildRolePresets = () => {
  const presets = {};
  for (const roleKey of ROLE_ORDER) presets[roleKey] = {};

  for (const group of CATALOGUE) {
    for (const perm of group.permissions) {
      perm.tiers.forEach((tier, idx) => {
        if (!GRANTING_TIERS.has(tier)) return;

        const roleKey = ROLE_ORDER[idx];
        const scope = (perm.roleScopes && perm.roleScopes[roleKey]) || SCOPE.ALL;

        presets[roleKey][perm.key] = { scope, tier };

        if (perm.approvable && DIRECT_TIERS.has(tier)) {
          const twin = directKeyFor(perm.key);
          if (twin) presets[roleKey][twin] = { scope, tier };
        }
      });
    }
  }
  return presets;
};

/** @type {Record<string, Record<string, {scope: string, tier: string}>>} */
const ROLE_PRESETS = buildRolePresets();

/** Role keys ordered high to low. */
const ROLE_KEYS = [...ROLE_ORDER].sort((a, b) => ROLE_META[b].level - ROLE_META[a].level);

const getRoleLevel = (roleKey) => (ROLE_META[roleKey] ? ROLE_META[roleKey].level : 0);

const isKnownRole = (roleKey) => Object.prototype.hasOwnProperty.call(ROLE_META, roleKey);

/** Roles `actorLevel` is permitted to assign — strictly below their own level. */
const assignableRolesFor = (actorLevel) =>
  ROLE_KEYS.filter((key) => ROLE_META[key].assignable && ROLE_META[key].level < actorLevel);

/** The preset grant map for a role, or an empty map for an unknown role. */
const presetFor = (roleKey) => ROLE_PRESETS[roleKey] || {};

/** Roles shaped for the role-picker UI, richest first. */
const getRolesForClient = () =>
  ROLE_KEYS.map((key) => ({
    key,
    level: ROLE_META[key].level,
    name: ROLE_META[key].name,
    displayName: ROLE_META[key].displayName,
    charter: ROLE_META[key].charter,
    assignable: ROLE_META[key].assignable,
    defaultScope: ROLE_META[key].defaultScope,
    permissionCount: Object.keys(ROLE_PRESETS[key] || {}).length,
  }));

module.exports = {
  UserRole,
  RoleKey,
  ROLE_META,
  ROLE_KEYS,
  ROLE_PRESETS,
  TIER,
  getRoleLevel,
  isKnownRole,
  assignableRolesFor,
  presetFor,
  getRolesForClient,
};

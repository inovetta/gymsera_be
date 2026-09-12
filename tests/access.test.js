/**
 * Access control — resolution, precedence and guardrails.
 *
 * These cover the logic that decides whether someone may spend money, so they are
 * exhaustive about precedence rather than representative.
 */

// Redis is optional at runtime; stub it so tests never depend on a live instance.
jest.mock('../src/config/redis.config', () => ({
  getRedisClient: () => null,
  safeRedisGet: jest.fn().mockResolvedValue(null),
  safeRedisSetex: jest.fn().mockResolvedValue(true),
  safeRedisDel: jest.fn().mockResolvedValue(true),
}));

// The platform DB is mocked so these are pure unit tests with no connection.
const mockTenant = { findByPk: jest.fn(), increment: jest.fn() };
const mockUser = { findByPk: jest.fn(), increment: jest.fn() };
jest.mock('../src/models/platform', () => ({
  Tenant: mockTenant,
  User: mockUser,
}));

const accessService = require('../src/services/access.service');
const { ROLE_META } = require('../src/constants/roles');

const TENANT_ID = 'tenant-1';
const OWNER_ID = 'user-owner';
const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

/** Build a fake tenantDb whose RoleAssignment.findAll returns these rows. */
const fakeTenantDb = (assignments) => ({
  models: {
    RoleAssignment: { findAll: jest.fn().mockResolvedValue(assignments) },
    RoleAssignmentBranch: {},
    AssignmentOverride: {},
  },
});

/** A role assignment as Sequelize would return it, with eager-loaded relations. */
const assignment = (over = {}) => ({
  id: over.id || 'assign-1',
  userId: over.userId || 'user-1',
  roleKey: over.roleKey || 'DESK',
  scopeType: over.scopeType || 'BRANCH',
  status: 'ACTIVE',
  validFrom: null,
  validUntil: null,
  branchLinks: (over.branchIds || [BRANCH_A]).map((b) => ({ branchId: b })),
  overrides: over.overrides || [],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTenant.findByPk.mockResolvedValue({
    id: TENANT_ID,
    ownerUserId: OWNER_ID,
    permissionVersion: 1,
  });
  mockUser.findByPk.mockResolvedValue({ id: 'user-1', permissionVersion: 1 });
});

describe('resolve — ownership', () => {
  it('short-circuits to full access for the tenant owner', async () => {
    const db = fakeTenantDb([]);
    const grants = await accessService.resolve(db, TENANT_ID, OWNER_ID, BRANCH_A);

    expect(grants.isOwner).toBe(true);
    expect(grants.has('payouts.bank.manage')).toBe(true);
    expect(grants.has('anything.at.all')).toBe(true);
    // The owner never needs an assignment lookup.
    expect(db.models.RoleAssignment.findAll).not.toHaveBeenCalled();
  });

  it('denies by default when the user has no assignment', async () => {
    const grants = await accessService.resolve(fakeTenantDb([]), TENANT_ID, 'stranger', BRANCH_A);

    expect(grants.isOwner).toBe(false);
    expect(grants.has('members.view')).toBe(false);
    expect(grants.keys()).toHaveLength(0);
  });
});

describe('resolve — branch scoping', () => {
  it('grants nothing in a branch the assignment does not cover', async () => {
    const db = fakeTenantDb([assignment({ roleKey: 'BR_ADMIN', branchIds: [BRANCH_A] })]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_B);

    expect(grants.has('members.create')).toBe(false);
  });

  it('an ORG-scoped assignment covers every branch', async () => {
    const db = fakeTenantDb([
      assignment({ roleKey: 'ORG_ADMIN', scopeType: 'ORG', branchIds: [] }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_B);

    expect(grants.has('members.create')).toBe(true);
  });

  it('refuses an org-only permission to a branch-scoped assignment', async () => {
    // plans.price.update is org-only; ORG_ADMIN's preset includes it.
    const db = fakeTenantDb([
      assignment({ roleKey: 'ORG_ADMIN', scopeType: 'BRANCH', branchIds: [BRANCH_A] }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('plans.price.update')).toBe(false);
    expect(grants.has('members.create')).toBe(true); // ordinary permissions unaffected
  });
});

describe('resolve — approval tiers', () => {
  it('Front Desk may request a member, not create one directly', async () => {
    const db = fakeTenantDb([assignment({ roleKey: 'DESK' })]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('members.create')).toBe(true);
    expect(grants.has('members.create.direct')).toBe(false);
    expect(grants.tierFor('members.create')).toBe('REQUEST');
  });

  it('Branch Admin creates members directly', async () => {
    const db = fakeTenantDb([assignment({ roleKey: 'BR_ADMIN' })]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.tierFor('members.create')).toBe('DIRECT');
  });

  it('a Trainer cannot create members at all', async () => {
    const db = fakeTenantDb([assignment({ roleKey: 'TRAINER' })]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.tierFor('members.create')).toBe('OFF');
  });

  it('reports DIRECT for a non-approvable permission that is held', async () => {
    const db = fakeTenantDb([assignment({ roleKey: 'DESK' })]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.tierFor('checkins.qr.scan')).toBe('DIRECT');
  });
});

describe('resolve — overrides', () => {
  it('ALLOW grants a permission the preset withholds', async () => {
    const db = fakeTenantDb([
      assignment({
        roleKey: 'TRAINER',
        overrides: [{ permissionKey: 'expenses.approve', effect: 'ALLOW', branchId: null }],
      }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('expenses.approve')).toBe(true);
  });

  it('DENY beats the preset', async () => {
    const db = fakeTenantDb([
      assignment({
        roleKey: 'BR_ADMIN',
        overrides: [{ permissionKey: 'members.pii.view', effect: 'DENY', branchId: null }],
      }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('members.pii.view')).toBe(false);
    expect(grants.has('members.view')).toBe(true);
  });

  it('DENY beats ALLOW regardless of order', async () => {
    const db = fakeTenantDb([
      assignment({
        roleKey: 'DESK',
        overrides: [
          { permissionKey: 'payments.refund', effect: 'ALLOW', branchId: null },
          { permissionKey: 'payments.refund', effect: 'DENY', branchId: null },
        ],
      }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('payments.refund')).toBe(false);
  });

  it('denying a base permission also withdraws its .direct twin', async () => {
    const db = fakeTenantDb([
      assignment({
        roleKey: 'BR_ADMIN', // holds members.create AND members.create.direct
        overrides: [{ permissionKey: 'members.create', effect: 'DENY', branchId: null }],
      }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('members.create')).toBe(false);
    expect(grants.has('members.create.direct')).toBe(false);
    expect(grants.tierFor('members.create')).toBe('OFF');
  });

  it('a branch-specific override does not leak into another branch', async () => {
    const db = fakeTenantDb([
      assignment({
        roleKey: 'BR_ADMIN',
        branchIds: [BRANCH_A, BRANCH_B],
        overrides: [{ permissionKey: 'members.create', effect: 'DENY', branchId: BRANCH_A }],
      }),
    ]);

    const inA = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);
    const inB = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_B);

    expect(inA.has('members.create')).toBe(false);
    expect(inB.has('members.create')).toBe(true);
  });

  it('ignores an override naming a permission that no longer exists', async () => {
    const db = fakeTenantDb([
      assignment({
        roleKey: 'DESK',
        overrides: [{ permissionKey: 'removed.in.v2', effect: 'ALLOW', branchId: null }],
      }),
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.has('removed.in.v2')).toBe(false);
  });
});

describe('resolve — multiple roles', () => {
  it('unions grants and keeps the widest data scope', async () => {
    const db = fakeTenantDb([
      assignment({ id: 'a1', roleKey: 'TRAINER', branchIds: [BRANCH_A] }), // members.view ASSIGNED
      assignment({ id: 'a2', roleKey: 'BR_ADMIN', branchIds: [BRANCH_A] }), // members.view ALL
    ]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.scopeFor('members.view')).toBe('ALL');
    expect(grants.has('members.notes.write')).toBe(true); // from Trainer
    expect(grants.has('subscriptions.create')).toBe(true); // from Branch Admin
    expect(grants.level).toBe(ROLE_META.BR_ADMIN.level);
  });

  it('a Trainer alone sees only their assigned members', async () => {
    const db = fakeTenantDb([assignment({ roleKey: 'TRAINER' })]);
    const grants = await accessService.resolve(db, TENANT_ID, 'user-1', BRANCH_A);

    expect(grants.scopeFor('members.view')).toBe('ASSIGNED');
    expect(grants.has('members.pii.view')).toBe(false); // no contact details
  });
});

describe('guardrails — privilege escalation', () => {
  const grantsAt = (level, keys = []) =>
    new accessService.Grants({
      level,
      map: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL', constraints: null }])),
    });

  it('refuses a role at or above the actor own level', () => {
    const manager = grantsAt(ROLE_META.MANAGER.level, ['team.role.assign']);

    expect(() => accessService.assertCanAssignRole(manager, 'BR_ADMIN')).not.toThrow();
    expect(() => accessService.assertCanAssignRole(manager, 'MANAGER')).toThrow(/at or above your own level/);
    expect(() => accessService.assertCanAssignRole(manager, 'ORG_ADMIN')).toThrow(/at or above your own level/);
  });

  it('never lets OWNER be assigned from the team screen', () => {
    const orgAdmin = grantsAt(ROLE_META.ORG_ADMIN.level, ['team.role.assign']);
    expect(() => accessService.assertCanAssignRole(orgAdmin, 'OWNER')).toThrow(/cannot be assigned/);
  });

  it('requires team.role.assign even at a high level', () => {
    const highButUnprivileged = grantsAt(ROLE_META.ORG_ADMIN.level, []);
    expect(() => accessService.assertCanAssignRole(highButUnprivileged, 'DESK')).toThrow(/do not have permission/);
  });

  it('refuses to grant a permission the actor does not hold', () => {
    const actor = grantsAt(ROLE_META.MANAGER.level, ['team.permission.override', 'members.create']);

    expect(() =>
      accessService.assertCanGrantOverrides(actor, [{ permissionKey: 'members.create', effect: 'ALLOW' }])
    ).not.toThrow();

    expect(() =>
      accessService.assertCanGrantOverrides(actor, [{ permissionKey: 'payouts.bank.manage', effect: 'ALLOW' }])
    ).toThrow(/do not hold it yourself/);
  });

  it('always allows revoking, even of a permission the actor lacks', () => {
    const actor = grantsAt(ROLE_META.MANAGER.level, ['team.permission.override']);
    expect(() =>
      accessService.assertCanGrantOverrides(actor, [{ permissionKey: 'payouts.bank.manage', effect: 'DENY' }])
    ).not.toThrow();
  });

  it('blocks self-elevation', () => {
    expect(() => accessService.assertNotSelf('user-1', 'user-1')).toThrow(/your own role/);
    expect(() => accessService.assertNotSelf('user-1', 'user-2')).not.toThrow();
  });

  it('blocks managing a peer or a superior', () => {
    const manager = grantsAt(ROLE_META.MANAGER.level, []);
    expect(() => accessService.assertCanManageAssignment(manager, { roleKey: 'DESK' })).not.toThrow();
    expect(() => accessService.assertCanManageAssignment(manager, { roleKey: 'MANAGER' })).toThrow(/at or above your own level/);
    expect(() => accessService.assertCanManageAssignment(manager, { roleKey: 'ORG_ADMIN' })).toThrow();
  });

  it('lets the owner do all of it', () => {
    const owner = accessService.ownerGrants();
    expect(() => accessService.assertCanAssignRole(owner, 'ORG_ADMIN')).not.toThrow();
    expect(() => accessService.assertCanManageAssignment(owner, { roleKey: 'ORG_ADMIN' })).not.toThrow();
    expect(() =>
      accessService.assertCanGrantOverrides(owner, [{ permissionKey: 'payouts.bank.manage', effect: 'ALLOW' }])
    ).not.toThrow();
  });
});

describe('catalogue integrity', () => {
  const { PERMISSIONS, DIRECT_TWINS, getPermission, baseKeyFor, directKeyFor } = require('../src/constants/permissions');
  const { ROLE_PRESETS, ROLE_KEYS } = require('../src/constants/roles');

  it('gives every approvable permission a .direct twin and nothing else one', () => {
    for (const [key, perm] of PERMISSIONS) {
      const twin = directKeyFor(key);
      if (perm.approvable) {
        expect(twin).toBe(`${key}.direct`);
        expect(DIRECT_TWINS.has(twin)).toBe(true);
      } else {
        expect(twin).toBeNull();
      }
    }
  });

  it('round-trips a twin back to its base key', () => {
    expect(baseKeyFor('members.create.direct')).toBe('members.create');
    expect(baseKeyFor('members.create')).toBe('members.create');
    expect(getPermission('members.create.direct').label).toBe('Add member');
  });

  it('never puts a .direct twin in a preset without its base permission', () => {
    for (const roleKey of ROLE_KEYS) {
      for (const key of Object.keys(ROLE_PRESETS[roleKey])) {
        if (!DIRECT_TWINS.has(key)) continue;
        expect(ROLE_PRESETS[roleKey][baseKeyFor(key)]).toBeDefined();
      }
    }
  });

  it('orders role levels strictly so escalation checks are meaningful', () => {
    expect(ROLE_META.OWNER.level).toBeGreaterThan(ROLE_META.ORG_ADMIN.level);
    expect(ROLE_META.ORG_ADMIN.level).toBeGreaterThan(ROLE_META.MANAGER.level);
    expect(ROLE_META.MANAGER.level).toBeGreaterThan(ROLE_META.BR_ADMIN.level);
    expect(ROLE_META.BR_ADMIN.level).toBeGreaterThan(ROLE_META.DESK.level);
    expect(ROLE_META.DESK.level).toBeGreaterThan(ROLE_META.SUPPORT.level);
  });

  it('keeps payouts and billing with the owner alone', () => {
    for (const roleKey of ROLE_KEYS) {
      if (roleKey === 'OWNER') continue;
      expect(ROLE_PRESETS[roleKey]['payouts.bank.manage']).toBeUndefined();
      expect(ROLE_PRESETS[roleKey]['billing.manage']).toBeUndefined();
      expect(ROLE_PRESETS[roleKey]['payouts.view']).toBeUndefined();
    }
  });

  it('gives the Support role no access to member contact details, ever', () => {
    expect(ROLE_PRESETS.SUPPORT['members.pii.view']).toBeUndefined();
    expect(ROLE_PRESETS.SUPPORT['members.view']).toBeUndefined();
  });

  it('gives the Trainer no financial access', () => {
    for (const key of Object.keys(ROLE_PRESETS.TRAINER)) {
      expect(key).not.toMatch(/^(payments|invoices|payouts|billing)\./);
    }
  });
});

/**
 * Persona Helper for GymsEra API Tests (§8.4 Persona Matrix)
 *
 * Provides personas:
 * - OWNER: Tenant Owner (full tenant scope)
 * - ORG_ADMIN: Organization Admin (scoped to organization)
 * - MANAGER: Branch Manager (scoped to branch)
 * - FRONT_DESK: Front Desk / Reception (scoped to branch)
 * - TRAINER: Trainer (scoped to branch / own clients)
 * - CLEANER: Cleaner (scoped to branch)
 * - MEMBER: Gym Member / Traveler
 * - PLATFORM_ADMIN: System Administrator
 * - OTHER_TENANT_OWNER: Owner of a separate tenant (for cross-tenant checks)
 * - ANONYMOUS: Unauthenticated caller
 */
const request = require('supertest');
const { signToken } = require('../../src/utils/jwt.utils');
const {
  createUser,
  createTenant,
  createGymListing,
  createBranch,
  createTenantSubscription,
  createRoleAssignment,
} = require('./factories');
const app = require('../../app');

class PersonaManager {
  constructor() {
    this.personas = {};
    this.context = null;
  }

  /**
   * Provisions a complete multi-tenant test topology with all personas from §8.4
   * @param {object} dbHarness - the object returned by setupTestDatabases()
   */
  async setup(dbHarness) {
    const { tenant1, tenant2 } = dbHarness;

    // 1. Tenant 1 & Owner
    const ownerUser = await createUser({
      role: 'GYM_HOST',
      email: 'owner@tenant1.test',
      fullName: 'Owner One',
    });
    const tenant1Record = await createTenant({
      id: '11111111-1111-4111-8111-111111111111',
      tenantCode: 'GYM-TENANT1',
      gymName: 'Alpha Fitness Club',
      ownerUserId: ownerUser.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
    });
    await createTenantSubscription(tenant1Record.id, { branchCount: 10 });
    const listing1 = await createGymListing(tenant1Record.id, {
      title: 'Alpha Fitness Downtown',
    });
    const branch1 = await createBranch(tenant1, listing1.id, {
      name: 'Downtown Main Branch',
    });

    // 2. Tenant 2 & Owner (for cross-tenant testing)
    const otherOwnerUser = await createUser({
      role: 'GYM_HOST',
      email: 'owner@tenant2.test',
      fullName: 'Other Tenant Owner',
    });
    const tenant2Record = await createTenant({
      id: '22222222-2222-4222-8222-222222222222',
      tenantCode: 'GYM-TENANT2',
      gymName: 'Beta Gym',
      ownerUserId: otherOwnerUser.id,
      connectionStringEncrypted: tenant2.encryptedConnStr,
    });
    await createTenantSubscription(tenant2Record.id, { branchCount: 5 });
    const listing2 = await createGymListing(tenant2Record.id, {
      title: 'Beta Gym West',
    });
    const branch2 = await createBranch(tenant2, listing2.id, {
      name: 'West Branch',
    });

    // 3. Organization Admin
    const orgAdminUser = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'orgadmin@tenant1.test',
      fullName: 'Org Admin',
    });
    await createRoleAssignment(tenant1, {
      userId: orgAdminUser.id,
      roleKey: 'ORGANIZATION_ADMIN',
      scopeType: 'ORGANIZATION',
      scopeId: listing1.id,
      tenantId: tenant1Record.id,
    });

    // 4. Branch Manager
    const managerUser = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'manager@tenant1.test',
      fullName: 'Branch Manager',
    });
    await createRoleAssignment(tenant1, {
      userId: managerUser.id,
      roleKey: 'BRANCH_MANAGER',
      scopeType: 'BRANCH',
      scopeId: branch1.id,
      branchIds: [branch1.id],
      tenantId: tenant1Record.id,
    });

    // 5. Front Desk
    const frontDeskUser = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'frontdesk@tenant1.test',
      fullName: 'Front Desk Officer',
    });
    await createRoleAssignment(tenant1, {
      userId: frontDeskUser.id,
      roleKey: 'FRONT_DESK',
      scopeType: 'BRANCH',
      scopeId: branch1.id,
      branchIds: [branch1.id],
      tenantId: tenant1Record.id,
    });

    // 6. Trainer
    const trainerUser = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'trainer@tenant1.test',
      fullName: 'Head Trainer',
    });
    await createRoleAssignment(tenant1, {
      userId: trainerUser.id,
      roleKey: 'TRAINER',
      scopeType: 'BRANCH',
      scopeId: branch1.id,
      branchIds: [branch1.id],
      tenantId: tenant1Record.id,
    });

    // 7. Cleaner
    const cleanerUser = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'cleaner@tenant1.test',
      fullName: 'Facility Cleaner',
    });
    await createRoleAssignment(tenant1, {
      userId: cleanerUser.id,
      roleKey: 'CLEANER',
      scopeType: 'BRANCH',
      scopeId: branch1.id,
      branchIds: [branch1.id],
      tenantId: tenant1Record.id,
    });

    // 8. Member
    const memberUser = await createUser({
      role: 'MEMBER',
      email: 'member@test.com',
      fullName: 'Gym Member',
    });

    // 9. Platform Admin
    const platformAdminUser = await createUser({
      role: 'PLATFORM_ADMIN',
      email: 'admin@gymsera.com',
      fullName: 'System SuperAdmin',
    });

    this.context = {
      tenant1: tenant1Record,
      tenant2: tenant2Record,
      listing1,
      listing2,
      branch1,
      branch2,
      tenant1Db: tenant1,
      tenant2Db: tenant2,
    };

    // Build persona tokens
    this.personas = {
      owner: {
        user: ownerUser,
        tenantId: tenant1Record.id,
        token: signToken({
          sub: ownerUser.id,
          id: ownerUser.id,
          email: ownerUser.email,
          role: 'GYM_HOST',
          isVerified: true,
          tenantId: tenant1Record.id,
        }),
      },
      orgAdmin: {
        user: orgAdminUser,
        tenantId: tenant1Record.id,
        token: signToken({
          sub: orgAdminUser.id,
          id: orgAdminUser.id,
          email: orgAdminUser.email,
          role: 'BRANCH_MANAGER',
          isVerified: true,
          tenantId: tenant1Record.id,
        }),
      },
      manager: {
        user: managerUser,
        tenantId: tenant1Record.id,
        token: signToken({
          sub: managerUser.id,
          id: managerUser.id,
          email: managerUser.email,
          role: 'BRANCH_MANAGER',
          isVerified: true,
          tenantId: tenant1Record.id,
          branchId: branch1.id,
        }),
      },
      frontDesk: {
        user: frontDeskUser,
        tenantId: tenant1Record.id,
        token: signToken({
          sub: frontDeskUser.id,
          id: frontDeskUser.id,
          email: frontDeskUser.email,
          role: 'BRANCH_MANAGER',
          isVerified: true,
          tenantId: tenant1Record.id,
          branchId: branch1.id,
        }),
      },
      trainer: {
        user: trainerUser,
        tenantId: tenant1Record.id,
        token: signToken({
          sub: trainerUser.id,
          id: trainerUser.id,
          email: trainerUser.email,
          role: 'BRANCH_MANAGER',
          isVerified: true,
          tenantId: tenant1Record.id,
          branchId: branch1.id,
        }),
      },
      cleaner: {
        user: cleanerUser,
        tenantId: tenant1Record.id,
        token: signToken({
          sub: cleanerUser.id,
          id: cleanerUser.id,
          email: cleanerUser.email,
          role: 'BRANCH_MANAGER',
          isVerified: true,
          tenantId: tenant1Record.id,
          branchId: branch1.id,
        }),
      },
      member: {
        user: memberUser,
        token: signToken({
          sub: memberUser.id,
          id: memberUser.id,
          email: memberUser.email,
          role: 'GYM_MEMBER',
          isVerified: true,
        }),
      },
      platformAdmin: {
        user: platformAdminUser,
        token: signToken({
          sub: platformAdminUser.id,
          id: platformAdminUser.id,
          email: platformAdminUser.email,
          role: 'PLATFORM_ADMIN',
          isVerified: true,
        }),
      },
      otherTenantOwner: {
        user: otherOwnerUser,
        tenantId: tenant2Record.id,
        token: signToken({
          sub: otherOwnerUser.id,
          id: otherOwnerUser.id,
          email: otherOwnerUser.email,
          role: 'GYM_HOST',
          isVerified: true,
          tenantId: tenant2Record.id,
        }),
      },
      anonymous: {
        user: null,
        token: null,
      },
    };

    return this.personas;
  }

  /**
   * Returns a supertest caller preconfigured for the given persona
   * @param {string} personaName - e.g. 'owner', 'manager', 'frontDesk', 'anonymous'
   * @param {object} [customHeaders] - extra headers to merge
   */
  as(personaName, customHeaders = {}) {
    const persona = this.personas[personaName];
    if (!persona && personaName !== 'anonymous') {
      throw new Error(`Unknown persona: ${personaName}. Available: ${Object.keys(this.personas).join(', ')}`);
    }

    const defaultHeaders = {
      Accept: 'application/json',
      ...customHeaders,
    };

    if (persona?.token) {
      defaultHeaders.Authorization = `Bearer ${persona.token}`;
    }
    if (persona?.tenantId && !defaultHeaders['X-Tenant-Id']) {
      defaultHeaders['X-Tenant-Id'] = persona.tenantId;
    }

    const formatPath = (path) => (path.startsWith('/api/v1') ? path : `/api/v1${path.startsWith('/') ? path : `/${path}`}`);

    const agent = request(app);

    return {
      get: (path) => {
        const req = agent.get(formatPath(path));
        for (const [k, v] of Object.entries(defaultHeaders)) req.set(k, v);
        return req;
      },
      post: (path, data) => {
        const req = agent.post(formatPath(path));
        for (const [k, v] of Object.entries(defaultHeaders)) req.set(k, v);
        if (data !== undefined) req.send(data);
        return req;
      },
      put: (path, data) => {
        const req = agent.put(formatPath(path));
        for (const [k, v] of Object.entries(defaultHeaders)) req.set(k, v);
        if (data !== undefined) req.send(data);
        return req;
      },
      patch: (path, data) => {
        const req = agent.patch(formatPath(path));
        for (const [k, v] of Object.entries(defaultHeaders)) req.set(k, v);
        if (data !== undefined) req.send(data);
        return req;
      },
      delete: (path, data) => {
        const req = agent.delete(formatPath(path));
        for (const [k, v] of Object.entries(defaultHeaders)) req.set(k, v);
        if (data !== undefined) req.send(data);
        return req;
      },
    };
  }
}

const personaManager = new PersonaManager();

module.exports = {
  PersonaManager,
  personaManager,
  setupPersonas: (harness) => personaManager.setup(harness),
  asPersona: (persona, headers) => personaManager.as(persona, headers),
};

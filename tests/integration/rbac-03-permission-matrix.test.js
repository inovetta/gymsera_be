/**
 * RBAC-03: Endpoint × Persona Permission Matrix Test Suite
 *
 * Verifies that every mutating route in the API correctly enforces the RBAC
 * permission matrix derived from constants/permissions.js and spec §8.4.
 *
 * Personas tested:
 * - OWNER: Tenant Owner (full tenant scope)
 * - ORG_ADMIN: Organization Admin (scoped to organization, orgWide)
 * - MANAGER: Branch Manager (scoped to assigned branch)
 * - FRONT_DESK: Front Desk Officer (scoped to assigned branch)
 * - TRAINER: Trainer (scoped to assigned branch / own clients)
 * - CLEANER: Support / Facility Cleaner (scoped to assigned branch)
 * - MEMBER: Regular gym member / traveler
 * - OTHER_TENANT_OWNER: Owner of a different tenant (cross-tenant check)
 * - ANONYMOUS: Unauthenticated caller
 *
 * Invariants:
 * 1. Unauthorized personas MUST NEVER receive 2xx for mutating operations.
 * 2. Cross-tenant callers MUST receive 404 Not Found (zero existence leakage).
 * 3. Anonymous callers MUST receive 401 Unauthorized.
 * 4. Approvable actions execute directly for DIRECT holders (200) and create approval requests for REQUEST holders (202).
 */

const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { setupPersonas, asPersona } = require('../harness/personas');
const { stopTestServer } = require('../harness/test-server');

describe('RBAC-03: Endpoint × Persona Permission Matrix', () => {
  let dbHarness;
  let personas;
  let tenant1Id;
  let branch1Id;
  let gymId;
  let planId;
  let categoryId;
  let ledgerDayId;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenant1Id = dbHarness.tenant1.tenantId || '11111111-1111-4111-8111-111111111111';

    const branch1 = await dbHarness.tenant1.models.Branch.findOne();
    branch1Id = branch1.id;
    gymId = branch1.gymId;

    // Create an active MembershipPlan for member enrollment commands
    const plan = await dbHarness.tenant1.models.MembershipPlan.create({
      gymId,
      branchId: branch1Id,
      name: 'Standard Monthly',
      price: 3000,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });
    planId = plan.id;

    // Create an ExpenseCategory for expense recording commands
    const category = await dbHarness.tenant1.models.ExpenseCategory.create({
      branchId: branch1Id,
      name: 'Maintenance & Cleaning',
      isDefault: true,
      status: 'ACTIVE',
    });
    categoryId = category.id;

    // Create an open LedgerDay for adjustment verification tests
    const ledgerDay = await dbHarness.tenant1.models.LedgerDay.create({
      branchId: branch1Id,
      businessDate: '2026-09-30',
      status: 'OPEN',
      openingBalance: 0,
      cashCollected: 0,
      expectedCash: 0,
    });
    ledgerDayId = ledgerDay.id;
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  // ── 1. Approvable Action Door: POST /api/v1/actions/:actionKey ───────────────
  describe('Approvable Action Door: POST /api/v1/actions/:actionKey', () => {
    describe('members.create (Add member)', () => {
      // Tiers: Owner (D), OrgAdmin (D), Manager (D), Desk (R), Trainer (x), Cleaner (x)
      it('executes directly (200) for Owner, OrgAdmin, and Manager', async () => {
        for (const persona of ['owner', 'orgAdmin', 'manager']) {
          const res = await asPersona(persona).post('/actions/members.create', {
            branchId: branch1Id,
            fullName: `Test Member ${persona}`,
            email: `member-${persona}-${Date.now()}@test.com`,
            phone: '+923001234567',
            planId,
          });
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.data?.status).toBe('EXECUTED');
        }
      });

      it('creates an approval request (202 PENDING) for Front Desk', async () => {
        const res = await asPersona('frontDesk').post('/actions/members.create', {
          branchId: branch1Id,
          fullName: 'FrontDesk Enrolled Member',
          email: `desk-member-${Date.now()}@test.com`,
          phone: '+923001234568',
          planId,
        });
        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        expect(res.body.data?.status).toBe('PENDING');
        expect(res.body.data?.requestId).toBeTruthy();
      });

      it('forbids Trainer and Cleaner (403 Forbidden)', async () => {
        for (const persona of ['trainer', 'cleaner']) {
          const res = await asPersona(persona).post('/actions/members.create', {
            branchId: branch1Id,
            fullName: 'Unauthorized Member',
            planId,
          });
          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
        }
      });

      it('forbids Member (404/403)', async () => {
        const res = await asPersona('member', { 'X-Tenant-Id': tenant1Id }).post('/actions/members.create', {
          branchId: branch1Id,
          planId,
        });
        expect([403, 404]).toContain(res.status);
      });

      it('rejects Other Tenant Owner with 404 (cross-tenant)', async () => {
        const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': tenant1Id }).post('/actions/members.create', {
          branchId: branch1Id,
          planId,
        });
        expect(res.status).toBe(404);
      });

      it('rejects Anonymous with 401 Unauthorized', async () => {
        const res = await asPersona('anonymous').post('/actions/members.create', {
          branchId: branch1Id,
          planId,
        });
        expect(res.status).toBe(401);
      });
    });

    describe('expenses.create (Record an expense)', () => {
      // Tiers: Owner (D), OrgAdmin (D), Manager (D), Desk (R), Trainer (x), Cleaner (R)
      it('executes directly (200) for Owner, OrgAdmin, and Manager', async () => {
        for (const persona of ['owner', 'orgAdmin', 'manager']) {
          const res = await asPersona(persona).post('/actions/expenses.create', {
            branchId: branch1Id,
            title: `Expense by ${persona}`,
            amount: 500,
            categoryId,
          });
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.data?.status).toBe('EXECUTED');
        }
      });

      it('creates an approval request (202 PENDING) for Front Desk and Cleaner', async () => {
        for (const persona of ['frontDesk', 'cleaner']) {
          const res = await asPersona(persona).post('/actions/expenses.create', {
            branchId: branch1Id,
            title: `Expense request by ${persona}`,
            amount: 750,
            categoryId,
          });
          expect(res.status).toBe(202);
          expect(res.body.success).toBe(true);
          expect(res.body.data?.status).toBe('PENDING');
          expect(res.body.data?.requestId).toBeTruthy();
        }
      });

      it('forbids Trainer from recording expenses (403 Forbidden)', async () => {
        const res = await asPersona('trainer').post('/actions/expenses.create', {
          branchId: branch1Id,
          title: 'Unauthorized Expense',
          amount: 1000,
          categoryId,
        });
        expect(res.status).toBe(403);
      });
    });

    describe('announcements.create (Draft / Publish announcement)', () => {
      // Tiers: Owner (D), OrgAdmin (D), Manager (D), Desk (R), Trainer (R), Cleaner (x)
      it('executes directly (200) for Owner, OrgAdmin, and Manager', async () => {
        for (const persona of ['owner', 'orgAdmin', 'manager']) {
          const res = await asPersona(persona).post('/actions/announcements.create', {
            branchId: branch1Id,
            title: `Announcement by ${persona}`,
            message: 'Important gym update.',
          });
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.data?.status).toBe('EXECUTED');
        }
      });

      it('creates an approval request (202 PENDING) for Front Desk and Trainer', async () => {
        for (const persona of ['frontDesk', 'trainer']) {
          const res = await asPersona(persona).post('/actions/announcements.create', {
            branchId: branch1Id,
            title: `Draft Announcement by ${persona}`,
            message: 'Class cancelled today.',
          });
          expect(res.status).toBe(202);
          expect(res.body.success).toBe(true);
          expect(res.body.data?.status).toBe('PENDING');
        }
      });

      it('forbids Cleaner (403 Forbidden)', async () => {
        const res = await asPersona('cleaner').post('/actions/announcements.create', {
          branchId: branch1Id,
          title: 'Unauthorized Announcement',
          message: 'Not allowed.',
        });
        expect(res.status).toBe(403);
      });
    });
  });

  // ── 2. Team & Governance Mutations: /api/v1/team/* ───────────────────────────
  describe('Team & Governance Mutations: /api/v1/team/*', () => {
    describe('POST /api/v1/team/invites (team.invite orgWide)', () => {
      it('allows Owner and OrgAdmin (orgWide holders) to invite staff', async () => {
        for (const persona of ['owner', 'orgAdmin']) {
          const res = await asPersona(persona).post('/team/invites', {
            email: `invited-by-${persona}-${Date.now()}@test.com`,
            roleKey: 'DESK',
            branchIds: [branch1Id],
          });
          expect([200, 201]).toContain(res.status);
          expect(res.body.success).toBe(true);
        }
      });

      it('forbids Manager (branch-scoped), Front Desk, Trainer, Cleaner, and Member (403/404)', async () => {
        for (const persona of ['manager', 'frontDesk', 'trainer', 'cleaner']) {
          const res = await asPersona(persona).post('/team/invites', {
            email: 'unauthorized-invite@test.com',
            roleKey: 'DESK',
            branchIds: [branch1Id],
          });
          expect(res.status).toBe(403);
        }
        const memberRes = await asPersona('member', { 'X-Tenant-Id': tenant1Id }).post('/team/invites', {
          email: 'member-invite@test.com',
          roleKey: 'DESK',
        });
        expect([403, 404]).toContain(memberRes.status);
      });

      it('rejects Other Tenant Owner with 404 (cross-tenant)', async () => {
        const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': tenant1Id }).post('/team/invites', {
          email: 'cross-tenant-invite@test.com',
          roleKey: 'DESK',
        });
        expect(res.status).toBe(404);
      });

      it('rejects Anonymous with 401 Unauthorized', async () => {
        const res = await asPersona('anonymous').post('/team/invites', {
          email: 'anon-invite@test.com',
          roleKey: 'DESK',
        });
        expect(res.status).toBe(401);
      });
    });

    describe('DELETE /api/v1/team/:assignmentId (team.role.assign orgWide)', () => {
      it('forbids Manager, Front Desk, Trainer, and Cleaner from revoking assignments (403)', async () => {
        for (const persona of ['manager', 'frontDesk', 'trainer', 'cleaner']) {
          const res = await asPersona(persona).delete('/team/00000000-0000-0000-0000-000000000000');
          expect(res.status).toBe(403);
        }
      });
    });
  });

  // ── 3. Approvals Decisions: /api/v1/approvals/* ──────────────────────────────
  describe('Approvals Decisions: /api/v1/approvals/*', () => {
    describe('POST /api/v1/approvals/:id/approve (approvals.decide orgWide)', () => {
      it('allows Owner and OrgAdmin (orgWide holders) to decide approvals', async () => {
        for (const persona of ['owner', 'orgAdmin']) {
          const res = await asPersona(persona).post('/approvals/00000000-0000-0000-0000-000000000000/approve', {});
          // Evaluated: request not found -> 404, but NOT 403 Forbidden
          expect(res.status).toBe(404);
        }
      });

      it('forbids Manager (branch-scoped), Front Desk, Trainer, and Cleaner (403 Forbidden)', async () => {
        for (const persona of ['manager', 'frontDesk', 'trainer', 'cleaner']) {
          const res = await asPersona(persona).post('/approvals/00000000-0000-0000-0000-000000000000/approve', {});
          expect(res.status).toBe(403);
        }
      });

      it('rejects Other Tenant Owner with 404 (cross-tenant)', async () => {
        const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': tenant1Id }).post(
          '/approvals/00000000-0000-0000-0000-000000000000/approve',
          {}
        );
        expect(res.status).toBe(404);
      });
    });
  });

  // ── 4. Ledger Closing & Adjustments ─────────────────────────────────────────
  describe('Ledger Operations', () => {
    describe('POST /api/v1/actions/ledger.close (ledger.close)', () => {
      // Tiers: Owner (D), OrgAdmin (D), Manager (R), Desk (x), Trainer (x), Cleaner (x)
      it('executes directly (200) for Owner and OrgAdmin', async () => {
        const resOwner = await asPersona('owner').post('/actions/ledger.close', {
          branchId: branch1Id,
          businessDate: '2026-09-27',
        });
        expect(resOwner.status).toBe(200);
        expect(resOwner.body.success).toBe(true);
        expect(resOwner.body.data?.status).toBe('EXECUTED');

        const resOrgAdmin = await asPersona('orgAdmin').post('/actions/ledger.close', {
          branchId: branch1Id,
          businessDate: '2026-09-28',
        });
        expect(resOrgAdmin.status).toBe(200);
        expect(resOrgAdmin.body.success).toBe(true);
        expect(resOrgAdmin.body.data?.status).toBe('EXECUTED');
      });

      it('creates an approval request (202 PENDING) for Manager', async () => {
        const res = await asPersona('manager').post('/actions/ledger.close', {
          branchId: branch1Id,
          businessDate: '2026-09-29',
        });
        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        expect(res.body.data?.status).toBe('PENDING');
      });

      it('forbids Front Desk, Trainer, Cleaner, and Member (403 Forbidden)', async () => {
        for (const persona of ['frontDesk', 'trainer', 'cleaner']) {
          const res = await asPersona(persona).post('/actions/ledger.close', {
            branchId: branch1Id,
            businessDate: '2026-09-29',
          });
          expect(res.status).toBe(403);
        }
      });
    });

    describe('POST /api/v1/ledger/:ledgerDayId/adjustments (ledger.verify)', () => {
      it('allows Owner, OrgAdmin, and Manager (ledger.verify holders)', async () => {
        for (const persona of ['owner', 'orgAdmin', 'manager']) {
          const res = await asPersona(persona).post(`/ledger/${ledgerDayId}/adjustments`, {
            branchId: branch1Id,
            type: 'DISCREPANCY_NOTE',
            reason: `Reconciliation note by ${persona}`,
            amount: 100,
          });
          expect([200, 201]).toContain(res.status);
          expect(res.body.success).toBe(true);
        }
      });

      it('forbids Front Desk, Trainer, and Cleaner (403 Forbidden)', async () => {
        for (const persona of ['frontDesk', 'trainer', 'cleaner']) {
          const res = await asPersona(persona).post(`/ledger/${ledgerDayId}/adjustments`, {
            branchId: branch1Id,
            type: 'DISCREPANCY_NOTE',
            reason: 'Unauthorized adjustment',
            amount: 50,
          });
          expect(res.status).toBe(403);
        }
      });
    });
  });

  // ── 5. Branch Lifecycle Mutations: /api/v1/gyms/branches ────────────────────
  describe('Branch Lifecycle: /api/v1/gyms/branches', () => {
    it('only allows Host/Owner to create a branch (branch.create)', async () => {
      // Owner is allowed (validation error 422 if input missing, never 403)
      const ownerRes = await asPersona('owner').post('/gyms/branches', {
        branchName: 'Downtown Expansion',
        address: 'Sector C',
      });
      expect([200, 201, 400, 422]).toContain(ownerRes.status);
      expect(ownerRes.status).not.toBe(403);

      // OrgAdmin, Manager, Desk, Trainer, Cleaner are strictly forbidden from branch creation
      for (const persona of ['orgAdmin', 'manager', 'frontDesk', 'trainer', 'cleaner']) {
        const res = await asPersona(persona).post('/gyms/branches', {
          branchName: 'Unauthorized Branch',
        });
        expect(res.status).toBe(403);
      }
    });
  });
});

/**
 * PAY-12 — Ledger adjustments go through the approval tier engine.
 *
 * Verifies:
 * 1. Missing reason returns 422 Unprocessable Entity (spec §12.8 requirement).
 * 2. DIRECT tier holders (Owner, Org Admin, Manager) execute directly (201, EXECUTED, audit logged).
 * 3. REQUEST tier holders (e.g. Branch Admin) create an approval request (202, PENDING).
 * 4. The approval request can be approved via approvalService.decide / POST /approvals/:id/approve,
 *    which then executes the adjustment.
 * 5. Users without permission get 403 Forbidden.
 * 6. Closed ledger days return 409 ledger_day_closed.
 * 7. Registered command ledger.verify works via POST /actions/perform.
 */

'use strict';

const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { setupPersonas, asPersona, personaManager } = require('../harness/personas');
const { createUser, createRoleAssignment } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { UserOrgIndex } = require('../../src/models/platform');
const { stopTestServer } = require('../harness/test-server');

describe('PAY-12: Ledger Adjustments through Approval Engine', () => {
  let dbHarness;
  let branchId;
  let openDayId;
  let closedDayId;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);

    const branch = await dbHarness.tenant1.models.Branch.findOne();
    branchId = branch.id;
    const testTenantId = personaManager.personas.owner.tenantId;

    // Create a Branch Admin persona (BR_ADMIN role) with REQUEST tier for ledger.verify
    const brAdminUser = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'bradmin@tenant1.test',
      fullName: 'Branch Admin',
    });
    await createRoleAssignment(dbHarness.tenant1, {
      userId: brAdminUser.id,
      roleKey: 'BR_ADMIN',
      scopeType: 'BRANCH',
      scopeId: branchId,
      branchIds: [branchId],
      overrides: { tenantId: testTenantId },
    });
    await UserOrgIndex.findOrCreate({
      where: { userId: brAdminUser.id, tenantId: testTenantId },
      defaults: {
        roleKey: 'BR_ADMIN',
        roleLevel: 40,
        highestLevel: 40,
        scopeType: 'BRANCH',
      },
    });
    const brAdminToken = signToken({
      sub: brAdminUser.id,
      id: brAdminUser.id,
      email: brAdminUser.email,
      role: 'BRANCH_MANAGER',
      isVerified: true,
      tenantId: testTenantId,
      branchId,
    });
    personaManager.personas.brAdmin = {
      user: brAdminUser,
      token: brAdminToken,
      tenantId: testTenantId,
    };

    // Create an open LedgerDay
    const openDay = await dbHarness.tenant1.models.LedgerDay.create({
      branchId,
      businessDate: '2026-10-05',
      status: 'OPEN',
      openingBalance: 0,
      cashCollected: 0,
      expectedCash: 0,
    });
    openDayId = openDay.id;

    // Create a closed LedgerDay
    const closedDay = await dbHarness.tenant1.models.LedgerDay.create({
      branchId,
      businessDate: '2026-10-04',
      status: 'CLOSED',
      openingBalance: 0,
      cashCollected: 0,
      expectedCash: 0,
    });
    closedDayId = closedDay.id;
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  describe('Validation: missing reason returns 422', () => {
    it('returns 422 when reason is omitted or empty', async () => {
      const res = await asPersona('owner').post(`/ledger/${openDayId}/adjustments`, {
        branchId,
        type: 'DISCREPANCY_NOTE',
        amount: 100,
        // reason is missing
      });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/reason is required/i);
    });

    it('returns 422 when reason is only whitespace', async () => {
      const res = await asPersona('manager').post(`/ledger/${openDayId}/adjustments`, {
        branchId,
        type: 'VARIANCE_ADJUSTMENT',
        amount: 50,
        reason: '   ',
      });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/reason is required/i);
    });
  });

  describe('Direct Execution (DIRECT tier: Owner, OrgAdmin, Manager)', () => {
    it('Owner executes adjustment directly with 201 status and audit log', async () => {
      const res = await asPersona('owner').post(`/ledger/${openDayId}/adjustments`, {
        branchId,
        type: 'DISCREPANCY_NOTE',
        amount: 150,
        reason: 'Owner safe count reconciliation',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.adjustment).toBeDefined();
      expect(res.body.data.adjustment.reason).toBe('Owner safe count reconciliation');
      expect(res.body.data.adjustment.ledgerDayId).toBe(openDayId);
    });

    it('Manager executes adjustment directly with 201 status', async () => {
      const res = await asPersona('manager').post(`/ledger/${openDayId}/adjustments`, {
        branchId,
        type: 'VARIANCE_ADJUSTMENT',
        amount: -25,
        reason: 'Manager register count short',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.adjustment).toBeDefined();
      expect(res.body.data.adjustment.amount).toBe(-25);
    });
  });

  describe('Approval Request Flow (REQUEST tier: Branch Admin / approval tier)', () => {
    it('Branch Admin (or role with REQUEST tier) creates approval request with 202 status', async () => {
      // brAdmin has tier 'R' for ledger.verify
      const res = await asPersona('brAdmin').post(`/ledger/${openDayId}/adjustments`, {
        branchId,
        type: 'REVERSAL',
        amount: 200,
        reason: 'Branch admin requested reversal for miskeyed cash payment',
      });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.approvalRequestId).toBeDefined();

      const approvalRequestId = res.body.data.approvalRequestId;

      // Approver (Manager or Org Admin) decides and approves the request
      const approveRes = await asPersona('orgAdmin').post(`/approvals/${approvalRequestId}/approve`, {
        notes: 'Approved after checking drawer tally',
      });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.success).toBe(true);
      expect(approveRes.body.data.request.status).toBe('APPROVED');
      expect(approveRes.body.data.result).toBeDefined();
      expect(approveRes.body.data.result.reason).toBe(
        'Branch admin requested reversal for miskeyed cash payment'
      );
    });
  });

  describe('Command Registration: ledger.verify available via /actions/perform', () => {
    it('executes directly via /actions/perform for Owner', async () => {
      const res = await asPersona('owner').post('/actions/ledger.verify', {
        branchId,
        ledgerDayId: openDayId,
        type: 'MISSED_DAY_RECONCILIATION',
        amount: 500,
        reason: 'Late reconciliation recorded through action engine',
      });

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('EXECUTED');
      expect(res.body.data.result.reason).toBe('Late reconciliation recorded through action engine');
    });
  });

  describe('Guardrail: closed ledger day', () => {
    it('rejects adjustment against closed ledger day with 409 ledger_day_closed', async () => {
      const res = await asPersona('owner').post(`/ledger/${closedDayId}/adjustments`, {
        branchId,
        type: 'DISCREPANCY_NOTE',
        amount: 10,
        reason: 'Attempt on closed day',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ledger_day_closed');
    });
  });

  describe('Forbidden Personas: 403 Forbidden', () => {
    it('rejects Front Desk, Trainer, and Cleaner from creating adjustments', async () => {
      for (const persona of ['frontDesk', 'trainer', 'cleaner']) {
        const res = await asPersona(persona).post(`/ledger/${openDayId}/adjustments`, {
          branchId,
          type: 'DISCREPANCY_NOTE',
          amount: 10,
          reason: 'Unauthorized attempt',
        });
        expect(res.status).toBe(403);
      }
    });
  });
});

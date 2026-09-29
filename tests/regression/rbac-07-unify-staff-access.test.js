const fs = require('fs');
const path = require('path');
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const request = require('supertest');
const { User, Tenant } = require('../../src/models/platform');
const bcrypt = require('bcrypt');

describe('RBAC-07: Unify staff access through Team & Access', () => {
  describe('Source Code Guard: No access-granting writes or access reads outside team service', () => {
    const srcDir = path.resolve(__dirname, '../../src');

    function getAllJsFiles(dir) {
      const results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results.push(...getAllJsFiles(fullPath));
        } else if (file.endsWith('.js')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    test('All files outside team.service.js must not create RoleAssignment or AssignmentOverride directly', () => {
      const files = getAllJsFiles(srcDir);
      const violations = [];

      // Allowed files for RoleAssignment / AssignmentOverride creation:
      // team.service.js is the designated single authority
      // (seeders and offline backfill scripts are exempt from runtime scans)
      const allowedFiles = [
        path.resolve(srcDir, 'services/team.service.js'),
        path.resolve(srcDir, 'scripts/backfill-rbac.js'),
        path.resolve(srcDir, 'seeders/seed-tenant.js'),
      ];

      for (const filePath of files) {
        if (allowedFiles.includes(filePath)) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          const trimmed = line.trim();

          // 1. Direct RoleAssignment.create / bulkCreate
          if (
            /(?:models\.)?RoleAssignment\.(?:create|bulkCreate|upsert)\s*\(/.test(trimmed) &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
          ) {
            violations.push(`${filePath}:${lineNum} - Direct RoleAssignment write: "${trimmed}"`);
          }

          // 2. Direct AssignmentOverride.create / bulkCreate
          if (
            /(?:models\.)?AssignmentOverride\.(?:create|bulkCreate|upsert)\s*\(/.test(trimmed) &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
          ) {
            violations.push(`${filePath}:${lineNum} - Direct AssignmentOverride write: "${trimmed}"`);
          }
        });
      }

      expect(violations).toEqual([]);
    });

    test('No controller or middleware may read GymStaff for access / permission authorization', () => {
      const files = getAllJsFiles(srcDir);
      const violations = [];

      for (const filePath of files) {
        // Only inspect controllers, middleware, and routes
        if (!filePath.includes('/controllers/') && !filePath.includes('/middleware/') && !filePath.includes('/routes/')) {
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          const trimmed = line.trim();

          // Flag queries checking GymStaff for designation === 'admin'
          if (
            /designation.*(?:admin|manager)/i.test(trimmed) &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
          ) {
            violations.push(`${filePath}:${lineNum} - GymStaff designation read for access: "${trimmed}"`);
          }
        });
      }

      expect(violations).toEqual([]);
    });
  });

  describe('Behavioral Guard: RoleAssignment is the single source of truth for access', () => {
    let dbHarness;
    let tenantId;
    let personas;
    let appServer;
    let branchId;

    beforeAll(async () => {
      dbHarness = await setupTestDatabases();
      personas = await setupPersonas(dbHarness);
      tenantId = personas.owner.tenantId;
      appServer = await startTestServer();

      const { Branch } = dbHarness.tenant1.models;
      const branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
      branchId = branch.id;
    });

    afterAll(async () => {
      await teardownTestDatabases();
    });

    test('A user with GymStaff row but NO RoleAssignment receives 403 on protected endpoints and isStaff: false', async () => {
      // Create user with NO role assignments
      const passwordHash = await bcrypt.hash('Secret123!', 10);
      const orphanStaffUser = await User.create({
        fullName: 'Orphan GymStaff User',
        email: 'orphan.staff@example.test',
        passwordHash,
        role: 'MEMBER',
        status: 'ACTIVE',
        isVerified: true,
      });

      // Insert GymStaff record directly (HR only)
      const { GymStaff } = dbHarness.tenant1.models;
      await GymStaff.create({
        userId: orphanStaffUser.id,
        email: orphanStaffUser.email,
        branchId,
        designation: 'admin',
        employmentStatus: 'ACTIVE',
        status: 'active',
      });

      // Login as orphan staff user
      const loginRes = await request(appServer)
        .post('/api/v1/auth/login')
        .send({ email: 'orphan.staff@example.test', password: 'Secret123!' });

      expect(loginRes.status).toBe(200);
      const token = loginRes.body.data.accessToken;

      // 1. GET /me/staff-status must return isStaff: false and empty branches
      const statusRes = await request(appServer)
        .get('/api/v1/me/staff-status')
        .set('Authorization', `Bearer ${token}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.isStaff).toBe(false);
      expect(statusRes.body.data.branches).toEqual([]);

      // 2. Access to payments recording must be 403
      const paymentRes = await request(appServer)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', tenantId)
        .send({
          branchId,
          userId: personas.member.user.id,
          amount: 1000,
          method: 'CASH',
        });

      expect([401, 403, 404]).toContain(paymentRes.status);

      // 3. Access to staff action requests must be 403
      const actionRes = await request(appServer)
        .post(`/api/v1/staff/branches/${branchId}/action-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          actionType: 'add_member',
          payload: { fullName: 'New Member' },
        });

      expect([401, 403]).toContain(actionRes.status);
    });

    test('Creating staff via legacy POST /gyms/staff creates RoleAssignment and keeps User role as MEMBER', async () => {
      const email = 'legacy.create@example.test';
      const createRes = await asPersona('owner').post('/gyms/staff', {
        fullName: 'Legacy Staff Member',
        email,
        phone: '+923001112233',
        designation: 'Receptionist',
        branchIds: [branchId],
        assignToAllBranches: false,
      });

      expect([200, 201]).toContain(createRes.status);
      expect(createRes.body.success).toBe(true);

      // Verify User platform role is MEMBER, not modified to BRANCH_MANAGER
      const user = await User.findOne({ where: { email } });
      expect(user).not.toBeNull();
      expect(user.role).toBe('MEMBER');

      // Verify RoleAssignment was created in tenantDb
      const { RoleAssignment, RoleAssignmentBranch } = dbHarness.tenant1.models;
      const assignment = await RoleAssignment.findOne({
        where: { userId: user.id, status: 'ACTIVE' },
        include: [{ model: RoleAssignmentBranch, as: 'branchLinks' }],
      });

      expect(assignment).not.toBeNull();
      expect(assignment.roleKey).toBe('DESK');
      expect(assignment.branchLinks.map((b) => b.branchId)).toContain(branchId);
    });

    test('Removing staff via legacy DELETE /gyms/staff/:userId revokes RoleAssignment and revokes access', async () => {
      // First, find the user created in previous test
      const email = 'legacy.create@example.test';
      const user = await User.findOne({ where: { email } });
      expect(user).not.toBeNull();

      // Delete via legacy endpoint
      const delRes = await asPersona('owner').delete(`/gyms/staff/${user.id}`);
      expect(delRes.status).toBe(200);

      // Verify RoleAssignment in tenantDb is REVOKED
      const { RoleAssignment } = dbHarness.tenant1.models;
      const assignment = await RoleAssignment.findOne({ where: { userId: user.id } });
      expect(assignment).not.toBeNull();
      expect(assignment.status).toBe('REVOKED');

      // Attempting to access staff-status returns isStaff: false
      // Login as this user
      const loginRes = await request(appServer)
        .post('/api/v1/auth/login')
        .send({ email, password: 'password123' }); // default password

      if (loginRes.status === 200 && loginRes.body.data?.accessToken) {
        const token = loginRes.body.data.accessToken;
        const statusRes = await request(appServer)
          .get('/api/v1/me/staff-status')
          .set('Authorization', `Bearer ${token}`);
        expect(statusRes.body.data.isStaff).toBe(false);
      }
    });

    test('Deleting a branch cascades revocation to branch-scoped RoleAssignments (RBAC-09)', async () => {
      const { RoleAssignment, RoleAssignmentBranch } = dbHarness.tenant1.models;
      const gymService = require('../../src/services/gym.service');

      // Create a test branch using factories
      const branch2 = await factories.createBranch(dbHarness.tenant1, tenantId, {
        branchName: 'Branch To Delete For RBAC',
      });

      // Create a user and branch-scoped RoleAssignment
      const staffUser = await User.create({
        fullName: 'Branch Staff To Revoke',
        email: 'branch.revoke@example.test',
        passwordHash: 'hash',
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      const assignment = await RoleAssignment.create({
        userId: staffUser.id,
        email: staffUser.email,
        roleKey: 'DESK',
        roleLevel: 20,
        scopeType: 'BRANCH',
        status: 'ACTIVE',
      });

      await RoleAssignmentBranch.create({
        assignmentId: assignment.id,
        branchId: branch2.id,
      });

      // Call deleteBranch with confirmOrganizationDeletion = true
      await gymService.deleteBranch(dbHarness.tenant1, branch2.id, null, { confirmOrganizationDeletion: true });

      // Verify RoleAssignment is REVOKED with revokedBy: 'system:branch_deleted'
      await assignment.reload();
      expect(assignment.status).toBe('REVOKED');
      expect(assignment.revokedBy).toBe('system:branch_deleted');
    });
  });
});

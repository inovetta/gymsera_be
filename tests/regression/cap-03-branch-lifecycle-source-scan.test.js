const fs = require('fs');
const path = require('path');
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');
const adminService = require('../../src/services/admin.service');
const gymService = require('../../src/services/gym.service');
const { TenantSubscription, GymListing } = require('../../src/models/platform');

describe('CAP-03: Branch Lifecycle and Source Scan Guard', () => {
  describe('Source Code Guard: No direct Branch creation or status writes outside gym.service', () => {
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

    test('All files outside gym.service.js must not call Branch.create or mutate Branch status directly', () => {
      const files = getAllJsFiles(srcDir);
      const violations = [];

      // Allowed files: gym.service.js is the designated branch lifecycle authority
      const allowedFiles = [
        path.resolve(srcDir, 'services/gym.service.js'),
      ];

      for (const filePath of files) {
        if (allowedFiles.includes(filePath)) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          const trimmed = line.trim();

          // 1. Direct Branch.create / models.Branch.create
          if (
            /(?:\bmodels\.)?\bBranch\.create\s*\(/.test(trimmed) &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
          ) {
            violations.push(`${filePath}:${lineNum} - Direct Branch.create call: "${trimmed}"`);
          }

          // 2. Direct branch.update({ status: ... }) or Branch.update({ status: ... })
          if (
            /(?:models\.)?(?:[bB]ranch)\.update\s*\([^)]*status\s*:/i.test(trimmed) &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
          ) {
            violations.push(`${filePath}:${lineNum} - Direct status update on Branch: "${trimmed}"`);
          }

          // 3. Direct branch.status = '...' assignment
          if (
            /\bbranch\.status\s*=\s*['"][A-Z]+['"]/.test(trimmed) &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
          ) {
            violations.push(`${filePath}:${lineNum} - Direct branch.status assignment: "${trimmed}"`);
          }
        });
      }

      if (violations.length > 0) {
        console.error('CAP-03 Source Violations Found:\n' + violations.join('\n'));
      }
      expect(violations).toEqual([]);
    });
  });

  describe('Lifecycle Enforcement: createAdminTenantBranch and createListing', () => {
    let dbHarness;
    let tenantId;
    let personas;

    beforeAll(async () => {
      dbHarness = await setupTestDatabases();
      personas = await setupPersonas(dbHarness);
      tenantId = personas.owner.tenantId;
    });

    afterAll(async () => {
      await teardownTestDatabases();
    });

    test('createAdminTenantBranch enforces subscription capacity via createBranch', async () => {
      // Set platform subscription branchCount to 1, currently 1 active branch
      let sub = await TenantSubscription.findOne({ where: { tenantId } });
      if (sub) {
        await sub.update({ branchCount: 1 });
      } else {
        await factories.createTenantSubscription(tenantId, { branchCount: 1, status: 'ACTIVE' });
      }

      // Attempting to create a 2nd branch via adminService.createAdminTenantBranch should throw 403 / capacity exceeded
      await expect(
        adminService.createAdminTenantBranch(tenantId, {
          branchName: 'Admin Branch Over Capacity',
          address: '123 Test St',
        }, personas.platformAdmin.user.id)
      ).rejects.toThrow('Branch limit reached');
    });

    test('createListing with branchSource: new consumes capacity or donor slots via createBranch', async () => {
      let sub = await TenantSubscription.findOne({ where: { tenantId } });
      if (sub) {
        await sub.update({ branchCount: 2 });
      } else {
        await factories.createTenantSubscription(tenantId, { branchCount: 2, status: 'ACTIVE' });
      }

      // Host creates listing with branchSource: 'new'
      const res = await asPersona('owner').post('/host/listings', {
        gymName: 'Host Created New Org',
        branchSource: 'new',
        branchName: 'Host Created New Branch',
        address: '456 Host Ave',
        packages: [
          { name: 'Monthly Pass', price: 50, durationType: 'MONTHLY', durationValue: 1 }
        ],
      });

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);

      // Verify branch was created in tenantDb with ACTIVE status
      const { Branch } = dbHarness.tenant1.models;
      const branch = await Branch.findOne({ where: { branchName: 'Host Created New Org' } });
      expect(branch).not.toBeNull();
      expect(branch.status).toBe('ACTIVE');

      // Now at 2 active branches (capacity 2). Next attempt to create branchSource: 'new' without donor slot must fail
      const failRes = await asPersona('owner').post('/host/listings', {
        gymName: 'Listing Over Capacity',
        branchSource: 'new',
        branchName: 'Over Capacity Branch',
        address: '789 Fail Ave',
        packages: [
          { name: 'Monthly Pass', price: 50, durationType: 'MONTHLY', durationValue: 1 }
        ],
      });

      expect([400, 403]).toContain(failRes.status);
      expect(failRes.body.success).toBe(false);
    });
  });
});

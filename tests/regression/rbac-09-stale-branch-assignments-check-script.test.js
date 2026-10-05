/**
 * RBAC-09 — read-only check script for stale branch-scoped role assignments
 * (`gymsera-rbac09-stale-branch-assignments-check.js`).
 *
 * Verifies that the check script runs against a real migrated tenant schema,
 * correctly identifies:
 *   1. Orphan assignment (ACTIVE, scope_type BRANCH, 0 branch links)
 *   2. Dangling branch link (linked branch ID does not exist in branches)
 *   3. Inactive branch link (linked branch is INACTIVE)
 *   4. Partial stale link (linked to both active and inactive branches)
 * and leaves healthy assignments untouched, with ZERO writes to any database.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { Sequelize } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
  getAdminConnection,
  factories,
} = require('../harness');
const { Tenant } = require('../../src/models/platform');
const registerTenantModels = require('../../src/models/tenant');
const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { encrypt } = require('../../src/utils/crypto.utils');

const SCRATCH_DB = 'gymsera_test_rbac09_check';

describe('gymsera-rbac09-stale-branch-assignments-check.js', () => {
  let adminConn;
  let tenantSequelize;
  let testTenant;
  let models;

  // Stored IDs for assertions
  let orphanRaId;
  let danglingRaId;
  let inactiveRaId;
  let partialRaId;
  let healthyRaId;
  let activeBranchId;
  let inactiveBranchId;

  beforeAll(async () => {
    await setupTestDatabases();
    adminConn = await getAdminConnection();

    // 1. Create dedicated test tenant database
    await adminConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    const testPort = process.env.PLATFORM_DB_PORT || '3308';
    const dbHost = process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || 'localhost';
    const dbUser = process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || 'root';
    const dbPass =
      process.env.PLATFORM_TEST_DB_PASS !== undefined
        ? process.env.PLATFORM_TEST_DB_PASS
        : process.env.PLATFORM_DB_PASS || '';

    tenantSequelize = new Sequelize(
      `mysql://${dbUser}:${dbPass}@${dbHost}:${testPort}/${SCRATCH_DB}`,
      {
        dialect: 'mysql',
        logging: false,
        define: {
          underscored: true,
          timestamps: true,
          charset: 'utf8mb4',
          collate: 'utf8mb4_unicode_ci',
        },
      }
    );

    await tenantSequelize.authenticate();
    models = registerTenantModels(tenantSequelize);
    await tenantSequelize.sync({ force: true });
    await runTenantMigrations(tenantSequelize);

    // 2. Register tenant in platform DB with encrypted connection string
    const connStr = `mysql://${dbUser}:${dbPass}@${dbHost}:${testPort}/${SCRATCH_DB}`;
    testTenant = await factories.createTenant({
      businessName: 'RBAC09 Test Gym',
      tenantCode: 'RBAC09-CHK',
      status: 'ACTIVE',
      connectionStringEncrypted: encrypt(connStr),
      dbName: SCRATCH_DB,
    });

    // 3. Seed gym and branches
    const gymId = uuidv4();
    await models.Gym.create({
      id: gymId,
      name: 'Main Test Gym Org',
    });

    activeBranchId = uuidv4();
    inactiveBranchId = uuidv4();

    await models.Branch.create({
      id: activeBranchId,
      gymId,
      branchName: 'Main Active Branch',
      status: 'ACTIVE',
    });

    await models.Branch.create({
      id: inactiveBranchId,
      gymId,
      branchName: 'Closed Inactive Branch',
      status: 'INACTIVE',
    });

    // 4. Seed role assignments and branch links
    // Case 1: Orphan assignment (0 branch links)
    orphanRaId = uuidv4();
    await models.RoleAssignment.create({
      id: orphanRaId,
      userId: uuidv4(),
      email: 'orphan@gymsera.test',
      roleKey: 'BRANCH_MANAGER',
      roleLevel: 50,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
      version: 1,
    });

    // Case 2: Dangling branch link (points to non-existent branch)
    danglingRaId = uuidv4();
    const missingBranchId = uuidv4();
    await models.RoleAssignment.create({
      id: danglingRaId,
      userId: uuidv4(),
      email: 'dangling@gymsera.test',
      roleKey: 'COACH',
      roleLevel: 30,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
      version: 1,
    });
    await models.RoleAssignmentBranch.create({
      id: uuidv4(),
      assignmentId: danglingRaId,
      branchId: missingBranchId,
    });

    // Case 3: Inactive branch link (points to INACTIVE branch only)
    inactiveRaId = uuidv4();
    await models.RoleAssignment.create({
      id: inactiveRaId,
      userId: uuidv4(),
      email: 'inactive@gymsera.test',
      roleKey: 'FRONT_DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
      version: 1,
    });
    await models.RoleAssignmentBranch.create({
      id: uuidv4(),
      assignmentId: inactiveRaId,
      branchId: inactiveBranchId,
    });

    // Case 4: Partial stale link (points to both active and inactive branches)
    partialRaId = uuidv4();
    await models.RoleAssignment.create({
      id: partialRaId,
      userId: uuidv4(),
      email: 'partial@gymsera.test',
      roleKey: 'TRAINER',
      roleLevel: 25,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
      version: 1,
    });
    await models.RoleAssignmentBranch.create({
      id: uuidv4(),
      assignmentId: partialRaId,
      branchId: activeBranchId,
    });
    await models.RoleAssignmentBranch.create({
      id: uuidv4(),
      assignmentId: partialRaId,
      branchId: inactiveBranchId,
    });

    // Case 5: Healthy assignment (points only to active branch)
    healthyRaId = uuidv4();
    await models.RoleAssignment.create({
      id: healthyRaId,
      userId: uuidv4(),
      email: 'healthy@gymsera.test',
      roleKey: 'BRANCH_MANAGER',
      roleLevel: 50,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
      version: 1,
    });
    await models.RoleAssignmentBranch.create({
      id: uuidv4(),
      assignmentId: healthyRaId,
      branchId: activeBranchId,
    });
  });

  afterAll(async () => {
    if (tenantSequelize) {
      await tenantSequelize.close().catch(() => {});
    }
    if (adminConn) {
      await adminConn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    }
    await teardownTestDatabases();
  });

  test('runs against migrated schema, identifies stale assignments, leaves zero writes', async () => {
    // Snapshot state before check script runs
    const snapshot = async () =>
      JSON.stringify({
        tenants: await Tenant.findAll({ order: [['id', 'ASC']], raw: true }),
        roleAssignments: await models.RoleAssignment.findAll({
          order: [['id', 'ASC']],
          raw: true,
        }),
        rabLinks: await models.RoleAssignmentBranch.findAll({
          order: [['id', 'ASC']],
          raw: true,
        }),
        branches: await models.Branch.findAll({ order: [['id', 'ASC']], raw: true }),
      });

    const beforeState = await snapshot();

    const root = path.join(__dirname, '..', '..');
    const res = spawnSync(
      process.execPath,
      ['-r', path.join(root, 'tests', 'harness', 'no-network.js'), 'gymsera-rbac09-stale-branch-assignments-check.js'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CHK_HOST:
            process.env.PLATFORM_TEST_DB_HOST ||
            process.env.PLATFORM_DB_HOST ||
            process.env.MYSQL_HOST ||
            '127.0.0.1',
          CHK_PORT: String(process.env.PLATFORM_DB_PORT || '3308'),
          CHK_USER:
            process.env.PLATFORM_TEST_DB_USER ||
            process.env.PLATFORM_DB_USER ||
            process.env.MYSQL_USER ||
            'root',
          CHK_PASSWORD:
            process.env.PLATFORM_TEST_DB_PASS !== undefined
              ? process.env.PLATFORM_TEST_DB_PASS
              : process.env.PLATFORM_DB_PASS || '',
          CHK_PLATFORM_DB: process.env.PLATFORM_DB_NAME || 'gymsera_test_platform',
          CHK_TENANTS: SCRATCH_DB,
        },
      }
    );

    // Prove zero writes
    const afterState = await snapshot();
    expect(afterState).toBe(beforeState);

    // Expect findings detected -> exit code 1
    expect(res.status).toBe(1);

    // Verify stdout reports all 4 defect conditions
    expect(res.stdout).toContain('Stale assignments / links found:   4');
    expect(res.stdout).toContain(`Assignment ID: ${orphanRaId}`);
    expect(res.stdout).toContain('Defect:  ORPHAN_NO_BRANCH_LINKS');
    expect(res.stdout).toContain('Verdict: STALE_ASSIGNMENT_NEEDS_REVOCATION');

    expect(res.stdout).toContain(`Assignment ID: ${danglingRaId}`);
    expect(res.stdout).toContain('Defect:  DANGLING_BRANCH_LINK');
    expect(res.stdout).toContain('Verdict: STALE_ASSIGNMENT_NEEDS_REVOCATION');

    expect(res.stdout).toContain(`Assignment ID: ${inactiveRaId}`);
    expect(res.stdout).toContain('Defect:  INACTIVE_BRANCH_INACTIVE');
    expect(res.stdout).toContain('Verdict: STALE_ASSIGNMENT_NEEDS_REVOCATION');

    expect(res.stdout).toContain(`Assignment ID: ${partialRaId}`);
    expect(res.stdout).toContain('Defect:  INACTIVE_BRANCH_INACTIVE');
    expect(res.stdout).toContain('Verdict: STALE_BRANCH_LINK_NEEDS_PRUNING');

    // Healthy assignment should NOT be reported
    expect(res.stdout).not.toContain(`Assignment ID: ${healthyRaId}`);
  });
});

/**
 * FLOW-02 — Tenant provisioning is resumable and idempotent (spec §12.3, §11.3).
 *
 * Approval runs six recorded steps on the Tenant row
 *   DB_CREATED → MODELS_SYNCED → LISTING_CREATED → BRANCH_CREATED → SUBSCRIPTION_LINKED → ACTIVE
 * under a lease lock, so:
 *   - a failure at any step leaves the tenant APPROVED with the last finished step recorded,
 *     and re-approving (Resume) or the daily sweep finishes it;
 *   - a crash after a step's work but before its step was recorded is redone without duplicates;
 *   - a second approve while one is running returns the in-progress state instead of running twice;
 *   - the approve endpoint takes an Idempotency-Key (REL-01 middleware).
 * After every path there is exactly one database, listing, gym, branch and subscription.
 *
 * Real provisioning into `gymsera_test_f02_*` databases on the local test MySQL (R-19).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const {
  City, Tenant, TenantSubscription, PlatformPackage, GymListing, CapacityEvent,
} = require('../../src/models/platform');
const provisioning = require('../../src/services/tenant-provisioning.service');
const adminService = require('../../src/services/admin.service');
const gymService = require('../../src/services/gym.service');

const STEPS = ['DB_CREATED', 'MODELS_SYNCED', 'LISTING_CREATED', 'BRANCH_CREATED', 'SUBSCRIPTION_LINKED', 'ACTIVE'];
const createdDbs = [];
let seq = 0;
let app;
let admin;
let adminToken;
let twoBranchPackage;
let mail;

beforeAll(async () => {
  await setupTestDatabases();
  mail = installMailFake();
  app = await startTestServer();
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
  admin = await factories.createUser({ email: 'admin-f02@gymsera.test', role: 'PLATFORM_ADMIN' });
  adminToken = signToken({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN', isVerified: true });
  // 2 branches: provisioning builds 1 and attributes 1 unbuilt slot (one CapacityEvent).
  twoBranchPackage = await PlatformPackage.create({
    name: 'F02 Two', price: 4000, billingCycle: 'MONTHLY', maxBranches: 2, maxOrganizations: 1, maxTrainers: 5, maxMembers: 500,
  });
});

afterEach(() => {
  if (provisioning.provisioningHooks) provisioning.provisioningHooks.onStep = null;
  jest.restoreAllMocks();
  mail = installMailFake(); // restoreAllMocks also removed the mail fake
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of createdDbs) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

/** A submitted application with no plan row yet (bank transfer): approval creates the plan. */
const pendingTenant = async (overrides = {}) => {
  seq += 1;
  const tenantCode = `test_f02_${Date.now().toString(36)}_${seq}`;
  createdDbs.push(`gymsera_${tenantCode}`);
  return factories.createTenant({
    tenantCode,
    status: 'PENDING_REVIEW',
    connectionStringEncrypted: null,
    selectedPackageId: twoBranchPackage.id,
    paymentMethod: 'BANK_TRANSFER',
    mainBranchDataJson: { name: 'Main', plans: [{ name: 'Monthly', price: 3000 }] },
    ...overrides,
  });
};

const tenantDbExists = async (tenant) => {
  const conn = await getAdminConnection();
  const [rows] = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [
    `gymsera_${tenant.tenantCode}`,
  ]);
  return rows.length === 1;
};

/** Everything provisioning creates, counted where it lives. */
const counts = async (tenant) => {
  const conn = await getAdminConnection();
  const db = `gymsera_${tenant.tenantCode}`;
  const one = async (sql) => {
    try {
      const [[row]] = await conn.query(sql);
      return Number(row.n);
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_DB_ERROR') return 0;
      throw err;
    }
  };
  return {
    databases: (await tenantDbExists(tenant)) ? 1 : 0,
    listings: await GymListing.count({ where: { tenantId: tenant.id } }),
    gyms: await one(`SELECT COUNT(*) AS n FROM \`${db}\`.gyms`),
    branches: await one(`SELECT COUNT(*) AS n FROM \`${db}\`.branches`),
    plans: await one(`SELECT COUNT(*) AS n FROM \`${db}\`.membership_plans`),
    subscriptions: await TenantSubscription.count({ where: { tenantId: tenant.id } }),
    capacityEvents: await CapacityEvent.count({ where: { tenantId: tenant.id } }),
  };
};

const EXACTLY_ONE = { databases: 1, listings: 1, gyms: 1, branches: 1, plans: 1, subscriptions: 1, capacityEvents: 1 };

const expectFullyProvisioned = async (tenant) => {
  await tenant.reload();
  expect(tenant.status).toBe('ACTIVE');
  expect(tenant.provisioningState).toBe('ACTIVE');
  expect(tenant.provisioningLockToken).toBeNull();
  expect(tenant.provisioningError).toBeNull();
  expect(tenant.connectionStringEncrypted).toBeTruthy();
  expect(await counts(tenant)).toEqual(EXACTLY_ONE);
  const listing = await GymListing.findOne({ where: { tenantId: tenant.id } });
  expect(listing.reservedSlots).toBe(1);
};

describe('FLOW-02: a failure at any step is resumed to exactly one of everything', () => {
  test.each(STEPS)('crash after the %s work, before the step is recorded → Resume finishes it', async (failStep) => {
    const tenant = await pendingTenant();
    provisioning.provisioningHooks.onStep = (step, phase) => {
      if (step === failStep && phase === 'after') throw new Error(`injected failure after ${step}`);
    };

    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });

    await tenant.reload();
    expect(tenant.status).toBe('APPROVED');
    const previous = STEPS.indexOf(failStep) === 0 ? 'REQUESTED' : STEPS[STEPS.indexOf(failStep) - 1];
    expect(tenant.provisioningState).toBe(previous);
    expect(tenant.provisioningError).toContain(`injected failure after ${failStep}`);
    expect(tenant.provisioningLockToken).toBeNull(); // released: Resume is possible at once

    provisioning.provisioningHooks.onStep = null;
    const result = await adminService.approveTenant(tenant.id, admin.id);
    expect(result.tenant.status).toBe('ACTIVE');
    expect(result.provisioning).toMatchObject({ state: 'ACTIVE', step: 6, totalSteps: 6, inProgress: false });
    await expectFullyProvisioned(tenant);
  });

  test('a failure before a step records the previous step; the admin summary shows "step n/6"', async () => {
    const tenant = await pendingTenant();
    provisioning.provisioningHooks.onStep = (step, phase) => {
      if (step === 'BRANCH_CREATED' && phase === 'before') throw new Error('injected before BRANCH_CREATED');
    };
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });

    const { tenant: view } = await adminService.getTenant(tenant.id);
    expect(view.provisioning).toMatchObject({
      state: 'LISTING_CREATED', step: 3, totalSteps: 6, inProgress: false, canResume: true,
    });
    expect(view.provisioning.lastError).toContain('injected before BRANCH_CREATED');
    expect(view.provisioningLockToken).toBeUndefined(); // the lock token never leaves the server

    provisioning.provisioningHooks.onStep = null;
    await adminService.approveTenant(tenant.id, admin.id);
    await expectFullyProvisioned(tenant);
  });

  test('a real failure inside a step (branch creation) resumes without a second gym or branch', async () => {
    const tenant = await pendingTenant();
    const spy = jest.spyOn(gymService, 'createBranch').mockImplementationOnce(async () => {
      throw new Error('branch insert timed out');
    });
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });
    await tenant.reload();
    expect(tenant.status).toBe('APPROVED');
    expect((await counts(tenant)).gyms).toBe(1); // the gym was created before the branch failed

    spy.mockRestore();
    await adminService.approveTenant(tenant.id, admin.id);
    await expectFullyProvisioned(tenant);
  });

  test('a failing listing insert stops provisioning instead of building a branch with no listing', async () => {
    const tenant = await pendingTenant();
    const spy = jest.spyOn(GymListing, 'create').mockRejectedValueOnce(new Error('listing insert failed'));
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });
    await tenant.reload();
    expect(tenant.status).toBe('APPROVED');
    expect((await counts(tenant)).branches).toBe(0);

    spy.mockRestore();
    await adminService.approveTenant(tenant.id, admin.id);
    await expectFullyProvisioned(tenant);
  });

  test('a failing subscription step is not swallowed: the tenant is not ACTIVE without its plan', async () => {
    const tenant = await pendingTenant();
    const spy = jest.spyOn(TenantSubscription, 'create').mockRejectedValueOnce(new Error('subscription insert failed'));
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });
    await tenant.reload();
    expect(tenant.status).toBe('APPROVED');
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(0);

    spy.mockRestore();
    await adminService.approveTenant(tenant.id, admin.id);
    await expectFullyProvisioned(tenant);
  });

  test('the approval e-mail is sent once, only when the tenant becomes ACTIVE', async () => {
    const tenant = await pendingTenant();
    const before = mail.sent.length;
    provisioning.provisioningHooks.onStep = (step, phase) => {
      if (step === 'SUBSCRIPTION_LINKED' && phase === 'after') throw new Error('injected');
    };
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toBeDefined();
    expect(mail.sent.length).toBe(before);

    provisioning.provisioningHooks.onStep = null;
    await adminService.approveTenant(tenant.id, admin.id);
    expect(mail.sent.slice(before).filter((m) => /approved/i.test(m.subject))).toHaveLength(1);
  });
});

describe('FLOW-02: one provisioning run at a time', () => {
  test('two approvals at the same time: one provisions, the other gets the in-progress state', async () => {
    const tenant = await pendingTenant();
    const results = await Promise.allSettled([
      adminService.approveTenant(tenant.id, admin.id),
      adminService.approveTenant(tenant.id, admin.id),
    ]);
    const values = results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason }));
    expect(values.filter((v) => v.error)).toEqual([]);
    expect(values.filter((v) => v.provisioning?.inProgress === true)).toHaveLength(1);
    expect(values.filter((v) => v.tenant?.status === 'ACTIVE' && v.provisioning?.inProgress === false)).toHaveLength(1);
    await expectFullyProvisioned(tenant);
  });

  test('while another run holds the lock, approve does nothing and reports the step', async () => {
    const tenant = await pendingTenant();
    await tenant.update({
      status: 'APPROVED',
      provisioningState: 'MODELS_SYNCED',
      provisioningLockToken: '11111111-1111-4111-8111-111111111111',
      provisioningLockedUntil: new Date(Date.now() + 5 * 60 * 1000),
    });
    const result = await adminService.approveTenant(tenant.id, admin.id);
    expect(result.provisioning).toMatchObject({ state: 'MODELS_SYNCED', step: 2, totalSteps: 6, inProgress: true, canResume: false });
    expect(await tenantDbExists(tenant)).toBe(false);
  });

  test('an expired lock (the run died, e.g. a serverless timeout) is taken over by Resume', async () => {
    const tenant = await pendingTenant();
    await tenant.update({
      status: 'APPROVED',
      provisioningState: 'REQUESTED',
      provisioningLockToken: '22222222-2222-4222-8222-222222222222',
      provisioningLockedUntil: new Date(Date.now() - 1000),
    });
    await adminService.approveTenant(tenant.id, admin.id);
    await expectFullyProvisioned(tenant);
  });

  test('a run whose lock was taken over stops at the next step and never activates the tenant', async () => {
    const tenant = await pendingTenant();
    provisioning.provisioningHooks.onStep = async (step, phase) => {
      if (step === 'LISTING_CREATED' && phase === 'before') {
        await Tenant.update({ provisioningLockToken: '33333333-3333-4333-8333-333333333333' }, { where: { id: tenant.id } });
      }
    };
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });
    await tenant.reload();
    expect(tenant.status).toBe('APPROVED');
    expect(tenant.provisioningLockToken).toBe('33333333-3333-4333-8333-333333333333'); // the new holder's lock is kept
    expect((await counts(tenant)).listings).toBe(0);
  });
});

describe('FLOW-02: HTTP approve endpoint', () => {
  test('takes an Idempotency-Key: a repeated click replays the first answer', async () => {
    const tenant = await pendingTenant();
    const key = `approve-${tenant.id}`;
    const first = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.data.provisioning).toMatchObject({ state: 'ACTIVE', step: 6 });

    const second = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send({});
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    await expectFullyProvisioned(tenant);
  });

  test('in progress → 202 with the step; GET shows the provisioning summary', async () => {
    const tenant = await pendingTenant();
    await tenant.update({
      status: 'APPROVED',
      provisioningState: 'LISTING_CREATED',
      provisioningLockToken: '44444444-4444-4444-8444-444444444444',
      provisioningLockedUntil: new Date(Date.now() + 5 * 60 * 1000),
    });
    const res = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.data.provisioning).toMatchObject({ state: 'LISTING_CREATED', step: 3, totalSteps: 6, inProgress: true });

    const view = await request(app).get(`/api/v1/admin/tenants/${tenant.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(view.status).toBe(200);
    expect(view.body.data.tenant.provisioning).toMatchObject({ state: 'LISTING_CREATED', step: 3, inProgress: true });
    expect(JSON.stringify(view.body)).not.toContain('44444444-4444-4444-8444-444444444444');
  });
});

describe('FLOW-02: the daily sweep resumes stalled provisioning', () => {
  test('a run that stopped halfway is finished by the sweep; one that never started under FLOW-02 is left alone', async () => {
    const stalled = await pendingTenant();
    provisioning.provisioningHooks.onStep = (step, phase) => {
      if (step === 'MODELS_SYNCED' && phase === 'after') throw new Error('injected');
    };
    await expect(adminService.approveTenant(stalled.id, admin.id)).rejects.toBeDefined();
    provisioning.provisioningHooks.onStep = null;

    // Approved before FLOW-02 (no recorded state): the sweep must not provision it on its own;
    // the admin decides (see the read-only check script).
    const legacy = await pendingTenant();
    await legacy.update({ status: 'APPROVED' });

    const summary = await provisioning.resumeStalledProvisioning();
    expect(summary.resumed).toContain(stalled.id);
    expect(summary.resumed).not.toContain(legacy.id);
    await expectFullyProvisioned(stalled);

    await legacy.reload();
    expect(legacy.status).toBe('APPROVED');
    expect(await tenantDbExists(legacy)).toBe(false);
  });

  test('the daily cron runs the sweep', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/jobs/subscription-expiry.cron'), 'utf8');
    expect(src).toMatch(/resumeStalledProvisioning\(/);
  });
});

describe('FLOW-02: resuming into a half-made, mixed-collation tenant database', () => {
  test('a database left by an earlier run (general_ci default, one table already there) is finished, not duplicated', async () => {
    const tenant = await pendingTenant();
    const db = `gymsera_${tenant.tenantCode}`;
    const conn = await getAdminConnection();
    // What an interrupted older run can leave on a server whose default is general_ci.
    await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await conn.query(`
      CREATE TABLE \`${db}\`.payments (
        id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
        branch_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    await tenant.update({ status: 'APPROVED', provisioningState: 'REQUESTED' });

    const result = await adminService.approveTenant(tenant.id, admin.id);
    expect(result.provisioning).toMatchObject({ state: 'ACTIVE', step: 6 });
    await expectFullyProvisioned(tenant);

    // Tables in both collations can be joined (no "Illegal mix of collations").
    const [[joined]] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${db}\`.payments p JOIN \`${db}\`.branches b ON b.id = p.branch_id`
    );
    expect(Number(joined.n)).toBe(0);
    const { TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');
    const [[mig]] = await conn.query(`SELECT MAX(version) AS v FROM \`${db}\`.schema_migrations`);
    expect(Number(mig.v)).toBe(TARGET_SCHEMA_VERSION);
  });
});

describe('FLOW-02: a tenant app user with no server-wide privileges', () => {
  // Neither the local test server nor CI runs the tenant app user restricted (locally it holds
  // ALL ON *.*, in CI it is root), so this test makes one: USAGE only, then whatever step 1 grants.
  const mysql = require('mysql2/promise');
  const { decrypt } = require('../../src/utils/crypto.utils');
  const LIMITED_USER = 'f02_limited_app';
  const limitedPass = require('crypto').randomBytes(12).toString('hex');
  const saved = {};

  const dropLimitedUser = async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP USER IF EXISTS '${LIMITED_USER}'@'%'`);
    await conn.query(`DROP USER IF EXISTS '${LIMITED_USER}'@'localhost'`);
  };

  beforeAll(async () => {
    await dropLimitedUser();
    const conn = await getAdminConnection();
    await conn.query(`CREATE USER '${LIMITED_USER}'@'%' IDENTIFIED BY '${limitedPass}'`);
    for (const k of ['TENANT_DB_USER', 'TENANT_DB_PASS']) saved[k] = process.env[k];
    process.env.TENANT_DB_USER = LIMITED_USER;
    process.env.TENANT_DB_PASS = limitedPass;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await dropLimitedUser();
  });

  const globalPrivileges = async () => {
    const conn = await getAdminConnection();
    const [rows] = await conn.query(
      'SELECT PRIVILEGE_TYPE AS p FROM information_schema.USER_PRIVILEGES WHERE GRANTEE LIKE ?',
      [`'${LIMITED_USER}'@%`]
    );
    return [...new Set(rows.map((r) => r.p))];
  };

  test('provisioning, and a resumed provisioning, complete as that user; it can reach only its own tenant database', async () => {
    expect(await globalPrivileges()).toEqual(['USAGE']);

    // One run straight through.
    const tenant = await pendingTenant();
    await adminService.approveTenant(tenant.id, admin.id);
    await expectFullyProvisioned(tenant);
    expect(decodeURIComponent(new URL(decrypt(tenant.connectionStringEncrypted)).username)).toBe(LIMITED_USER);

    // One run that stops after the tables are made and is resumed (the resumed run skips step 1).
    const resumed = await pendingTenant();
    provisioning.provisioningHooks.onStep = (step, phase) => {
      if (step === 'MODELS_SYNCED' && phase === 'after') throw new Error('injected');
    };
    await expect(adminService.approveTenant(resumed.id, admin.id)).rejects.toMatchObject({ statusCode: 502 });
    provisioning.provisioningHooks.onStep = null;
    await adminService.approveTenant(resumed.id, admin.id);
    await expectFullyProvisioned(resumed);

    // Still no server-wide privilege, and no way into the platform database or another tenant's.
    expect(await globalPrivileges()).toEqual(['USAGE']);
    const asApp = await mysql.createConnection({
      host: process.env.TENANT_DB_HOST || '127.0.0.1',
      port: Number(process.env.TENANT_DB_PORT),
      user: LIMITED_USER,
      password: limitedPass,
    });
    try {
      const [[own]] = await asApp.query(`SELECT COUNT(*) AS n FROM \`gymsera_${tenant.tenantCode}\`.branches`);
      expect(Number(own.n)).toBe(1);
      await expect(asApp.query(`SELECT COUNT(*) AS n FROM \`${process.env.PLATFORM_DB_NAME}\`.tenants`)).rejects.toMatchObject({
        code: expect.stringMatching(/ER_TABLEACCESS_DENIED_ERROR|ER_DBACCESS_DENIED_ERROR/),
      });
      await expect(asApp.query('SELECT COUNT(*) AS n FROM `gymsera_test_tenant_1`.branches')).rejects.toMatchObject({
        code: expect.stringMatching(/ER_TABLEACCESS_DENIED_ERROR|ER_DBACCESS_DENIED_ERROR/),
      });
    } finally {
      await asApp.end().catch(() => {});
    }
  });
});

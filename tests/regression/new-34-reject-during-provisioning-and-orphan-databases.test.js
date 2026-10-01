/**
 * NEW-34 (Prompt 1I, spec §12.13.11, owner decision §14 R-28 point 6).
 *
 * Found in 1G: rejecting a tenant while a provisioning run was in progress (or after one
 * failed) left a partial database behind and its GymListing still ACTIVE, and
 * `rejectTenant` never looked at the lease.
 *
 * Now:
 *   (b) `rejectTenant` answers 409 `provisioning_in_progress` while a live lease is held,
 *       and a rejection marks the tenant's ACTIVE listings INACTIVE;
 *   (a) orphan databases are only REPORTED (gymsera-flow02-provisioning-check.js, read-only);
 *       dropping one is a manual, per-database, confirmed script, with hard refusals.
 * Nothing drops a database automatically.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { Tenant, GymListing, PlatformAuditLog } = require('../../src/models/platform');
const adminService = require('../../src/services/admin.service');
const { dropOrphanTenantDatabase, assessOrphanDrop } = require('../../src/services/orphan-database.service');

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;
const createdDbs = [];

describe('NEW-34: reject during provisioning, and orphan databases', () => {
  let admin;
  let adminConn;

  const mkTenant = async (overrides = {}) => {
    const t = await factories.createTenant({
      connectionStringEncrypted: 'PENDING_PROVISIONING',
      status: 'APPROVED',
      ...overrides,
    });
    return t;
  };

  /** A real (empty) database named like a tenant's, so the drop tool has something to drop. */
  const mkDatabase = async (tenant, { withPayments = false } = {}) => {
    const dbName = `gymsera_test_n34_${uuidv4().slice(0, 8)}`;
    createdDbs.push(dbName);
    await adminConn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (withPayments) {
      await adminConn.query(`CREATE TABLE \`${dbName}\`.payments (id CHAR(36) PRIMARY KEY, amount DECIMAL(10,2))`);
      await adminConn.query(`INSERT INTO \`${dbName}\`.payments VALUES ('${uuidv4()}', 100)`);
    }
    await tenant.update({ dbName });
    return dbName;
  };

  const dbExists = async (dbName) => {
    const [rows] = await adminConn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dbName]);
    return rows.length === 1;
  };

  beforeAll(async () => {
    await setupTestDatabases();
    adminConn = await getAdminConnection();
    admin = await factories.createUser({ email: `admin-n34-${uuidv4().slice(0, 6)}@gymsera.test`, role: 'PLATFORM_ADMIN' });
  });

  beforeEach(() => {
    installMailFake();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const db of createdDbs) await adminConn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    await teardownTestDatabases();
  });

  describe('rejectTenant while a provisioning run is in progress', () => {
    test('a live lease → 409 provisioning_in_progress; NOTHING changes', async () => {
      const t = await mkTenant({ provisioningLockToken: uuidv4(), provisioningLockedUntil: new Date(Date.now() + 5 * 60 * 1000), provisioningState: 'DB_CREATED' });
      const listing = await factories.createGymListing(t.id, { status: 'ACTIVE' });

      await expect(adminService.rejectTenant(t.id, admin.id, 'not a real gym')).rejects.toMatchObject({
        statusCode: 409,
        code: 'provisioning_in_progress',
      });

      const after = await Tenant.findByPk(t.id);
      expect(after.status).toBe('APPROVED');
      expect(after.rejectedAt).toBeNull();
      expect((await GymListing.findByPk(listing.id)).status).toBe('ACTIVE');
    });

    test('an EXPIRED lease (the run died) can be rejected', async () => {
      const t = await mkTenant({ provisioningLockToken: uuidv4(), provisioningLockedUntil: new Date(Date.now() - 60 * 1000), provisioningState: 'LISTING_CREATED' });

      const res = await adminService.rejectTenant(t.id, admin.id, 'not a real gym');

      expect(res.tenant.status).toBe('REJECTED');
      expect((await Tenant.findByPk(t.id)).status).toBe('REJECTED');
    });

    test('the admin endpoint answers 409 with the code (reject after the run stops)', async () => {
      const request = require('supertest');
      const { startTestServer } = require('../harness/test-server');
      const { signToken } = require('../../src/utils/jwt.utils');
      const app = await startTestServer();
      const t = await mkTenant({ provisioningLockToken: uuidv4(), provisioningLockedUntil: new Date(Date.now() + 5 * 60 * 1000) });
      const token = signToken({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN', isVerified: true });

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${t.id}/reject`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'not a real gym' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('provisioning_in_progress');
    });
  });

  describe('rejecting marks the tenant\'s listings INACTIVE', () => {
    test('an ACTIVE listing becomes INACTIVE; PENDING / REJECTED listings are left as they were', async () => {
      const t = await mkTenant({ status: 'ACTIVE' });
      const active = await factories.createGymListing(t.id, { status: 'ACTIVE' });
      const pending = await factories.createGymListing(t.id, { status: 'PENDING' });
      const rejected = await factories.createGymListing(t.id, { status: 'REJECTED' });

      await adminService.rejectTenant(t.id, admin.id, 'policy');

      expect((await GymListing.findByPk(active.id)).status).toBe('INACTIVE');
      expect((await GymListing.findByPk(pending.id)).status).toBe('PENDING');
      expect((await GymListing.findByPk(rejected.id)).status).toBe('REJECTED');
    });
  });

  describe('the manual orphan-database drop (never automatic)', () => {
    test('DEFAULT is a dry run: reports what it would do and drops nothing', async () => {
      const t = await mkTenant({ status: 'REJECTED', rejectedAt: new Date(Date.now() - 100 * DAY) });
      const dbName = await mkDatabase(t);

      const res = await dropOrphanTenantDatabase({ dbName, adminConn });

      expect(res).toMatchObject({ eligible: true, dropped: false, dryRun: true });
      expect(await dbExists(dbName)).toBe(true);
    });

    test('--apply without the exact database name as --confirm refuses', async () => {
      const t = await mkTenant({ status: 'REJECTED', rejectedAt: new Date(Date.now() - 100 * DAY) });
      const dbName = await mkDatabase(t);

      await expect(dropOrphanTenantDatabase({ dbName, adminConn, apply: true })).rejects.toThrow(/--confirm/);
      await expect(dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: `${dbName}_x` })).rejects.toThrow(/--confirm/);
      expect(await dbExists(dbName)).toBe(true);
    });

    test('a REJECTED tenant (> 90 days, no money rows) is dropped on --apply --confirm; the tenant is marked database-less and it is audited', async () => {
      const t = await mkTenant({ status: 'REJECTED', rejectedAt: new Date(Date.now() - 100 * DAY), connectionStringEncrypted: 'encrypted-conn' });
      const dbName = await mkDatabase(t);

      const res = await dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: dbName });

      expect(res.dropped).toBe(true);
      expect(await dbExists(dbName)).toBe(false);
      expect((await Tenant.findByPk(t.id)).connectionStringEncrypted).toBe('PENDING_PROVISIONING');
      const audit = await PlatformAuditLog.findAll({ where: { action: 'TENANT_DATABASE_DROPPED', targetId: t.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0].details.dbName).toBe(dbName);
    });

    describe.each([
      ['an ACTIVE tenant', { status: 'ACTIVE' }, /active|live|not eligible/i],
      ['an APPROVED tenant (provisioning)', { status: 'APPROVED' }, /not eligible/i],
      ['a SUSPENDED tenant', { status: 'SUSPENDED' }, /not eligible/i],
      ['a tenant inside its 30-day undo window', { status: 'PENDING_DELETION', deletionScheduledFor: new Date(Date.now() + 10 * DAY) }, /undo window|not eligible/i],
      ['a REJECTED tenant rejected only 10 days ago', { status: 'REJECTED', rejectedAt: new Date(Date.now() - 10 * DAY) }, /90 days/],
      ['a DELETED tenant deleted 1 year ago (financial records are kept 6 years)', { status: 'DELETED', deletedAt: new Date(Date.now() - 1 * YEAR) }, /6 years/],
      ['a tenant with a live provisioning lease', { status: 'REJECTED', rejectedAt: new Date(Date.now() - 100 * DAY), provisioningLockToken: uuidv4(), provisioningLockedUntil: new Date(Date.now() + 60 * 1000) }, /lease|provisioning/i],
    ])('REFUSES %s', (_label, tenantFields, reason) => {
      test('even with --apply and the right --confirm, the database is kept', async () => {
        const t = await mkTenant(tenantFields);
        const dbName = await mkDatabase(t);

        const dry = await dropOrphanTenantDatabase({ dbName, adminConn });
        expect(dry.eligible).toBe(false);
        expect(dry.reason).toMatch(reason);
        await expect(dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: dbName })).rejects.toThrow(reason);
        expect(await dbExists(dbName)).toBe(true);
        expect(await PlatformAuditLog.count({ where: { action: 'TENANT_DATABASE_DROPPED', targetId: t.id } })).toBe(0);
      });
    });

    test('REFUSES a REJECTED tenant whose database holds payment rows (money is never dropped)', async () => {
      const t = await mkTenant({ status: 'REJECTED', rejectedAt: new Date(Date.now() - 100 * DAY) });
      const dbName = await mkDatabase(t, { withPayments: true });

      await expect(dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: dbName })).rejects.toThrow(/payment/i);
      expect(await dbExists(dbName)).toBe(true);
    });

    test('a DELETED tenant is droppable only after 6 years', async () => {
      const t = await mkTenant({ status: 'DELETED', deletedAt: new Date(Date.now() - 6 * YEAR - 2 * DAY) });
      const dbName = await mkDatabase(t, { withPayments: true });

      const res = await dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: dbName });

      expect(res.dropped).toBe(true);
      expect(await dbExists(dbName)).toBe(false);
    });

    test('REFUSES a database no tenant row maps to (unknown → the owner decides by hand)', async () => {
      const dbName = `gymsera_test_n34_${uuidv4().slice(0, 8)}`;
      createdDbs.push(dbName);
      await adminConn.query(`CREATE DATABASE \`${dbName}\``);

      await expect(dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: dbName })).rejects.toThrow(/no tenant/i);
      expect(await dbExists(dbName)).toBe(true);
    });

    test.each([
      ['the platform database', process.env.PLATFORM_DB_NAME],
      ['a name that is not a gymsera_ database', 'mysql'],
      ['a name with unsafe characters', 'gymsera_x`; DROP DATABASE mysql; --'],
    ])('REFUSES %s outright', async (_label, dbName) => {
      await expect(dropOrphanTenantDatabase({ dbName, adminConn, apply: true, confirm: dbName })).rejects.toThrow();
    });

    test('assessOrphanDrop is pure: the decision depends only on the tenant row, the clock and the money count', () => {
      const now = new Date('2030-01-01T00:00:00Z');
      expect(assessOrphanDrop({ tenant: { status: 'REJECTED', rejectedAt: new Date('2029-01-01T00:00:00Z') }, paymentRows: 0, now }).eligible).toBe(true);
      expect(assessOrphanDrop({ tenant: { status: 'REJECTED', rejectedAt: new Date('2029-12-01T00:00:00Z') }, paymentRows: 0, now }).eligible).toBe(false);
      expect(assessOrphanDrop({ tenant: null, paymentRows: 0, now }).eligible).toBe(false);
    });
  });

  test('no scheduled or automatic path drops a database: only the manual script and its service contain the DROP', () => {
    const root = path.resolve(__dirname, '../..');
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /DROP\s+DATABASE/i.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(root, full));
      }
    };
    walk(path.join(root, 'src'));
    expect(hits.sort()).toEqual(['src/services/orphan-database.service.js']);
  });
});

/**
 * Regression test for tools/release-1-1-approve-existing-test-businesses.js:
 *  - Default dry-run lists ACTIVE + NOT_SUBMITTED businesses and writes nothing.
 *  - --apply updates ONLY ACTIVE + NOT_SUBMITTED businesses to APPROVED and populates approvedAt.
 *  - PENDING/REJECTED/INACTIVE and already-submitted businesses stay untouched; 0 deletes.
 *  - Re-running --apply is idempotent (0 updated).
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { GymListing, sequelize } = require('../../src/models/platform');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'release-1-1-approve-existing-test-businesses.js');

const execScript = (args = []) => execFileSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT,
  env: process.env,
  encoding: 'utf8',
  timeout: 30000,
});

describe('tools/release-1-1-approve-existing-test-businesses.js', () => {
  let orgId;
  let unapprovedActive;
  let pendingBiz;
  let pendingKycActive;
  let rejectedBiz;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    orgId = personaManager.context.tenant1.id;

    unapprovedActive = await factories.createGymListing(orgId, {
      name: 'Legacy Active Test Gym',
      status: 'ACTIVE',
      kycStatus: 'NOT_SUBMITTED',
      approvedAt: null,
    });
    pendingKycActive = await factories.createGymListing(orgId, {
      name: 'Active Pending KYC',
      status: 'ACTIVE',
      kycStatus: 'PENDING',
      approvedAt: null,
    });
    pendingBiz = await factories.createGymListing(orgId, {
      name: 'New Pending Biz',
      status: 'PENDING',
      kycStatus: 'NOT_SUBMITTED',
      approvedAt: null,
    });
    rejectedBiz = await factories.createGymListing(orgId, {
      name: 'Old Rejected Biz',
      status: 'REJECTED',
      kycStatus: 'NOT_SUBMITTED',
      approvedAt: null,
    });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('dry-run lists matched ACTIVE + NOT_SUBMITTED businesses and updates nothing', async () => {
    const out = execScript();
    expect(out).toContain('Mode: DRY-RUN (no writes)');
    expect(out).toContain(unapprovedActive.id);
    expect(out).toContain('Legacy Active Test Gym');
    expect(out).not.toContain(pendingKycActive.id);
    expect(out).not.toContain(pendingBiz.id);
    expect(out).not.toContain(rejectedBiz.id);

    await unapprovedActive.reload();
    expect(unapprovedActive.kycStatus).toBe('NOT_SUBMITTED');
    expect(unapprovedActive.approvedAt).toBeNull();
  });

  test('--apply approves only ACTIVE + NOT_SUBMITTED businesses (update only, no deletes) and is idempotent', async () => {
    const totalBefore = await GymListing.count();
    const out = execScript(['--apply']);
    expect(out).toContain('Mode: APPLY (UPDATE ONLY)');
    expect(out).toContain('updated to kyc_status = \'APPROVED\'');

    expect(await GymListing.count()).toBe(totalBefore);
    await Promise.all([
      unapprovedActive.reload(),
      pendingKycActive.reload(),
      pendingBiz.reload(),
      rejectedBiz.reload(),
    ]);

    expect(unapprovedActive.kycStatus).toBe('APPROVED');
    expect(unapprovedActive.approvedAt).toBeTruthy();

    expect(pendingKycActive.kycStatus).toBe('PENDING');
    expect(pendingBiz.kycStatus).toBe('NOT_SUBMITTED');
    expect(rejectedBiz.kycStatus).toBe('NOT_SUBMITTED');

    const rerun = execScript(['--apply']);
    expect(rerun).toContain('Apply complete: 0 rows updated');

    // Confirm raw row still exists cleanly
    const [row] = await sequelize.query(
      'SELECT kyc_status AS kycStatus FROM business_listings WHERE id = ?',
      { replacements: [unapprovedActive.id], type: sequelize.QueryTypes.SELECT }
    );
    expect(row.kycStatus).toBe('APPROVED');
  });
});

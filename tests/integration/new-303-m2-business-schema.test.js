const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { GymListing } = require('../../src/models/platform');
const { PLATFORM_MIGRATIONS } = require('../../src/database/platform-migrations');
const rename = require('../../src/database/rename-helpers');

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
});
afterAll(async () => teardownTestDatabases());

test('M2 business KYC and verification columns are versioned and survive a model reload', async () => {
  expect(PLATFORM_MIGRATIONS.at(-1).version).toBe(38);
  for (const column of ['kyc_status', 'kyc_documents_json', 'kyc_submitted_at', 'approved_at',
    'approved_by', 'verified_at', 'verified_by']) {
    expect(await rename.columnInfo(GymListing.sequelize, 'business_listings', column)).toBeTruthy();
  }
  expect(GymListing.build({}).kycStatus).toBe('NOT_SUBMITTED'); // the column default; the test factory approves ACTIVE listings
  const listing = await GymListing.findOne();
  const now = new Date();
  await listing.update({ kycStatus: 'PENDING', kycDocumentsJson: [{ id: 'test' }],
    kycSubmittedAt: now, verifiedAt: now, verifiedBy: '11111111-1111-4111-8111-111111111111' });
  await listing.reload();
  expect(listing.kycStatus).toBe('PENDING');
  expect(listing.kycDocumentsJson).toEqual([{ id: 'test' }]);
  expect(listing.verifiedBy).toBe('11111111-1111-4111-8111-111111111111');
});

/**
 * R-119 (NEW-303c): create rules for Organization › Business › Branch.
 *  - D7: a business that is not approved (PENDING / REJECTED) receives no branch: 409 business_not_approved on
 *    POST /host/branches, POST /gyms/branches and restore; nothing written, no capacity event.
 *  - W4: a free unit parked on ANOTHER approved business moves to the target (SLOT_TRANSFERRED pair) and the
 *    branch is built into it (SLOT_CONSUMED_BUILD), instead of 403 at "3 used / 4 paid".
 *  - Q2: Add Business (POST /host/listings, branchSource 'new' from builds 27 / 28 too) reserves one unit and
 *    HOLDS the first branch (first_branch_data_json); no branch row until approval. Full pool → 403, nothing
 *    written. Approval builds the held branch into the reserved unit and clears the JSON; a second approval
 *    builds nothing. Rejection frees the pool and keeps the JSON.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { personaManager } = require('../harness/personas');
const { GymListing, CapacityEvent } = require('../../src/models/platform');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const adminService = require('../../src/services/admin.service');

describe('R-119 create rules', () => {
  let tenantDb; let tenantId; let sub; let adminId;
  let seq = 0;
  const n = () => `${Date.now()}-${(seq += 1)}`;
  const branchCount = () => tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
  const used = () => subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
  const setPool = async (max) => sub.update({ branchCount: max, overQuotaCount: 0 });
  const listingBody = (k) => ({
    gymName: `R119 Business ${k}`, branchSource: 'new', address: `${k} Street`,
    packages: [{ name: 'Monthly', price: 50, durationType: 'MONTHLY', durationValue: 1 }],
    openingTime: '06:00', closingTime: '22:00',
  });
  // D10: what approval needs (proof of premises + 3 photos), as an upload would leave it.
  const makeReady = (id) => GymListing.update({
    kycDocumentsJson: [{ documentId: `doc-${id}`, key: `kyc/${id}/premises.pdf`, originalName: 'premises.pdf', mimetype: 'application/pdf', size: 10, documentType: 'PROOF_OF_PREMISES', uploadedAt: new Date().toISOString() }],
    coverImageUrl: 'https://img.test/1.jpg', imagesJson: ['https://img.test/2.jpg', 'https://img.test/3.jpg'],
  }, { where: { id } });
  const branchBody = (k, gymListingId) => ({ branchName: `R119 Branch ${k}`, address: `${k} Road`, gymListingId, packages: [{ name: 'Monthly', price: 50 }] });

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    tenantDb = h.tenant1;
    tenantId = personaManager.personas.owner.tenantId;
    adminId = personaManager.personas.platformAdmin.user.id;
    sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    if (!sub) sub = await factories.createTenantSubscription(tenantId, { branchCount: 50, overQuotaCount: 0 });
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('Q2: Add Business holds its first branch', () => {
    let listingId;

    test('full pool: 403 branch_limit_reached, nothing written', async () => {
      await setPool(await used());
      const listings = await GymListing.count({ where: { tenantId } });
      const res = await asPersona('owner').post('/host/listings').send(listingBody(n()));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('branch_limit_reached');
      expect(await GymListing.count({ where: { tenantId } })).toBe(listings);
    });

    test('free pool: business PENDING, one reserved unit, held branch, no branch row', async () => {
      await setPool(50);
      const before = await branchCount();
      const usedBefore = await used();
      const res = await asPersona('owner').post('/host/listings').send(listingBody(n()));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'PENDING', reservedSlots: 1, branch: null, heldFirstBranch: true });
      listingId = res.body.data.id;
      const listing = await GymListing.findByPk(listingId);
      expect(listing.firstBranchDataJson).toMatchObject({ branchName: listing.title, openingTime: '06:00', closingTime: '22:00' });
      expect(listing.firstBranchDataJson.packages).toHaveLength(1);
      expect(await branchCount()).toBe(before);
      expect(await used()).toBe(usedBefore + 1);
    });

    test('D7: a branch into the PENDING business is 409 business_not_approved; nothing written, no event', async () => {
      const before = await branchCount();
      const events = await CapacityEvent.count({ where: { tenantId } });
      for (const path of ['/host/branches', '/gyms/branches']) {
        const res = await asPersona('owner').post(path).send(branchBody(n(), listingId));
        expect([path, res.status, res.body.code]).toEqual([path, 409, 'business_not_approved']);
        expect(res.body.message).toBe('This business is still under review. You can add branches once it is approved.');
      }
      expect(await branchCount()).toBe(before);
      expect(await CapacityEvent.count({ where: { tenantId } })).toBe(events);
    });

    test('approval builds the held branch into the reserved unit and clears the JSON; a second approval builds nothing', async () => {
      const before = await branchCount();
      const usedBefore = await used();
      await expect(adminService.approveTenant(`${tenantId}:${listingId}`, adminId, { photosChecked: true }))
        .rejects.toMatchObject({ statusCode: 422, code: 'business_requirements_missing' });
      await makeReady(listingId);
      await adminService.approveTenant(`${tenantId}:${listingId}`, adminId, { photosChecked: true });
      const listing = await GymListing.findByPk(listingId);
      expect(listing).toMatchObject({ status: 'ACTIVE', kycStatus: 'APPROVED', reservedSlots: 0, firstBranchDataJson: null, approvedBy: adminId });
      expect(listing.approvedAt).not.toBeNull();
      const built = await tenantDb.models.Branch.findOne({ where: { gymListingId: listingId } });
      expect(built).not.toBeNull();
      expect(built.status).toBe('ACTIVE');
      expect(built.refundsAllowed).toBe(false);
      expect(built.openingTime).toBe('06:00');
      expect(listing.branchId).toBe(built.id);
      expect(await CapacityEvent.count({ where: { tenantId, branchId: built.id, action: 'SLOT_CONSUMED_BUILD' } })).toBe(1);
      expect(await branchCount()).toBe(before + 1);
      expect(await used()).toBe(usedBefore);

      await adminService.approveTenant(`${tenantId}:${listingId}`, adminId, { photosChecked: true });
      expect(await branchCount()).toBe(before + 1);
    });

    test('rejection frees the pool and keeps the held JSON for a re-apply', async () => {
      const res = await asPersona('owner').post('/host/listings').send(listingBody(n()));
      expect(res.status).toBe(201);
      const usedHeld = await used();
      await adminService.rejectTenant(`${tenantId}:${res.body.data.id}`, adminId, 'Premises document missing');
      const listing = await GymListing.findByPk(res.body.data.id);
      expect(listing.status).toBe('REJECTED');
      expect(listing.firstBranchDataJson).not.toBeNull();
      expect(await used()).toBe(usedHeld - 1);
      const add = await asPersona('owner').post('/host/branches').send(branchBody(n(), listing.id));
      expect([add.status, add.body.code]).toEqual([409, 'business_not_approved']);
    });
  });

  describe('W4: a unit parked on another approved business is moved, not refused', () => {
    test('pool full only because of a reserved slot elsewhere → 201, SLOT_TRANSFERRED pair, SLOT_CONSUMED_BUILD', async () => {
      const target = await GymListing.findOne({ where: { tenantId, status: 'ACTIVE', reservedSlots: 0 }, order: [['createdAt', 'ASC']] });
      const donor = await factories.createGymListing(tenantId, { title: `R119 Donor ${n()}`, status: 'ACTIVE', reservedSlots: 1 });
      await setPool(await used());
      const res = await asPersona('owner').post('/host/branches').send(branchBody(n(), target.id));
      expect(res.status).toBe(201);
      await donor.reload();
      await target.reload();
      expect(donor.reservedSlots).toBe(0);
      expect(target.reservedSlots).toBe(0);
      expect(await CapacityEvent.count({ where: { tenantId, listingId: donor.id, action: 'SLOT_TRANSFERRED', delta: -1 } })).toBe(1);
      expect(await CapacityEvent.count({ where: { tenantId, listingId: target.id, action: 'SLOT_TRANSFERRED', delta: 1 } })).toBe(1);
      const branchId = (res.body.data.branch || res.body.data).id;
      expect(await CapacityEvent.count({ where: { tenantId, branchId, action: 'SLOT_CONSUMED_BUILD' } })).toBe(1);
    });

    test('a PENDING business\'s reservation (its held branch) is never taken: 403', async () => {
      const target = await GymListing.findOne({ where: { tenantId, status: 'ACTIVE' }, order: [['createdAt', 'ASC']] });
      await factories.createGymListing(tenantId, { title: `R119 Pending ${n()}`, status: 'PENDING', reservedSlots: 1 });
      await setPool(await used());
      const res = await asPersona('owner').post('/host/branches').send(branchBody(n(), target.id));
      expect([res.status, res.body.code]).toEqual([403, 'branch_limit_reached']);
      await setPool(50);
    });
  });

  test('D7 restore: a deleted branch of a REJECTED business is not restored (409)', async () => {
    const listing = await factories.createGymListing(tenantId, { title: `R119 Rejected ${n()}`, status: 'REJECTED', reservedSlots: 0 });
    const gym = await tenantDb.models.Gym.create({ gymListingId: listing.id, name: listing.title });
    const branch = await tenantDb.models.Branch.create({ gymId: gym.id, gymListingId: listing.id, branchName: 'R119 Old', status: 'INACTIVE' });
    const res = await asPersona('owner').post(`/host/branches/${branch.id}/restore`).send({});
    expect([res.status, res.body.code]).toEqual([409, 'business_not_approved']);
    await branch.reload();
    expect(branch.status).toBe('INACTIVE');
  });
});

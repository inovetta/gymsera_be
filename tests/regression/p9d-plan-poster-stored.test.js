'use strict';

/**
 * Phase 7 P9d, NEW-223 (P2): POST /membership-plans/:id/poster saved a made-up
 * `/uploads/plans/<id>-<ts>.jpg` path and never stored the image (membership-plans.controller.js:110),
 * the same defect as the P9c payment proofs. A poster is public, so it goes to the existing image
 * store (storage.service, like gym logos and covers: R2_BUCKET, or public/uploads outside production),
 * not the private bucket. The plan is checked before anything is stored; a replaced poster is deleted.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing } = require('../../src/models/platform');
const storageService = require('../../src/services/storage.service');
const kycStorage = require('../../src/services/kyc-storage.service');
const { createError } = require('../../src/utils/response.utils');

const UPLOADS = path.join(__dirname, '../../public/uploads');
const written = [];

let tenantDb;
let plan;
let jpeg;
let png;

const upload = (planId, buffer, name = 'poster.jpg', type = 'image/jpeg') =>
  asPersona('owner').post(`/membership-plans/${planId}/poster`).attach('image', buffer, { filename: name, contentType: type });

/** The file behind a URL the local image store returned (http://localhost:3000/uploads/<key>). */
const storedFile = (url) => {
  const m = /\/uploads\/(.+)$/.exec(url || '');
  return m ? path.join(UPLOADS, m[1]) : null;
};

beforeAll(async () => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) expect(process.env[k] || '').toBe('');
  const h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  const listing = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId } });
  const branch = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
  const gym = await tenantDb.models.Gym.findOne();
  plan = await tenantDb.models.MembershipPlan.create({
    gymId: gym.id, branchId: branch.id, name: 'Poster plan', durationType: 'MONTHLY', durationValue: 1,
    price: 5000, status: 'ACTIVE', isPublic: false,
  });
  jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
  png = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toBuffer();
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  for (const f of written) if (f && fs.existsSync(f)) fs.unlinkSync(f);
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-223: a plan poster is really stored', () => {
  test('the uploaded image is in the image store, at the URL saved on the plan', async () => {
    const res = await upload(plan.id, jpeg);
    expect(res.status).toBe(200);
    const url = res.body.data.posterUrl;
    const file = storedFile(url);
    written.push(file);
    expect(file).not.toBeNull();
    expect(fs.existsSync(file)).toBe(true);
    // SEC-08 re-encodes every upload (EXIF dropped), so the stored file is the same picture, not the same bytes.
    expect(await sharp(fs.readFileSync(file)).metadata()).toMatchObject({ format: 'jpeg', width: 12, height: 8 });
    expect(url).toMatch(/\/plans\/posters\//);
    expect((await plan.reload()).posterUrl).toBe(url);
  });

  test('a PNG keeps its type', async () => {
    const res = await upload(plan.id, png, 'poster.png', 'image/png');
    expect(res.status).toBe(200);
    const file = storedFile(res.body.data.posterUrl);
    written.push(file);
    expect(file.endsWith('.png')).toBe(true);
    expect(await sharp(fs.readFileSync(file)).metadata()).toMatchObject({ format: 'png', width: 8, height: 12 });
  });

  test('it goes to the public image store, never the private bucket', async () => {
    const pub = jest.spyOn(storageService, 'uploadImage');
    const priv = jest.spyOn(kycStorage, 'putPrivateObject');
    const res = await upload(plan.id, jpeg);
    written.push(storedFile(res.body.data.posterUrl));
    expect(res.status).toBe(200);
    expect(pub).toHaveBeenCalledTimes(1);
    expect(priv).not.toHaveBeenCalled();
  });

  test('replacing a poster deletes the previous one', async () => {
    const before = (await plan.reload()).posterUrl;
    const del = jest.spyOn(storageService, 'deleteImage');
    const res = await upload(plan.id, jpeg);
    written.push(storedFile(res.body.data.posterUrl));
    expect(res.status).toBe(200);
    expect(res.body.data.posterUrl).not.toBe(before);
    expect(del).toHaveBeenCalledWith(before);
  });

  test('an unknown plan: 404 and nothing is stored', async () => {
    const pub = jest.spyOn(storageService, 'uploadImage');
    const res = await upload('00000000-0000-4000-8000-000000000000', jpeg);
    expect(res.status).toBe(404);
    expect(pub).not.toHaveBeenCalled();
  });

  test('when the store refuses (production without R2: 503), the plan keeps its poster', async () => {
    const before = (await plan.reload()).posterUrl;
    jest.spyOn(storageService, 'uploadImage').mockRejectedValueOnce(
      createError('File storage is not available right now. Please try again later.', 503)
    );
    const res = await upload(plan.id, jpeg);
    expect(res.status).toBe(503);
    expect((await plan.reload()).posterUrl).toBe(before);
  });

  test('no file: 422, nothing stored', async () => {
    const pub = jest.spyOn(storageService, 'uploadImage');
    const res = await asPersona('owner').post(`/membership-plans/${plan.id}/poster`).send({});
    expect(res.status).toBe(422);
    expect(pub).not.toHaveBeenCalled();
  });
});

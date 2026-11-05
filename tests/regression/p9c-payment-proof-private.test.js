/**
 * Phase 7 P9c item A — payment proofs are stored, and only the receiving host's staff and
 * platform admins can open them.
 *
 * The bug: every proof upload route (app `/me/payment-requests/:id/proof`, website
 * `/me/payments/:id/proof` and `/subscriptions/:id/proof`, staff `/payments/:id/proof`) built a
 * `/uploads/payment-proofs/<id>-<ts>.jpg` string and saved it, but never wrote the file anywhere.
 * The CMS opened that relative path on its own host (cms.gymsera.com/uploads/...) → 404.
 *
 * Now: the bytes go to the private store (decision R-27: private R2 bucket, or
 * storage/private outside every public web root), the row keeps a private key, and the file is
 * served only by `GET /payments/:id/proof` (tenant context + `payments.view` on the payment's
 * branch; platform admins through their X-Tenant-Id). `proofUrl` in API answers is that route.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { createUser, makeBranchLive } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const subscriptionService = require('../../src/services/subscription.service');
const { PlatformAuditLog } = require('../../src/models/platform');

const PUBLIC_UPLOADS = path.join(__dirname, '../../public/uploads/payment-proofs');

describe('P9c A: payment proofs are stored privately and served only to the receiving host', () => {
  let ctx;
  let plan;
  let jpeg;
  let n = 0;
  const server = () => require('../harness/personas').personaManager.server;

  /** A traveller with a pending booking at tenant 1 (the real subscribe path). */
  const traveller = async () => {
    n += 1;
    const user = await createUser({ role: 'MEMBER', email: `p9c.a${n}@gymsera.test`, fullName: `P9c Traveller ${n}` });
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });
    const { subscription, payment } = await subscriptionService.subscribe(user.id, {
      planId: plan.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    return { user, token, subscription, payment };
  };
  const upload = (token, url) =>
    request(server()).post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`)
      .attach('image', jpeg, { filename: 'receipt.jpg', contentType: 'image/jpeg' });

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    plan = await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'P9c Proof Plan',
      price: '1500.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  const channels = [
    ['mobile app', (t) => `/me/payment-requests/${t.payment.id}/proof`],
    ['website payments page', (t) => `/me/payments/${t.payment.id}/proof`],
    ['website subscription page', (t) => `/subscriptions/${t.subscription.id}/proof`],
  ];

  test.each(channels)('1. a proof uploaded from the %s is stored and the owner can open it', async (_label, urlFor) => {
    const t = await traveller();
    const before = fs.existsSync(PUBLIC_UPLOADS) ? fs.readdirSync(PUBLIC_UPLOADS).length : 0;

    const up = await upload(t.token, urlFor(t));
    expect(up.status).toBe(200);

    // The row holds a private key, never a public /uploads path.
    const row = await ctx.tenant1Db.models.Payment.findByPk(t.payment.id, { raw: true });
    expect(row.proofUrl).toMatch(/^private:tenants\/.+\/payment-proofs\//);
    expect(row.proofUrl).not.toContain('/uploads/');
    // Nothing is written where the web server serves files.
    const after = fs.existsSync(PUBLIC_UPLOADS) ? fs.readdirSync(PUBLIC_UPLOADS).length : 0;
    expect(after).toBe(before);

    // API answers point at the authenticated route.
    const detail = await asPersona('owner').get(`/payments/${t.payment.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.payment.proofUrl).toBe(`/api/v1/payments/${t.payment.id}/proof`);

    const res = await asPersona('owner').get(`/payments/${t.payment.id}/proof`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.slice(0, 3).toString('hex')).toBe('ffd8ff'); // a real JPEG came back
  });

  test('2. staff of that branch with payments.view and a platform admin can open it; each opening is audited', async () => {
    const t = await traveller();
    expect((await upload(t.token, `/me/payment-requests/${t.payment.id}/proof`)).status).toBe(200);

    for (const persona of ['manager', 'frontDesk']) {
      expect((await asPersona(persona).get(`/payments/${t.payment.id}/proof`)).status).toBe(200);
    }
    const admin = await asPersona('platformAdmin', { 'X-Tenant-Id': ctx.tenant1.id }).get(`/payments/${t.payment.id}/proof`);
    expect(admin.status).toBe(200);

    const audits = await PlatformAuditLog.count({ where: { action: 'PAYMENT_PROOF_ACCESSED', targetId: t.payment.id } });
    expect(audits).toBe(3);
  });

  test('3. refused: another tenant\'s owner, a team member without payments.view, the traveller, anonymous', async () => {
    const t = await traveller();
    expect((await upload(t.token, `/me/payments/${t.payment.id}/proof`)).status).toBe(200);
    const url = `/payments/${t.payment.id}/proof`;

    // Other tenant's owner, in their own tenant and pointing at tenant 1.
    expect((await asPersona('otherTenantOwner').get(url)).status).toBe(404);
    expect((await asPersona('otherTenantOwner', { 'X-Tenant-Id': ctx.tenant1.id }).get(url)).status).toBe(404);
    // Same tenant, no payments.view.
    for (const persona of ['trainer', 'cleaner']) {
      expect((await asPersona(persona).get(url)).status).toBe(404);
    }
    // The traveller who uploaded it is not host staff.
    const own = await request(server()).get(`/api/v1${url}`).set('Authorization', `Bearer ${t.token}`).set('X-Tenant-Id', ctx.tenant1.id);
    expect([403, 404]).toContain(own.status);
    expect((await asPersona('anonymous').get(url)).status).toBe(401);
  });

  test('4. a proof saved before this fix (file never stored) answers 404 proof_missing and is flagged, not linked', async () => {
    const t = await traveller();
    await ctx.tenant1Db.models.Payment.update(
      { proofUrl: `/uploads/payment-proofs/${t.payment.id}-1700000000000.jpg` },
      { where: { id: t.payment.id } }
    );
    const detail = await asPersona('owner').get(`/payments/${t.payment.id}`);
    expect(detail.body.data.payment.proofUrl).toBeNull();
    expect(detail.body.data.payment.proofMissing).toBe(true);

    const res = await asPersona('owner').get(`/payments/${t.payment.id}/proof`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('proof_missing');
  });

  test('5. no proof at all answers 404 proof_not_found', async () => {
    const t = await traveller();
    const res = await asPersona('owner').get(`/payments/${t.payment.id}/proof`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('proof_not_found');
  });

  test('6. a second upload replaces the first file in the private store', async () => {
    const t = await traveller();
    await upload(t.token, `/me/payment-requests/${t.payment.id}/proof`);
    const first = (await ctx.tenant1Db.models.Payment.findByPk(t.payment.id, { raw: true })).proofUrl;
    await new Promise((r) => setTimeout(r, 5));
    await upload(t.token, `/me/payment-requests/${t.payment.id}/proof`);
    const second = (await ctx.tenant1Db.models.Payment.findByPk(t.payment.id, { raw: true })).proofUrl;
    expect(second).not.toBe(first);
    const { PRIVATE_KYC_DIR } = require('../../src/services/kyc-storage.service');
    expect(fs.existsSync(path.join(PRIVATE_KYC_DIR, first.replace(/^private:/, '')))).toBe(false);
    expect(fs.existsSync(path.join(PRIVATE_KYC_DIR, second.replace(/^private:/, '')))).toBe(true);
  });
});

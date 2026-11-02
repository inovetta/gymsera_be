/**
 * Phase 7 P9b item 0: what the released mobile build (before app a8829b8, P9) sends and reads back
 * must keep working against the P9 API, so no forced mobile release is needed.
 *
 * The released build:
 * - uploads with POST /tenants/:id/kyc-documents and NO `documentType` (verification_docs_screen.dart
 *   calls uploadKycDocuments(tenantId, [path])), so the API stores its default BUSINESS_LICENSE;
 * - reads the upload answer as `data.kycDocuments` (tenants_repository.dart); a list in `data` makes
 *   Dart throw, so the host sees an error although the upload was stored (NEW-198, left as is: the
 *   answer is the SEC-10 contract other tests and the P9 build rely on);
 * - reads GET /tenants/me `data.tenant.kycDocumentsJson` as a list of strings
 *   (tenant_model.g.dart `e as String`); the API sent one object per document since SEC-10, so every
 *   screen on myTenantProvider failed for a host who had sent a document. The objects also carried
 *   the private storage `key` (NEW-190).
 *
 * The P9 build sends a type and reads `data` as the list (R-85), and reads names from either shape.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { Tenant } = require('../../src/models/platform');

let tenantId;
const pdf = () => Buffer.from('%PDF-1.5 a document');

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  tenantId = h.tenant1.tenantId || '11111111-1111-4111-8111-111111111111';
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const upload = (documentType) => {
  const req = asPersona('owner').post(`/tenants/${tenantId}/kyc-documents`);
  if (documentType !== undefined) req.field('documentType', documentType);
  return req.attach('documents', pdf(), { filename: 'licence.pdf', contentType: 'application/pdf' });
};

describe('P9b item 0: the released app build against the P9 API', () => {
  test('an upload with no type is accepted and stored as BUSINESS_LICENSE', async () => {
    const res = await upload(undefined);
    expect(res.status).toBe(201);
    const stored = (await Tenant.findByPk(tenantId)).kycDocumentsJson;
    expect(stored[stored.length - 1].documentType).toBe('BUSINESS_LICENSE');
  });

  // Not changed (NEW-198): the upload answer stays the SEC-10 contract, the stored documents in `data`.
  // The released build reads `data.kycDocuments` from it and shows an error although the document is
  // stored; its count is right after a refresh (GET /tenants/me below), and the P9 build reads `data`.
  test('the upload answer keeps the SEC-10 contract: the stored documents in data', async () => {
    const res = await upload(undefined);
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toMatchObject({ originalName: 'licence.pdf', documentType: 'BUSINESS_LICENSE' });
  });

  test('GET /tenants/me lists the documents as strings (the old build casts each one as String)', async () => {
    await upload(undefined);
    const res = await asPersona('owner').get('/tenants/me');
    expect(res.status).toBe(200);
    const docs = res.body.data.tenant.kycDocumentsJson;
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) expect(typeof d).toBe('string');
    expect(docs).toContain('licence.pdf');
  });

  test('NEW-190: no host tenant answer carries a document storage key', async () => {
    const res = await asPersona('owner').get('/tenants/me');
    expect(JSON.stringify(res.body)).not.toMatch(/tenants\/[^"]*\/kyc\//);
  });

  test('the P9 build is unchanged: a typed upload answers the list in data (R-85)', async () => {
    const res = await upload('OWNER_ID');
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].documentType).toBe('OWNER_ID');
  });

  test('the owner still gets every document with its type from the list route', async () => {
    const res = await asPersona('owner').get(`/tenants/${tenantId}/kyc-documents`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((d) => d.documentType)).toEqual(expect.arrayContaining(['BUSINESS_LICENSE', 'OWNER_ID']));
  });
});

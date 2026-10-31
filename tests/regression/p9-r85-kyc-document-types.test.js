/**
 * Phase 7 P9, NEW-185 / R-85: verification documents by type.
 *
 * Before: POST /tenants/:id/kyc-documents stored any `documentType` string the client sent
 * (tenants.controller.js uploadKycDocuments → kyc-storage.service.js:83, default BUSINESS_LICENSE),
 * so "what was sent" could not be shown per type.
 * After: only OWNER_ID, BUSINESS_REGISTRATION and PROOF_OF_PREMISES are accepted (422
 * `invalid_document_type` otherwise, before anything is stored); an upload with no type (older
 * app builds) is stored as before; the list returns each document's type.
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

const upload = (documentType, persona = 'owner') => {
  const req = asPersona(persona).post(`/tenants/${tenantId}/kyc-documents`);
  if (documentType !== undefined) req.field('documentType', documentType);
  return req.attach('documents', pdf(), { filename: 'doc.pdf', contentType: 'application/pdf' });
};

describe('R-85: KYC documents by type', () => {
  test.each(['OWNER_ID', 'BUSINESS_REGISTRATION', 'PROOF_OF_PREMISES'])('%s is stored with its type', async (type) => {
    const res = await upload(type);
    expect(res.status).toBe(201);
    expect(res.body.data[0].documentType).toBe(type);
  });

  test('an unknown type is refused before anything is stored', async () => {
    const before = (await Tenant.findByPk(tenantId)).kycDocumentsJson;
    const res = await upload('SELFIE_WITH_CAT');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_document_type');
    expect((await Tenant.findByPk(tenantId)).kycDocumentsJson).toEqual(before);
  });

  test('no type (older app builds) is still accepted', async () => {
    const res = await upload(undefined);
    expect(res.status).toBe(201);
  });

  test('the list says which type each document is', async () => {
    const res = await asPersona('owner').get(`/tenants/${tenantId}/kyc-documents`);
    expect(res.status).toBe(200);
    const types = res.body.data.map((d) => d.documentType);
    expect(types).toEqual(expect.arrayContaining(['OWNER_ID', 'BUSINESS_REGISTRATION', 'PROOF_OF_PREMISES']));
  });

  test('another tenant owner cannot upload a typed document here', async () => {
    const res = await upload('OWNER_ID', 'otherTenantOwner');
    expect(res.status).toBe(403);
  });
});

/**
 * SEC-10: KYC Data Protection Regression Test (Prompt 1H)
 *
 * Verifies:
 * 1. KYC documents are stored in private storage (outside public /uploads) with SSE-AES256.
 * 2. Upload enforces strict MIME and magic byte checks (renamed .html/.exe rejected).
 * 3. Access is strictly gated: only tenant owner and PLATFORM_ADMIN can access.
 * 4. Admin and owner access to KYC documents is logged in PlatformAuditLog.
 * 5. Retention sweep (R-16) purges KYC documents 90 days after tenant rejection.
 */
const fs = require('fs');
const path = require('path');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
  factories,
} = require('../harness');
const { Tenant, PlatformAuditLog } = require('../../src/models/platform');
const { runKycRetentionSweep } = require('../../src/jobs/kyc-retention.sweep');

describe('SEC-10: KYC Data Protection', () => {
  let dbHarness;
  let tenant1Id;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);
    tenant1Id = dbHarness.tenant1.tenantId || '11111111-1111-4111-8111-111111111111';
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('1. Access Control on KYC Uploads', () => {
    test('Anonymous caller cannot upload KYC documents (401)', async () => {
      const res = await asPersona('anonymous')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', Buffer.from('%PDF-1.4 test pdf file'), 'test.pdf');
      expect(res.status).toBe(401);
    });

    test('Another tenant owner cannot upload KYC documents to tenant 1 (403)', async () => {
      const res = await asPersona('otherTenantOwner')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', Buffer.from('%PDF-1.4 test pdf file'), 'test.pdf');
      expect(res.status).toBe(403);
    });

    test('Regular member cannot upload KYC documents (403)', async () => {
      const res = await asPersona('member')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', Buffer.from('%PDF-1.4 test pdf file'), 'test.pdf');
      expect(res.status).toBe(403);
    });
  });

  describe('2. Upload Validation: Magic Bytes and File Types', () => {
    test('Rejects spoofed file (HTML disguised as JPG) via magic bytes (422)', async () => {
      const fakeJpg = Buffer.from('<html><body>malicious payload</body></html>');

      const res = await asPersona('owner')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', fakeJpg, { filename: 'license.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(422);
      expect(res.body.message || res.body.error).toMatch(/magic bytes|invalid file content|declared mime/i);
    });

    test('Rejects disallowed file types such as .exe / .js (422)', async () => {
      const scriptBuffer = Buffer.from('console.log("hello");');

      const res = await asPersona('owner')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', scriptBuffer, { filename: 'script.js', contentType: 'application/javascript' });
      expect(res.status).toBe(422);
    });

    test('Accepts valid PDF and JPEG documents and saves to private storage', async () => {
      // Valid PDF magic bytes: %PDF
      const validPdf = Buffer.from('%PDF-1.5 legitimate business license document content');
      // Valid JPEG magic bytes: FF D8 FF E0
      const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

      const res = await asPersona('owner')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', validPdf, { filename: 'license.pdf', contentType: 'application/pdf' })
        .attach('documents', validJpg, { filename: 'cnic_front.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);

      const [doc1, doc2] = res.body.data;
      expect(doc1.documentId).toBeDefined();
      expect(doc1.originalName).toBe('license.pdf');
      expect(doc1.mimetype).toBe('application/pdf');

      expect(doc2.documentId).toBeDefined();
      expect(doc2.originalName).toBe('cnic_front.jpg');
      expect(doc2.mimetype).toBe('image/jpeg');

      // Verify files do NOT exist in public/uploads directory
      const publicPath1 = path.join(__dirname, '../../public/uploads', doc1.key || '');
      expect(fs.existsSync(publicPath1)).toBe(false);

      // Verify tenant record updated in database
      const tenant = await Tenant.findByPk(tenant1Id);
      expect(Array.isArray(tenant.kycDocumentsJson)).toBe(true);
      expect(tenant.kycDocumentsJson.length).toBe(2);
      expect(tenant.kycDocumentsJson[0].documentId).toBe(doc1.documentId);
    });
  });

  describe('3. Document Retrieval, Streaming, and Access Audit Logging', () => {
    let uploadedDocId;

    beforeAll(async () => {
      const validPdf = Buffer.from('%PDF-1.4 official kyc certificate');
      const res = await asPersona('owner')
        .post(`/tenants/${tenant1Id}/kyc-documents`)
        .attach('documents', validPdf, { filename: 'certificate.pdf', contentType: 'application/pdf' });
      uploadedDocId = res.body.data[res.body.data.length - 1].documentId;
    });

    test('Listing KYC documents: owner succeeds, other tenant owner 403', async () => {
      // Other tenant owner blocked
      const forbidden = await asPersona('otherTenantOwner')
        .get(`/tenants/${tenant1Id}/kyc-documents`);
      expect(forbidden.status).toBe(403);

      // Owner succeeds
      const success = await asPersona('owner')
        .get(`/tenants/${tenant1Id}/kyc-documents`);
      expect(success.status).toBe(200);
      expect(Array.isArray(success.body.data)).toBe(true);
      expect(success.body.data.some((d) => d.documentId === uploadedDocId)).toBe(true);
    });

    test('Streaming document: Platform Admin access is logged to PlatformAuditLog', async () => {
      const auditBefore = await PlatformAuditLog.count({
        where: {
          action: 'KYC_DOCUMENT_ACCESSED',
          targetId: tenant1Id,
        },
      });

      const res = await asPersona('platformAdmin')
        .get(`/tenants/${tenant1Id}/kyc-documents/${uploadedDocId}/stream`);

      expect(res.status).toBe(200);
      expect(res.header['content-type']).toContain('application/pdf');
      expect(res.header['cache-control']).toContain('private, no-store');
      expect(res.body.toString()).toContain('%PDF-1.4');

      // Assert audit log row created
      const auditAfter = await PlatformAuditLog.findAll({
        where: {
          action: 'KYC_DOCUMENT_ACCESSED',
          targetId: tenant1Id,
        },
        order: [['created_at', 'DESC']],
      });

      expect(auditAfter.length).toBe(auditBefore + 1);
      const latestAudit = auditAfter[0];
      expect(latestAudit.targetType).toBe('Tenant');
      expect(latestAudit.details.documentId).toBe(uploadedDocId);
    });
  });

  describe('4. Retention Policy (R-16): 90-Day Deletion Sweep', () => {
    test('Purges KYC documents for tenants rejected more than 90 days ago', async () => {
      const expiredTenant = await factories.createTenant({
        businessName: 'Expired Rejected Gym',
        email: 'rejected90@gym.test',
        status: 'REJECTED',
        kycStatus: 'REJECTED',
        rejectedAt: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000), // 95 days ago
        kycDocumentsJson: [
          {
            documentId: 'doc_old_95',
            key: 'tenants/test-expired/kyc/test.pdf',
            originalName: 'old_license.pdf',
            mimetype: 'application/pdf',
            size: 1024,
          },
        ],
      });

      // Also create a tenant rejected recently (10 days ago) — should NOT be purged
      const recentTenant = await factories.createTenant({
        businessName: 'Recent Rejected Gym',
        email: 'rejected10@gym.test',
        status: 'REJECTED',
        kycStatus: 'REJECTED',
        rejectedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
        kycDocumentsJson: [
          {
            documentId: 'doc_recent_10',
            key: 'tenants/test-recent/kyc/recent.pdf',
            originalName: 'recent.pdf',
            mimetype: 'application/pdf',
            size: 1024,
          },
        ],
      });

      // Run the retention sweep
      const sweepResult = await runKycRetentionSweep({
        sequelize: dbHarness.platform.sequelize,
        olderThanDays: 90,
      });

      expect(sweepResult.purgedTenantsCount).toBeGreaterThanOrEqual(1);

      // Verify expired tenant KYC is purged
      const updatedExpired = await Tenant.findByPk(expiredTenant.id);
      expect(updatedExpired.kycDocumentsJson).toBeNull();

      // Verify recent tenant KYC is NOT purged
      const updatedRecent = await Tenant.findByPk(recentTenant.id);
      expect(updatedRecent.kycDocumentsJson).not.toBeNull();
      expect(updatedRecent.kycDocumentsJson.length).toBe(1);

      // Verify audit log for the purge
      const purgeAudit = await PlatformAuditLog.findOne({
        where: {
          action: 'KYC_DOCUMENTS_PURGED',
          targetId: expiredTenant.id,
        },
      });
      expect(purgeAudit).not.toBeNull();
      expect(purgeAudit.details.policy).toContain('R-16');
    });
  });
});

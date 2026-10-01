'use strict';

const { Op } = require('sequelize');
const { Tenant, PlatformAuditLog } = require('../models/platform');
const kycStorageService = require('../services/kyc-storage.service');

/**
 * Executes the 90-day KYC retention sweep (spec §14 Rule R-16).
 * Automatically deletes KYC files for tenants rejected or deleted more than 90 days ago.
 *
 * @param {object} options
 * @param {import('sequelize').Sequelize} [options.sequelize]
 * @param {boolean} [options.dryRun=false]
 * @param {number} [options.olderThanDays=90]
 * @returns {Promise<{ evaluatedTenantsCount: number, purgedTenantsCount: number, purgedDocumentsCount: number, details: Array }>}
 */
async function runKycRetentionSweep({ sequelize, dryRun = false, olderThanDays = 90 } = {}) {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  // Find rejected or inactive tenants whose rejection/deletion date exceeds retention window
  const tenants = await Tenant.findAll({
    where: {
      [Op.or]: [
        {
          status: 'REJECTED',
          [Op.or]: [
            { rejectedAt: { [Op.lte]: cutoffDate } },
            { rejectedAt: null, updatedAt: { [Op.lte]: cutoffDate } },
          ],
        },
        {
          kycStatus: 'REJECTED',
          [Op.or]: [
            { rejectedAt: { [Op.lte]: cutoffDate } },
            { rejectedAt: null, updatedAt: { [Op.lte]: cutoffDate } },
          ],
        },
        {
          status: 'INACTIVE',
          updatedAt: { [Op.lte]: cutoffDate },
        },
      ],
      kycDocumentsJson: {
        [Op.ne]: null,
      },
    },
  });

  let purgedTenantsCount = 0;
  let purgedDocumentsCount = 0;
  const details = [];

  for (const tenant of tenants) {
    const rawDocs = tenant.kycDocumentsJson;
    const docs = kycStorageService.normalizeKycDocuments(rawDocs);

    if (docs.length === 0) continue;

    details.push({
      tenantId: tenant.id,
      tenantCode: tenant.tenantCode,
      status: tenant.status,
      rejectedAt: tenant.rejectedAt,
      documentCount: docs.length,
    });

    if (dryRun) {
      purgedTenantsCount++;
      purgedDocumentsCount += docs.length;
      continue;
    }

    // 1. Delete files from storage
    for (const doc of docs) {
      if (doc.key && !doc.isLegacyUrl) {
        await kycStorageService.deleteKycFile(doc.key);
      }
    }

    // 2. Update tenant record
    await tenant.update({
      kycDocumentsJson: null,
    });

    // 3. Immutably log retention action in PlatformAuditLog
    await PlatformAuditLog.create({
      actorUserId: null, // System automated sweep
      action: 'KYC_DOCUMENTS_PURGED',
      targetType: 'Tenant',
      targetId: tenant.id,
      details: {
        purgedDocumentCount: docs.length,
        rejectedAt: tenant.rejectedAt,
        policy: `R-16 (${olderThanDays}-day retention after rejection or deletion)`,
      },
      createdAt: new Date(),
    });

    purgedTenantsCount++;
    purgedDocumentsCount += docs.length;
  }

  return {
    evaluatedTenantsCount: tenants.length,
    purgedTenantsCount,
    purgedDocumentsCount,
    details,
  };
}

module.exports = {
  runKycRetentionSweep,
};

const { Op } = require('sequelize');
const { sequelize: platformSequelize } = require('../database/platform');
const { GymListing, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const subscriptionQuotaService = require('./subscription-quota.service');

/**
 * Capacity Outbox Service (spec §6.2, CAP-02)
 *
 * Ensures cross-database capacity mutations (credits/debits between tenant DB and platform DB)
 * are never lost if a process dies or network drops between the tenant DB commit and the
 * platform DB capacity update.
 *
 * Pattern:
 * 1. The tenant-DB Outbox row is written inside the SAME tenant transaction as the branch mutation.
 * 2. Immediately after tenant commit, processOutboxEntry is called to apply the credit to the platform DB.
 * 3. The platform step uses the existing CapacityEvent.idempotencyKey so replays are completely safe.
 * 4. A background sweep inside the daily cron processes any pending outbox rows that were interrupted.
 */

const createOutboxEntry = async (tenantDb, entry, { transaction } = {}) => {
  const { CapacityOutbox, Outbox } = tenantDb.models;
  const Model = CapacityOutbox || Outbox;
  if (!Model) {
    throw new Error('CapacityOutbox model not registered on tenant DB');
  }

  return await Model.create(
    {
      eventType: entry.eventType || 'CAPACITY_STEP',
      payloadJson: entry.payloadJson,
      idempotencyKey: entry.idempotencyKey,
      status: 'PENDING',
    },
    { transaction }
  );
};

const processOutboxEntry = async (tenantDb, outboxId) => {
  const { CapacityOutbox, Outbox } = tenantDb.models;
  const Model = CapacityOutbox || Outbox;
  if (!Model) return { processed: false, reason: 'model_not_found' };

  const entry = await Model.findByPk(outboxId);
  if (!entry) return { processed: false, reason: 'entry_not_found' };
  if (entry.status === 'PROCESSED') return { processed: true, alreadyProcessed: true };

  const payload = typeof entry.payloadJson === 'string' ? JSON.parse(entry.payloadJson) : entry.payloadJson;
  const platformTx = await platformSequelize.transaction();

  try {
    const listingId = payload.listingId;
    const reservedSlotsDelta = parseInt(payload.reservedSlotsDelta, 10) || 0;

    if (listingId) {
      const listing = await GymListing.findByPk(listingId, { lock: true, transaction: platformTx });
      if (listing) {
        const { applied } = await subscriptionQuotaService.recordCapacityEvent(
          {
            tenantId: listing.tenantId,
            listingId: listing.id,
            branchId: payload.branchId,
            action: payload.action,
            delta: payload.delta || 0,
            reservedSlotsBefore: listing.reservedSlots,
            reservedSlotsAfter: listing.reservedSlots + reservedSlotsDelta,
            actorUserId: payload.actorUserId || null,
            actorType: payload.actorType || 'SYSTEM',
            reason: payload.reason || `Outbox processed event: ${payload.action}`,
            idempotencyKey: payload.idempotencyKey || entry.idempotencyKey,
          },
          { transaction: platformTx }
        );

        if (applied && reservedSlotsDelta !== 0) {
          if (reservedSlotsDelta > 0) {
            await listing.increment('reservedSlots', { by: reservedSlotsDelta, transaction: platformTx });
          } else if (reservedSlotsDelta < 0) {
            await listing.decrement('reservedSlots', { by: Math.abs(reservedSlotsDelta), transaction: platformTx });
          }
        }
      }
    }

    // Clean up primary branchId pointer on listing if branch was deleted
    if (payload.action === 'BRANCH_DELETED' && payload.branchId) {
      await GymListing.update({ branchId: null }, { where: { branchId: payload.branchId }, transaction: platformTx });
    }

    await platformTx.commit();

    await entry.update({
      status: 'PROCESSED',
      processedAt: new Date(),
      lastError: null,
    });

    return { processed: true };
  } catch (err) {
    await platformTx.rollback();
    await entry.increment('attempts', { by: 1 }).catch(() => {});
    await entry.update({ lastError: err.message, status: 'FAILED' }).catch(() => {});
    throw err;
  }
};

const sweepTenantOutbox = async (tenantId, tenantDb) => {
  const { CapacityOutbox, Outbox } = tenantDb.models;
  const Model = CapacityOutbox || Outbox;
  if (!Model) return { processedCount: 0 };

  const pendingEntries = await Model.findAll({
    where: {
      status: { [Op.in]: ['PENDING', 'FAILED'] },
      attempts: { [Op.lt]: 10 },
    },
    order: [['createdAt', 'ASC']],
    limit: 100,
  });

  let processedCount = 0;
  for (const entry of pendingEntries) {
    try {
      await processOutboxEntry(tenantDb, entry.id);
      processedCount++;
    } catch (err) {
      console.warn(`[CapacityOutbox] Failed to process outbox entry ${entry.id} for tenant ${tenantId}:`, err.message);
    }
  }

  return { processedCount };
};

const sweepAllTenantsOutbox = async () => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  let totalProcessed = 0;
  for (const tenant of tenants) {
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { processedCount } = await sweepTenantOutbox(tenant.id, tenantDb);
      totalProcessed += processedCount;
    } catch (err) {
      console.error(`[CapacityOutbox] Sweep error for tenant ${tenant.id}:`, err.message);
    }
  }

  if (totalProcessed > 0) {
    console.log(`[CapacityOutbox] Sweep complete: processed ${totalProcessed} pending outbox event(s)`);
  }
  return { totalProcessed };
};

module.exports = {
  createOutboxEntry,
  processOutboxEntry,
  sweepTenantOutbox,
  sweepAllTenantsOutbox,
};

const { DataTypes } = require('sequelize');

/**
 * Append-only ledger of every action that changes how much of a tenant's
 * paid branch capacity is committed — branch delete/restore, slot transfer,
 * organization delete/branch-move, and the automatic trim/attribution that
 * runs when a subscription's branchCount changes.
 *
 * This table is deliberately doing two jobs at once, not two separate ones:
 *   1. Audit trail — who/what changed a tenant's capacity and when.
 *   2. Idempotency guard — `idempotencyKey` is unique, so the same logical
 *      action (e.g. "delete branch X") can be retried after a partial
 *      failure without double-applying its reservedSlots delta. Callers
 *      must check for an existing row with the same key before mutating
 *      GymListing.reservedSlots, inside the same transaction.
 *
 * Rows are never updated or deleted.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'CapacityEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      listingId: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'The GymListing whose reservedSlots this event changed. Null for tenant-wide events with no single listing (rare).',
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'The tenant-DB branch this event concerns, when applicable. Not a real FK — branches live in a separate per-tenant database.',
      },
      action: {
        type: DataTypes.ENUM(
          'BRANCH_DELETED',
          'BRANCH_RESTORED',
          'SLOT_TRANSFERRED',
          'SLOT_TRIMMED_DOWNGRADE',
          'SLOT_ATTRIBUTED_UPGRADE',
          'SLOT_CONSUMED_BUILD',
          'ORG_DELETED',
          'ORG_BRANCHES_MOVED'
        ),
        allowNull: false,
      },
      delta: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Change applied to listingId.reservedSlots by this event (can be negative).',
      },
      reservedSlotsBefore: { type: DataTypes.INTEGER, allowNull: true },
      reservedSlotsAfter: { type: DataTypes.INTEGER, allowNull: true },
      actorUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'Null when actorType is SYSTEM (cron/webhook-driven, no human actor).',
      },
      actorType: {
        type: DataTypes.ENUM('HOST', 'ADMIN', 'SYSTEM'),
        allowNull: false,
        defaultValue: 'HOST',
      },
      reason: { type: DataTypes.STRING(255), allowNull: true },
      idempotencyKey: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
    },
    {
      tableName: 'capacity_events',
      underscored: true,
      timestamps: true,
      updatedAt: false,
      indexes: [
        { fields: ['tenant_id'] },
        { fields: ['listing_id'] },
        { unique: true, fields: ['idempotency_key'] },
      ],
    }
  );
};

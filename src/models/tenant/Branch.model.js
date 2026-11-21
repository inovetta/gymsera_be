const { DataTypes } = require('sequelize');

/** NEW-273: "06:00:00" → "06:00"; null stays null. */
const hourMinute = (v) => (v == null ? v : String(v).slice(0, 5));

module.exports = (sequelize) => {
  const Branch = sequelize.define(
    'Branch',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      gymId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      gymListingId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'gym_listing_id',
        comment: 'Cross-DB reference to GymListing id on the platform DB',
      },
      branchName: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Stored as plain values (cross-DB reference to platform cities/areas)
      cityId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      areaId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      },
      // Phase 7 P3: Google place id of the address (tenant migration 020). `address` holds its formatted address.
      googlePlaceId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // NEW-273: MySQL TIME reads back as "HH:MM:SS"; every client shows hours as "HH:MM", so they are
      // read as "HH:MM" here (storage unchanged; writes take "HH:MM").
      openingTime: {
        type: DataTypes.TIME,
        allowNull: true,
        get() { return hourMinute(this.getDataValue('openingTime')); },
      },
      closingTime: {
        type: DataTypes.TIME,
        allowNull: true,
        get() { return hourMinute(this.getDataValue('closingTime')); },
      },
      // R-113 H1 (tenant migration 029): the weekly schedule (branch-hours.service.js), or NULL.
      hoursJson: {
        type: DataTypes.JSON,
        allowNull: true,
        field: 'hours_json',
      },
      // R-119 D12 (tenant migration 030): the refund policy belongs to the branch only. Off for a new branch;
      // window in days from the payment, null = no limit (subscription-refund.service.js#policyFor).
      refundsAllowed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'refunds_allowed',
      },
      refundWindowDays: {
        type: DataTypes.SMALLINT.UNSIGNED,
        allowNull: true,
        field: 'refund_window_days',
      },
      phone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
      // IANA timezone name. Every ledger business-date boundary (today/weekly/
      // monthly, close-of-day) is computed against this, never server time.
      timezone: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'Asia/Karachi',
      },
      // ISO 4217 code. Payments, invoices and payouts created in this branch carry it (GLB-02).
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'PKR',
      },
      facilitiesJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of facility strings e.g. ["AC", "Parking", "Shower"]',
      },
      imagesJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of gallery image URLs',
      },
      tagline: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      category: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      tagsJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of tag strings',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      establishedYear: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'established_year',
      },
      floorArea: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'floor_area',
      },
      addressLine1: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'address_line1',
      },
      addressLine2: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'address_line2',
      },
      postalCode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'postal_code',
      },
      country: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      travelerVisibilityStatus: {
        type: DataTypes.ENUM('pending', 'active', 'deactivated'),
        allowNull: false,
        defaultValue: 'pending',
        field: 'traveler_visibility_status',
      },
      deactivationReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'deactivation_reason',
      },
      deactivatedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'deactivated_at',
      },
      deactivatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deactivated_by',
      },
      adminSuspended: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'admin_suspended',
      },
      adminSuspendedReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'admin_suspended_reason',
      },
      adminSuspendedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'admin_suspended_at',
      },
      adminSuspendedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'admin_suspended_by',
      },
      billingLockedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'billing_locked_at',
      },
      billingLockReason: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'billing_lock_reason',
      },
      // P5b item 2 (tenant migration 021): paused by the host, hidden from travellers. Not a
      // status: a paused branch stays ACTIVE and keeps everything (gym.service.js pauseBranch).
      pausedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'paused_at',
      },
      pausedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'paused_by',
      },
    },
    {
      tableName: 'branches',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['gym_id'] },
        { fields: ['status'] },
        { fields: ['city_id', 'area_id'] },
      ],
    }
  );

  /**
   * R-113 H6: every branch object a route sends carries the week and what it means now, in the
   * branch's timezone: hours (its own, else the one its old pair stands for, else null), timezone,
   * utcOffsetMinutes, hoursToday, openNow, openNowFor, nextChange. Computed when serialized, so a
   * query that did not load hoursJson / timezone still answers (from the pair, Asia/Karachi).
   */
  const plainToJSON = Branch.prototype.toJSON;
  Branch.prototype.toJSON = function toJSON() {
    const { hoursJson, ...out } = plainToJSON.call(this);
    return { ...out, ...require('../../services/branch-hours.service').readFields({ ...out, hoursJson }) };
  };

  return Branch;
};

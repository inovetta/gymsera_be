const { DataTypes } = require('sequelize');
const { TenantStatus, KycStatus } = require('../../constants/subscription-status');

module.exports = (sequelize) => {
  return sequelize.define(
    'Tenant',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantCode: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },
      businessName: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      // FK to users.id — set in associations
      ownerUserId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      phone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
      cityId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // ── Gym profile (pre-approval snapshot) ─────────────────────────────────
      gymName: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      gymDescription: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      logoUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      coverImageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      genderType: {
        type: DataTypes.ENUM('MIXED', 'MALE_ONLY', 'FEMALE_ONLY'),
        allowNull: true,
      },
      // ── Onboarding workflow ──────────────────────────────────────────────────
      status: {
        type: DataTypes.ENUM(...Object.values(TenantStatus)),
        allowNull: false,
        defaultValue: TenantStatus.PENDING_REVIEW,
      },
      kycStatus: {
        type: DataTypes.ENUM(...Object.values(KycStatus)),
        allowNull: false,
        defaultValue: KycStatus.NOT_SUBMITTED,
      },
      // Step 1=registered, 2=profile submitted, 3=package selected
      onboardingStep: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
      },
      kycDocumentsJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of uploaded document URLs',
      },
      selectedPackageId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      approvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      approvedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      rejectedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      rejectedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      rejectionReason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // ── Tenant DB info (populated after provisioning) ────────────────────────
      dbName: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      connectionStringEncrypted: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'AES-256-CBC encrypted MySQL connection URL',
      },
    },
    {
      tableName: 'tenants',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['tenant_code'] },
        { fields: ['owner_user_id'] },
        { fields: ['status'] },
        { fields: ['city_id'] },
      ],
    }
  );
};

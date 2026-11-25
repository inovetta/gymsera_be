const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'GymListing',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // References the approved tenant
      organizationId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // References the primary branch in the tenant DB (stored as value — cross-DB reference)
      primaryBranchId: {
        field: 'primary_branch_id', // R-120 NEW-306 (p033)
        type: DataTypes.UUID,
        allowNull: true,
      },
      cityId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      areaId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // NEW-265 (R-108, R-109, migration p032): the gym's own area marker. While an area request is
      // pending or was rejected, area_id stays NULL; `rejected` is cleared when the host picks again.
      areaStatus: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      areaRequestId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      name: {
        field: 'name', // R-120 NEW-306 (p033)
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      description: {
        field: 'description', // R-120 NEW-306 (p033)
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
      averageRating: {
        type: DataTypes.DECIMAL(3, 2),
        defaultValue: 0.0,
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      },
      isFeatured: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      contactPhone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
      website: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      facilitiesJson: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      imagesJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of cover/gallery image URLs shown in the public listing',
      },
      category: {
        type: DataTypes.STRING(50),
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
      postalCode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'postal_code',
      },
      country: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      minPrice: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0.0,
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'PENDING', 'DRAFT', 'REJECTED'),
        allowNull: false,
        defaultValue: 'DRAFT',
      },
      // Units of the tenant's branch-count subscription earmarked for this
      // organization but not yet built into a real Branch — e.g. a host buys
      // a 2-branch plan, builds 1 branch immediately, and the other unit sits
      // here until they either build it (gym.service.js#createBranch consumes
      // one reservedSlot instead of fresh capacity when this org has any) or
      // move it to a different organization. Deliberately just a count, not
      // individually-tracked rows: an unbuilt slot has no branchName/address/
      // anything yet to distinguish one from another, and every real branch
      // already lives in a separate per-tenant database — adding a new
      // "unbuilt" status there would mean a schema migration across every
      // tenant's database for a distinction that carries no real data.
      reservedSlots: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      // A complete first branch is held here while the business awaits approval.
      firstBranchDraft: {
        field: 'first_branch_draft_json',
        type: DataTypes.JSON,
        allowNull: true,
      },
      rejectionReason: {
        type: DataTypes.TEXT,
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
    },
    {
      tableName: 'business_listings', // R-120 NEW-306 (p033); attribute names change with the API (NEW-309)
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['city_id', 'area_id', 'status'] },
        { fields: ['organization_id'] },
        { fields: ['is_featured'] },
        { fields: ['gender_type'] },
      ],
    }
  );
};

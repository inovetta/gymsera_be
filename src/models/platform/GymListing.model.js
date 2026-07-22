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
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // References the primary branch in the tenant DB (stored as value — cross-DB reference)
      branchId: {
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
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      shortDescription: {
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
      tableName: 'gym_listings',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['city_id', 'area_id', 'status'] },
        { fields: ['tenant_id'] },
        { fields: ['is_featured'] },
        { fields: ['gender_type'] },
      ],
    }
  );
};

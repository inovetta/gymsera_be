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
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'PENDING'),
        allowNull: false,
        defaultValue: 'PENDING',
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

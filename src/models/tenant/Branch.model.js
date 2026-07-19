const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
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
      openingTime: {
        type: DataTypes.TIME,
        allowNull: true,
      },
      closingTime: {
        type: DataTypes.TIME,
        allowNull: true,
      },
      phone: {
        type: DataTypes.STRING(25),
        allowNull: true,
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
};

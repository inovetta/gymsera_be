const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'PlatformPackage',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      billingCycle: {
        type: DataTypes.ENUM('MONTHLY', 'QUARTERLY', 'YEARLY'),
        allowNull: false,
        defaultValue: 'MONTHLY',
      },
      maxBranches: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      maxTrainers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 5,
      },
      maxMembers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 200,
      },
      featureFlagsJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Object of feature flags enabled for this package tier',
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
    },
    {
      tableName: 'platform_packages',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['status'] }],
    }
  );
};

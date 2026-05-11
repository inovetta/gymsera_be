const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Gym',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      contactPhone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
      contactEmail: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      website: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      genderType: {
        type: DataTypes.ENUM('MIXED', 'MALE_ONLY', 'FEMALE_ONLY'),
        allowNull: false,
        defaultValue: 'MIXED',
      },
      logoUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      coverImageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      socialLinksJson: {
        type: DataTypes.JSON,
        allowNull: true,
      },
    },
    {
      tableName: 'gyms',
      underscored: true,
      timestamps: true,
    }
  );
};

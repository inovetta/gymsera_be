const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'City',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      imageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // Phase 7 P3: set when the city is picked from Google Places (migration p024).
      googlePlaceId: {
        type: DataTypes.STRING(255),
        allowNull: true,
        unique: 'cities_google_place_id',
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      },
      // ISO 3166-1 alpha-2 from Google (e.g. 'PK'); keeps Places search in the city's country (p025).
      countryCode: {
        type: DataTypes.STRING(2),
        allowNull: true,
      },
    },
    {
      tableName: 'cities',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['is_active'] }],
    }
  );
};

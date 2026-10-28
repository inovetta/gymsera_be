const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Area',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      cityId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      imageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // Phase 7 P3: set when the area is picked from Google Places (migration p024).
      googlePlaceId: {
        type: DataTypes.STRING(255),
        allowNull: true,
        unique: 'areas_google_place_id',
      },
    },
    {
      tableName: 'areas',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['city_id'] }],
    }
  );
};

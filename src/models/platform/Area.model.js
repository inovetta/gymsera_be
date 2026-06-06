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
    },
    {
      tableName: 'areas',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['city_id'] }],
    }
  );
};

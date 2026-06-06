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
    },
    {
      tableName: 'cities',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['is_active'] }],
    }
  );
};

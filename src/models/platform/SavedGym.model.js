const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'SavedGym',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      gymListingId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      tableName: 'saved_gyms',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['user_id', 'gym_listing_id'] },
        { fields: ['user_id'] },
      ],
    }
  );
};

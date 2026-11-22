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
        field: 'business_id', // R-120 NEW-306 (p033)
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      tableName: 'saved_businesses', // R-120 NEW-306 (p033)
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['user_id', 'business_id'] },
        { fields: ['user_id'] },
      ],
    }
  );
};

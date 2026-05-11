const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'GymStaff',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Platform user ID (cross-DB reference — no FK constraint)
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      designation: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      employmentStatus: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'TERMINATED'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
    },
    {
      tableName: 'gym_staff',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['branch_id'] },
        { fields: ['user_id'] },
      ],
    }
  );
};

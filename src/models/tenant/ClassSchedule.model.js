const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'ClassSchedule',
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
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      instructor: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      time: {
        type: DataTypes.STRING(100), // e.g. "07:00 AM - 08:00 AM"
        allowNull: false,
      },
      day: {
        type: DataTypes.STRING(10), // e.g. "Mon", "Tue"
        allowNull: false,
      },
      currentCapacity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      maxCapacity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 20,
      },
    },
    {
      tableName: 'class_schedules',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['branch_id', 'day'] },
      ],
    }
  );
};

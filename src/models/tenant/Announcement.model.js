const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Announcement',
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
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      tag: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'SENT TO ALL MEMBERS',
      },
      status: {
        type: DataTypes.ENUM('draft', 'sent'),
        allowNull: false,
        defaultValue: 'sent',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      tableName: 'announcements',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['branch_id'] },
        { fields: ['created_at'] },
      ],
    }
  );
};

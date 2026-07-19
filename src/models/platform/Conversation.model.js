const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Conversation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      type: {
        type: DataTypes.ENUM('MEMBER', 'INQUIRY'),
        allowNull: false,
        defaultValue: 'INQUIRY',
      },
      lastMessageText: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      lastMessageAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      unreadCountHost: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      unreadCountUser: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: 'conversations',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'conversations_tenant_id', fields: ['tenant_id'] },
        { name: 'conversations_branch_id', fields: ['branch_id'] },
        { name: 'conversations_user_id', fields: ['user_id'] },
        { name: 'conversations_last_message_at', fields: ['last_message_at'] },
      ],
    }
  );
};

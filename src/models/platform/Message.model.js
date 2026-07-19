const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Message',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      conversationId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      senderId: {
        type: DataTypes.UUID,
        allowNull: true, // Null for system messages
      },
      senderType: {
        type: DataTypes.ENUM('USER', 'HOST', 'SYSTEM'),
        allowNull: false,
        defaultValue: 'USER',
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      isRead: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: 'messages',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'messages_conversation_id', fields: ['conversation_id'] },
        { name: 'messages_sender_id', fields: ['sender_id'] },
        { name: 'messages_created_at', fields: ['created_at'] },
      ],
    }
  );
};

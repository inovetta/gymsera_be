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
      // Client-generated idempotency key (RT-05). NULL for system messages and old rows.
      clientMessageId: {
        type: DataTypes.STRING(64),
        allowNull: true,
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
        {
          name: 'messages_conversation_sender_client_msg',
          unique: true,
          fields: ['conversation_id', 'sender_id', 'client_message_id'],
        },
      ],
    }
  );
};

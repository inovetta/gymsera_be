const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'CapacityOutbox',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      eventType: {
        type: DataTypes.STRING(60),
        allowNull: false,
        field: 'event_type',
      },
      payloadJson: {
        type: DataTypes.JSON,
        allowNull: false,
        field: 'payload_json',
      },
      idempotencyKey: {
        type: DataTypes.STRING(191),
        allowNull: false,
        unique: true,
        field: 'idempotency_key',
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'PROCESSED', 'FAILED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      lastError: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'last_error',
      },
      processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'processed_at',
      },
    },
    {
      tableName: 'capacity_outbox',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['status'] },
        { fields: ['idempotency_key'], unique: true },
      ],
    }
  );
};

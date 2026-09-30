const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const IdempotencyRecord = sequelize.define(
    'IdempotencyRecord',
    {
      id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      idempotencyKey: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'idempotency_key',
      },
      userId: {
        type: DataTypes.CHAR(36),
        allowNull: true,
        field: 'user_id',
      },
      route: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      requestHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'request_hash',
      },
      status: {
        type: DataTypes.ENUM('IN_PROGRESS', 'RESOLVED', 'FAILED'),
        allowNull: false,
        defaultValue: 'IN_PROGRESS',
      },
      statusCode: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'status_code',
      },
      responseBody: {
        type: DataTypes.TEXT('medium'),
        allowNull: true,
        field: 'response_body',
        get() {
          const raw = this.getDataValue('responseBody');
          if (!raw) return null;
          try {
            return JSON.parse(raw);
          } catch (_) {
            return raw;
          }
        },
        set(val) {
          if (val === null || val === undefined) {
            this.setDataValue('responseBody', null);
          } else if (typeof val === 'string') {
            this.setDataValue('responseBody', val);
          } else {
            this.setDataValue('responseBody', JSON.stringify(val));
          }
        },
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
    },
    {
      tableName: 'idempotency_records',
      timestamps: true,
      underscored: true,
      indexes: [
        { unique: true, fields: ['idempotency_key'], name: 'idx_idempotency_records_key' },
        { fields: ['expires_at'], name: 'idx_idempotency_records_expires_at' },
      ],
    }
  );

  return IdempotencyRecord;
};

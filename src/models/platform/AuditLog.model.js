'use strict';

const { DataTypes } = require('sequelize');

/**
 * Platform AuditLog Model (SEC-12).
 *
 * Appends a structured audit record for mutating HTTP API requests on Platform DB.
 * Maps to table `audit_logs` in the platform database.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'AuditLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'user_id',
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'tenant_id',
      },
      method: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      path: {
        type: DataTypes.STRING(500),
        allowNull: false,
      },
      statusCode: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        field: 'status_code',
      },
      ipAddress: {
        type: DataTypes.STRING(45),
        allowNull: true,
        field: 'ip_address',
      },
      userAgent: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'user_agent',
      },
      durationMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'duration_ms',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'created_at',
      },
    },
    {
      tableName: 'audit_logs',
      underscored: true,
      timestamps: false,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['tenant_id'] },
        { fields: ['created_at'] },
      ],
    }
  );
};

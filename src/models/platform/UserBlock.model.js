'use strict';
const { DataTypes } = require('sequelize');

/**
 * NEW-256: a block between a traveller (`user_id`) and a gym (`tenant_id`). `blocked_by` says which
 * side did it (USER: the traveller blocked the gym; TENANT: the gym blocked the traveller). While
 * any row exists for the pair, messages are refused both ways; the conversation is hidden only for
 * the side that blocked. Table created by platform migration p031.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'UserBlock',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      blockedBy: { type: DataTypes.STRING(16), allowNull: false }, // R-120 NEW-307: 16 (was 8, F6); values USER | ORGANIZATION
      createdByUserId: { type: DataTypes.UUID, allowNull: false },
    },
    {
      tableName: 'user_blocks',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'user_blocks_pair_side', unique: true, fields: ['user_id', 'tenant_id', 'blocked_by'] },
        { name: 'user_blocks_tenant_id', fields: ['tenant_id'] },
      ],
    }
  );

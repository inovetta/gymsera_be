'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'TenantInvitation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tokenHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'token_hash',
      },
      ownerEmail: {
        type: DataTypes.STRING(150),
        allowNull: false,
        field: 'owner_email',
      },
      ownerFullName: {
        type: DataTypes.STRING(150),
        allowNull: false,
        field: 'owner_full_name',
      },
      ownerPhone: {
        type: DataTypes.STRING(25),
        allowNull: true,
        field: 'owner_phone',
      },
      businessName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'organization_name',
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      phone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
      cityId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'city_id',
      },
      packageId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'package_id',
      },
      invitedBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'invited_by',
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'),
        defaultValue: 'PENDING',
        allowNull: false,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      acceptedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'accepted_at',
      },
      organizationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'organization_id',
      },
    },
    {
      tableName: 'organization_invitations', // R-120 NEW-307 (p034)
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['token_hash'] },
        { fields: ['owner_email'] },
        { fields: ['status'] },
      ],
    }
  );
};

'use strict';
const { DataTypes } = require('sequelize');

/**
 * NEW-265 Part A (R-108): a typed area, or a Google road / landmark, waiting for a platform admin
 * (CMS › Cities & Areas › Unmatched areas). Never an official area until approved or merged.
 * `openKey` (`<user>:<city>:<nameKey>` while pending, NULL once decided) makes one open request per
 * person, city and spelling. Created by platform migration p032.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'AreaRequest',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      cityId: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(60), allowNull: false },
      nameKey: { type: DataTypes.STRING(60), allowNull: false },
      source: { type: DataTypes.ENUM('typed', 'google_road', 'google_landmark'), allowNull: false, defaultValue: 'typed' },
      googlePlaceId: { type: DataTypes.STRING(255), allowNull: true },
      status: {
        type: DataTypes.ENUM('pending_review', 'approved', 'merged', 'rejected'),
        allowNull: false,
        defaultValue: 'pending_review',
      },
      openKey: { type: DataTypes.STRING(120), allowNull: true },
      resolvedAreaId: { type: DataTypes.INTEGER, allowNull: true },
      requestedByUserId: { type: DataTypes.CHAR(36).BINARY, allowNull: false },
      rejectReason: { type: DataTypes.STRING(300), allowNull: true },
      decidedBy: { type: DataTypes.CHAR(36).BINARY, allowNull: true },
      decidedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'area_requests',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'area_requests_open_key', unique: true, fields: ['open_key'] },
        { name: 'area_requests_city_id_status', fields: ['city_id', 'status'] },
        { name: 'area_requests_requested_by_user_id_created_at', fields: ['requested_by_user_id', 'created_at'] },
      ],
    }
  );

'use strict';
const { DataTypes } = require('sequelize');

/**
 * NEW-265 Part A (R-108, R-109): one location waiting on an area request. `target`:
 *   tenant      – the organisation (tenants row; targetId = tenant id)
 *   main_branch – the draft first branch in tenants.main_branch_data_json (targetId = tenant id);
 *                 provisioning turns it into a `branch` link
 *   listing     – a gym_listings row
 *   branch      – a branches row in the tenant database (no tenant migration needed)
 * UNIQUE (target, tenant_id, target_id): a location waits on at most one request. `propagatedAt` is set
 * once an approval / merge wrote the area to the row; `propagationError` keeps why it could not.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'AreaRequestLink',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      areaRequestId: { type: DataTypes.INTEGER, allowNull: false },
      tenantId: { type: DataTypes.CHAR(36).BINARY, allowNull: false },
      target: { type: DataTypes.ENUM('organization', 'first_branch_draft', 'business', 'branch'), allowNull: false }, // R-120 NEW-307 (p034): was tenant, main_branch, listing
      targetId: { type: DataTypes.STRING(36), allowNull: false },
      propagatedAt: { type: DataTypes.DATE, allowNull: true },
      propagationError: { type: DataTypes.STRING(300), allowNull: true },
    },
    {
      tableName: 'area_request_links',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'area_request_links_target', unique: true, fields: ['target', 'tenant_id', 'target_id'] },
        { name: 'area_request_links_area_request_id', fields: ['area_request_id'] },
      ],
    }
  );

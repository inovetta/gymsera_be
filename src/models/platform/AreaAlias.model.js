'use strict';
const { DataTypes } = require('sequelize');

/**
 * NEW-265 Part A (R-108 point 3): another spelling of an area in one city (a merged or corrected request).
 * The next time someone types it, the area answers. Created by platform migration p032.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'AreaAlias',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      cityId: { type: DataTypes.INTEGER, allowNull: false },
      aliasKey: { type: DataTypes.STRING(60), allowNull: false },
      areaId: { type: DataTypes.INTEGER, allowNull: false },
      createdBy: { type: DataTypes.CHAR(36).BINARY, allowNull: true },
    },
    {
      tableName: 'area_aliases',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'area_aliases_city_alias', unique: true, fields: ['city_id', 'alias_key'] },
        { name: 'area_aliases_area_id', fields: ['area_id'] },
      ],
    }
  );

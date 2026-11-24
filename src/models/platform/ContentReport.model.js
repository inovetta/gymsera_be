'use strict';
const { DataTypes } = require('sequelize');
const { ReportStatus } = require('../../constants/moderation');

/**
 * NEW-256: a person reports a review or a chat message. Platform admins act on it in the CMS.
 * Table created by platform migration p031. One report per reporter and target (a repeat is the
 * same report). `snapshot_text` keeps what was reported, so the evidence survives a deletion.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'ContentReport',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      reporterUserId: { type: DataTypes.UUID, allowNull: false },
      targetType: { type: DataTypes.STRING(16), allowNull: false },
      targetId: { type: DataTypes.UUID, allowNull: false },
      targetUserId: { type: DataTypes.UUID, allowNull: true },
      conversationId: { type: DataTypes.UUID, allowNull: true },
      organizationId: { type: DataTypes.UUID, allowNull: true },
      reason: { type: DataTypes.STRING(32), allowNull: false },
      note: { type: DataTypes.STRING(500), allowNull: true },
      snapshotText: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: ReportStatus.OPEN },
      action: { type: DataTypes.STRING(32), allowNull: true },
      adminNote: { type: DataTypes.STRING(500), allowNull: true },
      handledByUserId: { type: DataTypes.UUID, allowNull: true },
      handledAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'content_reports',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'content_reports_reporter_target', unique: true, fields: ['reporter_user_id', 'target_type', 'target_id'] },
        { name: 'content_reports_status_created_at', fields: ['status', 'created_at'] },
        { name: 'content_reports_target', fields: ['target_type', 'target_id'] },
      ],
    }
  );

'use strict';
const { DataTypes } = require('sequelize');

/**
 * NEW-256: one word of the filter checked on chat messages and reviews. Seeded by platform
 * migration p031 (STARTER_WORDS), edited by platform admins in the CMS.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'ModerationWord',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      word: { type: DataTypes.STRING(50), allowNull: false },
    },
    {
      tableName: 'moderation_words',
      underscored: true,
      timestamps: true,
      indexes: [{ name: 'moderation_words_word', unique: true, fields: ['word'] }],
    }
  );

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'RefreshToken',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      token: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      isRevoked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      ipAddress: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      userAgent: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
    },
    {
      tableName: 'refresh_tokens',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['is_revoked'] },
        { fields: ['expires_at'] },
      ],
    }
  );
};

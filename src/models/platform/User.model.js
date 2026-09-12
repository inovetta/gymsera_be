const { DataTypes } = require('sequelize');
const { UserRole } = require('../../constants/roles');

module.exports = (sequelize) => {
  return sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      fullName: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
        validate: { isEmail: true },
      },
      phone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
      // Null for social-only accounts
      passwordHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      role: {
        type: DataTypes.ENUM(...Object.values(UserRole)),
        allowNull: false,
        defaultValue: UserRole.MEMBER,
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED'),
        allowNull: false,
        defaultValue: 'INACTIVE',
      },
      isVerified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      googleId: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'google_id',
      },
      profileImageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'profile_image_url',
      },
      isHost: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_host',
      },
      // Bumped on any change to this user's access. Embedded in the permission
      // cache key, so bumping it orphans every stale entry instantly — no cache
      // scanning, and no window in which a revoked manager can still act.
      permissionVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'permission_version',
      },
    },
    {
      tableName: 'users',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'users_email_unique', unique: true, fields: ['email'] },
        { name: 'users_role', fields: ['role'] },
        { name: 'users_status', fields: ['status'] },
        { name: 'users_google_id', fields: ['google_id'] },
      ],
    }
  );
};

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
        unique: true,
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
      },
      profileImageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
    },
    {
      tableName: 'users',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['email'] },
        { fields: ['role'] },
        { fields: ['status'] },
        { fields: ['google_id'] },
      ],
    }
  );
};

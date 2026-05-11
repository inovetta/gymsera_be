const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'MemberProfile',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Platform user ID (cross-DB reference)
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
      },
      dateOfBirth: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      gender: {
        type: DataTypes.ENUM('MALE', 'FEMALE', 'OTHER'),
        allowNull: true,
      },
      heightCm: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
      },
      weightKg: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
      },
      fitnessGoal: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      medicalNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      emergencyContactName: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      emergencyContactPhone: {
        type: DataTypes.STRING(25),
        allowNull: true,
      },
    },
    {
      tableName: 'member_profiles',
      underscored: true,
      timestamps: true,
      indexes: [{ unique: true, fields: ['user_id'] }],
    }
  );
};

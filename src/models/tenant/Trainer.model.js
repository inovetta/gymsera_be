const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Trainer',
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
      },
      // null = not assigned to a specific branch
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      specialization: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      bio: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      yearsExperience: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      certificationsJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of certification strings or objects',
      },
      availabilityJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Weekly availability schedule object',
      },
      ratingAvg: {
        type: DataTypes.DECIMAL(3, 2),
        defaultValue: 0.0,
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
    },
    {
      tableName: 'trainers',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['branch_id'] },
        { fields: ['status'] },
      ],
    }
  );
};

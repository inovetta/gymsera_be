const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'GymReview',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      businessId: {
        field: 'business_id', // R-120 NEW-306 (p033)
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Branch-level identifier — reviews are scoped per branch, not per organization
      branchId: {
        type: DataTypes.UUID,
        allowNull: true, // nullable for backward-compat with old reviews
      },
      // Platform user who submitted the review
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // The tenant the user is subscribed to (for verification)
      organizationId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      rating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      title: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // PENDING → admin approves → APPROVED / REJECTED
      status: {
        type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
        defaultValue: 'APPROVED',
        allowNull: false,
      },
      adminNote: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
    },
    {
      tableName: 'business_reviews', // R-120 NEW-306 (p033)
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['business_id', 'status'] },
        { fields: ['branch_id', 'status'] },
        { fields: ['user_id'] },
        // One review per user per branch (branch-level uniqueness)
        { name: 'business_reviews_branch_user_unique', unique: true, fields: ['branch_id', 'user_id'] },
      ],
    }
  );
};

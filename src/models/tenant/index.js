/**
 * Tenant models factory.
 *
 * Called once per tenant connection (by TenantDbManager) with the tenant's
 * Sequelize instance. Registers all tenant-side models and their associations.
 *
 * Returns an object with all models so controllers can destructure what they need:
 *   const { Gym, Branch, MembershipPlan } = req.tenantDb.models;
 */
const registerTenantModels = (sequelize) => {
  const Gym = require('./Gym.model')(sequelize);
  const Branch = require('./Branch.model')(sequelize);
  const GymStaff = require('./GymStaff.model')(sequelize);
  const MemberProfile = require('./MemberProfile.model')(sequelize);
  const MembershipPlan = require('./MembershipPlan.model')(sequelize);
  const MemberSubscription = require('./MemberSubscription.model')(sequelize);
  const AttendanceLog = require('./AttendanceLog.model')(sequelize);
  const Payment = require('./Payment.model')(sequelize);
  const Invoice = require('./Invoice.model')(sequelize);
  const Trainer = require('./Trainer.model')(sequelize);

  // ── Associations ─────────────────────────────────────────────────────────────

  // Gym ↔ Branch
  Gym.hasMany(Branch, { foreignKey: 'gymId', as: 'branches', onDelete: 'CASCADE' });
  Branch.belongsTo(Gym, { foreignKey: 'gymId', as: 'gym' });

  // Branch ↔ GymStaff
  Branch.hasMany(GymStaff, { foreignKey: 'branchId', as: 'staff' });
  GymStaff.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // Gym ↔ MembershipPlan (gym-wide plans)
  Gym.hasMany(MembershipPlan, { foreignKey: 'gymId', as: 'membershipPlans' });
  MembershipPlan.belongsTo(Gym, { foreignKey: 'gymId', as: 'gym' });

  // Branch ↔ MembershipPlan (branch-specific plans)
  Branch.hasMany(MembershipPlan, { foreignKey: 'branchId', as: 'branchPlans' });
  MembershipPlan.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // Branch ↔ MemberSubscription
  Branch.hasMany(MemberSubscription, { foreignKey: 'branchId', as: 'subscriptions' });
  MemberSubscription.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // MembershipPlan ↔ MemberSubscription
  MembershipPlan.hasMany(MemberSubscription, { foreignKey: 'membershipPlanId', as: 'subscriptions' });
  MemberSubscription.belongsTo(MembershipPlan, { foreignKey: 'membershipPlanId', as: 'plan' });

  // MemberSubscription ↔ AttendanceLog
  MemberSubscription.hasMany(AttendanceLog, { foreignKey: 'memberSubscriptionId', as: 'attendanceLogs' });
  AttendanceLog.belongsTo(MemberSubscription, { foreignKey: 'memberSubscriptionId', as: 'subscription' });

  // Branch ↔ AttendanceLog
  Branch.hasMany(AttendanceLog, { foreignKey: 'branchId', as: 'attendanceLogs' });
  AttendanceLog.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // Branch ↔ Trainer
  Branch.hasMany(Trainer, { foreignKey: 'branchId', as: 'trainers' });
  Trainer.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  return {
    Gym,
    Branch,
    GymStaff,
    MemberProfile,
    MembershipPlan,
    MemberSubscription,
    AttendanceLog,
    Payment,
    Invoice,
    Trainer,
  };
};

module.exports = registerTenantModels;

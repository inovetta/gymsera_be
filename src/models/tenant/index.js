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
  const Announcement = require('./Announcement.model')(sequelize);
  const ClassSchedule = require('./ClassSchedule.model')(sequelize);
  const BranchVisibilityHistory = require('./BranchVisibilityHistory.model')(sequelize);
  const StaffActionRequest = require('./StaffActionRequest.model')(sequelize);
  const ExpenseCategory = require('./ExpenseCategory.model')(sequelize);
  const Expense = require('./Expense.model')(sequelize);

  // ── Associations ─────────────────────────────────────────────────────────────

  // Gym ↔ Branch
  Gym.hasMany(Branch, { foreignKey: 'gymId', as: 'branches', onDelete: 'CASCADE' });
  Branch.belongsTo(Gym, { foreignKey: 'gymId', as: 'gym' });

  // Branch ↔ BranchVisibilityHistory
  Branch.hasMany(BranchVisibilityHistory, { foreignKey: 'branchId', as: 'visibilityHistory', onDelete: 'CASCADE' });
  BranchVisibilityHistory.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

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
  MemberSubscription.belongsTo(MembershipPlan, { foreignKey: 'pendingPlanId', as: 'pendingPlan' });

  // MemberSubscription ↔ AttendanceLog
  MemberSubscription.hasMany(AttendanceLog, { foreignKey: 'memberSubscriptionId', as: 'attendanceLogs' });
  AttendanceLog.belongsTo(MemberSubscription, { foreignKey: 'memberSubscriptionId', as: 'subscription' });

  // Branch ↔ AttendanceLog
  Branch.hasMany(AttendanceLog, { foreignKey: 'branchId', as: 'attendanceLogs' });
  AttendanceLog.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // Branch ↔ Trainer
  Branch.hasMany(Trainer, { foreignKey: 'branchId', as: 'trainers' });
  Trainer.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // Branch ↔ Announcement
  Branch.hasMany(Announcement, { foreignKey: 'branchId', as: 'announcements', onDelete: 'CASCADE' });
  Announcement.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // Branch ↔ ClassSchedule
  Branch.hasMany(ClassSchedule, { foreignKey: 'branchId', as: 'classSchedules', onDelete: 'CASCADE' });
  ClassSchedule.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // GymStaff ↔ StaffActionRequest
  GymStaff.hasMany(StaffActionRequest, { foreignKey: 'staffId', as: 'actionRequests', onDelete: 'CASCADE' });
  StaffActionRequest.belongsTo(GymStaff, { foreignKey: 'staffId', as: 'staff' });

  // Branch ↔ Expense
  Branch.hasMany(Expense, { foreignKey: 'branchId', as: 'expenses', onDelete: 'CASCADE' });
  Expense.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  // ExpenseCategory ↔ Expense
  ExpenseCategory.hasMany(Expense, { foreignKey: 'categoryId', as: 'expenses' });
  Expense.belongsTo(ExpenseCategory, { foreignKey: 'categoryId', as: 'category' });

  // Expense ↔ Expense (Self-referencing for recurring templates)
  Expense.hasMany(Expense, { foreignKey: 'recurringTemplateId', as: 'generatedInstances' });
  Expense.belongsTo(Expense, { foreignKey: 'recurringTemplateId', as: 'template' });

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
    Announcement,
    ClassSchedule,
    BranchVisibilityHistory,
    StaffActionRequest,
    ExpenseCategory,
    Expense,
  };
};

module.exports = registerTenantModels;

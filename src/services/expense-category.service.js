const DEFAULT_CATEGORIES = [
  'Rent',
  'Utilities',
  'Equipment Purchase/Repair',
  'Staff Wages',
  'Maintenance',
  'Marketing',
  'Insurance',
  'Supplies',
  'Software/Subscriptions',
  'Other',
];

/**
  * Ensure default system expense categories exist for a tenant DB.
  */
const ensureDefaultCategories = async (tenantDb) => {
  const { ExpenseCategory } = tenantDb.models;
  const count = await ExpenseCategory.count({ where: { isSystem: true } });
  if (count === 0) {
    const categoriesToCreate = DEFAULT_CATEGORIES.map((name) => ({
      name,
      isSystem: true,
      gymId: null,
    }));
    await ExpenseCategory.bulkCreate(categoriesToCreate);
  }
};

module.exports = {
  DEFAULT_CATEGORIES,
  ensureDefaultCategories,
};

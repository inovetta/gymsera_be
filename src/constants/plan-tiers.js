/**
 * Hosting plan tier names (Phase 7 P2, BUG-24).
 *
 * The hosting plan is a branch count (BillingPlan.branchCount); there is no
 * "Starter" product. A tier name is only a label over a range of branch counts.
 * This is the one table: the API sends the resolved name (host-status.service.js)
 * so no client keeps its own copy. The ranges are the ones the mobile plan picker
 * already showed (branch_plan_picker_screen.dart), the product reference (§0.5).
 *
 * `maxBranches: null` = no upper bound (kept JSON-safe, no Infinity).
 */
const PLAN_TIERS = [
  { key: 'STARTER', name: 'Starter', minBranches: 1, maxBranches: 1 },
  { key: 'PROFESSIONAL', name: 'Professional', minBranches: 2, maxBranches: 4 },
  { key: 'GROWTH', name: 'Growth', minBranches: 5, maxBranches: 7 },
  { key: 'SCALE', name: 'Scale', minBranches: 8, maxBranches: null },
];

/** The tier for a branch count, or null when there is no plan (0, null, not a number). */
const tierForBranchCount = (branchCount) => {
  const n = Number(branchCount);
  if (branchCount == null || !Number.isFinite(n) || n < 1) return null;
  return PLAN_TIERS.find((t) => n >= t.minBranches && (t.maxBranches == null || n <= t.maxBranches)) || null;
};

module.exports = { PLAN_TIERS, tierForBranchCount };

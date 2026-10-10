# NEW-60: monthly report and exports permission gating and branch scoping

- **Issue ID**: NEW-60
- **Title**: `GET /reports/monthly`, `/monthly/export-pdf`, `/monthly/print-layout`, `/monthly/export` missing `dashboard.revenue.view` check and branch scope
- **Status**: RESOLVED

## Root cause

In `src/routes/reports.routes.js:76-136`:
- `GET /reports/monthly`
- `GET /reports/monthly/export-pdf`
- `GET /reports/monthly/print-layout`
- `GET /reports/monthly/export`
were guarded only by `authorize('GYM_HOST', 'BRANCH_MANAGER')`.
Because `src/middleware/tenantContext.js:41-82` sets `req.user.role = 'BRANCH_MANAGER'` for any team member holding any active role assignment, every team member (including Front Desk, Trainers, Support) passed the check.
Additionally, `reports.service.js#monthlyBreakdown` aggregated whole-organization data across all active branches without any branch filtering, exposing organization-wide daily revenue, new subscriptions, and attendance to branch-scoped users.

## What changed

1. `src/routes/reports.routes.js`: added `can.atAnyBranch('dashboard.revenue.view')` to all 4 routes (`/monthly`, `/monthly/export-pdf`, `/monthly/print-layout`, `/monthly/export`), matching the pattern of `/reports/yearly` (NEW-44).
2. `src/controllers/reports.controller.js`: in `monthlyBreakdown`, `monthlyExportPdf`, and `monthlyPrintLayout`, scoped the request using `resolveBranchScope(req, req.query.branchId, 'dashboard.revenue.view', 'revenue')`. If a `branchId` is passed, `hasBranchAccess` verifies access (403 if unauthorized). Passed `{ ...req.query, branchId: scope.branchId, branchIds: scope.branchIds }` to `reportsService.monthlyBreakdown`.
3. `src/services/reports.service.js`: updated `monthlyBreakdown` to apply branch filtering (`branchId` if provided, `branchId IN (branchIds)` if scoped, or whole organization if `branchIds` is `null` for org-wide holders / owners) across `Payment`, `MemberSubscription`, and `AttendanceLog` queries.

## Tests

`tests/regression/new-58-59-60-payouts-reports-collected.test.js`:
- Front Desk with `dashboard.revenue.view` OFF gets 403 on all 4 routes.
- Manager of 1 branch gets 200 at their own branch (positive control) and 403 at another branch on all 4 routes.
- Manager of 3 branches gets 200 at each permitted branch and when querying without a branchId.
- Owner gets 200 with whole organization figures.
- Returned figures are properly scoped (manager of 1 branch sees only their branch's takings; manager of 3 branches sees the 3-branch total).

## Clients that might depend on old behaviour

- **CMS**: Prompt 3C updated the CMS reports page to display the unscoped organization-wide monthly breakdown only to org-wide holders. With this backend fix, the API boundary enforces the same rule directly. Branch-scoped users without revenue permission opening the URL will now receive 403.
- **Mobile**: `reports_repository.dart` calls `ApiConstants.reportsMonthly`. Team members without `dashboard.revenue.view` will receive 403 (consistent with `/reports/yearly` and `/reports/dashboard` from NEW-44) rather than seeing entire organization revenue.

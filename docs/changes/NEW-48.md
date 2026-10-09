# NEW-48: GET /gyms/members for a multi-branch Branch Manager

- **Issue ID**: NEW-48
- **Title**: `GET /gyms/members` for a multi-branch Branch Manager
- **Status**: RESOLVED (tests green; full suite passing 3x)

---

## 1. Summary & Problem Statement

When a Branch Manager assigned to multiple branches accessed `GET /gyms/members` (e.g. from the CMS or mobile), they could only see members at their first assigned branch, or zero members if active subscriptions were at other branches. Meanwhile, the dashboard showed active members across all their managed branches.

Furthermore, `GET /gyms/members` sat behind `authorize('GYM_HOST', 'BRANCH_MANAGER')` without validating `members.view` permissions, and supplied `?branchId=...` query parameters were ignored for Branch Managers because a legacy override unconditionally overwrote `branchId` with `req.user.branchId`.

---

## 2. Root Cause

1. **Legacy `req.user.branchId` override in controller**:
   In `src/controllers/gyms.controller.js:279-281`:
   ```javascript
   if (req.user.role === 'BRANCH_MANAGER') {
     branchId = req.user.branchId;
   }
   ```
   `req.user.branchId` was derived in `src/middleware/tenantContext.js:81` as `linkedBranchIds[0] || null`. For any multi-branch staff member, this collapsed all branch assignments down to only the very first branch, discarding other branch assignments and overriding any explicit `?branchId` query filter.

2. **Single-branch service limitation**:
   `gymService.listMembers` in `src/services/gym.service.js:1545-1565` only accepted a scalar `branchId`. If `branchId` was provided, it filtered by `branchId`; if omitted, it queried all active branches across the entire tenant. It lacked support for scoping to a subset array of permitted `branchIds`.

3. **Missing route permission middleware**:
   `src/routes/gyms.routes.js:320` mounted `router.get('/members', gymsController.listMembers)` without `can.atAnyBranch('members.view')`. Through the `tenantContext` role shim, every staff member passes `authorize('GYM_HOST', 'BRANCH_MANAGER')`, meaning a staff user (e.g., Front Desk) with `members.view` turned off could still access the member list.

---

## 3. Changes Made

### A. Route (`src/routes/gyms.routes.js`)
- Added `can.atAnyBranch('members.view')` to `router.get('/members', ...)`:
  ```javascript
  // NEW-48: listing members requires members.view at one or more branches.
  router.get('/members', can.atAnyBranch('members.view'), gymsController.listMembers);
  ```
  This immediately blocks callers who lack `members.view` at all branches with a `403 Forbidden` (`You do not have permission to view members here`) and attaches `req.permittedBranchIds`.

### B. Controller (`src/controllers/gyms.controller.js`)
- Imported `branchIdsWithPermission` from `../utils/branchAccess.utils`.
- Removed legacy `if (req.user.role === 'BRANCH_MANAGER') branchId = req.user.branchId;` override.
- Added explicit verification when `branchId` is passed in query:
  ```javascript
  if (branchId) {
    if (!(await hasBranchAccess(req, branchId, 'members.view'))) {
      throw createError('You do not have permission to view members at this branch', 403);
    }
  } else {
    branchIds = req.permittedBranchIds !== undefined
      ? req.permittedBranchIds
      : await branchIdsWithPermission(req, 'members.view');
  }
  ```
- Passed `branchId` and `branchIds` to `gymService.listMembers`.

### C. Service (`src/services/gym.service.js`)
- Updated `listMembers` signature to accept `branchIds`:
  ```javascript
  const listMembers = async (tenantDb, tenantId, { q, status, branchId, branchIds, page, limit, offset }) => {
  ```
- Added filtering for `branchIds` array:
  ```javascript
  if (branchId) {
    if (!activeBranchIds.includes(branchId)) {
      return { members: [], pagination: buildPagination(0, page, limit) };
    }
    subWhere.branchId = branchId;
  } else if (Array.isArray(branchIds)) {
    const allowed = branchIds.filter((id) => activeBranchIds.includes(id));
    if (allowed.length === 0) {
      return { members: [], pagination: buildPagination(0, page, limit) };
    }
    subWhere.branchId = { [Op.in]: allowed };
  } else {
    subWhere.branchId = { [Op.in]: activeBranchIds };
  }
  ```

---

## 4. Audit: Other Routes Still Using `req.user.branchId` or Missing Branch Scoping

As instructed, other routes still relying on `req.user.branchId` or lacking branch scoping for staff were audited. **Only `GET /gyms/members` was modified in NEW-48.**

| File & Line | Route | Today's Behaviour | Should Require |
|---|---|---|---|
| `src/middleware/tenantContext.js:81` | (Middleware) | Sets `user.branchId = branchId && linkedBranchIds.includes(branchId) ? branchId : linkedBranchIds[0] || null` for backward compatibility. | Keep for legacy callers; transition remaining routes to `branchIdsWithPermission` / `can()`. |
| `src/routes/subscriptions.routes.js:160`<br>`src/controllers/subscriptions.controller.js:90` | `GET /subscriptions` (`listForStaff`) | Guarded by `authorize(...staffRoles)`. Query `branchId` is optional. If omitted, lists subscriptions across the whole tenant regardless of assigned branches. If provided, does not verify if caller has `subscriptions.view` at that branch. | `can.atAnyBranch('subscriptions.view')`, verify `query.branchId` with `hasBranchAccess`, scope omitted branchId to `branchIdsWithPermission(req, 'subscriptions.view')`. |
| `src/routes/attendance.routes.js:70`<br>`src/controllers/attendance.controller.js:38` | `GET /attendance` (`listAttendance`) | Guarded by `authorize('GYM_HOST', 'BRANCH_MANAGER')`. Accepts `branchId` in query but does not verify caller has access to it. If `branchId` omitted, queries attendance across the entire tenant. | `can.atAnyBranch('checkins.view')`, verify `query.branchId` with `hasBranchAccess`, scope omitted branchId to `branchIdsWithPermission(req, 'checkins.view')`. |
| `src/routes/attendance.routes.js:108`<br>`src/controllers/attendance.controller.js:116` | `GET /attendance/stats` (`attendanceStats`) | Guarded by `authorize('GYM_HOST', 'BRANCH_MANAGER')`. Accepts `branchId` without verifying branch access. | `can.atAnyBranch('checkins.view')`, verify `query.branchId` with `hasBranchAccess`. |
| `src/routes/attendance.routes.js:63`<br>`src/controllers/attendance.controller.js:78` | `GET /attendance/history` | Guarded by `authorize('GYM_HOST', 'BRANCH_MANAGER')`. Does not verify caller's branch access for provided `branchId`. | `can.atAnyBranch('checkins.view')`, verify `query.branchId` with `hasBranchAccess`. |
| `src/routes/membership-plans.routes.js:133`<br>`src/controllers/membership-plans.controller.js:10` | `GET /membership-plans` | Guarded by `authorize('GYM_HOST', 'BRANCH_MANAGER')`. Filter by `branchId` does not check caller assignment. | `plans.view` per branch or org-wide. |
| `src/routes/trainers.routes.js:18`<br>`src/controllers/trainers.controller.js:10` | `GET /trainers` | Guarded by `authorize('GYM_HOST', 'BRANCH_MANAGER')`. Filter by `branchId` does not check caller assignment. | `team.view` per branch or org-wide. |

---

## 5. Regression Tests

New regression test file: `tests/regression/new-48-multi-branch-members.test.js`
- Built using real platform and tenant models via `tests/harness`.
- Tenant setup with 3 active branches (A, B, C) and 3 active members (1 per branch).
- Test cases:
  1. `manager of three branches sees members at all three`: Manager assigned to branches A, B, and C calls `GET /gyms/members` and receives all 3 members.
  2. `manager of three branches supplying ?branchId=branchB sees only branch B members`: Calls `GET /gyms/members?branchId=B` and receives only Branch B's member.
  3. `manager of one sees only that branch`: Manager assigned to Branch A calls `GET /gyms/members` and receives only Branch A's member.
  4. `manager of one requesting branch they lack access to gets 403`: Manager assigned only to Branch A calls `GET /gyms/members?branchId=B` and receives `403`.
  5. `Front Desk with members.view off gets 403`: Front Desk user with `members.view` override `DENY` calls `GET /gyms/members` and receives `403`.
  6. `owner sees all members`: Tenant owner calls `GET /gyms/members` and receives all 3 members.

### Failing-First Verification
Captured on initial test run before code fixes were applied:
```text
FAIL tests/regression/new-48-multi-branch-members.test.js
  NEW-48: GET /gyms/members multi-branch access and permission enforcement
    ✕ manager of three branches sees members at all three (134 ms)
    ✓ manager of three branches supplying ?branchId=branchB sees only branch B members (26 ms)
    ✓ manager of one sees only that branch (24 ms)
    ✕ manager of one requesting branch they lack access to gets 403 (23 ms)
    ✕ Front Desk with members.view off gets 403 (22 ms)
    ✓ owner sees all members (22 ms)

  ● manager of three branches sees members at all three: Expected length 3, Received length 1
  ● manager of one requesting branch they lack access to gets 403: Expected 403, Received 200
  ● Front Desk with members.view off gets 403: Expected 403, Received 200
```

Post-fix result:
```text
PASS tests/regression/new-48-multi-branch-members.test.js
  NEW-48: GET /gyms/members multi-branch access and permission enforcement
    ✓ manager of three branches sees members at all three (150 ms)
    ✓ manager of three branches supplying ?branchId=branchB sees only branch B members (39 ms)
    ✓ manager of one sees only that branch (57 ms)
    ✓ manager of one requesting branch they lack access to gets 403 (44 ms)
    ✓ Front Desk with members.view off gets 403 (48 ms)
    ✓ owner sees all members (19 ms)
```

# NEW-50: Branch scoping on the remaining attendance read routes, and the listForStaff shape bug

- **Issue ID**: NEW-50
- **Status**: RESOLVED on branch `fix/new-50` (from `origin/main` at 3a07c86, not pushed). Suite counts in §7.

## 1. Routes named in the brief

All four exist. `GET /attendance/report` is the query-param alias; `GET /attendance/report/:period` is the same controller and had the same gap, so I guarded both (otherwise the path form would have stayed open).

| Route | Route file (before) | Controller (before) |
|---|---|---|
| `GET /attendance/today` | `attendance.routes.js:222` | `attendance.controller.js:59` `todayLogs` |
| `GET /attendance/range` | `:263` | `:78` `rangeLogs` |
| `GET /attendance/customer/:userId` | `:294` | `:98` `memberHistory` |
| `GET /attendance/report/:period` and `GET /attendance/report` | `:331`, `:340` | `:116` `report` |

## 2. What each had before

- Middleware: `authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), tenantContext`. `authorize` ran **before** `tenantContext`, so a team member whose account role is MEMBER was rejected with 403 before the role shim applied (same defect NEW-49 fixed on `GET /attendance`).
- No permission check at all (no `can`). No `checkins.view`.
- Controllers passed `req.query.branchId` straight to the service (`branchId: branchId || null`; `memberHistory` passed it raw). No `hasBranchAccess`.
- Services (`attendance.service.js` `today`, `range`, `memberHistory`, `aggregateReport`) filtered by `branchId` only when supplied, otherwise tenant-wide.
- `memberHistory` returned a member's logs at every branch of the tenant.

Key confirmed: `checkins.view` at `docs/PERMISSIONS.md:75`.

## 3. Fix (NEW-49 pattern, nothing new built)

- **Routes**: `authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can.atAnyBranch('checkins.view')` on all five paths (`attendance.routes.js` `/today`, `/range`, `/customer/:userId`, `/report/:period`, `/report`). This is the order `GET /attendance` already uses.
- **Controllers**: each calls the existing `resolveBranchScope(req, branchId, 'checkins.view', 'check-ins')` from `src/utils/branchAccess.utils.js`. A supplied `branchId` must pass `hasBranchAccess` or the request gets 403. Omitted, it scopes to `req.permittedBranchIds`. `null` (owner / org-wide holder) means no filter; nobody else falls back to tenant-wide.
- **Service**: one small `applyBranchScope(where, branchId, branchIds)` in `attendance.service.js`, used by `today`, `range`, `memberHistory`, `aggregateReport`. `list` (NEW-49) was left as written.
- **`/customer/:userId`**: the member's logs are limited to branches where the caller holds `checkins.view`. A manager of branch A asking for a member who also trained at B and C sees only the A logs.
- **listForStaff** (`subscription.service.js:645`): the two early exits (no active branches; `branchId` not an active branch) returned `{ count: 0, rows: [] }`, but the controller reads `.subscriptions` and `.pagination`, so the response carried `subscriptions: undefined`. Both now return `{ subscriptions: [], pagination: buildPagination(0, page, limit) }`, the same helper the NEW-49 empty-scope exit already used, via a local `empty()`.

## 4. Behaviour changes to know about

- A team member whose platform role is MEMBER (Front Desk, Manager) can now reach these routes; before they got 403 from `authorize`.
- A role with `checkins.view` off now gets 403 instead of data.
- Pagination `total` on `/today`, `/range`, `/customer/:userId` now counts only the caller's branches.
- `GET /subscriptions/staff?branchId=<inactive branch>` now returns `subscriptions: []` plus `pagination`, not `subscriptions: undefined`.

## 5. Same gap, found and NOT changed

| Route | File | Gap |
|---|---|---|
| `POST /attendance/qr-scan`, `POST /attendance/manual`, `POST /attendance/check-in` | `attendance.routes.js:47,82,356` (current numbering) | `authorize` before `tenantContext`; no `checkins.qr.scan` / `checkins.manual.create` check; branch comes from the body and is unchecked. |
| `PATCH /attendance/:id/check-out` | `:366` | Same; no check against the log's branch. |
| `GET /reports/weekly-attendance` | `reports.routes.js:139` | `authorize` only, no `can.atAnyBranch`; `reportsService.weeklyAttendance(req.tenantDb)` takes no branch scope (controller `reports.controller.js:147`). Counts attendance tenant-wide. |
| `GET /host/dashboard`-style attendance counts | `host.controller.js:93,155,1016,1071,1081` | `AttendanceLog.count/findAll` without branch scope. I only read the call sites; not checked whether those routes carry a `can` guard. |
| Items already listed in `NEW-49.md` §5 (subscription writes, trainer writes, plan writes, `GET /subscriptions/staff/:id` route-level guard, `tenantContext.js:81` legacy `user.branchId`) | | Unchanged. |

## 6. Clients that might depend on the old behaviour

Read-only search, no client code changed.

- **Mobile (`gyms_era`)**: `lib/features/attendance/data/repositories/attendance_repository.dart` has `todayLogs`, `rangeLogs`, `memberHistory`, `getReport` for these routes (`api_constants.dart:220-224`). `memberHistory` is called from `member_attendance_history_screen.dart:12` and `member_profile_screen.dart:32`. I did not find callers of `todayLogs`, `rangeLogs` or `getReport` in `lib`. The member-history screens will now show only the branches the staff user holds `checkins.view` for.
- **CMS (`gymsera_cms`)**: `src/lib/api/attendance.ts` calls `GET /attendance/today` (used by `gym/attendance/page.tsx:46`) and `GET /attendance/report?period=` (no caller found). Staff with `checkins.view` at one branch will see only that branch's check-ins today, and a role with the key off now gets 403 where it used to get data. The sidebar already gates the page on `checkins.view` (`sidebar.tsx:85`), so this should match what the UI shows.
- **Web (`gymsera_web`)**: only `/me/attendance`, a different route. Not affected.

## 7. Tests

`tests/regression/new-50-attendance-branch-scope.test.js`: 38 tests.

- 5 route variants x 7 cases = 35: manager of 3 sees all 3; manager of 1 sees only theirs; manager of 1 filtering to their own branch; manager of 1 requesting a branch they lack gets 403; Front Desk with `checkins.view` on sees only their branch; Front Desk with `checkins.view` DENIED gets 403; owner sees all 3. Branches A/B/C hold 1/2/4 check-ins of one member, so `/customer/:userId` proves the other-branch logs are hidden and the two report routes are checked by total (7 vs 1).
- 3 for the listForStaff early exits: no active branches and non-active `branchId` (service level, stubbed branch lookup), plus an HTTP check that `?branchId=<inactive branch>` answers 200 with `subscriptions: []` and a `pagination` object.

The "Front Desk with the key on" case is a positive control. On unpatched code the 403 cases pass for the wrong reason (`authorize` rejects MEMBER-role accounts before the shim), so only a 200 for a permitted role proves the permission check is what decides.

**Before the fix (source stashed, test file kept): 23 failed, 15 passed.** Failures: all four "sees ..." cases and the own-branch filter for every route variant (403 from `authorize` ordering), and all three listForStaff cases (`subscriptions` undefined). The 15 passes are the wrong-reason 403s and the owner cases.

**After the fix: 38 passed, 0 failed** (with the 24 NEW-49 tests also green: 62/62).

Full suite (`jest --runInBand`, local Docker MySQL):

| Run | Suites | Tests |
|---|---|---|
| 1 | 138 passed / 138 | 990 passed / 990 |
| 2 | 138 passed / 138 | 990 passed / 990 |
| 3 (`DISABLE_REDIS=true`) | 138 passed / 138 | 990 passed / 990 |

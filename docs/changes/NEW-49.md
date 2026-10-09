# NEW-49: Branch scoping on subscriptions, attendance, plans and trainers lists

- **Issue ID**: NEW-49
- **Status**: RESOLVED on branch `fix/new-49` (not pushed). See §6 for suite counts.

## 1. Problem

Four staff list routes sat behind `authorize('GYM_HOST', 'BRANCH_MANAGER')` only. That passes every team member (the `tenantContext` role shim), never checks the permission key, ignores which branches the caller works at, and trusts any `?branchId`. A manager of one branch saw the whole tenant; a role with the key off still got data.

## 2. Route names differ from the brief

Three of the six routes named in the task do not exist as written. I changed the real route that matches and left everything else alone.

| Brief | What the code has | Action |
|---|---|---|
| `GET /subscriptions` (listForStaff) | `GET /subscriptions/staff`, `src/routes/subscriptions.routes.js:213` (was :211). `GET /subscriptions` does not exist. | Fixed `/staff`. |
| `GET /attendance` | `src/routes/attendance.routes.js:118` | Fixed. |
| `GET /attendance/stats` | No such route. `grep "attendance/stats\|'/stats'" src` finds only the unrelated `admin.routes.js:346`. The NEW-48 doc's `attendanceStats` controller does not exist. | Not changed. |
| `GET /attendance/history` | No such route. Closest is `GET /attendance/customer/:userId` (`memberHistory`). | Not changed (see §5). |
| `GET /membership-plans` | That path is the **public**, unauthenticated plan browser (`membership-plans.routes.js:44`, `listPublic`). The staff list is `GET /membership-plans/host` (`:65`). | Fixed `/host`. Public route untouched on purpose. |
| `GET /trainers` | `src/routes/trainers.routes.js:48` | Fixed. |

Permission keys confirmed in `docs/PERMISSIONS.md` (lines 75, 116, 149, 159) and `src/constants/permissions.js` (146, 254, 331, 351): `checkins.view`, `subscriptions.view`, `plans.view`, `team.view`.

## 3. Root cause

- No `can.atAnyBranch` on any of the four routes.
- `src/controllers/subscriptions.controller.js:90` (listForStaff), `attendance.controller.js:36`, `membership-plans.controller.js:27`, `trainers.controller.js:16` passed `req.query.branchId` straight to the service without `hasBranchAccess`.
- Services fell back to every branch when `branchId` was omitted: `subscription.service.js:645`, `attendance.service.js:186`, `membership-plan.service.js:276`, `trainer.service.js:34`.
- Attendance only: `authorize` ran **before** `tenantContext` (`attendance.routes.js` GET `/`), so a team member whose account role is MEMBER was rejected with 403 before the shim ran. Even a manager with `checkins.view` could not reach the list.

## 4. Fix (NEW-48 pattern)

- **Routes**: `can.atAnyBranch('<key>')` added after `authorize` on the four routes. Attendance `GET /` reordered to `authenticate, tenantContext, authorize, can.atAnyBranch`.
- **Helper** `resolveBranchScope(req, branchId, key, noun)` in `src/utils/branchAccess.utils.js`: if `branchId` is supplied it must pass `hasBranchAccess` or the request gets 403; otherwise it returns `req.permittedBranchIds` (set by `can.atAnyBranch`), falling back to `branchIdsWithPermission`. `null` means owner/org-wide, no filter. Added once instead of copying the NEW-48 block four times; NEW-48's own code is untouched.
- **Services** take a new `branchIds` array: `subscription.service.js` (`listForStaff`), `attendance.service.js` (`list`), `membership-plan.service.js` (`listForHost`), `trainer.service.js` (`listTrainers`, plus the missing `Op` import).
- Plans: a scoped caller also sees plans with `branchId = null` (tenant-wide plans), matching what `?branchId=` already returned.
- Trainers: a scoped caller does not see trainers with no branch (`branchId = null`); only owners/org-wide holders do.

## 5. Same gap, not changed (out of scope)

| Route | File:line | Gap |
|---|---|---|
| `GET /attendance/today` | `attendance.routes.js` `/today`, `controller.todayLogs` | `authorize` before `tenantContext`, no `checkins.view`, `branchId` unchecked, tenant-wide when omitted. |
| `GET /attendance/range` | `/range`, `rangeLogs` | Same. |
| `GET /attendance/customer/:userId` | `/customer/:userId`, `memberHistory` | Same; returns a member's logs at any branch. |
| `GET /attendance/report/:period`, `GET /attendance/report` | `report` | Same. |
| `PATCH /attendance/:id/check-out`, `POST /attendance/check-in` | write routes | `authorize` before `tenantContext`; no branch check on the log's branch. |
| `GET /subscriptions/staff/:id` | `subscriptions.routes.js:234` | Branch check exists in the controller (`hasBranchAccess`), but no route-level `can`. |
| `POST /subscriptions/staff`, `/staff/:id/activate`, `/preview` | `:182`, `:255`, `:256` | Role check only. |
| Trainer writes `POST /trainers`, `PATCH /trainers/:id`, `POST /trainers/:id/assign` | `trainers.routes.js:79,103,131` | Role check only. |
| Plan writes `POST/PATCH/DELETE /membership-plans…` | `membership-plans.routes.js:132-294` | Role check only. |
| `src/middleware/tenantContext.js:81` | | Still sets `user.branchId = linkedBranchIds[0]` for legacy callers. |

Separate pre-existing bug seen while editing: `subscription.service.js` `listForStaff` returns `{ count: 0, rows: [] }` on its two early exits (no active branches, or `branchId` not active), but the controller reads `.subscriptions` and `.pagination`, so those cases return `subscriptions: undefined`. My new empty-scope exit returns the correct shape. The old exits are left as they were.

## 6. Tests

`tests/regression/new-49-branch-scoped-lists.test.js`: 4 routes x 6 cases = 24 tests, built on the same harness as NEW-48 (3 branches, one record each). Cases per route: manager of 3 sees all 3; manager of 1 sees only theirs; manager of 1 filtering to their own branch; manager of 1 requesting a lacking branch gets 403; Front Desk with the key DENIED gets 403; owner sees all 3.

**Failing before the fix (unpatched code): 12 failed, 12 passed.**
```
subscriptions/staff : manager of one sees only their branch (extra rows returned)
                      lacking branch expected 403, got 200
                      key off expected 403, got 200
attendance          : manager of three / manager of one / own-branch filter: expected 200, got 403
                      (authorize ran before the tenantContext shim)
membership-plans/host: manager of one sees extra rows; lacking branch 200; key off 200
trainers            : manager of one sees extra rows; lacking branch 200; key off 200
```
**After the fix: 24 passed, 0 failed.**

Full suite (`jest --runInBand`, local Docker MySQL), includes the 24 new tests:

| Run | Suites | Tests |
|---|---|---|
| 1 | 137 passed / 137 | 952 passed / 952 |
| 2 | 137 passed / 137 | 952 passed / 952 |
| 3 (`DISABLE_REDIS=true`) | 137 passed / 137 | 952 passed / 952 |

# NEW-51: Branch scoping on the attendance write routes, weekly-attendance, and two host attendance reads

- **Issue ID**: NEW-51
- **Status**: RESOLVED on branch `fix/new-51` (from `origin/main` at 64b2a24, which includes NEW-50; not pushed). Suite counts in §7.
- **Worktree**: built in its own checkout (`gymsera_be_new51`); no other folder's branch was switched.

## 1. Routes named in the brief

All exist. Line numbers are the unpatched `origin/main`.

| Route | Route file (before) | Handler |
|---|---|---|
| `POST /attendance/qr-scan` | `attendance.routes.js:47` | `attendance.controller.js:16` `qrScan` |
| `POST /attendance/manual` | `:82` | `:26` `manual` |
| `POST /attendance/check-in` (alias of manual) | `:356` | same `manual` |
| `PATCH /attendance/:id/check-out` | `:366` | `:142` `checkOut` |
| `GET /reports/weekly-attendance` | `reports.routes.js:139` | `reports.controller.js:147` -> `reports.service.js:312` |
| attendance counts in `host.controller.js` | see §4 | |

## 2. What the write routes had before

- Middleware: `authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), tenantContext`. `authorize` ran **before** `tenantContext`, so a team member whose account role is MEMBER (Front Desk, Manager) got 403 before the role shim applied. Every team member was locked out of the write routes, not just the wrong ones.
- No permission check (no `can`).
- The branch comes from `req.body.branchId` (qr-scan, manual, check-in) and went straight to the service; `attendance.service.js` only checks the branch exists and is active (`qrScan` line 31, `manual` line 161). `checkOut` (service line 378) loads the log by id and never looks at its branch.
- Result for anyone who did get through (a legacy BRANCH_MANAGER account): they could record or close a check-in at any branch of the tenant.

## 3. Keys and fix

Keys (from `docs/PERMISSIONS.md`):

| Route | Key | Citation |
|---|---|---|
| `qr-scan` | `checkins.qr.scan` | `docs/PERMISSIONS.md:76`, `src/constants/permissions.js:152` |
| `manual`, `check-in` | `checkins.manual.create` | `docs/PERMISSIONS.md:77`, `src/constants/permissions.js:154` |
| `check-out` | `checkins.qr.scan` (owner decision, see below) | |

**Check-out has no key of its own.** No `checkout` permission exists in `PERMISSIONS.md` or the catalogue, so I stopped and asked. Decision: use `checkins.qr.scan`, which every role that works the desk already holds. No new permission was added.

Fix:

- **Routes**: `authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can(<key>)`. `can()` resolves the branch from `body.branchId` (its default lookup) and runs `hasAllBranches` first, so owners and org-wide holders pass everywhere. 403 if the caller lacks the key at that branch.
- **check-out**: the branch is the log's, so the route uses `can.atAnyBranch('checkins.qr.scan')` as the gate and `attendance.controller.js` `checkOut` loads the log and calls the existing `hasBranchAccess(req, log.branchId, 'checkins.qr.scan')`; 403 otherwise. A missing log is still 404 (checked before the access test, so a 404 reveals nothing the 404 did not before).
- Nothing new built: `can`, `can.atAnyBranch`, `hasBranchAccess` and `resolveBranchScope` are the NEW-44/49/50 pieces.

**Untouched on purpose** (FLOW-09 and the subscription rule): `qrScan` in the service, `src/utils/qr.utils.js`, rotating token verification, nonce replay protection, legacy grace mode, the duplicate window, and the "QR code is not valid for this branch" subscription-vs-branch check (service line 134). The guard only decides whether the *staff caller* may record at `body.branchId`. A member is still only checked in at a branch their subscription covers. `tests/regression/flow-09-attendance-qr.test.js` is unchanged and passes.

## 4. GET /reports/weekly-attendance

Before: `authenticate, tenantContext, authorize(...)`, no `can`; `reportsService.weeklyAttendance(req.tenantDb)` counted every branch (service lines 322-333, no branch in `where`).

After: `can.atAnyBranch('checkins.view')` on the route; the controller calls `resolveBranchScope(req, req.query.branchId, 'checkins.view', 'check-ins')`, so a supplied `branchId` needs `hasBranchAccess` (else 403), and without one the count is limited to the caller's permitted branches (`null` for owner/org-wide = unfiltered). The service takes `{ branchId, branchIds }` with a default of "everything", so any other caller is unchanged. Same pattern as NEW-49/50.

## 5. host.controller attendance counts

I read the routes that reach each call site first.

| Call site (`host.controller.js`) | Route | Guard before | Verdict |
|---|---|---|---|
| `getTodaySummary` counts (lines 93, 155) | `GET /host/today-summary`, `host.routes.js:33` | `authenticate, authorize('GYM_HOST')` | **No gap.** Owner-only and it covers the owner's active branches by design. Unchanged. |
| `getBranchDashboard` counts and recent check-ins (1016, 1071, 1081) | `GET /host/branches/:branchId/dashboard`, `:98` | `authenticate, tenantContext, authorize(...)`, no branch check | **Gap.** `authorize` passes any account with a role assignment (the shim maps it to BRANCH_MANAGER), and `branchId` is the URL's, so a manager of branch A could read branch B's counts and recent check-ins. |
| `getBranchCheckins` (1256) | `GET /host/branches/:branchId/checkins`, `:102` | same | **Gap**, same reason. |

Fix: added `can('dashboard.view')` and `can('checkins.view')` after `authorize` on those two routes. `can()` reads `params.branchId`. `dashboard.view` already existed and is the key the dashboard controller's revenue-masking comment names (`host.controller.js:1119`); I did not add a key. The controller's own revenue masking (`dashboard.revenue.view`, `dashboard-access.test.js`) is unchanged.

## 6. Behaviour changes to know about

- A team member whose platform role is MEMBER can now reach the write routes (before: 403 from `authorize`), at the branches where they hold the key.
- A manager of branch A can no longer record, close, or read host dashboard/check-ins for branch B, and gets 403.
- A role with the key off gets 403. Trainers hold `checkins.qr.scan` but not `checkins.manual.create`, so manual check-in is 403 for them and QR scan and check-out work.
- `weekly-attendance` for a branch-scoped caller shows only their branches.
- **Not enforced, unchanged:** `checkins.manual.create` is approvable and Front Desk holds it as Request tier (`PERMISSIONS.md:77`). The route has no approval-request flow today, so a Front Desk with the key records directly. `can()` checks holding the key, as for the other routes in this series. Adding `requireDirect` or an approval request is a separate decision.

## 7. Same gap, found and NOT changed

| Item | Where | Note |
|---|---|---|
| `POST /attendance/device-notify` | `attendance.routes.js` (device API-key route) | Takes `tenantId` and `branchId` from the body, guarded by one global `DEVICE_API_KEY`, not by user or branch. Not in scope. |
| `/host/branches/:branchId/` members (GET, POST, lookup), announcements (GET, POST, DELETE), schedule (GET, POST), expenses (GET, POST, PATCH, DELETE) | `host.routes.js:26-31,99-101,103-107` | Same shape: `authorize` plus `:branchId` in the URL, no `can` on the route. I did not open their controllers, so a guard inside a controller is not ruled out. |
| `GET /reports/branch/:branchId` | `reports.routes.js:160` | Route has `authorize` only, no `can`; `branchReport` (`reports.controller.js`, `reports.service.js:349`) includes attendance counts for the URL's branch. Same gap as the dashboard; not in scope. |
| `GET /reports/dashboard` | `reports.routes.js:45` | Not read. |
| Items from `NEW-49.md` §5 / `NEW-50.md` §5 not in this issue | | Subscription, trainer and plan writes; `GET /subscriptions/staff/:id`; `tenantContext.js:81` legacy `user.branchId`. |
| `tests/dashboard-access.test.js` | `tests/` root | Not matched by `jest.config.js` `testMatch` (only `tests/integration` and `tests/regression`), so it never runs in the suite. Run on its own it still passes with this change (it calls the controller directly). |

## 8. Clients that might depend on the old behaviour

Read-only search, no client code changed.

- **CMS (`gymsera_cms`)**
  - `src/lib/api/attendance.ts:34` posts `/attendance/check-in` with `{ email, branchId }`, and the `check-in` validator requires `userId` and `subscriptionId`. That call looks already mismatched before this change, so I would not expect it to be working today. Worth confirming with the CMS owner.
  - `attendance.ts:39` calls `PATCH /attendance/:id/check-out`.
  - `reports.ts:62` calls `GET /reports/weekly-attendance` with no `branchId` (used by `gym/attendance/page.tsx:60`), so branch-scoped staff will now see only their branches' totals.
  - `reports.ts:69` calls `GET /host/branches/:branchId/dashboard`.
- **Mobile (`gyms_era`)**
  - `attendance_repository.dart:18,37` call `qr-scan` and `manual`.
  - Dashboard calls: `reports_repository.dart:25`, `workspace_repository.dart:108`.
  - `check_ins_screen.dart:88` already gates the scan button on `checkins.qr.scan`, which matches the new guard.
  - A staff user who could open another branch's dashboard by URL will now get 403 there.
- **Web (`gymsera_web`)**: no calls to these routes found.

## 9. Tests

`tests/regression/new-51-attendance-write-branch-scope.test.js`: 71 tests.

- Per write route (qr-scan, manual, check-in, check-out): manager of 3 records at each of A/B/C; manager of 1 records at own branch (positive control) and gets 403 at B and C with nothing written (and the other branch's log not closed for check-out); Front Desk with the key on records at own branch, 403 at B and C; Front Desk with the key DENIED gets 403 at own branch; owner records at all 3. The 403 assertions also check the message mentions "permission".
- Trainer without `checkins.manual.create`: manual 403, qr-scan 201 at the same branch.
- Check-out of a non-existent log: 404 for owner and manager (not 500).
- `weekly-attendance`: manager of 3 sees 9 (1+3+5); manager of 1 sees 1; own-branch filter; other-branch filter 403; manager of 3 filters to one; Front Desk with `checkins.view` on sees own branch; Front Desk with it DENIED 403; owner sees all or filters.
- Host `checkins` and `dashboard`: manager of 1 reads own (positive control) and gets 403 on another; manager of 3 reads each; owner reads each.
- QR tokens are real signed tokens from `generateAttendanceQrToken`, one per call, so replay protection is exercised normally.

**Before the fix (source untouched, test file new): 31 failed, 40 passed.** The 31 failures: every positive control for team members on all four write routes (403 from `authorize` ordering), the weekly-attendance team-member cases, and the two host cross-branch cases, which returned 200 (the leak). The 40 passes include the wrong-reason 403s (team members rejected by `authorize`), which is why each route has a positive control that must be 2xx.

**After the fix**: 71 passed in the new file, and with `flow-09-attendance-qr.test.js` (unchanged) 82/82.

Full suite (`jest --runInBand`, local Docker MySQL):

| Run | Suites | Tests |
|---|---|---|
| 1 | 139 passed / 139 | 1061 passed / 1061 |
| 2 | 139 passed / 139 | 1061 passed / 1061 |
| 3 (`DISABLE_REDIS=true`) | 139 passed / 139 | 1061 passed / 1061 |

The NEW-50 baseline was 138 suites / 990 tests; the difference is this issue's 1 suite and 71 tests.

Not committed: `.env` (copied into the worktree so the harness can reach the local Docker MySQL; it is gitignored) and a `node_modules` symlink to the main checkout.

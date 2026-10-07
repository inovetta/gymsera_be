# NEW-44: permission enforcement on routes that still use the role-only guard

- **Issue ID**: NEW-44
- **Title**: `/reports/*` and `/gyms/*` are guarded by `authorize('GYM_HOST','BRANCH_MANAGER')`, which every team member passes, so revenue and branch data were not tied to permissions
- **Status**: PARTLY RESOLVED. Items 1 and 2 are fixed; item 3 lists what is left (reported, not fixed).

## Root cause

- `src/middleware/tenantContext.js:41-82` (legacy role shim, called at `:298`) sets `req.user.role = 'BRANCH_MANAGER'` for anyone with an assignment, whatever their role. `authorize('GYM_HOST','BRANCH_MANAGER')` (`src/middleware/authorize.js:16`) therefore lets every team member in.
- `GET /reports/dashboard` and `GET /reports/yearly` (`src/routes/reports.routes.js:43-48`, `:134`) had no permission check, and `reports.service.js` summed **every** active branch. `dashboard.revenue.view` was used only on `GET /host/branches/:branchId/dashboard` (`host.controller.js:1119-1130`). Found on the CMS dashboard: a Front Desk user with revenue off saw the tenant's Revenue Overview chart and Monthly Revenue card.
- `GET /gyms/branches` (`gyms.controller.js:47`, `gym.service.js:247`) returned every non-inactive branch to every team member.

## Item 1 — report routes (commit 1)

- `can.atAnyBranch(permissionKey)` (`src/middleware/can.js`): passes when the caller holds the key at one or more branches or organization-wide, attaches `req.permittedBranchIds` (`null` = every branch), 403 otherwise.
- `branchIdsWithPermission(req, key)` (`src/utils/branchAccess.utils.js`): asks `hasBranchAccess` once per ACTIVE branch, so the answer is exactly what a request for that branch would get. An ORG-scoped assignment resolves at every branch, so "organization-wide" needs no second case. Owner, host and platform admin short-circuit to `null` (unchanged).
- `GET /reports/dashboard` and `GET /reports/yearly` require `dashboard.revenue.view` and pass `branchIds` to `reportsService.hostDashboard`, `hostDashboardFiltered` and `yearlyRevenue`, which add up only those branches (member and attendance counts, plans, `branches.active` and the revenue sums).
- `authorize('GYM_HOST','BRANCH_MANAGER')` stays in front, so a platform admin is refused exactly as before.
- Cost: one cached grant resolution per active branch per request.
- Tests: `tests/regression/new-44-report-permissions.test.js` (uses `tests/harness/two-branch-team.js`, real models, team members with account role MEMBER).

## Item 3 — every other route still guarded only by the role check (reported, not fixed)

All of these pass for any team member through the shim. "Should require" is the permission from `src/constants/permissions.js`.

### reports.routes.js

| Route (line) | What it returns | Should require |
|---|---|---|
| `GET /reports/monthly` (`:75`) | revenue, new subscriptions and check-ins per day, whole tenant | `dashboard.revenue.view`, scoped to the branches it is held at (same as item 1) |
| `GET /reports/monthly/export-pdf` (`:104`), `/monthly/print-layout` (`:126`), `/monthly/export` (`:132`) | same data as a PDF or HTML page | `dashboard.revenue.view`, scoped |
| `GET /reports/weekly-attendance` (`:135`) | check-ins for the last 7 days, whole tenant | `checkins.view`, scoped to its branches |
| `GET /reports/branch/:branchId` (`:156`) | one branch's members, revenue, staff, check-ins | `dashboard.revenue.view` at `:branchId` for the revenue block (`can()` reads the branch from the URL); the rest `dashboard.view` at that branch |

### gyms.routes.js (the whole router sits behind the role guard, `:13`)

| Route (line) | Today | Should require |
|---|---|---|
| `GET /gyms/profile` (`:35`) | returns the gym row **and `paymentDetailsJson` (bank details)** to any team member (`gym.service.js:159-168`) | any grant; hide `paymentDetailsJson` unless `payouts.bank.manage` |
| `POST /profile/logo`, `/cover`, `/images`, `DELETE /profile/images` (`:37-40`) | no check | `listing.manage` (organization-wide) |
| `PATCH /gyms/profile` (`:83`) | bank details already need `payouts.bank.manage` + re-auth (`gyms.controller.js:24-26`); other fields no check | `listing.manage` |
| `POST /gyms/branches` (`:149`) | `authorize('GYM_HOST')` (owner) | keep owner-only; or `branch.create` (owner-only tier) so it follows the catalogue |
| `GET /gyms/branches/:branchId` (`:175`) | controller asks `hasBranchAccess(..., 'branches.view')` (`gyms.controller.js:72`) — **`branches.view` is not a key in the catalogue**, so every non-owner gets 403 | any grant at the branch, or `branch.settings` |
| `PATCH /gyms/branches/:branchId` (`:194`) | asks `'branches.manage'` (`gyms.controller.js:84`) — **not a catalogue key either**, so every non-owner gets 403 | `branch.settings` at `:branchId` |
| `DELETE /gyms/branches/:branchId` (`:217`) | `authorize('GYM_HOST')` + re-auth | keep owner-only |
| `POST`/`DELETE /branches/:branchId/images` (`:220-221`) | no check: any team member can add or remove any branch's photos | `branch.settings` (or `listing.manage`) at `:branchId` |
| `GET /branches/:branchId/staff` (`:241`) | asks `team.view` at the branch (`gyms.controller.js:123`) | already right |
| `POST`/`DELETE /branches/:branchId/staff…` (`:277`, `:305`), `GET`/`POST /staff`, `DELETE /staff/:userId` (`:331`, `:367`, `:386`) | `authorize('GYM_HOST')`, legacy staff | retire (410), per spec §8.3.6 / RBAC-07; the CMS stopped calling them in Prompt 3A; mobile still calls the branch-staff ones (see item 4) |
| `GET /gyms/members/search` (`:314`) | looks up **any platform user by e-mail** (`gymService.searchMember(email)`), no check | `members.create` |
| `POST /gyms/members/enroll` (`:315`) | no permission check at all and no approval tier: a Trainer or Support can enrol a member directly | `members.create` through `approvalService.perform` (REQUEST tier → 202), like `POST /branches/:id/members` |
| `GET /gyms/members` (`:316`) | for team members the handler forces `branchId = req.user.branchId` (the shim's first linked branch, `gyms.controller.js:266-269`); `members.view` is never asked | `members.view` per branch, scoped like item 1 |

## Item 4 — who calls what, and what breaks

Mobile source: `gyms_era` `master` (f33e211). I cannot tell which version is in the stores.

| Route | Mobile | CMS | Effect of items 1 and 2 |
|---|---|---|---|
| `GET /reports/dashboard` | `reports_repository.dart:19` via `hostDashboardProvider` (`host_providers.dart:12`) and `dashboardReportProvider` (`analytics_provider.dart:15`) — the owner's host dashboard | `reports.ts:24`, `dashboard/page.tsx:46-50` | Owner: unchanged (`null` scope). Team member without `dashboard.revenue.view`: now 403; the mobile providers rethrow so the screens show their error state. Team member with it: now sees only their branches. |
| `GET /reports/yearly` | not called | `reports.ts:47`, `dashboard/page.tsx:52-56` | Owner unchanged. A Front Desk user's chart now errors. |
| `GET /reports/monthly`, `/monthly/export-pdf`, `/monthly/print-layout` | `reports_repository.dart:29-58` | `reports.ts:34`, `:39` (export) | Not changed. |
| `GET /host/branches/:branchId/dashboard` | `reports_repository.dart:25`, `workspace_repository.dart:~108` (team members) | not called | Not changed; already hides revenue without the key. |
| `GET /gyms/branches` | not called (mobile lists branches with `GET /host/branches`, `api_constants.dart:141`, owner-only, same handler) | `gym.ts:95`; dashboard, branches, members, payments, plans, attendance pages and the team invite dialog and member panel | Owner and Org Admin: unchanged. Branch-scoped team member: only their branches (an improvement for the pickers). |
| `GET /gyms/branches/:id`, `PATCH` | `gyms_repository.dart:689`, `:709` (owner flows) | `branches/[id]/page.tsx:80`, `branches/page.tsx:167` | Not changed. |

What breaks:

- **CMS dashboard for a user without revenue permission.** The page still requests both routes. Their stats card and chart now fail: `stats` stays null, so the cards read `0` and `—` instead of an error or a hidden block. That is misleading, not a crash. It needs a CMS follow-up: do not request or render the revenue chart and card without `dashboard.revenue.view`, and show member and check-in counts from a route that needs only `dashboard.view`.
- **CMS payments page** is unaffected by this change (still sends no branch; separate finding).
- **Mobile:** nothing breaks for owners. A team member who opens the host dashboard screens without the key now gets an error state where they previously got the whole tenant's takings.

### Deploy order

1. Backend (this change). It is backward compatible for owners, hosts and anyone holding the key; only callers who were wrongly seeing data change.
2. CMS follow-up (dashboard gating, payments branch) — can follow at any time; until then a Front Desk user sees zeros on the dashboard instead of revenue.
3. No mobile release needed for owners. If team members use the host dashboard screens, confirm their error state is acceptable.
4. Items in the item 3 tables: backend first, then clients, each as its own change; the members/enroll and branch-images checks are the most urgent.

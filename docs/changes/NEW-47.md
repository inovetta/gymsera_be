# NEW-47: Tenant owner access when account role is MEMBER

- **Issue ID**: NEW-47
- **Title**: Tenant owners whose account role is MEMBER received 0 branches, 0 members, and hit owner gaps across reports, bank details, member search, enrollment, and image routes
- **Status**: Complete
- **Root Cause**:
  - `src/utils/branchAccess.utils.js:55`: `hasAllBranches(req)` synchronously checked only `req.user?.role === 'PLATFORM_ADMIN' || req.user?.role === 'GYM_HOST' || req.user?.isHost === true`. It never checked tenant ownership or verified whether `tenant.ownerUserId === userId`.
  - When an owner signed up or operated with their platform account (`users.role = 'MEMBER'`), `hasAllBranches(req)` returned `false`.
  - In `branchIdsWithAnyGrant(req)`: when `hasAllBranches` returned `false`, the helper fell back to resolving grants per active branch via `accessService.resolve(req.tenantDb, tenantId, userId, branchId)`. For a tenant owner, `accessService.resolve` returned `ownerGrants()`, where `isOwner: true` but `map: {}`. The check `if (grants.keys().length > 0)` evaluated `Object.keys({}).length > 0` as `false`, returning `[]` (an empty array of branch IDs).
  - In `gyms.controller.js#listBranches`, passing `branchIds = []` to `gymService.listBranches` caused SQL querying `WHERE id IN ()`, returning `{ branches: [], pagination: { total: 0 } }`.
  - Any other endpoint or middleware relying on `hasAllBranches`, `branchIdsWithAnyGrant`, `branchIdsWithPermission`, `can.atAnyBranch`, `can()`, or legacy `authorize('GYM_HOST')` suffered from the same owner gap when the owner's platform token role remained `MEMBER`.

## Changes Made

### 1. `src/utils/branchAccess.utils.js`
- **Async `hasAllBranches(req)`**:
  - Checks if `req.user?.role === 'PLATFORM_ADMIN' || req.user?.role === 'GYM_HOST' || req.user?.isHost === true`.
  - Checks if `req.user?.isOwner === true`.
  - Reuses `membershipService.listOwnedTenants(userId, { statuses: ['ACTIVE', 'SUSPENDED'], attributes: ['id'] })`. If the resolved `tenantId` is in the user's owned tenants, marks `req.user.isOwner = true` and returns `true`.
- **`hasBranchAccess` & `hasDirectBranchAccess`**:
  - Short-circuit with `if (await hasAllBranches(req)) return true;`.
- **`branchIdsWithPermission` & `branchIdsWithAnyGrant`**:
  - Await `hasAllBranches(req)` and return `null` ("every branch") for tenant owners.
  - In `branchIdsWithAnyGrant`, added `if (grants.isOwner || grants.keys().length > 0) allowed.push(id)` to prevent owner exclusion in branch iteration fallbacks.

### 2. `src/middleware/can.js`
- In `can()`, `can.any()`, and `attachGrants()`:
  - Added short-circuit with `if (await hasAllBranches(req)) { req.grants = accessService.ownerGrants(); req.branchId = branchId; req.tenantId = tenantId; return next(); }`.
  - Ensures tenant owners bypass permission failures and receive full `ownerGrants()` across all `can()` guarded endpoints.
- `can.atAnyBranch()` automatically returns `null` (`req.permittedBranchIds = null`) for owners via `branchIdsWithPermission`.

### 3. `src/middleware/authorize.js`
- When `roles.includes('GYM_HOST')`:
  - If the caller's role does not directly match, checks if the caller is the owner of the tenant (`req.user.isOwner || membershipService.listOwnedTenants`).
  - If the caller owns the tenant, passes them through (`return next()`).
  - Does NOT bypass for `PLATFORM_ADMIN` when `roles` does not include `PLATFORM_ADMIN` (preserving platform-admin role separation on report routes).

### 4. `src/controllers/gyms.controller.js`
- **`enrollMember`**:
  - Awaits `hasAllBranches(req)`: `const grants = (await hasAllBranches(req)) ? accessService.ownerGrants() : await accessService.resolve(...)`.
- **`getProfile` & `updateProfile`**:
  - Bank payout details (`paymentDetailsJson`) access check: `const isOwner = grants.isOwner || (await hasAllBranches(req));`.
  - Guarantees owners with account role `MEMBER` see and update `paymentDetailsJson`, while Front Desk and unauthorized roles remain blocked.

## Audited Routes & Tests

| Concern / Route | Middleware / Guard | Owner with role MEMBER | Front Desk / Non-owner |
|---|---|---|---|
| Direct utility checks | `hasAllBranches`, `branchIdsWithAnyGrant` | Returns `true` and `null` | Returns `false` and `[branchA.id]` |
| `GET /gyms/branches` | `branchIdsWithAnyGrant` | Sees all branches (A and B) | Sees only assigned branch A |
| `GET /gyms/members` | `gymService.listMembers` | Sees all members across branches | Sees only branch A members |
| `GET /reports/dashboard` | `authorize('GYM_HOST')`, `can.atAnyBranch('dashboard.revenue.view')` | Sees all-time revenue (PKR 8,000) | `403 Forbidden` |
| `GET /reports/yearly` | `authorize('GYM_HOST')`, `can.atAnyBranch('dashboard.revenue.view')` | Sees monthly breakdown (PKR 8,000) | `403 Forbidden` |
| `GET /gyms/profile` | Bank details gate (`payouts.bank.manage`) | Receives `paymentDetailsJson` | `paymentDetailsJson` deleted |
| `PATCH /gyms/profile` | `can('listing.manage', { orgWide: true })` + re-auth | Updates bank details (200 OK) | `403 Forbidden` |
| `GET /gyms/members/search` | `can.atAnyBranch('members.create')` | Searches members by email (200 OK) | Trainer without `members.create`: `403 Forbidden` |
| `POST /gyms/members/enroll` | Approval engine (`members.create`) | Enrolls directly (`201 Created`) | Submits for approval (`202 Accepted`) |
| Image routes (`/gyms/profile/logo`, `/cover`, `/images`, `/branches/:id/images`) | `can('listing.manage')`, `can('branch.settings')` | Passes permission check (422 without file) | `403 Forbidden` |
| `GET` & `PATCH /gyms/branches/:id` | `hasBranchAccess('branch.settings')` | Views and updates branch (200 OK) | Branch B: `404 Not Found` |

## Regression Test Suite

- **Test File**: `tests/regression/new-47-owner-member-role-access.test.js`
- **Result**: 21 passing tests verifying real platform models, real tenant database models, and realistic JWT tokens.

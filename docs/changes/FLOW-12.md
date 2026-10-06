# FLOW-12: Legacy Staff Invites Single-Use Expiring Token & Access Control

- **Issue ID**: FLOW-12
- **Title**: Legacy staff-invites: single-use expiring token, no global role mutation on accept (route through team.service / the AUTH-09 invitation pattern).
- **Status**: RESOLVED
- **Root Cause**:
  - `src/routes/staff-invites.routes.js:90-120`: The legacy staff invite acceptance route accepted without verifying that `staff.status === 'pending'`. Consequently, already accepted or declined invites could be accepted again.
  - `src/routes/staff-invites.routes.js:95`: If `staff.userId` was null (the common case when inviting a user by email who has not yet accepted), any authenticated user who possessed or guessed the `staffId` could accept the invite because `staff.userId && staff.userId !== req.user.id` was skipped.
  - `src/routes/staff-invites.routes.js`: No token expiration check was enforced. Invites older than 7 days could be accepted indefinitely.
  - `src/routes/staff-invites.routes.js:149`: ReferenceError when creating host acceptance notification (`user.fullName` was referenced without defining `const user = await User.findByPk(req.user.id)`).
  - Schema: `gym_staff` lacked columns for secure SHA-256 token hashing (`invite_token_hash`) and explicit expiration timestamp (`token_expires_at`).
- **Pattern Reused**:
  - Reused `AUTH-09` invitation pattern: SHA-256 token hashing, 7-day expiration window, single-use token consumption, and email binding verification.
  - Reused `team.service.js:acceptStaffInvite`: creates/activates tenant `RoleAssignment` with strict level hierarchy validation below inviter, preserving the platform `User.role = 'MEMBER'` (no global role mutation).
  - Reused migration runner pattern for Tenant Migration 015 (`015_add_gym_staff_invite_token`).
- **Files Modified / Created**:
  - `src/database/tenant-migration-runner.js`: Added Tenant Migration 015 (`015_add_gym_staff_invite_token`) adding `invite_token_hash` and `token_expires_at` to `gym_staff`, with conflict-skip and dry-run safety.
  - `src/models/tenant/GymStaff.model.js`: Declared `inviteTokenHash`, `tokenExpiresAt`, and indexed `invite_token_hash`.
  - `src/routes/staff-invites.routes.js`:
    - Updated `_resolveStaffAndTenant` to support lookup by primary key UUID or SHA-256 token hash.
    - Added `_assertInviteValid` enforcing `status === 'pending'`, 7-day expiration check, and recipient user ID & email binding.
    - Consumed invite on acceptance by clearing `inviteTokenHash` and setting `status = 'active'`.
    - Fixed ReferenceError in notification emission by resolving `user` from `User.findByPk(req.user.id)`.
  - `tests/integration/tenant-migrations-015.test.js`: Integration test verifying migration 015 dry-run preview, conflict-skip, and idempotency.
  - `tests/regression/flow-12-staff-invites.test.js`: Regression test verifying:
    1. Unassigned user cannot accept an invite issued to someone else's email.
    2. Single-use: accepted invite cannot be accepted a second time (409 Conflict).
    3. Expired invite cannot be accepted (> 7 days, 410 Gone).
    4. Declined or revoked invite cannot be accepted.
    5. Accepting an invite preserves platform `User.role` as `MEMBER` and creates `RoleAssignment`.
    6. Raw token resolution via URL path with stored SHA-256 token hash.
- **Client Impact**:
  - Backward compatible: Existing mobile apps sending UUID `:staffId` continue to resolve and work seamlessly.
  - DeepLink and token links can pass either the UUID or raw 64-char hex token.
  - Expired, already-consumed, or unauthorized accept attempts now return 410 / 409 / 403 instead of 200.
- **Migration & Deploy Order**:
  - Tenant Migration 015 must be applied to tenant databases before or at deployment (`node src/scripts/run-tenant-migrations.js`).

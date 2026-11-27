# Pull Request: `feat/naming-v2-r2` → `origin/main` (Release 1.1.0)

> **Diff baseline (`origin/main` `e966d2e` → `feat/naming-v2-r2` `fb47422`):** `102` commits ahead (`0` behind), `594 files changed, 16390 insertions(+), 7061 deletions(-)` (before adding this doc/runbook update; clean fast-forward/no-conflict merge verified with `git merge-tree --write-tree origin/main HEAD`).

## Summary

Clean **Organization › Business › Branch** domain naming refactor (R-120 / `API_CONTRACT_V2.md`) and **Enterprise multi-business onboarding, per-business KYC/verification, held first branch, and branch-level refund policy** (R-119 / `ENTERPRISE_ORG_BUSINESS_BRANCH.md`), plus **`NEW-302`** (`+` email space normalization cherry-picked from `fix/email-plus-space` `7f9dc17`), `BUG-09` branch plan-currency fix, and Release 1.1.0 cut-over runbook & dry-run tooling on top of `origin/main` (`e966d2e`).

> **Important cut-over & branch notes:**
> - **No old-build compatibility (D14):** Release 1.1.0 breaks legacy `/tenants*`, `/gyms*`, `/listings*`, `X-Tenant-Id`, and `tenantId` token claims. Coordinate deploy with CMS, website, and mobile builds and raise the force-update gate (`MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID`).
> - **`NEW-302` (`+` email space normalization) included:** Cherry-picked only the NEW-302 commit (`7f9dc17`, `emailField()` in `src/validators/auth.validator.js` + `tests/regression/new-302-email-plus-space.test.js`) from `fix/email-plus-space` onto `feat/naming-v2-r2` (without merging `fix/email-plus-space`).
> - **Runbook:** Follow [docs/RELEASE_1_1_RUNBOOK.md](RELEASE_1_1_RUNBOOK.md) for backup, exact migration order (platform `p033`–`p038` first, then per-organization `030`–`032`), restarting solely via touching `web.config`, smoke tests, and rollback.

---

## What Changed Since `origin/main` (`e966d2e`)

1. **Naming v2 & Option S (`NEW-305`–`NEW-312`, R-120):**
   - Safe MySQL 5.7 rename helper (`src/database/rename-helpers.js`: probe-then-act, exact column definition/collation preservation, `ALGORITHM=INPLACE`).
   - Database, model, validator, controller, service, socket, and SQL check updates from `tenant`/`gym`/`listing` → `organization`/`business`/`branch`.
   - Single organization code generator (`ORG-XXXXXXXX`, `src/utils/organization-code.utils.js`).
   - Option S: unified business ID (`businesses.id === business_listings.id`; `gym_listing_id` dropped).
   - Frozen contract documented in `docs/API_CONTRACT_V2.md` (including Amendments A1–A3 and M3e fixes).
2. **Enterprise Organization › Business › Branch (`NEW-303` M1–M3e, `S2`–`S5`):**
   - **Held first branch (`M1`/`M2d`):** Both `first-business` and Add Business (`POST /host/businesses`) validate unified `FirstBranch` schema, store `firstBranchDraft`, reserve 1 capacity unit, and build the first branch only upon admin business approval.
   - **Per-business KYC, approval & Verified badge (`M2`):** Host & admin business document routes (`/kyc-documents`, `/documents`), approval requires proof of premises + ≥3 photos (`422 business_requirements_missing`), independent optional registration document drives `businessVerified` (`verify` / `DELETE /verify`, where revoking also rejects `BUSINESS_REGISTRATION` docs with `"Verification revoked"`).
   - **Capacity pool, branch donor transfer, and refund policy per branch (`M3`):** Branch creation automatically transfers free capacity units across approved businesses (`SLOT_TRANSFERRED` → `SLOT_CONSUMED_BUILD`), gates branch creation on PENDING businesses (`409 business_not_approved`), and moves refund policy exclusively to `branches`.
   - **M3e & walkthrough fixes (`S2`–`S5`):** `host/status` `nextStep` hint, normalized `FirstBranch` draft keys, `GET /admin/review-queue` (`kind`, `page`, `total`), `organization.businesses`, `businessVerified` on business detail, `organization_not_active` error code, `genderType`/`logoUrl`/`coverImageUrl` on `first-business`, updated `organization_approved`/`business_approved` deep links, `branchCount` on `GET /host/businesses*`, and non-production `PLACES_PROVIDER=fake` (`S5`).
3. **Additional fixes & release prep (`BUG-09`, `NEW-302`, `ZK-P2`, release ops):**
   - `BUG-09`: scope discovery branch/plan queries to the requested business and ordered first-branch lookups (`F2`).
   - `NEW-302`: treat spaces as `+` in `emailField()` across register, OTP verify/resend, login, and password reset request/confirm.
   - `ZK-P2`: fix month-boundary OUT grace time assertion in `tests/integration/zkteco-p2-sync-engine.test.js`.
   - Release prep: `docs/RELEASE_1_1_RUNBOOK.md` and `src/scripts/dry-run-release-1-1-backup.js`.

---

## Migration List (Exact Application Order Since `origin/main` `e966d2e`)

`origin/main` (`e966d2e`) is already at platform `v32` (`p032_area_requests`) and tenant `v29` (`029_branch_hours_json`).
Run **all platform migrations first**, then **all per-organization (tenant) migrations** (`run-tenant-migrations.js` reads `organizations`).

### Platform Database (`p033`–`p038`, `v32` → `v38`, 6 new migrations)

1. `p033_business_naming` — renames `gym_listings` → `business_listings` (`name`, `primary_branch_id`, `description`), `saved_gyms` → `saved_businesses`, `gym_reviews` → `business_reviews`, `user_gym_memberships` → `member_subscription_index`, `.business_id`, `platform_packages.max_businesses`, `capacity_events.action` `BUSINESS_*`, and indexes.
2. `p034_organization_naming` — renames `tenants` → `organizations`, `tenant_subscriptions` → `organization_subscriptions`, `tenant_invitations` → `organization_invitations`, `user_org_index` → `user_organization_index`, renames columns/indexes, widens `user_blocks.blocked_by`, renames enum/string values (`ORGANIZATION`, `organization`, `first_branch_draft`, `business`).
3. `p035_organization_id_columns` — renames `tenant_id` → `organization_id` and related indexes across all 19 platform tables.
4. `p036_member_index_branch_id` — adds nullable `member_subscription_index.branch_id`.
5. `p037_held_first_branch` — adds `business_listings.first_branch_draft_json`.
6. `p038_business_kyc_verification` — adds `kyc_status`, `kyc_documents_json`, `kyc_submitted_at`, `approved_at`, `approved_by`, `verified_at`, `verified_by` on `business_listings`.

### Per-Organization / Tenant Databases (`030`–`032`, `v29` → `v32`, 3 new migrations)

1. `030_business_naming` — renames `gyms` → `businesses`; renames `gym_id` → `business_id` + indexes on `branches`, `membership_plans`, `expense_categories`.
2. `031_business_one_id` — drops `branches.gym_listing_id` and `businesses.gym_listing_id` (Option S).
3. `032_branch_refund_policy` — adds `branches.{refunds_allowed,refund_window_days}` and drops them from `businesses`.

---

## Breaking API Changes (`API_CONTRACT_V2.md`)

- **Auth / Headers / Claims:**
  - Header `X-Tenant-Id` → `X-Organization-Id`.
  - JWT claim `tenantId` → `organizationId` (legacy tokens return `401`).
  - Socket room `tenant:<id>` → `organization:<id>`.
- **Route Renames & Removals:**
  - `/tenants*` → `/organizations*`; `/tenants/:id/gym-profile` → `/organizations/:organizationId/first-business`; `/first-business/images` removed (use `POST /host/staging-images`).
  - `/admin/tenants*` → `/admin/organizations*`; compound `tenantId:listingId` removed; business moderation/docs live under `/admin/businesses/:businessId*` and `/admin/review-queue`.
  - `/host/listings*` and `/gyms*` legacy routes → `/host/businesses*` and `/organizations/me/businesses/:businessId/*` (`/profile`, `/branches`, etc.).
  - `/discovery/gyms*`, `/discovery/organizations*`, `/discovery/top-hosts` → `/discovery/businesses*`, `/discovery/branches*`, `/discovery/top-businesses`.
  - `/me/saved-gyms` → `/me/saved-businesses`; `/auth/tenant-invitations/*` → `/auth/organization-invitations/*`; `/host/organization-quota` → `/host/business-quota`.
- **Payload & Key Renames:**
  - Global entity renames across requests/responses (`tenantId`→`organizationId`, `tenantCode`→`organizationCode`, `businessName`/`brandName` (org)→`organizationName`, `gymName`/`title` (business)→`name`/`businessName`, `gymListingId`/`listingId`/`gymId`→`businessId`, `mainBranchDataJson`→`firstBranchDraft`).
  - Traveller privacy (D3): `organizationName` and nested `tenant` removed from all traveller/discovery payloads; `BranchCard` uses `displayName`, `businessName`, `businessVerified`, and nested `business`.
  - Notification types: `tenant_approved` → `organization_approved` (deep link `/host/businesses/:businessId/documents` when proof pending), `listing_approved` → `business_approved` (`/host/businesses/:businessId`), `tenant_reactivated` → `organization_reactivated`.
  - Error codes: `tenant_not_active` → `organization_not_active`, `missing_tenant_context` → `missing_organization_context`, `tenant_not_found` → `organization_not_found`, `gym_not_available` → `business_not_available`, `gym_not_bookable` → `branch_not_bookable`, `brand_name_*` → `organization_name_*`; new codes `business_not_approved`, `business_requirements_missing`, `registration_missing`, `first_branch_already_built`, `branch_required`.
- **Environment Variables:**
  - New: `PLACES_PROVIDER` (dev/local only; ignored in `production`), `TEST_LOCAL_UPLOAD_DIR` (test only). Removed: none.

---

## Tests

- Full backend test suite verified on local Docker MySQL 5.7 (`7081dd1`, under `caffeinate` with CI ZK timing env):
  - **Suites:** `399 passed, 399 total`
  - **Tests:** `3973 passed, 3973 total`
  - **Snapshots:** `0 total`
- Targeted release-prep & `NEW-302` verifications after `7081dd1`:
  - `npx eslint src/scripts/dry-run-release-1-1-backup.js tests/regression/release-1-1-dry-run-script.test.js src/validators/auth.validator.js tests/regression/new-302-email-plus-space.test.js` → exit `0` (0 errors, 0 warnings).
  - `npx jest tests/regression/release-1-1-dry-run-script.test.js tests/regression/new-206-env-example-complete.test.js --runInBand --forceExit` → `2 passed, 2 total` suites, `5 passed, 5 total` tests.
  - `npx jest tests/regression/new-302-email-plus-space.test.js tests/regression/auth-04-otp-security.test.js tests/regression/sec-06-unknown-fields.test.js --runInBand --forceExit` → `3 passed, 3 total` suites, `60 passed, 60 total` tests (`new-302-email-plus-space` 6/6 including password reset).

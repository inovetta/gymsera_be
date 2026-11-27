# Pull Request: `feat/naming-v2-r2` → `main` (Release 1.1.0)

## Summary

Clean **Organization › Business › Branch** domain naming refactor (R-120 / `API_CONTRACT_V2.md`) plus **Enterprise multi-business onboarding, business KYC/verification, held first branch, and branch-level refund policy** (R-119 / `ENTERPRISE_ORG_BUSINESS_BRANCH.md`), alongside preceding release-candidate items merged/stacked after `main` (`11f57f2`).

> **Important cut-over & branch notes:**
> - **No old-build compatibility (D14):** Release 1.1.0 breaks legacy `/tenants*`, `/gyms*`, `/listings*`, `X-Tenant-Id`, and `tenantId` token claims. Coordinate deploy with CMS, website, and mobile builds and raise the force-update gate (`MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID`).
> - **`NEW-302` (`+` email space normalization) included:** Cherry-picked only the NEW-302 commit (`7f9dc17`, `emailField()` in `src/validators/auth.validator.js` + `tests/regression/new-302-email-plus-space.test.js`) from `fix/email-plus-space` onto `feat/naming-v2-r2` (without merging `fix/email-plus-space`).
> - **Runbook:** Follow [docs/RELEASE_1_1_RUNBOOK.md](RELEASE_1_1_RUNBOOK.md) for backup, exact migration order (platform first, then per-organization), restarting solely via touching `web.config`, smoke tests, and rollback.

---

## What Changed

1. **Pre-naming release items included since `main` (`11f57f2`):**
   - **Refunds on subscription cancellation (`NEW-252`, `NEW-253`, PR #233):** Accurate single-deduction payout/revenue accounting (`revenue.service.js`), refund quotes, member refund requests, and refund approvals.
   - **Launch wipe & safety tooling (PR #234, #235, #239, #240, #241, #242):** Launch-wipe runbook/SQL updates, R-96 neutral plan copy, content moderation & block lists (`NEW-256`, `NEW-257`), city/area restrictions & pending area requests (`NEW-259`, `NEW-265`), Become-a-Host amenities fix (`NEW-266`), real `organizationName` / brand field (`R-112`), `HH:MM` branch hours + full weekly schedule (`NEW-273`, `R-113`), Store API timeout/takeover hardening (`NEW-276`–`NEW-278`).
2. **Naming v2 & Option S (`NEW-305`–`NEW-312`, R-120):**
   - Safe MySQL 5.7 rename helper (`src/database/rename-helpers.js`: probe-then-act, exact column definition/collation preservation, `ALGORITHM=INPLACE`).
   - Database, model, validator, controller, service, socket, and SQL check updates from `tenant`/`gym`/`listing` → `organization`/`business`/`branch`.
   - Single organization code generator (`ORG-XXXXXXXX`, `src/utils/organization-code.utils.js`).
   - Option S: unified business ID (`businesses.id === business_listings.id`; `gym_listing_id` dropped).
   - Frozen contract documented in `docs/API_CONTRACT_V2.md` (with Amendments A1–A3 and M3e fixes).
3. **Enterprise Organization › Business › Branch (`NEW-303` M1–M3e, `S2`–`S5`):**
   - **Held first branch (`M1`/`M2d`):** Both `first-business` and Add Business (`POST /host/businesses`) validate unified `FirstBranch` schema, store `firstBranchDraft`, reserve 1 capacity unit, and build the first branch only upon admin business approval.
   - **Per-business KYC, approval & Verified badge (`M2`):** Host & admin business document routes (`/kyc-documents`, `/documents`), approval requires proof of premises + ≥3 photos (`422 business_requirements_missing`), independent optional registration document drives `businessVerified` (`verify` / `DELETE /verify`, where revoking also rejects `BUSINESS_REGISTRATION` docs with `"Verification revoked"`).
   - **Capacity pool, branch donor transfer, and refund policy per branch (`M3`):** Branch creation automatically transfers free capacity units across approved businesses (`SLOT_TRANSFERRED` → `SLOT_CONSUMED_BUILD`), gates branch creation on PENDING businesses (`409 business_not_approved`), and moves refund policy exclusively to `branches`.
   - **M3e / Live walkthrough fixes (`S2`–`S5`):** `host/status` `nextStep` hint, normalized `FirstBranch` draft keys, `GET /admin/review-queue` (`kind`, `page`, `total`), `organization.businesses`, `businessVerified` on business detail, `organization_not_active` error code, `genderType`/`logoUrl`/`coverImageUrl` on `first-business`, updated `organization_approved`/`business_approved` deep links, `branchCount` on `GET /host/businesses*`, and non-production `PLACES_PROVIDER=fake` (`S5`).

---

## Migration List (Exact Application Order)

Run **all platform migrations first**, then **all per-organization (tenant) migrations** (`run-tenant-migrations.js` reads `organizations`).

### Platform Database (`p031`–`p038`, target `v38`)

1. `p031_content_moderation` — adds `content_reports`, `user_blocks`, `moderation_words` + starter word rows.
2. `p032_area_requests` — adds `area_requests`, `area_request_links`, `area_aliases`, `areas.{latitude,longitude,radius_m}`, and `area_status`/`area_request_id`.
3. `p033_business_naming` — renames `gym_listings` → `business_listings` (`name`, `primary_branch_id`, `description`), `saved_gyms` → `saved_businesses`, `gym_reviews` → `business_reviews`, `user_gym_memberships` → `member_subscription_index`, `.business_id`, `platform_packages.max_businesses`, `capacity_events.action` `BUSINESS_*`, and indexes.
4. `p034_organization_naming` — renames `tenants` → `organizations`, `tenant_subscriptions` → `organization_subscriptions`, `tenant_invitations` → `organization_invitations`, `user_org_index` → `user_organization_index`, renames columns/indexes, widens `user_blocks.blocked_by`, renames enum/string values (`ORGANIZATION`, `organization`, `first_branch_draft`, `business`).
5. `p035_organization_id_columns` — renames `tenant_id` → `organization_id` and related indexes across all 19 platform tables.
6. `p036_member_index_branch_id` — adds nullable `member_subscription_index.branch_id`.
7. `p037_held_first_branch` — adds `business_listings.first_branch_draft_json`.
8. `p038_business_kyc_verification` — adds `kyc_status`, `kyc_documents_json`, `kyc_submitted_at`, `approved_at`, `approved_by`, `verified_at`, `verified_by` on `business_listings`.

### Per-Organization / Tenant Databases (`028`–`032`, target `v32`)

1. `028_refund_policy_and_requests` — adds `refund_requests` table (and initial refund policy columns).
2. `029_branch_hours_json` — adds `branches.hours_json`.
3. `030_business_naming` — renames `gyms` → `businesses`; renames `gym_id` → `business_id` + indexes on `branches`, `membership_plans`, `expense_categories`.
4. `031_business_one_id` — drops `branches.gym_listing_id` and `businesses.gym_listing_id` (Option S).
5. `032_branch_refund_policy` — adds `branches.{refunds_allowed,refund_window_days}` and drops them from `businesses`.

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
  - New: `APPLE_API_TIMEOUT_MS` (optional runtime), `PLACES_PROVIDER` (dev/local only; ignored in production), `TEST_LOCAL_UPLOAD_DIR` (test only). Removed: none.

---

## Tests

- Full backend test suite verified on local Docker MySQL 5.7 (`7081dd1`, under `caffeinate` with CI ZK timing env):
  - **Suites:** `399 passed, 399 total`
  - **Tests:** `3973 passed, 3973 total`
  - **Snapshots:** `0 total`
- Targeted release-prep verification after adding `docs/RELEASE_1_1_RUNBOOK.md`, `src/scripts/dry-run-release-1-1-backup.js`, and `tests/regression/release-1-1-dry-run-script.test.js`:
  - `npx eslint src/scripts/dry-run-release-1-1-backup.js tests/regression/release-1-1-dry-run-script.test.js` → exit `0` (0 errors, 0 warnings).
  - `npx jest tests/regression/release-1-1-dry-run-script.test.js tests/regression/new-206-env-example-complete.test.js --runInBand --forceExit` → `2 passed, 2 total` suites, `5 passed, 5 total` tests (`release-1-1-dry-run-script` 3/3, `new-206-env-example-complete` 2/2).
  - `node src/scripts/dry-run-release-1-1-backup.js --platform-db gymsera_local_walk` ran against the local throwaway DB (verified v38/v32 schema versions, 41 platform + 24 tenant index checks, non-null `organization_id`, and correctly caught 2 pre-Option-S seeded listings missing matching `businesses` rows in `POWERZONE` and `VITALITYFIT`).


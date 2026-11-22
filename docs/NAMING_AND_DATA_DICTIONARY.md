# Naming and data dictionary: Organization › Business › Branch

Status: **DECIDED by the owner 2026-11-22 (decision R-120, spec §14).** D-1 to D-7 are answered in §8; the fixes F1, F2, F3, F7, F8, F9 are part of the work, F4 goes with the route cleanup, F5 is deferred. The frozen API is [`API_CONTRACT_V2.md`](API_CONTRACT_V2.md). Written 2026-11-22 as a read-only report; decisions added the same day.

Basis: read-only review of `gymsera_be` `origin/main` (`e966d2e`), app `origin/feat/build-27` (`ad5f703`, build 28),
`gymsera_cms` `origin/main` (`5e83da1`), `gymsera_web` `origin/main` (`f2bc76f`). File:line references are to those
commits. All 67 Sequelize models were loaded with no database connection to list their real table, column and index names;
the 24 tables that exist only as raw SQL were parsed from the migration files. No database was opened (none is reachable
from this machine), so foreign-key names are given as the query that finds them, not as literals.

Owner decisions applied (2026-11-22, in the request): there are no real hosts, all data is test data; **no old-build
compatibility** (the draft spec's §2.4 and the legacy-field and Top-hosts workarounds are removed); **the backfill
(NEW-303f) is dropped**, replaced by the launch wipe (runbook `docs/runbooks/launch-wipe.md`, R-79) plus recreating
demo data; goal: clean names everywhere. Recorded with D-1 to D-7 as R-120 in spec §14.

---

## 0. Summary

1. **The glossary is right in direction, with five corrections** (§1.1):
   - (C1) In today's code **"organization" already means a business** (a `gym_listings` row). The word appears about 2,400 times in code and tests, and every use checked outside RBAC means a business:
     `organizationId`, `/discovery/organizations`, `/host/organization-quota`, `max_organizations`, `ORG_DELETED`, the app's
     `GymOrganization` and `EditOrganizationScreen`. Renaming `tenants` to `organizations` before those are renamed to
     "business" would give one word two meanings. Business renames go first.
   - (C2) `tenants.gym_name` / `gym_description` are **not duplicates** of `business_name`. They are the Become a Host draft
     of the *first business*, copied into `gym_listings.title` and `gyms.name` at provisioning
     (`tenant-provisioning.service.js:399,435`). Rename them; don't delete them.
   - (C3) "tenant" is not limited to five names. `tenant_id` is the organization foreign key in 19 platform tables,
     and `tenantId` appears about 4,200 times in code, tests and JSON, plus the access-token claim. A new decision is needed (D-2).
   - (C4) A business has **two ids**: tenant `gyms.id` and platform `gym_listings.id`. Code mixes them: one column name holds
     either id (`access_devices.organization_id` vs `payout_accounts.organization_id`), and one query matches both
     (`gym.service.js:228-235`). Recommendation: give both rows the same UUID (option S, §1.4).
   - (C5) "org" in RBAC (`scope_type = 'ORG'`, `ORG_ADMIN`, `user_org_index`) already means the tenant. It fits the new
     glossary and stays.
2. **Cost splits in two.** Database names (snake_case) are small: most column renames touch under 100 lines, all in
   the API, none in a client. With Sequelize `tableName` / `field` mapping they change **no JSON**, so client test suites
   are untouched. Code and JSON names (camelCase) are large: `tenantId` about 4,200, `gymName` about 670, `gymId` about 660, `gymListingId` about 650.
   Estimates: tiers B+C (database) **≈ 4 days**, tier A (code, JSON, UI, docs) **≈ 11 days**, plus **≈ 5.5 days** if
   `tenant_id` / `tenantId` is renamed too (§4).
3. **Before 5 Dec: documentation only.** Build 28 is the release candidate and the freeze is 2026-11-30. Every JSON rename
   changes the API contract that build 28 reads. **In 1.0.1**, do tiers C+B first (invisible to clients), then write the
   enterprise work (Organization › Business › Branch spec) directly in the new names, and ship tier A together with it in
   one cut-over that uses the force-update gate. No compatibility layer is needed (§6).
4. Found while reading, **not fixed** (each needs its own verify-first issue): §2.10 (F1–F9).

---

## 1. The glossary: validated and corrected

### 1.1 Verdict on each proposed item

| # | Proposed | Verdict | Evidence / correction |
|---|---|---|---|
| G1 | Organization = platform `tenants` → `organizations` | **Confirmed, with an ordering condition (C1)** | "organization"/"org" means *business* today in: `payout_accounts.organization_id` (= `gym_listings.id`, `PayoutAccount.model.js:7`), `access_devices.organization_id` (= tenant `gyms.id`, `device-registry.service.js:588,834`), `platform_packages.max_organizations`, `capacity_events.action` `ORG_DELETED` / `ORG_BRANCHES_MOVED`, `GET /discovery/organizations`, `GET /discovery/organizations/:gymId/branches`, `GET /host/organization-quota`, `?organizationId=` on `/host/branch-quota` (`branch-quota.service.js:12-77`), the comment "Every organization gets its own Gym row" (`host.controller.js:650`), app `GymOrganization`, `EditOrganizationScreen`, `NewOrganizationSourceScreen`, `OrganizationOverviewScreen`, `LastBranchInOrganizationException.organizationName` (= `listing.title`, `gym.service.js:486`), CMS `HostOrganization`, `OrganizationQuota`, `NewOrganizationDialog`. These must become "business" **before** `tenants` becomes `organizations`. |
| G2 | `tenant_code` → `organization_code` | **Confirmed** | `tenants_tenant_code_unique` index renamed too. Values look like `GYM-12345678`, generated in two places (`tenant.service.js:17`, `auth.service.js:1220`, F8). A prefix change for new codes is cosmetic (D-5). |
| G3 | `business_name` → `organization_name` | **Confirmed** | Also `tenant_invitations.business_name`. JSON today: `businessName` (tenants), `brandName` (= `business_name`, `host-status.service.js:134`). Both become `organizationName`. |
| G4 | `main_branch_data_json` → `first_branch_draft_json` | **Confirmed, extended** | Also the stored value `area_request_links.target = 'main_branch'` (`AreaRequestLink.model.js:21`), the virtual `mainBranchCurrency` (`Tenant.model.js:93`), `onboardingBranchData()` in provisioning. |
| G5 | Remove `gym_name` / `gym_description` duplicates | **Corrected (C2)** | Not duplicates: they hold the **first business's** name and description while the organization is a draft, and are copied at approval (`tenant-provisioning.service.js:399-400` to the listing, `:435-436` to `gyms`). Deleting them loses the first business name. Rename to `first_business_name` / `first_business_description` (D-3). `tenants.logo_url`, `cover_image_url`, `gender_type`, `latitude`, `longitude` are the same kind of draft field (copied at `:401-406`, `:437-440`); their COMMENTs say so (§5). Folding all of them into one `first_business_draft_json` is cleaner but larger (D-3, option b). |
| G6 | `tenant_subscriptions` → `organization_subscriptions` | **Confirmed, extended** | FK columns `plan_payment_requests.tenant_subscription_id` and `platform_invoices.tenant_subscription_id` → `organization_subscription_id`. |
| G7 | Platform `gym_listings` → `business_listings` (`title` → `name`) | **Confirmed, extended** | Also `gym_listings.branch_id` → `primary_branch_id` (it is the business's primary branch, `discovery.service.js:500-501`) and `short_description` → `description` (it is the only description; `gyms` already calls it `description`). |
| G8 | Tenant `gyms` → `businesses` | **Confirmed** | One row per business (`host.controller.js:657` creates one per Add Business). Five call sites still read "the" gym with an unordered `Gym.findOne()` (F2). |
| G9 | `gyms.gym_listing_id` → `businesses.listing_id` | **Confirmed as the minimum; option S recommended** | See §1.4: same UUID for both rows, then the link column is redundant. |
| G10 | `branches.gym_id` → `business_id` | **Confirmed, extended** | Same FK in `membership_plans.gym_id` and `expense_categories.gym_id` → `business_id`. |
| G11 | Drop `branches.gym_listing_id` | **Confirmed** | It duplicates `gyms.gym_listing_id` and has caused a real defect: `listBranches` returns `gym_listing_id = X OR gym_id = X OR gym_listing_id IS NULL` (`gym.service.js:228-235`), so a branch with a NULL copy appears under every business (F1). Clients read `branch.gymListingId` (app 189 uses of `gymListingId`), so the drop comes **after** tier A gives branch objects `businessId`. |
| G12 | "tenant" stays only for the per-organization database mechanism | **Extended (C3), decision D-2** | Mechanism names that stay: `TenantDbManager`, `tenant-migration-runner.js`, `tenantContext` middleware, `req.tenantDb`, `tenants.db_name` (→ `organizations.db_name`), env `TENANT_DB_*`, the "tenant database" phrase. **Not** mechanism, yet named "tenant": the `tenant_id` FK in 19 platform tables, JSON `tenantId`, the JWT claim `tenantId` (`auth.service.js:166-226`), socket room `tenant:<id>`, R2 key prefix `tenants/<id>/…`. Recommendation in §4 and §6. |

### 1.2 Where "org" already means the organization (keep)

`role_assignments.scope_type` / `user_org_index.scope_type` = `ORG` | `BRANCH`; role key `ORG_ADMIN`; app
`OrgMembership.scopeType` "ORG | BRANCH" and `orgPermissions` (`workspace_models.dart:99-108`); `user_org_index`
("which tenants a user holds any role in", `UserOrgIndex.model.js:4`). Only the table name changes, to
`user_organization_index`, to spell it out.

### 1.3 Final glossary (proposed)

| Term | Means | Platform DB | Tenant DB | API / JSON | UI (English) | Never call it |
|---|---|---|---|---|---|---|
| **Organization** | The host's company. Owns businesses, pays one GymsEra plan, has one tenant database. | `organizations` (`id`, `organization_code`, `organization_name`) | — (the database itself) | `organizationId`, `organizationName`, `organizationCode` | "Organization" (host Profile, CMS); never shown to travellers | tenant (outside the mechanism), brand, business |
| **Business** | One brand of gym the organization runs. Has its own name, photos, KYC, approval and branches. | `business_listings` (public half: approval, discovery, reserved units) | `businesses` (staff half: profile, refund defaults) | `businessId`, `businessName` | "Business" for hosts. Travellers see the business name ("Iron House"). | gym (in identifiers), listing (in JSON), organization, org |
| **Branch** | One physical location of a business. | referenced as `branch_id` (no FK across databases) | `branches` (`business_id`, `branch_name`) | `branchId`, `branchName` | "Branch". Travellers see "<Business> · <Branch>". | gym, location, title |
| **Listing** | Only the table name `business_listings` (the platform half of a business). With option S there is no separate listing id. | `business_listings` | — | not used (without option S: `listingId` only where the platform id is meant) | not used | — |
| **Tenant database** | The per-organization MySQL database and the code that opens and migrates it. | `organizations.db_name`, `connection_string_encrypted` | the whole database | not sent | not used | — |
| **Host** | The user who owns an organization (`users.role = 'GYM_HOST'`, `users.is_host`). | `organizations.owner_user_id` | — | `ownerUserId` | "Host" | owner (except the column), tenant |
| **Member / Traveller** | A user with a subscription / a user browsing businesses. | `users` | `member_subscriptions`, `member_profiles` | `memberId`, `userId` | "Member", "Traveller" | — |
| **GymsEra plan** vs **membership plan** | What an organization pays GymsEra (`organization_subscriptions`, `billing_plans`) vs what a member pays a business (`membership_plans`). | | | `subscription` vs `membershipPlan` | "Your GymsEra plan" vs "Plan" | "package" (except the legacy `platform_packages`) |

Rule for new code (proposed for AGENTS.md, all four repos): no new identifier uses `gym`, `tenant` (outside the
mechanism) or `organization`/`org` for a business. "Gym" stays allowed in UI copy and the brand (GymsEra). This file is
the reference.

### 1.4 Option S: one id per business (recommended, decision D-1)

Today a business has two UUIDs: tenant `gyms.id` and platform `gym_listings.id`, linked by `gyms.gym_listing_id` (and by
the stale copy `branches.gym_listing_id`). Clients receive both (`gymId` and `gymListingId`), routes accept either
(`/host/listings/:listingId/branches` and `/host/gyms/:gymId/branches` share one handler, `host.routes.js:201-202`,
which takes `req.params.gymId || req.params.listingId || req.query.organizationId || req.query.gymId`,
`gyms.controller.js:75`), and one column name holds either one (F3).

Since all data is recreated after the launch wipe, the tenant `businesses` row can be **created with the same UUID** as its
`business_listings` row. Then `businessId` means one value everywhere and `businesses.listing_id` is not needed (drop
`gyms.gym_listing_id` instead of renaming it). Creation sites to change: `host.controller.js:657`,
`tenant-provisioning.service.js:434`, `gym.service.js:131`, `membership-plan.service.js:213`. About 1 day with tests. A
guard test asserts `businesses.id = business_listings.id` for every business. Without option S, keep `businesses.listing_id`
(G9) and use `businessId` = `business_listings.id` in JSON, tenant `businesses.id` internally only.

---

## 2. Other misleading names (full catalogue)

Proposed names follow §1.3. "Tier" = A (code / JSON / UI / docs), B (column), C (table). "Client" = whether a client sees
the change.

### 2.1 Tables

| Current | Proposed | Tier | Why |
|---|---|---|---|
| `tenants` | `organizations` | C | G1 |
| `tenant_subscriptions` | `organization_subscriptions` | C | G6 |
| `tenant_invitations` | `organization_invitations` | C | invites a host to create an organization |
| `gym_listings` | `business_listings` | C | G7 |
| `gyms` (tenant) | `businesses` | C | G8 |
| `saved_gyms` | `saved_businesses` | C | a saved row points at a listing |
| `gym_reviews` | `business_reviews` | C | reviews of a business (optionally one branch) |
| `user_gym_memberships` | `member_subscription_index` | C | it is a routing index of member subscriptions across tenant databases (`UserGymMembership.model.js:5`), not "memberships of gyms" (D-4) |
| `user_org_index` | `user_organization_index` | C | spell out (meaning already right) |
| `gym_staff`, `staff_action_requests`, platform `devices`, `device_members`, `platform_packages` | **no rename** | — | legacy, superseded by `role_assignments`, `approval_requests`, `access_devices`, `billing_plans`. Renaming them is wasted work; retire them in their own issues (F5) |

### 2.2 Columns

| Table.column (current) | Proposed | Tier | Why |
|---|---|---|---|
| `tenants.tenant_code` | `organization_code` | B | G2 |
| `tenants.business_name` | `organization_name` | B | G3 |
| `tenants.gym_name` | `first_business_name` | B | G5 / C2 |
| `tenants.gym_description` | `first_business_description` | B | G5 |
| `tenants.main_branch_data_json` | `first_branch_draft_json` | B | G4 |
| `tenant_invitations.business_name` | `organization_name` | B | G3 |
| `gym_listings.title` | `name` | B | G7 |
| `gym_listings.branch_id` | `primary_branch_id` | B | it is one chosen branch, not "the" branch |
| `gym_listings.short_description` | `description` | B | only description of the business |
| `gyms.gym_listing_id` | **DROP** (option S, decided) | B | G9 / §1.4 |
| `gyms.refunds_allowed`, `gyms.refund_window_days` | **DROP** | B | refund policy is on the branch only (enterprise spec D12, R-120) |
| enterprise P1 columns (p033) on `gym_listings`: `kyc_status`, `kyc_documents_json`, `kyc_submitted_at`, `approved_at`, `approved_by`, `verified_at`, `verified_by`, `first_branch_data_json` | created directly on `business_listings`; the last one as `first_branch_draft_json` | — | new columns take the new names from the start |
| `branches.gym_id`, `membership_plans.gym_id`, `expense_categories.gym_id` | `business_id` | B | G10 |
| `branches.gym_listing_id` | DROP | B (after A) | G11 |
| `payout_accounts.organization_id` | `listing_id` (`business_id` with option S) | B | holds `gym_listings.id` |
| `access_devices.organization_id` | `business_id` | B | holds tenant `gyms.id` (F3) |
| `saved_gyms.gym_listing_id`, `gym_reviews.gym_listing_id`, `user_gym_memberships.gym_listing_id` | `listing_id` (`business_id` with option S) | B | |
| `user_gym_memberships.gym_name` | `business_name` | B | copy of the business name |
| `plan_payment_requests.tenant_subscription_id`, `platform_invoices.tenant_subscription_id` | `organization_subscription_id` | B | G6 |
| `platform_packages.max_organizations` | `max_businesses` | B | counts businesses (legacy table; only if it is not retired first) |
| `tenant_id` in 19 platform tables: `area_request_links`, `audit_logs`, `billing_events`, `capacity_events`, `content_reports`, `conversations`, `devices`, `device_members`, `gym_listings`, `gym_reviews`, `payout_accounts`, `plan_payment_requests`, `platform_invoices`, `tenant_invitations`, `tenant_subscriptions`, `user_blocks`, `user_gym_memberships`, `user_org_index`, `access_devices` | `organization_id` | B2 (D-2) | C3 |
| `capacity_events.listing_id` | keep (`business_id` with option S) | — | already clear |
| `ledger_days.business_date`, `payments.business_date` | **keep**, COMMENT "accounting day" | — | "business date" is the accounting term; renaming touches about 500 occurrences in money code for no gain. The COMMENT says it is unrelated to the Business entity |
| `branches.branch_name` | keep | — | explicit and used about 780 times; `businesses.name` / `business_listings.name` vs `branches.branch_name` is acceptable |
| `branches.traveler_visibility_status` | keep | — | code spelling "traveler" is consistent (about 450 uses); UI says "traveller" |
| `users.is_host`, `users.role = 'GYM_HOST'` | keep | — | role keys are in tokens, RBAC presets and CMS guards; "host" is the glossary word |
| `conversations.unread_count_host` | keep | — | "host" side = the organization's staff |

### 2.3 Stored values (enum and string values in rows)

| Where | Current values | Proposed | Note |
|---|---|---|---|
| `capacity_events.action` | `ORG_DELETED`, `ORG_BRANCHES_MOVED` | `BUSINESS_DELETED`, `BUSINESS_BRANCHES_MOVED` | widen ENUM, UPDATE rows, narrow (existing helper `_widenEnumColumn`, `platform-migrations.js:28`) |
| `area_request_links.target` | `tenant`, `main_branch`, `listing`, `branch` | `organization`, `first_branch_draft`, `listing` (or `business` with option S), `branch` | same three-step ENUM change |
| `user_blocks.blocked_by` | `USER`, `TENANT` | `USER`, `ORGANIZATION` | column is `VARCHAR(8)`: widen to `VARCHAR(16)` first (F6) |
| R2 object keys | `tenants/<id>/…`, `gym-listings/<id>/…`, `gyms/<id>/…`, `branches/<id>/…` | **keep** | the full URL is stored in `logo_url`, `images_json`, … Renaming the prefix for new uploads only would give two layouts; no reader parses the prefix |
| Socket room | `tenant:<id>` | `organization:<id>` (tier A3 only) | in-memory, no stored state |

### 2.4 API models, services and files

| Current | Proposed | Tier |
|---|---|---|
| model `Tenant`, `TenantSubscription`, `TenantInvitation`, `UserOrgIndex` | `Organization`, `OrganizationSubscription`, `OrganizationInvitation`, `UserOrganizationIndex` | A2 |
| model `GymListing`, `Gym`, `SavedGym`, `GymReview`, `UserGymMembership` | `BusinessListing`, `Business`, `SavedBusiness`, `BusinessReview`, `MemberSubscriptionIndex` | A1 |
| association aliases `as: 'gymListing'`, `'gymListings'`, `'gym'` (on SavedGym / GymReview), `'tenant'`, `'ownedTenants'` | `'listing'`/`'businessListing'`, `'business'`, `'organization'`, `'ownedOrganizations'` | A1/A2 (aliases become JSON keys in `include` results) |
| `tenant.service.js` (organization CRUD, onboarding), `tenants.routes.js`, `tenants.controller.js` | `organization.service.js`, `organizations.routes.js`, … | A2 |
| `gym.service.js` (branches + businesses), `gyms.routes.js`, `gyms.controller.js` | `branch.service.js` + `business.service.js`, `business.routes.js` | A1 |
| `tenant-provisioning.service.js` | keep (mechanism: it creates the tenant database) | — |
| `subscription.service.js` (member subscriptions) vs `subscription-quota.service.js`, `subscription-migration.service.js` (GymsEra plans) | `member-subscription.service.js`; `plan-quota.service.js`, `plan-migration.service.js` | A (optional; "subscription" means two things) |
| `branch-quota.service.js#getBranchQuota(tenantId, { organizationId })` | `(organizationId, { businessId })` | A1 |
| `discovery.service.js#listOrganizations`, `#listOrganizationBranches`, `#getTopHosts` | `#listBusinesses`, `#listBusinessBranches`, `#getTopBusinesses` | A1 |

### 2.5 Routes

| Current | Proposed | Note |
|---|---|---|
| `GET /discovery/organizations` | `GET /discovery/businesses` | lists businesses |
| `GET /discovery/organizations/:gymId/branches` | `GET /discovery/businesses/:businessId/branches` | |
| `GET /discovery/top-hosts` | `GET /discovery/top-businesses` | returns businesses; the organization name must not reach travellers (enterprise spec D3) |
| `GET /discovery/gyms`, `/gyms/:id`, `/gyms/featured`, `/top-rated`, `/nearby`, `/map`, `/:id/reviews`, `/:id/payment-details` | `/discovery/branches…` or `/discovery/businesses/:businessId…` (by what each returns) | `:id` is a listing id **or** a branch id today (`discovery.service.js:416-440`, F4); one meaning per route. `/gyms/:id` is registered twice (`discovery.routes.js:269,451`) |
| `GET /host/organization-quota` | `GET /host/business-quota` (or fold into `/host/branch-quota?businessId=`) | |
| `GET /host/listings…` (`/listings`, `/:id`, `/:id/reserved-slots/transfer`, `/:listingId/branches`) | `/host/businesses…` | |
| `GET /host/gyms/:gymId/branches` | delete (duplicate of the above, `host.routes.js:202`) | |
| `/gyms/profile…` (staff side: business profile, logo, cover, images) | `/businesses/:businessId/profile…` | singular "profile" assumes one business per organization |
| `/gyms/branches…`, `/gyms/members…`, `/gyms/staff…` | `/branches…`, `/members…`, `/staff…` | |
| `/tenants/me`, `/tenants/:id/gym-profile`, `/:id/finalize`, `/:id/kyc-documents…` | `/organizations/me`, `/organizations/:id/first-business`, `/:id/finalize`, `/:id/kyc-documents…` | `gym-profile` saves the first business draft |
| `/admin/tenants…` | `/admin/organizations…` | |
| `/admin/tenants/:id/gym-listing…` (`:id` = tenant id **or** `tenantId:listingId`, `admin.service.js:1422`) | `/admin/businesses/:businessId…` | one id, not a compound string (F7) |

### 2.6 JSON fields

The same key carries different things today:

| Key today | Carries (file:line) | Proposed |
|---|---|---|
| `gymName` | `tenant.gymName` (`admin.service.js:669`, `tenant-provisioning.service.js:731`), `tenant.gymName \|\| tenant.businessName` (`me.controller.js:369`, `host-status.service.js:132`, `data-export.service.js:98`), `listing.title` (`admin.service.js:233`, `gym.service.js:1930`, `subscription.service.js:271`) | `businessName` where it is a business; `organizationName` where it is the organization (workspace switcher `context.controller.js:141,145`, staff invite `staff-invites.routes.js:139`, data export) |
| `title` | `listing.title` (`admin.service.js:245`), `tenant.gymName` (`tenant-provisioning.service.js:399`), `b.branchName` (`area-requests.service.js:520`), `t.gymName \|\| t.businessName` (`:509`); the app's `GymListing.fromJson` fills `title` from `name` (`gym_listing.dart:84`) | `businessName` / `branchName`; `title` only for real titles (announcements, notifications, expenses, reviews) |
| `name` | `tenant.gymName` (`membership-plan.service.js:214`), `tenant.businessName` (`stripe-billing.service.js:95`), `gym.name` (`discovery.service.js:235`), `b.branchName` (`context.controller.js:63`) | `businessName`, `organizationName`, `branchName` by entity; `name` only inside an object that is itself that entity |
| `organizationName` | `listing.title` (`gym.service.js:486`), `gym.name` (`discovery.service.js:227`) | `businessName` |
| `brandName` (`host-status.service.js:134`), `businessName` (tenants) | organization name | `organizationName` |
| `organizationId` | `gym_listings.id` (`subscription-migration.service.js:950`, `branch-quota.service.js`) | `businessId` |
| `gymListingId`, `listingId` | listing id | `businessId` (option S) |
| `gymId` | tenant `gyms.id` (`GymOrganization.gymId`, `gym_organization.dart:3`) | `businessId` (option S) |
| `tenantId` | organization id | `organizationId` (A3, D-2) |
| `tenantCode` | organization code | `organizationCode` |
| `mainBranchDataJson`, `mainBranchCurrency` | first-branch draft | `firstBranchDraft`, `firstBranchCurrency` |

### 2.7 App (Flutter) names

| Current | Proposed | Note |
|---|---|---|
| `GymListing` (`features/discovery/data/models/gym_listing.dart`) | `BranchCard` (it is usually a branch: `id` ← `branchId`, `title` ← `name`, `:74,84`) or `BusinessCard` by endpoint | fields `title` → `businessName`/`branchName`, `organizationName` → `businessName` |
| `GymOrganization` | `Business` | |
| `TenantModel`, `TenantsRepository`, `features/tenants/` | `OrganizationModel`, `OrganizationsRepository`, `features/organization/` | |
| `GymsRepository`, `features/gym_host/` | `BusinessRepository` + `BranchRepository`, `features/host_business/` | |
| `UserGymMembership` | `MemberSubscriptionSummary` | |
| `EditOrganizationScreen`, `OrganizationOverviewScreen`, `LastBranchInOrganizationException` | `EditBusinessScreen`, `BusinessOverviewScreen`, `LastBranchInBusinessException` | |
| `brand_name.dart` | `organization_name.dart` | |
| `ListingStep1..5Screen`, `ListingPreviewScreen`, `NewOrganizationSourceScreen`, `add_branch_screen.dart` | **do not rename** | the enterprise spec §3.2 deletes them (new `setup_wizard` module) |
| `GymDetailScreen`, `GymMapScreen`, `GymReviewsScreen`, `GymGalleryScreen`, `HostGymsOverviewScreen`, `StaffGymsTabScreen` | `BusinessDetailScreen`, … | low value; screens can keep "Gym" (UI word) if D-7 keeps "gym" in traveller copy |
| local draft keys `add_branch_draft_v3:*` | replaced by `setup_draft_v1:*` (enterprise spec) | old keys are not read (no compatibility) |

### 2.8 CMS and website names

| Repo | Current | Proposed |
|---|---|---|
| CMS | `/(dashboard)/admin/tenants` | `/admin/organizations` |
| CMS | `/(dashboard)/gym/*` (host area: branches, plans, members, …) | `/business/*` or `/host/*` |
| CMS | types `HostOrganization`, `OrganizationQuota`, `OrganizationImages`, `OrganizationProfileForm`, `OrganizationStripProps`, `NewOrganizationDialogProps`, `SelectedOrgState` (all mean business) | `HostBusiness`, `BusinessQuota`, … `SelectedBusinessState` |
| CMS | `GymListing`, `GymListingDetail`, `CreateGymListingPayload`, `HostListing`, `CapacityAuditListing`, `ListingAccess` | `Business…` |
| CMS | `CreateTenantPayload`, `CreateTenantBranchPayload`, `GetTenantsParams` | `CreateOrganization…` |
| CMS | `OrgMembership` | keep (org = organization, §1.2) |
| Web | `/(public)/gyms/[id]`, `/gyms/[id]/branches/[branchId]` | keep the URL (SEO, shared links; "gyms" is the public word), rename the param to `[businessId]` |
| Web | `/gym-owner/register`, `/for-gym-owners` | keep (marketing URLs) |
| Web | `Tenant`, `TenantStatus`, `RegisterTenantPayload`, `CurrentTenantSubscription`, `GymProfilePayload`, `GymProfileData`, `BusinessData`, `GymPhase` | `Organization…`, `FirstBusinessPayload` (`GymProfile*`), `OrganizationData` (`BusinessData` holds organization fields) |

### 2.9 Looked misleading, kept on purpose

`business_date` (accounting day), `GYM_HOST` role key, `users.is_host`, `traveler_*` spelling in code, `branch_name`,
`TENANT_DB_*` env names, `tenantContext`, `req.tenantDb`, `tenant-migration-runner.js`, `tenant-provisioning.service.js`,
`organizations.db_name`, R2 key prefixes, the website's public URLs. Each is the mechanism, an accounting term, or a
stored or public value where a rename costs more than it clears.

### 2.10 Defects found while reading (NOT fixed; each needs its own verify-first issue)

| # | Defect | Where | Effect |
|---|---|---|---|
| F1 | `listBranches` matches `gym_listing_id = X OR gym_id = X OR gym_listing_id IS NULL` | `gym.service.js:228-235` | a branch with a NULL copy is listed under every business; either id is accepted |
| F2 | "The" gym read with an unordered `Gym.findOne()` | `membership-plan.service.js:88,211`, `discovery.service.js:520`, `tenant-provisioning.service.js:432`, `gym.service.js:224` (`gym.service.js:124` already orders, BUG-22) | in a multi-business organization the wrong business can be used (plan `gymId`, discovery fallback, branch list) |
| F3 | One column name, two id spaces | `access_devices.organization_id` = `gyms.id` (`device-registry.service.js:588,834`); `payout_accounts.organization_id` = `gym_listings.id` (`PayoutAccount.model.js:7`) | a join of the two never matches; reading code cannot tell |
| F4 | Discovery `:id` is a listing id or a branch id; on a miss it opens every ACTIVE tenant database | `discovery.service.js:416-440`, `:780-800`; route registered twice `discovery.routes.js:269,451` | ambiguity; cost grows with every organization |
| F5 | Second systems for one concern still in use | `gym_staff` (6 services) vs `role_assignments`; `staff_action_requests` vs `approval_requests`; platform `devices`/`device_members` vs `access_devices` (ZKTeco phase 4) | AGENTS rule 2 |
| F6 | `user_blocks.blocked_by` is `VARCHAR(8)` | `UserBlock.model.js:17` | any longer value is cut or refused |
| F7 | Admin business routes take a compound `tenantId:listingId` in `:id`; without it they act on the oldest listing | `admin.service.js:1422-1428`, `:1470` | wrong business when the compound part is missing |
| F8 | Organization code generated in two places | `tenant.service.js:17`, `auth.service.js:1220` | two rules can drift |
| F9 | Add Business falls back to the organization draft's logo and cover (`tenants.logo_url`) for every new business | `host.controller.js:662-663` (`logoUrl \|\| tenant.logoUrl`) | a second business shows the first business's logo when none is uploaded. **Owner: remove the fallback** |

---

## 3. Rename catalogue: counts, risk and MySQL 5.7 steps

### 3.1 How the counts were made

Regular expressions over the four exported trees (no `node_modules`, build output, `Pods`, `.dart_tool`, lock files).
Each figure is the number of **occurrences** (comments included), so it is an upper bound on edits. Buckets: API code
(`src/` minus migrations), API tests (`tests/`), migrations (`src/database/platform-migrations.js`,
`tenant-migration-runner.js`, `platform.js`, `tenant-schema-baseline.js`, `rbac-migration.js`, `ledger-migration.js`,
`payout-accounts-backfill.js`, `docker/tenant-db-init.sql`), SQL and scripts (`src/scripts/`, `src/seeders/`,
`scripts/`, `docs/sql/*.sql`, root `*.js`), docs (`*.md`), app (`lib/` vs `test/`), CMS and web (`src/` vs
`tests/`, `e2e/`, `*.test.*`). snake_case and camelCase are counted separately because they are different work:
snake_case is database text, camelCase is code and JSON.

### 3.2 Counts

**Database names (snake_case: raw SQL, migrations, scripts).** Clients never use these.

| Name | API code | API tests | Migrations | SQL + scripts | Docs | App | CMS | Web |
|---|---|---|---|---|---|---|---|---|
| tenants table | 8 | 74 | 12 | 56 | 24 | 0 | 6 | 0 |
| tenant_subscriptions | 3 | 42 | 27 | 37 | 12 | 0 | 0 | 0 |
| gym_listings | 5 | 14 | 6 | 12 | 11 | 1 | 0 | 0 |
| gyms table | 2 | 11 | 13 | 19 | 13 | 20 | 0 | 1 |
| tenant_id | 52 | 43 | 28 | 49 | 18 | 3 | 0 | 0 |
| tenant_code | 7 | 41 | 0 | 69 | 17 | 0 | 0 | 0 |
| business_name | 2 | 2 | 2 | 34 | 13 | 2 | 1 | 3 |
| gym_name | 0 | 6 | 0 | 10 | 6 | 0 | 0 | 0 |
| gym_description | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| main_branch_data_json | 2 | 0 | 0 | 7 | 4 | 0 | 0 | 0 |
| gym_listing_id | 5 | 7 | 20 | 16 | 4 | 0 | 0 | 0 |
| gym_id | 12 | 3 | 0 | 2 | 0 | 1 | 0 | 0 |
| organization_id | 4 | 4 | 5 | 0 | 2 | 0 | 0 | 0 |
| listing_id | 1 | 0 | 2 | 3 | 0 | 0 | 0 | 0 |
| tenant_subscription_id | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| title (gym_listings ctx) | 4 | 1 | 0 | 11 | 0 | 1 | 1 | 0 |

**Code and JSON names (camelCase / class names: model attributes, JSON keys, client fields).**

| Name | API code | API tests | API scripts | App code | App tests | CMS code | CMS tests | Web code | Web tests | Files (API/App/CMS/Web) |
|---|---|---|---|---|---|---|---|---|---|---|
| tenantId | 1721 | 1317 | 144 | 626 | 89 | 192 | 59 | 9 | 7 | 399/96/50/9 |
| tenantCode | 29 | 115 | 121 | 30 | 21 | 0 | 0 | 0 | 0 | 79/24/0/0 |
| businessName | 143 | 84 | 23 | 88 | 40 | 29 | 18 | 8 | 3 | 65/38/14/5 |
| gymName | 147 | 168 | 56 | 182 | 48 | 14 | 11 | 15 | 7 | 117/52/12/13 |
| gymDescription | 27 | 26 | 5 | 74 | 5 | 7 | 3 | 2 | 1 | 20/15/8/3 |
| mainBranchData(Json) | 62 | 111 | 0 | 21 | 16 | 0 | 0 | 2 | 3 | 38/6/0/3 |
| gymListingId | 174 | 149 | 50 | 189 | 22 | 10 | 15 | 14 | 2 | 124/40/16/9 |
| gymId | 76 | 243 | 12 | 282 | 25 | 5 | 2 | 11 | 1 | 121/48/5/3 |
| organizationId | 47 | 60 | 1 | 7 | 3 | 18 | 12 | 0 | 0 | 34/5/16/0 |
| listingId | 127 | 15 | 5 | 27 | 3 | 22 | 4 | 0 | 0 | 27/6/9/0 |
| tenantSubscriptionId | 13 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 8/0/1/0 |
| JSON/ts key 'title' | 239 | 156 | 75 | 763 | 58 | 618 | 72 | 104 | 21 | 130/191/125/40 |
| model TenantSubscription | 105 | 181 | 13 | 3 | 0 | 22 | 0 | 1 | 0 | 83/3/7/1 |
| model GymListing | 197 | 223 | 24 | 89 | 9 | 4 | 0 | 12 | 0 | 125/22/2/3 |
| model Gym | 135 | 236 | 25 | 65 | 62 | 44 | 84 | 53 | 20 | 135/60/52/27 |
| model Tenant | 490 | 423 | 144 | 33 | 5 | 61 | 11 | 10 | 5 | 293/12/25/6 |

**Other names (both forms together).**

| Name | API code | API tests | Migrations | SQL + scripts | App code | App tests | CMS code | CMS tests | Web code | Web tests | Files (API/App/CMS/Web) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| brandName / brand_name | 1 | 4 | 0 | 0 | 12 | 5 | 0 | 0 | 5 | 2 | 3/8/0/5 |
| organizationName | 5 | 0 | 0 | 0 | 42 | 2 | 10 | 1 | 0 | 0 | 3/11/3/0 |
| mainBranchCurrency | 1 | 3 | 0 | 0 | 32 | 3 | 0 | 0 | 0 | 0 | 5/6/0/0 |
| gymListing (var/alias) | 42 | 23 | 0 | 0 | 4 | 3 | 13 | 1 | 2 | 0 | 16/6/6/1 |
| organization* identifiers (Organization/organisation) | 463 | 374 | 9 | 50 | 434 | 190 | 495 | 283 | 6 | 5 | 191/82/122/5 |
| orgId / org_ (abbrev) | 82 | 163 | 0 | 14 | 88 | 31 | 44 | 61 | 0 | 0 | 66/28/30/0 |
| max_organizations / maxOrganizations | 21 | 11 | 0 | 7 | 1 | 6 | 12 | 14 | 0 | 0 | 18/7/17/0 |
| ORG_DELETED / ORG_BRANCHES_MOVED | 5 | 0 | 6 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 7/1/0/0 |
| route /discovery/organizations | 3 | 10 | 0 | 0 | 12 | 3 | 3 | 0 | 0 | 0 | 9/10/3/0 |
| route /host/organization-quota | 1 | 0 | 0 | 0 | 2 | 6 | 6 | 2 | 0 | 0 | 2/8/5/0 |
| route /gym-listing (admin) | 7 | 10 | 0 | 0 | 0 | 0 | 12 | 5 | 0 | 0 | 6/0/6/0 |
| route /gym-profile | 6 | 54 | 0 | 0 | 2 | 31 | 0 | 0 | 2 | 3 | 19/8/0/4 |
| route /gyms/profile | 12 | 73 | 0 | 0 | 9 | 19 | 12 | 10 | 0 | 0 | 32/8/12/0 |
| top-hosts / topHosts | 6 | 1 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 4/3/0/0 |
| user_gym_memberships / UserGymMembership | 72 | 68 | 0 | 15 | 19 | 0 | 0 | 0 | 1 | 0 | 50/3/0/1 |
| user_org_index / UserOrgIndex | 29 | 9 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 16/0/0/0 |
| gym_staff / GymStaff | 84 | 71 | 23 | 21 | 8 | 0 | 6 | 0 | 0 | 0 | 49/3/3/0 |
| saved_gyms / SavedGym | 19 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 8/0/0/0 |
| gym_reviews / GymReview | 35 | 24 | 0 | 15 | 54 | 0 | 6 | 0 | 6 | 0 | 19/8/3/3 |
| branch_name / branchName | 141 | 143 | 0 | 41 | 193 | 32 | 117 | 78 | 25 | 2 | 115/68/74/11 |
| is_host / isHost | 39 | 27 | 0 | 4 | 86 | 7 | 2 | 4 | 6 | 5 | 39/22/7/3 |
| business_date / businessDate | 128 | 235 | 22 | 20 | 59 | 0 | 23 | 9 | 0 | 0 | 45/4/4/0 |
| traveler (US spelling, code) | 110 | 77 | 0 | 10 | 133 | 50 | 39 | 11 | 0 | 0 | 59/41/19/0 |
| GYM_HOST role | 171 | 151 | 0 | 8 | 13 | 10 | 4 | 75 | 6 | 10 | 136/17/51/6 |

Reading the counts:
- **Database text is small and API-only.** No client contains a table or column name (app "gyms table" hits are the
  `/gyms` route string). The largest snake_case items are `tenant_id` (129 outside tests, 172 with them), `tenant_code`
  (117, mostly scripts and tests) and the `tenants` table name (150, mostly scripts and tests).
- **Code and JSON text is large.** `tenantId` 4,200, `gymName` 670, `gymId` 660, `gymListingId` 650, `title` 2,100
  (most `title` hits are legitimate titles; only the business / branch-name ones change).
- Scripts in the API root and `src/scripts/` (one-off checks such as `check_tenant_payment.js`, `gymsera-*-check.js`)
  account for about 40 % of the snake_case hits (325 of 840). Recommendation: delete the dead ones in their own issue instead of
  renaming them.

### 3.3 Risk per rename

| Rename | Tier | Client sees it | Risk | Why |
|---|---|---|---|---|
| tables `gyms`, `gym_listings`, `saved_gyms`, `gym_reviews`, `user_gym_memberships` | C | no | **low** | metadata-only `RENAME TABLE`; models keep attribute names |
| tables `tenants`, `tenant_subscriptions`, `tenant_invitations`, `user_org_index` | C | no | **low–medium** | `tenants` appears in 56 script lines and every launch-wipe / R-79 tool (`reset-platform-data.js`, `docs/sql/launch-wipe-inventory.sql`, `tenant-db-name-before-drop.sql`): those must change in the same commit or the wipe breaks |
| columns of §2.2 (except `tenant_id`) | B | no (with `field:` mapping) | **low** | metadata-only `CHANGE COLUMN`, same type |
| `branches.gym_listing_id` DROP | B | yes (`branch.gymListingId` in JSON) | **medium** | needs tier A1 first and F1 fixed |
| `tenant_id` → `organization_id` (19 tables) | B2 | no (with `field:`) | **low** for the database, **medium** for 52 raw-SQL lines | raw queries in devices, payouts, reports |
| stored values (§2.3) | B | yes (`target`, `blocked_by`, `action` are sent to CMS) | **low** | three-step ENUM change; CMS labels updated in A |
| JSON keys, routes, model and class names | A | **yes** | **high** for the contract, low per line | every rename must land in API, app, CMS and web together; build 28 reads the old keys |
| `tenantId` JSON and JWT claim | A3 | yes | **medium** | about 4,200 occurrences; access tokens issued before the cut-over carry the old claim (§3.6) |

### 3.4 MySQL 5.7 rules for every rename migration

1. **No `RENAME COLUMN` in 5.7** (it is 8.0). Use `ALTER TABLE t CHANGE COLUMN old new <full definition>`. The helper reads
   the current definition from `information_schema.COLUMNS` (`COLUMN_TYPE`, `IS_NULLABLE`, `COLUMN_DEFAULT`, `EXTRA`,
   `CHARACTER_SET_NAME`, `COLLATION_NAME`) and restates it exactly, adding only the new `COMMENT`. UUID columns are
   `CHAR(36) BINARY` (`utf8mb4_bin`): a collation change breaks the foreign key (error 150) and forces a table copy.
2. Append **`, ALGORITHM=INPLACE, LOCK=NONE`** to every `ALTER`. A rename with an unchanged type is then metadata-only,
   and MySQL **refuses** instead of silently copying the table if anything else changed.
3. **Foreign keys.** Renaming a column that is part of a foreign key, on either side, is allowed with the same type.
   InnoDB rewrites the FK definition. `RENAME TABLE` keeps every FK that points to or from the table. Constraint
   *names* (Sequelize's `<table>_ibfk_<n>`) do not change. Rename them by drop-and-add with the existing pattern at
   `platform.js:99-102`, or leave them; the names are cosmetic. Find them with:
   ```sql
   SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
   FROM information_schema.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
     AND (TABLE_NAME IN (...) OR REFERENCED_TABLE_NAME IN (...));
   ```
   FKs expected from the associations (`models/platform/index.js`, `models/tenant/index.js`, those without
   `constraints: false`): `tenant_subscriptions.tenant_id`, `gym_listings.tenant_id`, `platform_invoices.tenant_id` and
   `.tenant_subscription_id`, `user_gym_memberships.tenant_id` and `.gym_listing_id`, `gym_reviews.tenant_id` and
   `.gym_listing_id`, `saved_gyms.gym_listing_id`, `devices.tenant_id`, `tenant_invitations.tenant_id`, `tenants.city_id`,
   `tenants.owner_user_id`, `tenants.selected_package_id`; tenant DB: `branches.gym_id` (ON DELETE CASCADE),
   `membership_plans.gym_id`.
4. **Indexes keep their old names** after a column or table rename. Rename each one with
   `ALTER TABLE t RENAME INDEX old TO new` (5.7+, metadata-only), and give the model the same explicit `name`.
   Otherwise development `sync({ alter: true })` derives a name from the new table and **adds a duplicate index**.
5. **`RENAME TABLE a TO b, c TO d`** is atomic and metadata-only. Check for triggers and views first
   (`information_schema.TRIGGERS` / `VIEWS`; the code creates none).
6. **Comments**: column `COMMENT` goes in the same `CHANGE COLUMN`; table: `ALTER TABLE t COMMENT = '…'`. Limits:
   1,024 characters per column, 2,048 per table. Text in §5.
7. **Sequelize `sync` is the trap.** Development boots `sequelize.sync({ alter: true })` on the platform database
   (`platform.js:453-456`), and provisioning runs `sync({ alter: true })` on every new tenant database before replaying
   *all* tenant migrations from 001 (`tenant-provisioning.service.js:348`, `:726-731`). Therefore:
   - The rename helper handles four states: only old (rename); only new (done); both, with the new one empty (drop the new
     one, then rename; this happens when new code booted before the migration); both, with data in each (refuse and
     report, like `_addNullableColumn`, `platform-migrations.js:66-90`).
   - **Historical migrations that name a renamed table or column are updated to the new names in the same commit.** They
     only run again on a fresh database, where `sync` has already created the new names. Recorded versions never re-run.
     Otherwise p002–p006 (ALTER `tenant_subscriptions`) fail on a fresh database, and tenant 003 (`ensureCol('branches',
     'gym_listing_id')`) re-adds the dropped column. The new rename migration is the only code that still knows the old
     names.
   - `tenant-schema-baseline.js` probes (`ADDS`, NEW-127) are updated to the new names, and a probe is added for each new
     migration (its test fails without one).
8. **Deploy order**: migrations first (`--dry-run`, then apply), then the API (rule already in
   `platform-migrations.js:13-14`). Tenant migrations run through the tenant runner (resumable, per-tenant report).
   After the launch wipe production has no tenant databases; local and staging have.
9. **Numbering**: the enterprise draft names p033 and tenant 030 as "next". Whatever merges first takes the next free
   numbers; the other renumbers. No number is reserved in this report.
10. Tests run only against local/Docker MySQL 5.7 (R-19). The helper gets its own tests for the four states, FK
    survival, index rename, `INPLACE` refusal on a type change, and a re-run that is a no-op.

### 3.5 Helper (sketch, reusing the existing migration style)

```js
// src/database/rename-helpers.js — used by platform and tenant migrations alike.
async function renameColumn(sequelize, { table, from, to, comment }) {
  const col = async (name) => (await sequelize.query(
    'SELECT COLUMN_TYPE t, IS_NULLABLE n, COLUMN_DEFAULT d, EXTRA e, COLLATION_NAME c FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', { replacements: [table, name], type: QueryTypes.SELECT }))[0];
  const [oldCol, newCol] = [await col(from), await col(to)];
  if (!oldCol) return null;                                          // done (or fresh database)
  if (newCol) {                                                      // sync() added an empty copy
    const [{ k }] = await sequelize.query(`SELECT COUNT(*) k FROM \`${table}\` WHERE \`${to}\` IS NOT NULL`, { type: QueryTypes.SELECT });
    if (Number(k) > 0) return { skipped: true, reason: 'both_columns_have_data', table, from, to };
    await sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${to}\`, ALGORITHM=INPLACE, LOCK=NONE`);
  }
  const def = [oldCol.t, oldCol.c && /char|text|enum/i.test(oldCol.t) ? `COLLATE ${oldCol.c}` : '',
    oldCol.n === 'NO' ? 'NOT NULL' : 'NULL', oldCol.d != null ? `DEFAULT ${sequelize.escape(oldCol.d)}` : '',
    oldCol.e || '', `COMMENT ${sequelize.escape(comment)}`].filter(Boolean).join(' ');
  await sequelize.query(`ALTER TABLE \`${table}\` CHANGE COLUMN \`${from}\` \`${to}\` ${def}, ALGORITHM=INPLACE, LOCK=NONE`);
  return null;
}
// renameTable(sequelize, { from, to, comment }) and renameIndex(sequelize, { table, from, to }): same four-state shape.
```
(`DEFAULT CURRENT_TIMESTAMP` and JSON columns need the special cases the real helper will test; the sketch shows the shape.)

### 3.6 Exact steps per migration

Names are final; numbers are placeholders (`pNNN`, `0NN`). Every statement goes through the helper (four states,
`INPLACE`), so each block is idempotent.

**Tenant migration `0NN_business_naming`** (tier C+B, each tenant database):
```sql
RENAME TABLE gyms TO businesses;
ALTER TABLE businesses COMMENT = 'One row per business inside the organization''s tenant database: profile used by staff screens, refund defaults.';
-- option S: ALTER TABLE businesses DROP COLUMN gym_listing_id;  (else:)
ALTER TABLE businesses CHANGE COLUMN gym_listing_id listing_id CHAR(36) BINARY NULL COMMENT 'The platform listing of this business (business_listings.id).', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE branches CHANGE COLUMN gym_id business_id CHAR(36) BINARY NOT NULL COMMENT 'The business this branch belongs to (businesses.id).', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE branches RENAME INDEX branches_gym_id TO branches_business_id;
ALTER TABLE membership_plans CHANGE COLUMN gym_id business_id CHAR(36) BINARY NOT NULL COMMENT 'The business that sells the plan (businesses.id).', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE membership_plans RENAME INDEX membership_plans_gym_id TO membership_plans_business_id;
ALTER TABLE expense_categories CHANGE COLUMN gym_id business_id CHAR(36) BINARY NULL COMMENT 'Business of a custom category; NULL for system categories.', ALGORITHM=INPLACE, LOCK=NONE;
-- FKs branches.gym_id -> gyms.id and membership_plans.gym_id -> gyms.id follow automatically (rule 3).
```
Code in the same commit: `Gym.model.js` `tableName: 'businesses'`, `gymListingId` gets `field: 'listing_id'`; `Branch.model.js`
and `MembershipPlan.model.js` `gymId` gets `field: 'business_id'` and index names; raw SQL with `gym_id` (12 lines in code,
for example `device-registry.service.js:588,834`); historical migrations and baseline probes (rule 7). Attribute names stay,
so the JSON is unchanged.

**Tenant migration `0NN_drop_branch_listing_copy`** (after tier A1, with F1's fix):
```sql
ALTER TABLE branches DROP COLUMN gym_listing_id, ALGORITHM=INPLACE, LOCK=NONE;
```
plus remove `ensureCol('branches', 'gym_listing_id', …)` from migration 003 and its baseline probe.

**Platform migration `pNNN_business_naming`** (tier C+B):
```sql
RENAME TABLE gym_listings TO business_listings, saved_gyms TO saved_businesses,
             gym_reviews TO business_reviews, user_gym_memberships TO member_subscription_index;
ALTER TABLE business_listings
  CHANGE COLUMN title name VARCHAR(200) NOT NULL COMMENT 'Business name shown to travellers. Same value as businesses.name.',
  CHANGE COLUMN branch_id primary_branch_id CHAR(36) BINARY NULL COMMENT 'Primary branch of the business (tenant branches.id).',
  CHANGE COLUMN short_description description TEXT NULL COMMENT 'Business description shown to travellers.',
  ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE business_listings RENAME INDEX gym_listings_city_id_area_id_status TO business_listings_city_id_area_id_status,
  RENAME INDEX gym_listings_tenant_id TO business_listings_tenant_id, RENAME INDEX gym_listings_is_featured TO business_listings_is_featured,
  RENAME INDEX gym_listings_gender_type TO business_listings_gender_type;
ALTER TABLE saved_businesses CHANGE COLUMN gym_listing_id listing_id CHAR(36) BINARY NOT NULL COMMENT 'The business saved.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE saved_businesses RENAME INDEX saved_gyms_user_id_gym_listing_id TO saved_businesses_user_id_listing_id, RENAME INDEX saved_gyms_user_id TO saved_businesses_user_id;
ALTER TABLE business_reviews CHANGE COLUMN gym_listing_id listing_id CHAR(36) BINARY NOT NULL COMMENT 'The business reviewed.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE business_reviews RENAME INDEX gym_reviews_gym_listing_id_status TO business_reviews_listing_id_status,
  RENAME INDEX gym_reviews_branch_id_status TO business_reviews_branch_id_status, RENAME INDEX gym_reviews_user_id TO business_reviews_user_id,
  RENAME INDEX gym_reviews_branch_user_unique TO business_reviews_branch_user_unique;
ALTER TABLE member_subscription_index
  CHANGE COLUMN gym_listing_id listing_id CHAR(36) BINARY NULL COMMENT 'The business, for display without opening the tenant database.',
  CHANGE COLUMN gym_name business_name VARCHAR(200) NULL COMMENT 'Business name at subscription time (copy).', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE member_subscription_index RENAME INDEX user_gym_memberships_user_id_status TO member_subscription_index_user_id_status,
  RENAME INDEX user_gym_memberships_tenant_id TO member_subscription_index_tenant_id,
  RENAME INDEX user_gym_memberships_subscription_id TO member_subscription_index_subscription_id,
  RENAME INDEX user_gym_memberships_gym_listing_id TO member_subscription_index_listing_id;
ALTER TABLE payout_accounts CHANGE COLUMN organization_id listing_id CHAR(36) BINARY NULL COMMENT 'The business this account is for; NULL = organization-wide.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE payout_accounts RENAME INDEX payout_accounts_organization_id TO payout_accounts_listing_id;
ALTER TABLE access_devices CHANGE COLUMN organization_id business_id CHAR(36) BINARY NULL COMMENT 'The business of the device''s branch.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE platform_packages CHANGE COLUMN max_organizations max_businesses INT NOT NULL DEFAULT 1 COMMENT 'Businesses allowed on this legacy package.', ALGORITHM=INPLACE, LOCK=NONE;
-- capacity_events.action: widen with BUSINESS_DELETED, BUSINESS_BRANCHES_MOVED (_widenEnumColumn), then
UPDATE capacity_events SET action = 'BUSINESS_DELETED' WHERE action = 'ORG_DELETED';
UPDATE capacity_events SET action = 'BUSINESS_BRANCHES_MOVED' WHERE action = 'ORG_BRANCHES_MOVED';
-- then narrow the ENUM without the ORG_* values (the helper refuses if a row still holds one).
```
Note `capacity_events` is append-only (model comment). Rewriting two enum values in place is a one-time rename at
launch on test data, not an edit of history.

**Platform migration `pNNN_organization_naming`** (tier C+B):
```sql
RENAME TABLE tenants TO organizations, tenant_subscriptions TO organization_subscriptions,
             tenant_invitations TO organization_invitations, user_org_index TO user_organization_index;
ALTER TABLE organizations
  CHANGE COLUMN tenant_code organization_code VARCHAR(50) NOT NULL COMMENT 'Short human code of the organization, unique.',
  CHANGE COLUMN business_name organization_name VARCHAR(200) NOT NULL COMMENT 'The organization''s own name; private (host Profile, CMS).',
  CHANGE COLUMN gym_name first_business_name VARCHAR(200) NULL COMMENT 'Become a Host draft: name of the first business; copied at provisioning.',
  CHANGE COLUMN gym_description first_business_description TEXT NULL COMMENT 'Become a Host draft: description of the first business.',
  CHANGE COLUMN main_branch_data_json first_branch_draft_json JSON NULL COMMENT 'Become a Host draft of the first branch; built at provisioning.',
  ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE organizations RENAME INDEX tenants_tenant_code_unique TO organizations_organization_code_unique,
  RENAME INDEX tenants_owner_user_id TO organizations_owner_user_id, RENAME INDEX tenants_status TO organizations_status,
  RENAME INDEX tenants_city_id TO organizations_city_id;
ALTER TABLE organization_invitations CHANGE COLUMN business_name organization_name VARCHAR(200) NULL COMMENT 'Organization name proposed in the invitation.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE organization_invitations RENAME INDEX tenant_invitations_token_hash TO organization_invitations_token_hash,
  RENAME INDEX tenant_invitations_owner_email TO organization_invitations_owner_email, RENAME INDEX tenant_invitations_status TO organization_invitations_status;
ALTER TABLE organization_subscriptions RENAME INDEX tenant_subscriptions_tenant_id TO organization_subscriptions_tenant_id,
  RENAME INDEX tenant_subscriptions_status TO organization_subscriptions_status, RENAME INDEX tenant_subscriptions_end_date TO organization_subscriptions_end_date,
  RENAME INDEX tenant_subscriptions_external_original_transaction_id TO organization_subscriptions_external_original_transaction_id,
  RENAME INDEX tenant_subscriptions_platform_external_unique TO organization_subscriptions_platform_external_unique;
ALTER TABLE plan_payment_requests CHANGE COLUMN tenant_subscription_id organization_subscription_id CHAR(36) BINARY NULL COMMENT 'Subscription created when the request was approved.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE platform_invoices CHANGE COLUMN tenant_subscription_id organization_subscription_id CHAR(36) BINARY NULL COMMENT 'The plan this invoice is for.', ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE platform_invoices RENAME INDEX platform_invoices_tenant_subscription_id TO platform_invoices_organization_subscription_id;
ALTER TABLE user_organization_index RENAME INDEX user_org_index_user_id_status TO user_organization_index_user_id_status,
  RENAME INDEX user_org_index_tenant_id_status TO user_organization_index_tenant_id_status;
-- area_request_links.target: widen with 'organization','first_branch_draft'; UPDATE ... SET target='organization' WHERE target='tenant';
--   UPDATE ... SET target='first_branch_draft' WHERE target='main_branch'; narrow.
ALTER TABLE user_blocks MODIFY COLUMN blocked_by VARCHAR(16) NOT NULL;   -- widening a VARCHAR within 255 bytes is in-place
UPDATE user_blocks SET blocked_by = 'ORGANIZATION' WHERE blocked_by = 'TENANT';
```
Type definitions above are from the models and must be checked against `information_schema` by the helper (rule 1). The
launch-wipe tools (`src/scripts/reset-platform-data.js`, `src/services/platform-reset.service.js`,
`docs/sql/launch-wipe-inventory.sql`, `docs/sql/tenant-db-name-before-drop.sql`) and runbook `launch-wipe.md` read
`tenants.db_name`. They change **in this commit**, and `tests/regression/reset-platform-data.test.js` must stay green
(R-79 depends on it).

**Platform migration `pNNN_organization_id`** (tier B2, only if D-2 = rename): in each of the 19 tables of §2.2,
`CHANGE COLUMN tenant_id organization_id CHAR(36) BINARY NOT NULL|NULL COMMENT 'The organization (organizations.id).'` plus
every index whose name contains `tenant_id` (for example `capacity_events_tenant_id`, `platform_invoices_tenant_id`,
`plan_payment_requests_tenant_id_status`, `payout_accounts_tenant_scope_provider` → `payout_accounts_organization_scope_provider`).
FKs follow (rule 3).

---

## 4. Plan in tiers

### 4.1 Tiers and effort (agent-days, including tests and the §13 record)

| Tier | Slice | API | App | CMS | Web | Days |
|---|---|---|---|---|---|---|
| A0 | Docs: glossary into the master spec, this file, AGENTS.md naming rule, a grep guard test per repo that fails on new forbidden identifiers | 0.25 | 0.1 | 0.1 | 0.05 | **0.5** |
| B/C 0 | Rename helper + its tests (§3.4 rule 10) | 0.75 | | | | **0.75** |
| C+B 1 | Business tables and columns (tenant `0NN_business_naming`, platform `pNNN_business_naming`), models mapped, raw SQL, historical migrations, baseline probes | 1.5 | | | | **1.5** |
| C+B 2 | Organization tables and columns (`pNNN_organization_naming`), launch-wipe tools | 1.25 | | | | **1.25** |
| S | Option S: same id for both business rows, guard test | 1.0 | | | | **1.0** |
| A1 | Business words in code and JSON: `organizationId`/`gymListingId`/`gymId`/`listingId` → `businessId`; `gymName`/`title`/`organizationName` → `businessName`/`branchName`; routes of §2.5 (business ones); `ORG_*` labels; models `GymListing`/`Gym`/…; client types and screens not deleted by the enterprise rewrite | 2.5 | 2.5 | 1.5 | 0.5 | **7.0** |
| B 3 | Drop `branches.gym_listing_id` + F1 | 0.5 | | | | **0.5** |
| A2 | Organization words: `Tenant`/`TenantSubscription`/`TenantInvitation` models, `tenantCode`, `businessName`/`brandName` → `organizationName`, `mainBranchData*` → `firstBranchDraft*`, `gymName` (draft) → `firstBusinessName`, `/tenants` and `/admin/tenants` routes | 1.5 | 1.0 | 0.75 | 0.25 | **3.5** |
| B2+A3 | *(D-2)* `tenant_id` → `organization_id` in 19 tables; `tenantId` → `organizationId` in code, JSON, JWT claim, socket room | 2.5 | 1.5 | 1.0 | 0.5 | **5.5** |
| | **Total without B2+A3** | | | | | **≈ 16** |
| | **Total with B2+A3** | | | | | **≈ 21.5** |

Overlap with the enterprise model (draft spec, about 34 days): its P2 deletes the 2,422-line `add_branch_screen.dart` and the six Become a Host screens (§2.7) and rewrites the
Listings / Gyms tabs and the create endpoints. If tier A1 is done **inside** that work instead of before it, about 2 days
of A1 disappear (nothing to rename in code that is rewritten).

### 4.2 Order that keeps every suite green

1. **B/C 0**, the helper with tests. Nothing else changes.
2. **C+B 1, then C+B 2.** Each is one commit per migration: migration, model `tableName` / `field` / index `name`,
   raw-SQL strings, historical migrations, baseline probes, scripts. **Model attribute names do not change**, so every
   JSON response is byte-identical. App, CMS and web suites are not touched. API suite: full run on Docker MySQL 5.7.
   Clients cannot tell, so these can deploy any time after release.
3. **S** (if chosen): creation sites + guard test. JSON still unchanged (`gymListingId` and `gymId` now hold the same value).
4. **A1** per concept (ids, names, routes, models), API first. Each API commit updates its tests and the JSON
   fixtures in `tests/`. Each client commit updates its own fixtures and tests to the new keys. The API branch and the
   three client branches are **merged and deployed together** (no compatibility, §6). Until then each repo is green on
   its own branch against its own fixtures. A contract test in the API (response key lists for the routes in §2.5) proves
   the clients' fixtures match.
5. **B 3** (drop the branch copy + F1), now that no client reads `branch.gymListingId`.
6. **A2** the same way as A1.
7. **B2+A3** last (D-2): one mechanical commit per repo, full suites.

---

## 5. Data dictionary (draft)

Every table and column from the models and the raw-SQL migrations on `origin/main`. "Rename to" shows the tier B / C
proposal (`organization_id (B2, decision D-2)` marks every `tenant_id`). **The description is the proposed COMMENT text**,
written in plain English. Add it in the same `CHANGE COLUMN` as a rename, or with `MODIFY COLUMN … COMMENT` (same
definition, `ALGORITHM=INPLACE`) for columns that keep their name. Model comments that already exist were used as the source where
present. Where the model comment carries an issue id, the COMMENT keeps only the meaning.

### 5.1 Platform database

#### `access_devices`

*platform database · source `src/database/platform-migrations.js`*

**Table COMMENT:** Platform registry of door access devices: which organization and branch a device serial belongs to, and its connection state.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin NOT NULL |  | Primary key. |
| `device_key` | CHAR(8) NOT NULL |  | Short key in the device’s server path that identifies it. |
| `serial_number` | VARCHAR(32) NULL |  | Device serial number. |
| `previous_serial_number` | VARCHAR(32) NULL |  | Serial number before a board swap. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization owning the device (tenants.id). |
| `organization_id` | CHAR(36) bin NULL | `business_id` | The business (tenant gyms.id) of the device’s branch. Note: same column name as payout_accounts.organization_id but a different id space. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `link_mode` | VARCHAR(8) NOT NULL |  | How the device is linked. |
| `comm_key` | VARCHAR(8) NULL |  | Device communication password. |
| `registry_code` | VARCHAR(32) NOT NULL |  | Registration code the device sent. |
| `session_id` | VARCHAR(32) NOT NULL |  | Current device session. |
| `token_mode` | VARCHAR(8) NOT NULL DEFAULT 'log |  | How the device authenticates. |
| `status` | VARCHAR(24) NOT NULL DEFAULT 'awaiting_connection |  | Lifecycle status (values in the type). |
| `registered_at` | DATETIME NULL |  | When the device registered. |
| `last_seen_at` | DATETIME NULL |  | Last time it was seen. |
| `last_ip` | VARCHAR(45) NULL |  | Last IP address. |
| `last_pushver` | VARCHAR(16) NULL |  | Push protocol version last reported. |
| `last_host` | VARCHAR(255) NULL |  | Host name the device last used. |
| `last_scheme` | VARCHAR(8) NULL |  | http or https last used. |
| `last_token_state` | VARCHAR(16) NULL |  | Result of the last token check. |
| `serial_mismatch_at` | DATETIME NULL |  | When the device reported a different serial. |
| `serial_mismatch_value` | VARCHAR(32) NULL |  | The different serial reported. |
| `created_by` | CHAR(36) bin NULL |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `area_aliases`

*platform database · source `src/models/platform/AreaAlias.model.js`*

**Table COMMENT:** Another spelling of an official area in one city; typing it finds the area.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | INT |  | Primary key. |
| `city_id` | INT NOT NULL |  | City (cities.id). |
| `alias_key` | VARCHAR(60) NOT NULL |  | Normalised alias. |
| `area_id` | INT NOT NULL |  | Official area (areas.id); NULL while an area request is pending or none was chosen. |
| `created_by` | CHAR(36) bin |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `area_request_links`

*platform database · source `src/models/platform/AreaRequestLink.model.js`*

**Table COMMENT:** One location (organization draft, first-branch draft, listing or branch) waiting on an area request.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | INT |  | Primary key. |
| `area_request_id` | INT NOT NULL |  | The pending area request (area_requests.id), if any. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `target` | ENUM(tenant,main_branch,listing,branch) NOT NULL |  | What waits: tenant (organization draft), main_branch (first-branch draft), listing, branch. |
| `target_id` | VARCHAR(36) NOT NULL |  | Id of the target (tenant id for tenant / main_branch). |
| `propagated_at` | DATETIME |  | When the approved area was written to the target. |
| `propagation_error` | VARCHAR(300) |  | Why writing to the target failed. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `area_requests`

*platform database · source `src/models/platform/AreaRequest.model.js`*

**Table COMMENT:** An area typed by a host that is not on the official list yet, waiting for a platform admin.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | INT |  | Primary key. |
| `city_id` | INT NOT NULL |  | City (cities.id). |
| `name` | VARCHAR(60) NOT NULL |  | Display name. |
| `name_key` | VARCHAR(60) NOT NULL |  | Normalised name used for matching. |
| `source` | ENUM(typed,google_road,google_landmark) NOT NULL |  | Where the row came from. |
| `google_place_id` | VARCHAR(255) |  | Google Places id of this place. |
| `status` | ENUM(pending_review,approved,merged,rejected) NOT NULL |  | Lifecycle status (values in the type). |
| `open_key` | VARCHAR(120) |  | Uniqueness key while pending; NULL once decided. |
| `resolved_area_id` | INT |  | Official area it was approved or merged into. |
| `requested_by_user_id` | CHAR(36) bin NOT NULL |  | User who asked for it. |
| `reject_reason` | VARCHAR(300) |  | Why it was rejected. |
| `decided_by` | CHAR(36) bin |  | User who decided. |
| `decided_at` | DATETIME |  | When it was decided. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `areas`

*platform database · source `src/models/platform/Area.model.js`*

**Table COMMENT:** Official areas (neighbourhoods) inside a city.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | INT |  | Primary key. |
| `city_id` | INT NOT NULL |  | City (cities.id). |
| `name` | VARCHAR(100) NOT NULL |  | Display name. |
| `image_url` | VARCHAR(500) |  | Image URL. |
| `google_place_id` | VARCHAR(255) |  | Google Places id of this place. |
| `latitude` | DECIMAL(10,8) |  | Latitude (WGS84). |
| `longitude` | DECIMAL(11,8) |  | Longitude (WGS84). |
| `radius_m` | INT |  | Radius in metres. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `audit_logs`

*platform database · source `src/models/platform/AuditLog.model.js`*

**Table COMMENT:** Platform audit trail of mutating API requests (who, what, when).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin |  | The user (users.id). |
| `tenant_id` | CHAR(36) bin | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `method` | VARCHAR(10) NOT NULL |  | Method used. |
| `path` | VARCHAR(500) NOT NULL |  | Request path. |
| `status_code` | SMALLINT NOT NULL |  | Stored HTTP status. |
| `ip_address` | VARCHAR(45) |  | IP address. |
| `user_agent` | TEXT |  | Client user agent. |
| `duration_ms` | INT NOT NULL |  | Request duration in ms. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `billing_events`

*platform database · source `src/models/platform/BillingEvent.model.js`*

**Table COMMENT:** Inbox of every incoming billing notification from Apple, Google and Stripe, processed once.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `provider` | ENUM(APPLE,GOOGLE,STRIPE) NOT NULL |  | Payment / billing provider. |
| `provider_event_id` | VARCHAR(191) NOT NULL |  | Apple notificationUUID, Pub/Sub messageId, or Stripe event id — the provider's own dedupe key. |
| `event_type` | VARCHAR(100) |  | Provider event type. |
| `raw_payload` | LONGTEXT NOT NULL |  | Exactly what the provider sent (after signature verification), kept so the sweep can reprocess it. |
| `status` | ENUM(RECEIVED,PROCESSED,IGNORED,FAILED) NOT NULL |  | Lifecycle status (values in the type). |
| `attempts` | INT NOT NULL |  | How many attempts so far. |
| `last_error` | VARCHAR(500) |  | Last error message. |
| `tenant_id` | CHAR(36) bin | `organization_id (B2, decision D-2)` | OBS-05: the tenant that owns the subscription this event is about, when known. Null when no tenant owns it yet, and on rows from before p022 (not backfilled). |
| `received_at` | DATETIME NOT NULL |  | When it was received. |
| `processed_at` | DATETIME |  | When it was processed. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `billing_offers`

*platform database · source `src/models/platform/BillingOffer.model.js`*

**Table COMMENT:** Promotional offers on GymsEra plans (store offer ids, Stripe coupons).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `name` | VARCHAR(150) NOT NULL |  | Display name. |
| `description` | TEXT |  | Free-text description. |
| `discount_type` | ENUM(PERCENTAGE,FIXED_AMOUNT,FREE_PERIOD) NOT NULL |  | PERCENT or AMOUNT. |
| `discount_value` | DECIMAL(12,2) NOT NULL |  | Percent (0-100) for PERCENTAGE, currency amount for FIXED_AMOUNT, number of billing periods for FREE_PERIOD. |
| `applies_to_branch_min` | INT |  | Smallest branch count the offer applies to. |
| `applies_to_branch_max` | INT |  | Largest branch count the offer applies to. |
| `platform` | ENUM(ALL,IOS,ANDROID,WEB) NOT NULL |  | Where the plan was bought: MANUAL, IOS, ANDROID or STRIPE. |
| `apple_offer_id` | VARCHAR(150) |  | App Store offer code / promotional offer id. |
| `android_offer_id` | VARCHAR(150) |  | Google Play offer id. |
| `stripe_coupon_id` | VARCHAR(150) |  | Stripe coupon id. |
| `valid_from` | DATETIME |  | Offer starts. |
| `valid_until` | DATETIME |  | Offer ends. |
| `is_active` | BOOL NOT NULL |  | Whether it is active. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `billing_plan_price_checks`

*platform database · source `src/models/platform/BillingPlanPriceCheck.model.js`*

**Table COMMENT:** Result of the last read-only price check of a billing plan against a store.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `billing_plan_id` | CHAR(36) bin NOT NULL |  | Catalogue plan (billing_plans.id). |
| `provider` | VARCHAR(10) NOT NULL |  | Payment / billing provider. |
| `status` | ENUM(VERIFIED,MISMATCH,UNVERIFIABLE) NOT NULL |  | Lifecycle status (values in the type). |
| `mismatch_count` | INT NOT NULL |  | Mismatches found. |
| `details_json` | JSON |  | Account details (JSON, bank / wallet). |
| `checked_at` | DATETIME NOT NULL |  | When the check ran. |

#### `billing_plan_prices`

*platform database · source `src/models/platform/BillingPlanPrice.model.js`*

**Table COMMENT:** An extra currency price for a billing plan.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `billing_plan_id` | CHAR(36) bin NOT NULL |  | Catalogue plan (billing_plans.id). |
| `currency` | VARCHAR(3) NOT NULL |  | ISO 4217 currency code. |
| `monthly_minor` | BIGINT NOT NULL |  | Monthly price in minor units. |
| `annual_minor` | BIGINT NOT NULL |  | Annual price in minor units. |
| `stripe_monthly_price_id` | VARCHAR(150) |  | Stripe price id (monthly). |
| `stripe_annual_price_id` | VARCHAR(150) |  | Stripe price id (annual). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `billing_plans`

*platform database · source `src/models/platform/BillingPlan.model.js`*

**Table COMMENT:** The GymsEra plan catalogue: one row per branch count with every store product id and price.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_count` | INT NOT NULL |  | How many branches this step of the staircase includes, across all of a tenant's organizations combined. |
| `ios_monthly_product_id` | VARCHAR(150) |  | App Store product id of the monthly plan. |
| `ios_annual_product_id` | VARCHAR(150) |  | App Store product id of the annual plan. |
| `android_product_id` | VARCHAR(150) |  | Google Play subscription product id. |
| `android_monthly_base_plan_id` | VARCHAR(150) |  | Google Play base plan id (monthly). |
| `android_annual_base_plan_id` | VARCHAR(150) |  | Google Play base plan id (annual). |
| `stripe_product_id` | VARCHAR(150) |  | Stripe product id. |
| `stripe_monthly_price_id` | VARCHAR(150) |  | Stripe price id (monthly). |
| `stripe_annual_price_id` | VARCHAR(150) |  | Stripe price id (annual). |
| `monthly_price` | DECIMAL(12,2) NOT NULL |  | Monthly price (catalogue currency, major units). |
| `annual_price` | DECIMAL(12,2) NOT NULL |  | Annual price (catalogue currency, major units). |
| `currency` | VARCHAR(3) NOT NULL |  | ISO 4217 currency code. |
| `is_active` | BOOL NOT NULL |  | Whether it is active. |
| `sort_order` | INT NOT NULL |  | Display order. |
| `ios_sync_status` | ENUM(SYNCED,PENDING,MISMATCH,NOT_CONFIGURED) NOT NULL |  | Whether the App Store matches this row: SYNCED, PENDING, MISMATCH, NOT_CONFIGURED. |
| `android_sync_status` | ENUM(SYNCED,PENDING,MISMATCH,NOT_CONFIGURED) NOT NULL |  | Whether Google Play matches this row. |
| `stripe_sync_status` | ENUM(SYNCED,PENDING,MISMATCH,NOT_CONFIGURED) NOT NULL |  | Whether Stripe matches this row. |
| `ios_last_synced_at` | DATETIME |  | Last App Store check. |
| `android_last_synced_at` | DATETIME |  | Last Google Play check. |
| `stripe_last_synced_at` | DATETIME |  | Last Stripe check. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `capacity_events`

*platform database · source `src/models/platform/CapacityEvent.model.js`*

**Table COMMENT:** Append-only log of every change to an organization's committed branch capacity (delete, restore, transfer, trim); also the idempotency guard for those changes.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `listing_id` | CHAR(36) bin |  | The business (gym_listings.id) whose reserved_slots changed; NULL for organization-wide events. |
| `branch_id` | CHAR(36) bin |  | The tenant-DB branch this event concerns, when applicable. Not a real FK — branches live in a separate per-tenant database. |
| `action` | ENUM(BRANCH_DELETED,BRANCH_RESTORED,SLOT_TRANSFERRED,SLOT_TRIMMED_DOWNGRADE,SLOT_ATTRIBUTED_UPGRADE,SLOT_CONSUMED_BUILD,ORG_DELETED,ORG_BRANCHES_MOVED,BRANCH_BILLING_LOCKED,BRANCH_BILLING_UNLOCKED) NOT NULL |  | What happened. ORG_DELETED / ORG_BRANCHES_MOVED mean a business was deleted / its branches moved. |
| `delta` | INT NOT NULL |  | Change applied to listingId.reservedSlots by this event (can be negative). |
| `reserved_slots_before` | INT |  | reserved_slots before. |
| `reserved_slots_after` | INT |  | reserved_slots after. |
| `actor_user_id` | CHAR(36) bin |  | Null when actorType is SYSTEM (cron/webhook-driven, no human actor). |
| `actor_type` | ENUM(HOST,ADMIN,SYSTEM) NOT NULL |  | HOST, ADMIN or SYSTEM. |
| `reason` | VARCHAR(255) |  | Reason given. |
| `idempotency_key` | VARCHAR(255) NOT NULL |  | Idempotency key; the same key never applies twice. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `cities`

*platform database · source `src/models/platform/City.model.js`*

**Table COMMENT:** Cities GymsEra serves (official list).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | INT |  | Primary key. |
| `name` | VARCHAR(100) NOT NULL |  | Display name. |
| `is_active` | BOOL |  | Whether it is active. |
| `image_url` | VARCHAR(500) |  | Image URL. |
| `google_place_id` | VARCHAR(255) |  | Google Places id of this place. |
| `latitude` | DECIMAL(10,8) |  | Latitude (WGS84). |
| `longitude` | DECIMAL(11,8) |  | Longitude (WGS84). |
| `country_code` | VARCHAR(2) |  | ISO 3166-1 alpha-2 country code. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `content_reports`

*platform database · source `src/models/platform/ContentReport.model.js`*

**Table COMMENT:** A report by a person about a review or a chat message, handled by platform admins.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `reporter_user_id` | CHAR(36) bin NOT NULL |  | User who reported. |
| `target_type` | VARCHAR(16) NOT NULL |  | What is targeted. |
| `target_id` | CHAR(36) bin NOT NULL |  | Id of the target. |
| `target_user_id` | CHAR(36) bin |  | User who wrote the reported content. |
| `conversation_id` | CHAR(36) bin |  | Conversation (conversations.id). |
| `tenant_id` | CHAR(36) bin | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `reason` | VARCHAR(32) NOT NULL |  | Reason given. |
| `note` | VARCHAR(500) |  | Free-text note. |
| `snapshot_text` | TEXT |  | Copy of the reported text at report time. |
| `status` | VARCHAR(16) NOT NULL |  | Lifecycle status (values in the type). |
| `action` | VARCHAR(32) |  | Action taken / requested. |
| `admin_note` | VARCHAR(500) |  | Note by the platform admin. |
| `handled_by_user_id` | CHAR(36) bin |  | Admin who handled it. |
| `handled_at` | DATETIME |  | When an admin handled it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `conversations`

*platform database · source `src/models/platform/Conversation.model.js`*

**Table COMMENT:** A chat thread between a traveller/member and a branch.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `branch_id` | CHAR(36) bin NOT NULL |  | Branch the conversation is with. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `type` | ENUM(MEMBER,INQUIRY) NOT NULL |  | MEMBER (member chat) or INQUIRY (traveller question). |
| `last_message_text` | TEXT |  | Preview of the last message. |
| `last_message_at` | DATETIME |  | Time of the last message. |
| `unread_count_host` | INT NOT NULL |  | Messages the branch has not read. |
| `unread_count_user` | INT NOT NULL |  | Messages the traveller has not read. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_members`

*platform database · source `src/models/platform/DeviceMember.model.js`*

**Table COMMENT:** Legacy map of a ZKTeco PIN to a user on a legacy device. Superseded by member_device_identity.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `device_id` | CHAR(36) bin NOT NULL |  | The access device (access_devices.id). |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | Denormalized for fast lookup without joining devices table. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `zk_pin` | INT NOT NULL |  | ZKTeco PIN on the legacy device. |
| `label` | VARCHAR(200) |  | Display label. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_tokens`

*platform database · source `src/models/platform/DeviceToken.model.js`*

**Table COMMENT:** Push-notification tokens (FCM/APNs) of a user’s phones.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `token` | VARCHAR(500) NOT NULL |  | Token value. |
| `platform` | ENUM(android,ios,web) NOT NULL |  | Where the plan was bought: MANUAL, IOS, ANDROID or STRIPE. |
| `last_active_at` | DATETIME NOT NULL |  | Last time the user used the app. |
| `device_id` | VARCHAR(255) |  | The access device (access_devices.id). |
| `device_name` | VARCHAR(255) |  | Name of the phone. |
| `app_version` | VARCHAR(40) |  | App version that registered. |
| `locale` | VARCHAR(35) |  | Language / locale. |
| `timezone` | VARCHAR(64) |  | IANA timezone name. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `devices`

*platform database · source `src/models/platform/Device.model.js`*

**Table COMMENT:** Legacy ZKTeco device registry (pre access-device system). Superseded by access_devices; kept until ZKTeco phase 4.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `serial_number` | VARCHAR(100) NOT NULL |  | Device serial number. |
| `name` | VARCHAR(150) NOT NULL |  | Friendly name e.g. "Main Gate Reader". |
| `model` | VARCHAR(100) |  | Device model e.g. ZK-F22, ZKTeco-UA860. |
| `ip_address` | VARCHAR(50) |  | Local IP of the device (for reference/diagnostics). |
| `status` | ENUM(ACTIVE,INACTIVE) NOT NULL |  | Lifecycle status (values in the type). |
| `last_seen_at` | DATETIME |  | Timestamp of last ADMS heartbeat from the device. |
| `last_sync_stamp` | BIGINT NOT NULL |  | Last ATTLOG stamp synced (legacy device). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `gym_listings` → `business_listings`

*platform database · source `src/models/platform/GymListing.model.js`*

**Table COMMENT:** One row per business: the public, traveller-facing record in the platform database (name, photos, area, approval status, reserved branch units).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization that owns this business (tenants.id). |
| `branch_id` | CHAR(36) bin | `primary_branch_id` | Primary branch of the business (tenant branches.id), used for the card and chat; NULL until a branch exists. |
| `city_id` | INT NOT NULL |  | City of the business (of its primary branch). |
| `area_id` | INT |  | Area of the business (of its primary branch). |
| `area_status` | VARCHAR(20) |  | Area marker: NULL = official area set; pending / rejected = waiting on or refused an area request. |
| `area_request_id` | INT |  | The pending area request (area_requests.id), if any. |
| `title` | VARCHAR(200) NOT NULL | `name` | Business name shown to travellers. Same value as gyms.name. |
| `short_description` | TEXT | `description` | Business description shown to travellers. |
| `logo_url` | VARCHAR(500) |  | Logo image URL. |
| `cover_image_url` | VARCHAR(500) |  | Cover image URL. |
| `gender_type` | ENUM(MIXED,MALE_ONLY,FEMALE_ONLY) |  | Who may train: MIXED, MALE_ONLY or FEMALE_ONLY. |
| `average_rating` | DECIMAL(3,2) |  | Average of approved reviews (0–5). |
| `latitude` | DECIMAL(10,8) |  | Latitude (WGS84). |
| `longitude` | DECIMAL(11,8) |  | Longitude (WGS84). |
| `is_featured` | BOOL |  | Promoted in discovery. |
| `contact_phone` | VARCHAR(25) |  | Public phone of the business. |
| `website` | VARCHAR(300) |  | Website URL. |
| `facilities_json` | JSON |  | JSON array of amenity keys. |
| `images_json` | JSON |  | Array of cover/gallery image URLs shown in the public listing. |
| `category` | VARCHAR(50) |  | Category key. |
| `established_year` | INT |  | Year the place opened. |
| `floor_area` | INT |  | Floor area in square feet. |
| `postal_code` | VARCHAR(20) |  | Postal code. |
| `country` | VARCHAR(100) |  | Country name. |
| `min_price` | DECIMAL(10,2) |  | Lowest public plan price, for search filters. |
| `status` | ENUM(ACTIVE,INACTIVE,PENDING,DRAFT,REJECTED) NOT NULL |  | DRAFT, PENDING (under review), ACTIVE (approved), REJECTED, INACTIVE (deleted). |
| `reserved_slots` | INT NOT NULL |  | Branch units of the organization’s plan set aside for this business but not built yet. |
| `rejection_reason` | TEXT |  | Why it was rejected. |
| `rejected_at` | DATETIME |  | When it was rejected. |
| `rejected_by` | CHAR(36) bin |  | User who rejected it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `gym_reviews` → `business_reviews`

*platform database · source `src/models/platform/GymReview.model.js`*

**Table COMMENT:** A traveller review of a business (optionally of one branch), moderated by platform admins.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `gym_listing_id` | CHAR(36) bin NOT NULL | `listing_id` | The business reviewed (gym_listings.id). |
| `branch_id` | CHAR(36) bin |  | The branch reviewed, if any. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `rating` | TINYINT UNSIGNED NOT NULL |  | Star rating 1–5. |
| `title` | VARCHAR(150) |  | Review title. |
| `body` | TEXT |  | Text body. |
| `status` | ENUM(PENDING,APPROVED,REJECTED) NOT NULL |  | Lifecycle status (values in the type). |
| `admin_note` | VARCHAR(300) |  | Note by the platform admin. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `idempotency_records`

*platform database · source `src/models/platform/IdempotencyRecord.model.js`*

**Table COMMENT:** Stored responses of platform requests sent with an Idempotency-Key, so a retry returns the same answer.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) |  | Primary key. |
| `idempotency_key` | VARCHAR(128) NOT NULL |  | Idempotency key; the same key never applies twice. |
| `user_id` | CHAR(36) |  | The user (users.id). |
| `route` | VARCHAR(255) NOT NULL |  | API route. |
| `request_hash` | VARCHAR(64) NOT NULL |  | Hash of the request body, to refuse a reused key with a different body. |
| `status` | ENUM(IN_PROGRESS,RESOLVED,FAILED) NOT NULL |  | Lifecycle status (values in the type). |
| `status_code` | INT |  | Stored HTTP status. |
| `response_body` | MEDIUMTEXT |  | Stored response returned for a retry. |
| `expires_at` | DATETIME NOT NULL |  | When it expires. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `messages`

*platform database · source `src/models/platform/Message.model.js`*

**Table COMMENT:** One chat message in a conversation.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `conversation_id` | CHAR(36) bin NOT NULL |  | Conversation (conversations.id). |
| `sender_id` | CHAR(36) bin |  | User who sent it. |
| `sender_type` | ENUM(USER,HOST,SYSTEM) NOT NULL |  | USER, HOST or SYSTEM. |
| `text` | TEXT NOT NULL |  | Text. |
| `client_message_id` | VARCHAR(64) |  | Id the client made, to drop duplicate sends. |
| `is_read` | BOOL NOT NULL |  | Read by the recipient. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `moderation_words`

*platform database · source `src/models/platform/ModerationWord.model.js`*

**Table COMMENT:** Words the chat and review filter blocks.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `word` | VARCHAR(50) NOT NULL |  | Word or phrase. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `notifications`

*platform database · source `src/models/platform/Notification.model.js`*

**Table COMMENT:** In-app notifications to a user.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `role` | ENUM(traveler,host,admin,staff) NOT NULL |  | Platform role of the user. |
| `type` | VARCHAR(50) NOT NULL |  | Kind of row (values in the type). |
| `title` | VARCHAR(255) NOT NULL |  | Title. |
| `message` | TEXT NOT NULL |  | Message text. |
| `body` | TEXT NOT NULL |  | Text body. |
| `priority` | ENUM(normal,high) NOT NULL |  | Higher runs first. |
| `deep_link` | VARCHAR(255) |  | App route opened when tapped. |
| `metadata_json` | JSON |  | Extra data (JSON). |
| `metadata` | JSON |  | Extra data (JSON). |
| `is_read` | BOOL NOT NULL |  | Read by the recipient. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `otps`

*platform database · source `src/models/platform/Otp.model.js`*

**Table COMMENT:** One-time codes (email/phone verification, password reset).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `email` | VARCHAR(150) NOT NULL |  | Email address. |
| `code` | VARCHAR(64) NOT NULL |  | Code. |
| `attempts` | INT NOT NULL |  | How many attempts so far. |
| `max_attempts` | INT NOT NULL |  | Attempts allowed. |
| `type` | ENUM(EMAIL_VERIFICATION,PASSWORD_RESET) NOT NULL |  | Kind of row (values in the type). |
| `expires_at` | DATETIME NOT NULL |  | When it expires. |
| `is_used` | BOOL |  | Already used. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `payout_accounts`

*platform database · source `src/models/platform/PayoutAccount.model.js`*

**Table COMMENT:** Where an organization (or one of its businesses) is paid out: bank / wallet details.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `organization_id` | CHAR(36) bin | `listing_id` | The business (gym_listings.id) this account is for; NULL = organization-wide. |
| `scope_key` | VARCHAR(36) NOT NULL |  | Scope of the row: the listing id, or a fixed key for organization-wide. |
| `provider` | VARCHAR(32) NOT NULL |  | Payment / billing provider. |
| `status` | VARCHAR(16) NOT NULL |  | Lifecycle status (values in the type). |
| `country_code` | VARCHAR(2) |  | ISO 3166-1 alpha-2 country code. |
| `external_account_id` | VARCHAR(255) |  | Provider account id. |
| `capabilities_json` | JSON |  | What the account or device can do (JSON). |
| `details_json` | JSON |  | BANK_TRANSFER: bankName, accountTitle, accountNumber, iban, branchCode, jazzCashNumber, easyPaisaNumber, additionalInstructions. |
| `details_updated_at` | DATETIME |  | SEC-13: last change of the details; a payout is refused for 24 hours after it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `plan_payment_requests`

*platform database · source `src/models/platform/PlanPaymentRequest.model.js`*

**Table COMMENT:** A host’s request to pay for a GymsEra plan outside the stores (bank transfer), reviewed by an admin.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `requested_by_user_id` | CHAR(36) bin NOT NULL |  | User who asked for it. |
| `billing_plan_id` | CHAR(36) bin NOT NULL |  | Catalogue plan (billing_plans.id). |
| `branch_count` | INT NOT NULL |  | Number of branches the plan allows (capacity). |
| `billing_cycle` | VARCHAR(16) NOT NULL |  | MONTHLY, QUARTERLY or YEARLY. |
| `amount` | DECIMAL(12,2) NOT NULL |  | Amount in major units of `currency`. |
| `currency` | VARCHAR(3) NOT NULL |  | ISO 4217 currency code. |
| `method` | VARCHAR(32) NOT NULL |  | Method used. |
| `status` | VARCHAR(16) NOT NULL |  | Lifecycle status (values in the type). |
| `proof_key` | VARCHAR(500) |  | Storage key of the payment proof (private bucket). |
| `payer_reference` | VARCHAR(100) |  | Reference the payer gave. |
| `external_reference` | VARCHAR(255) |  | Reference from the bank / provider. |
| `reviewed_by_user_id` | CHAR(36) bin |  | User who reviewed it. |
| `reviewed_at` | DATETIME |  | When an admin reviewed it. |
| `rejection_reason` | VARCHAR(500) |  | Why it was rejected. |
| `tenant_subscription_id` | CHAR(36) bin | `organization_subscription_id` | Subscription created when the request was approved. |
| `period_start` | DATE |  | Start of the paid period. |
| `period_end` | DATE |  | End of the paid period. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `platform_audit_logs`

*platform database · source `src/models/platform/PlatformAuditLog.model.js`*

**Table COMMENT:** Audit trail of platform-admin actions (approve, reject, revoke, …).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `actor_user_id` | CHAR(36) bin |  | User who did it; NULL for system. |
| `action` | VARCHAR(100) NOT NULL |  | Action taken / requested. |
| `target_type` | VARCHAR(50) |  | What is targeted. |
| `target_id` | VARCHAR(100) |  | Id of the target. |
| `details` | JSON |  | Request details (JSON). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `platform_invoices`

*platform database · source `src/models/platform/PlatformInvoice.model.js`*

**Table COMMENT:** Invoices GymsEra issues to an organization for its plan.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `tenant_subscription_id` | CHAR(36) bin | `organization_subscription_id` | The plan this invoice is for. |
| `invoice_no` | VARCHAR(50) NOT NULL |  | Invoice number. |
| `description` | VARCHAR(500) |  | Free-text description. |
| `subtotal` | DECIMAL(10,2) NOT NULL |  | Total before tax and discount. |
| `tax_amount` | DECIMAL(10,2) |  | Tax. |
| `total_amount` | DECIMAL(10,2) NOT NULL |  | Total to pay. |
| `status` | ENUM(DRAFT,ISSUED,PAID,OVERDUE,CANCELLED) NOT NULL |  | Lifecycle status (values in the type). |
| `due_date` | DATE |  | Payment due date. |
| `paid_at` | DATETIME |  | When it was paid. |
| `notes` | TEXT |  | Internal admin notes. |
| `created_by` | CHAR(36) bin |  | Platform admin user ID who created this invoice. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `platform_packages`

*platform database · source `src/models/platform/PlatformPackage.model.js`*

**Table COMMENT:** Legacy plan catalogue for manual / enterprise deals (before billing_plans).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `name` | VARCHAR(100) NOT NULL |  | Display name. |
| `description` | TEXT |  | Free-text description. |
| `price` | DECIMAL(10,2) NOT NULL |  | Price in major units of the branch currency. |
| `billing_cycle` | ENUM(MONTHLY,QUARTERLY,YEARLY) NOT NULL |  | MONTHLY, QUARTERLY or YEARLY. |
| `max_organizations` | INT NOT NULL | `max_businesses` | Businesses allowed on this legacy package. |
| `max_branches` | INT NOT NULL |  | Branches allowed. |
| `max_trainers` | INT NOT NULL |  | Trainers allowed. |
| `max_members` | INT NOT NULL |  | Members allowed. |
| `feature_flags_json` | JSON |  | Object of feature flags enabled for this package tier. |
| `status` | ENUM(ACTIVE,INACTIVE) NOT NULL |  | Lifecycle status (values in the type). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `refresh_tokens`

*platform database · source `src/models/platform/RefreshToken.model.js`*

**Table COMMENT:** Login refresh tokens (rotated; family_id detects reuse).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `family_id` | CHAR(36) bin |  | Refresh-token family; reuse of an old token revokes the family. |
| `token` | TEXT NOT NULL |  | Token value. |
| `expires_at` | DATETIME NOT NULL |  | When it expires. |
| `is_revoked` | BOOL |  | Revoked. |
| `ip_address` | VARCHAR(50) |  | IP address. |
| `user_agent` | VARCHAR(300) |  | Client user agent. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `saved_gyms` → `saved_businesses`

*platform database · source `src/models/platform/SavedGym.model.js`*

**Table COMMENT:** A business a traveller saved (bookmarked).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `gym_listing_id` | CHAR(36) bin NOT NULL | `listing_id` | The business saved (gym_listings.id). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `schema_migrations`

*platform database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Which versioned migrations have run on this database (platform and every tenant database).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `version` | INT NOT NULL |  | Migration number. |
| `name` | VARCHAR NOT NULL |  | Migration name. |
| `applied_at` | DATETIME |  | When it ran. |

#### `tenant_invitations` → `organization_invitations`

*platform database · source `src/models/platform/TenantInvitation.model.js`*

**Table COMMENT:** An invitation from a platform admin to a new host to create an organization.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `token_hash` | VARCHAR(64) NOT NULL |  | Hash of the token (the token itself is never stored). |
| `owner_email` | VARCHAR(150) NOT NULL |  | Email of the invited owner. |
| `owner_full_name` | VARCHAR(150) NOT NULL |  | Name of the invited owner. |
| `owner_phone` | VARCHAR(25) |  | Phone of the invited owner. |
| `business_name` | VARCHAR(200) NOT NULL | `organization_name` | Organization name proposed in the invitation. |
| `email` | VARCHAR(150) NOT NULL |  | Email address. |
| `phone` | VARCHAR(25) |  | Phone number. |
| `city_id` | INT |  | City (cities.id). |
| `package_id` | CHAR(36) bin |  | Plan offered (platform_packages.id). |
| `invited_by` | CHAR(36) bin NOT NULL |  | Who invited. |
| `status` | ENUM(PENDING,ACCEPTED,EXPIRED,REVOKED) NOT NULL |  | Lifecycle status (values in the type). |
| `expires_at` | DATETIME NOT NULL |  | When it expires. |
| `accepted_at` | DATETIME |  | When the invite was accepted. |
| `tenant_id` | CHAR(36) bin | `organization_id (B2, decision D-2)` | Organization created from the invitation. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `tenant_subscriptions` → `organization_subscriptions`

*platform database · source `src/models/platform/TenantSubscription.model.js`*

**Table COMMENT:** The organization's GymsEra plans (store, Stripe or manual). At most one entitling row (ACTIVE or GRACE) per organization; branch_count is the capacity.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `platform_package_id` | CHAR(36) bin |  | Legacy manual / enterprise plan (platform_packages.id); NULL for store plans. |
| `billing_plan_id` | CHAR(36) bin |  | Catalogue plan (billing_plans.id). |
| `platform` | ENUM(MANUAL,IOS,ANDROID,STRIPE) NOT NULL |  | Where the plan was bought: MANUAL, IOS, ANDROID or STRIPE. |
| `branch_count` | INT |  | Branches this plan allows, copied from the catalogue at purchase. |
| `product_id` | VARCHAR(150) |  | The store product ID actually purchased, e.g. branches_3_monthly. |
| `external_original_transaction_id` | VARCHAR(150) |  | Store id that stays the same across renewals (Apple original transaction id, Google purchase token, Stripe subscription id). |
| `external_transaction_id` | VARCHAR(150) |  | The specific transaction last verified — changes on every renewal, unlike externalOriginalTransactionId. |
| `environment` | ENUM(SANDBOX,PRODUCTION) |  | SANDBOX or PRODUCTION store environment. |
| `last_verified_at` | DATETIME |  | Last time the row was confirmed with the store. |
| `start_date` | DATE NOT NULL |  | First day (date). |
| `end_date` | DATE NOT NULL |  | Last day (date). |
| `amount` | DECIMAL(10,2) NOT NULL |  | What the provider actually charges (verified), major units. |
| `currency` | CHAR(3) |  | ISO 4217 currency code. |
| `billing_cycle` | ENUM(MONTHLY,QUARTERLY,YEARLY) NOT NULL |  | MONTHLY, QUARTERLY or YEARLY. |
| `status` | ENUM(ACTIVE,EXPIRED,CANCELLED,PENDING_MIGRATION,PENDING_CANCEL,SCHEDULED,REVOKED,GRACE,ON_HOLD,PAUSED) NOT NULL |  | ACTIVE and GRACE entitle; EXPIRED, CANCELLED, REVOKED, ON_HOLD, PAUSED do not; PENDING_MIGRATION, PENDING_CANCEL, SCHEDULED are provider-migration states. |
| `auto_renew` | BOOL |  | Renews automatically. |
| `payment_status` | ENUM(PENDING,PAID,FAILED) NOT NULL |  | PENDING, PAID or FAILED. |
| `bank_transfer_ref` | VARCHAR(100) |  | Bank transfer reference for a manual plan. |
| `over_quota_count` | INT NOT NULL |  | Active branches above the plan after a downgrade; >0 blocks new branches. |
| `status_note` | VARCHAR(255) |  | Explanation shown to the host for a transitional status. |
| `pending_change` | JSON |  | Plan change the provider applies later (JSON: plan, branch count, branches to keep, dates). |
| `duplicate_billing` | BOOL NOT NULL |  | A replaced plan is still auto-renewing at the provider. |
| `entitlement_ended_at` | DATETIME |  | When the plan stopped entitling; the 7-day over-quota grace counts from here. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `tenants` → `organizations`

*platform database · source `src/models/platform/Tenant.model.js`*

**Table COMMENT:** One row per organization: the host company that owns businesses and pays the plan. Also holds the Become a Host draft (first business and first branch) and the name of its tenant database.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `tenant_code` | VARCHAR(50) NOT NULL | `organization_code` | Short human code of the organization (e.g. GYM-12345678), unique; used in support and admin lists. |
| `business_name` | VARCHAR(200) NOT NULL | `organization_name` | The organization's own name (company / brand), private: host Profile and CMS only. |
| `owner_user_id` | CHAR(36) bin NOT NULL |  | The user who owns the organization (users.id). |
| `email` | VARCHAR(150) NOT NULL |  | Organization contact email (the owner’s at sign-up). |
| `phone` | VARCHAR(25) |  | Organization contact phone; also the default phone of the first business. |
| `city_id` | INT |  | City chosen in Become a Host (default for the first branch). |
| `area_id` | INT |  | Area chosen in Become a Host (default for the first branch). |
| `area_status` | VARCHAR(20) |  | Area marker: NULL = official area set; pending / rejected = waiting on or refused an area request. |
| `area_request_id` | INT |  | The pending area request (area_requests.id), if any. |
| `address` | TEXT |  | Address given in Become a Host. |
| `gym_name` | VARCHAR(200) | `first_business_name` | Become a Host draft: name of the first business. Copied to gym_listings.title and gyms.name at provisioning. |
| `gym_description` | TEXT | `first_business_description` | Become a Host draft: description of the first business. Copied at provisioning. |
| `logo_url` | VARCHAR(500) |  | Become a Host draft: logo of the first business. Copied at provisioning. |
| `cover_image_url` | VARCHAR(500) |  | Become a Host draft: cover image of the first business. Copied at provisioning. |
| `gender_type` | ENUM(MIXED,MALE_ONLY,FEMALE_ONLY) |  | Become a Host draft: gender rule of the first business. |
| `latitude` | DECIMAL(10,8) |  | Become a Host draft: map pin (fallback for the first branch). |
| `longitude` | DECIMAL(11,8) |  | Become a Host draft: map pin (fallback for the first branch). |
| `main_branch_data_json` | JSON | `first_branch_draft_json` | Become a Host draft of the first branch (JSON). Built into a branches row at provisioning. |
| `payment_method` | VARCHAR(30) |  | Onboarding payment choice: BANK_TRANSFER or PAY_LATER (manual plans). |
| `bank_transfer_ref` | VARCHAR(100) |  | Bank transfer reference given at onboarding. |
| `status` | ENUM(DRAFT,PENDING_REVIEW,UNDER_REVIEW,APPROVED,REJECTED,SUSPENDED,ACTIVE,PENDING_DELETION,DELETED) NOT NULL |  | Organization lifecycle: DRAFT → PENDING → APPROVED → ACTIVE (or REJECTED, SUSPENDED, DELETED). |
| `kyc_status` | ENUM(NOT_SUBMITTED,PENDING,APPROVED,REJECTED) NOT NULL |  | Identity / business documents review: NOT_SUBMITTED, PENDING, APPROVED, REJECTED. |
| `onboarding_step` | INT |  | Last Become a Host step finished (resume point). |
| `kyc_documents_json` | JSON |  | KYC documents uploaded (JSON array: type, storage key, status). |
| `selected_package_id` | CHAR(36) bin |  | Legacy: platform_packages row chosen at onboarding. |
| `approved_at` | DATETIME |  | When it was approved. |
| `approved_by` | CHAR(36) bin |  | User who approved it. |
| `rejected_at` | DATETIME |  | When it was rejected. |
| `rejected_by` | CHAR(36) bin |  | User who rejected it. |
| `rejection_reason` | TEXT |  | Why it was rejected. |
| `db_name` | VARCHAR(100) |  | Name of the organization’s tenant database. The only source of that name for drop tools. |
| `connection_string_encrypted` | TEXT |  | Encrypted connection URL of the tenant database. |
| `provisioning_state` | VARCHAR(32) |  | Last provisioning step finished; NULL = never provisioned by the resumable flow. |
| `provisioning_lock_token` | CHAR(36) |  | Run holding the provisioning lease (server only). |
| `provisioning_locked_until` | DATETIME |  | Until when the provisioning lease is held. |
| `provisioning_error` | VARCHAR(500) |  | Last provisioning error. |
| `deletion_requested_at` | DATETIME |  | When the owner asked to delete the organization (30-day undo starts). |
| `deletion_scheduled_for` | DATETIME |  | When the deletion will run. |
| `deleted_at` | DATETIME |  | When the deletion finished. |
| `status_before_deletion` | VARCHAR(20) |  | Status restored if the deletion is undone. |
| `payment_details_json` | JSON |  | Legacy host payment details (bank, IBAN, wallets). Read through payout_accounts. |
| `payment_details_updated_at` | DATETIME |  | When payment details last changed. |
| `permission_version` | INT NOT NULL |  | Bumped to invalidate every cached permission set of the organization. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `unclaimed_device_contacts`

*platform database · source `src/database/platform-migrations.js`*

**Table COMMENT:** Devices that contacted the server but are not registered to any organization.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `contact_hash` | CHAR(64) NOT NULL |  | Hash of the device contact (serial + host). |
| `serial_number` | VARCHAR(64) NULL |  | Device serial number. |
| `host` | VARCHAR(255) NULL |  | Host name the device called. |
| `path_key` | VARCHAR(32) NULL |  | Key in the path the device used. |
| `ip` | VARCHAR(45) NULL |  | IP address. |
| `reason` | VARCHAR(32) NOT NULL |  | Reason given. |
| `first_seen_at` | DATETIME NOT NULL |  | First time it was seen. |
| `last_seen_at` | DATETIME NOT NULL |  | Last time it was seen. |
| `hits` | INT UNSIGNED NOT NULL DEFAULT 1 |  | How many times it was seen. |

#### `user_blocks`

*platform database · source `src/models/platform/UserBlock.model.js`*

**Table COMMENT:** A block between a traveller and an organization; chat is refused both ways while it exists.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization in the block. |
| `blocked_by` | VARCHAR(8) NOT NULL |  | Which side blocked: USER (traveller) or TENANT (the organization). |
| `created_by_user_id` | CHAR(36) bin NOT NULL |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `user_gym_memberships` → `member_subscription_index`

*platform database · source `src/models/platform/UserGymMembership.model.js`*

**Table COMMENT:** Index of a member's subscriptions across tenant databases, so the app can list them without opening every tenant database. The real record is the tenant member_subscriptions row.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `gym_listing_id` | CHAR(36) bin NOT NULL | `listing_id` | The business (gym_listings.id), for display without opening the tenant database. |
| `subscription_id` | CHAR(36) bin NOT NULL |  | member_subscriptions.id in the tenant database. |
| `gym_name` | VARCHAR(200) | `business_name` | Business name at subscription time (copy). |
| `plan_name` | VARCHAR(200) |  | Plan name at subscription time (copy). |
| `start_date` | DATE |  | First day (date). |
| `end_date` | DATE |  | Last day (date). |
| `status` | ENUM(PENDING,ACTIVE,FROZEN,EXPIRED,CANCELLED) NOT NULL |  | Lifecycle status (values in the type). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `user_org_index` → `user_organization_index`

*platform database · source `src/models/platform/UserOrgIndex.model.js`*

**Table COMMENT:** Routing index: which organizations a user holds a role in. Never an authorization source; role_assignments in the tenant database decides.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `tenant_id` | CHAR(36) bin NOT NULL | `organization_id (B2, decision D-2)` | The organization (tenants.id) this row belongs to; also selects its tenant database. |
| `role_key` | VARCHAR(40) NOT NULL |  | Role preset key (e.g. ORG_ADMIN, BRANCH_MANAGER). |
| `role_level` | SMALLINT NOT NULL |  | Rank of the role (higher = more senior). |
| `scope_type` | ENUM(ORG,BRANCH) NOT NULL |  | ORG = whole organization; BRANCH = only listed branches. |
| `branch_count` | INT NOT NULL |  | Branches the user’s assignments cover. |
| `status` | ENUM(INVITED,ACTIVE,SUSPENDED,REVOKED) NOT NULL |  | Aggregate state of the user’s assignments in this organization. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `users`

*platform database · source `src/models/platform/User.model.js`*

**Table COMMENT:** Every person with a GymsEra login: travellers, members, hosts, staff and platform admins.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `full_name` | VARCHAR(100) NOT NULL |  | Full name. |
| `email` | VARCHAR(150) NOT NULL |  | Email address. |
| `phone` | VARCHAR(25) |  | Phone number. |
| `password_hash` | VARCHAR(255) |  | Password hash (bcrypt). |
| `role` | ENUM(PLATFORM_ADMIN,GYM_HOST,BRANCH_MANAGER,TRAINER,MEMBER) NOT NULL |  | Platform role: PLATFORM_ADMIN, GYM_HOST, BRANCH_MANAGER, TRAINER, MEMBER. |
| `status` | ENUM(ACTIVE,INACTIVE,SUSPENDED,PENDING_DELETION,DELETED) NOT NULL |  | Lifecycle status (values in the type). |
| `is_verified` | BOOL |  | Verified. |
| `last_login_at` | DATETIME |  | Last login. |
| `google_id` | VARCHAR(100) |  | Google account id. |
| `apple_id` | VARCHAR(100) |  | Apple account id. |
| `profile_image_url` | VARCHAR(500) |  | Profile photo URL. |
| `is_host` | BOOL |  | The user has started Become a Host. |
| `permission_version` | INT NOT NULL |  | Bumped to invalidate every cached permission set of the organization. |
| `apple_refresh_token_encrypted` | TEXT |  | Encrypted Sign in with Apple refresh token (to revoke at account deletion). |
| `deletion_requested_at` | DATETIME |  | When account deletion was asked for (undo window starts). |
| `deletion_scheduled_for` | DATETIME |  | When the deletion will run. |
| `deleted_at` | DATETIME |  | When the row was deleted (soft delete); NULL = not deleted. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

### 5.2 Tenant database

#### `access_device_details`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Tenant-side details of an access device (model, firmware, counts, state); id = access_devices.id.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) NOT NULL |  | Primary key. |
| `branch_id` | CHAR(36) NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `name` | VARCHAR(100) NOT NULL |  | Display name. |
| `direction` | VARCHAR(8) NOT NULL DEFAULT 'in |  | in (entry) or out (exit) door. |
| `enabled` | BOOL NOT NULL DEFAULT 1 |  | Switched on. |
| `model` | VARCHAR(100) NULL |  | Device model. |
| `firmware` | VARCHAR(100) NULL |  | Firmware version. |
| `push_version` | VARCHAR(16) NULL |  | ZKTeco push protocol version. |
| `mac` | VARCHAR(32) NULL |  | MAC address. |
| `comm_type` | VARCHAR(32) NULL |  | Connection type. |
| `device_type` | VARCHAR(8) NULL |  | Device type. |
| `capabilities_json` | TEXT NULL |  | What the account or device can do (JSON). |
| `counts_json` | TEXT NULL |  | User / template / log counts the device reports (JSON). |
| `state_json` | TEXT NULL |  | Device state (JSON). |
| `door_mask` | TINYINT UNSIGNED NOT NULL DEFAULT 1 |  | Doors the device controls (bit mask). |
| `timezone_id` | INT NOT NULL DEFAULT 1 |  | Device time-zone slot. |
| `last_full_audit_at` | DATETIME NULL |  | Last full audit. |
| `last_error_code` | INT NULL |  | Code of the last error. |
| `last_error_at` | DATETIME NULL |  | When the last error happened. |
| `removed_at` | DATETIME NULL |  | When it was removed. |
| `created_by` | CHAR(36) NULL |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `announcements`

*tenant database · source `src/models/tenant/Announcement.model.js`*

**Table COMMENT:** Announcements a branch posts to its members.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `title` | VARCHAR(255) NOT NULL |  | Title. |
| `message` | TEXT NOT NULL |  | Message text. |
| `tag` | VARCHAR(50) NOT NULL |  | Tag. |
| `status` | ENUM(draft,sent) NOT NULL |  | Lifecycle status (values in the type). |
| `created_by` | CHAR(36) bin |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `approval_policies`

*tenant database · source `src/models/tenant/ApprovalPolicy.model.js`*

**Table COMMENT:** Who must approve an approvable action, per organization or per branch.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `action_key` | VARCHAR(64) NOT NULL |  | Permission key of the requested action. |
| `approver_permission` | VARCHAR(64) NOT NULL |  | Permission an approver must hold. |
| `min_approver_level` | SMALLINT NOT NULL |  | Minimum role level that may approve. |
| `quorum` | SMALLINT NOT NULL |  | Approvals needed. |
| `sla_hours` | INT |  | Hours to decide. |
| `escalate_to_level` | SMALLINT |  | Role level it escalates to. |
| `auto_expire_hours` | INT |  | Hours before an undecided request expires. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `approval_requests`

*tenant database · source `src/models/tenant/ApprovalRequest.model.js`*

**Table COMMENT:** An action waiting for a decision (staff request, refund, …).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `action_key` | VARCHAR(64) NOT NULL |  | Permission key of the requested action. |
| `payload` | JSON NOT NULL |  | Event payload. |
| `summary` | VARCHAR(255) |  | Short summary. |
| `requested_by` | CHAR(36) bin NOT NULL |  | User who asked for it. |
| `requested_by_assignment_id` | CHAR(36) bin |  | Role assignment of the requester. |
| `status` | ENUM(PENDING,APPROVED,REJECTED,EXPIRED,CANCELLED) NOT NULL |  | Lifecycle status (values in the type). |
| `decided_by` | CHAR(36) bin |  | User who decided. |
| `decided_at` | DATETIME |  | When it was decided. |
| `decision_reason` | TEXT |  | Reason for the decision. |
| `result_ref` | JSON |  | Reference of the result. |
| `idempotency_key` | VARCHAR(120) |  | Idempotency key; the same key never applies twice. |
| `expires_at` | DATETIME |  | When it expires. |
| `escalated_at` | DATETIME |  | When it escalated. |
| `collected_by` | CHAR(36) bin |  | Staff who collected it. |
| `collected_at` | DATETIME |  | When the cash was collected. |
| `collection_method` | VARCHAR(30) |  | How it was collected. |
| `collection_notes` | TEXT |  | Collection notes. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `assignment_overrides`

*tenant database · source `src/models/tenant/AssignmentOverride.model.js`*

**Table COMMENT:** Per-person permission additions or removals on top of a role preset.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `assignment_id` | CHAR(36) bin NOT NULL |  | Role assignment (role_assignments.id). |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `permission_key` | VARCHAR(64) NOT NULL |  | Permission key from the catalogue. |
| `effect` | ENUM(ALLOW,DENY) NOT NULL |  | GRANT or DENY. |
| `data_scope` | ENUM(ALL,ASSIGNED,OWN) |  | Data the person may see. |
| `constraints` | JSON |  | Limits (JSON). |
| `created_by` | CHAR(36) bin |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `attendance_logs`

*tenant database · source `src/models/tenant/AttendanceLog.model.js`*

**Table COMMENT:** Check-ins and check-outs of members at a branch.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `member_subscription_id` | CHAR(36) bin |  | Member subscription (member_subscriptions.id). |
| `attendance_type` | ENUM(CHECK_IN,CHECK_OUT) NOT NULL |  | How the check-in was made. |
| `check_in_at` | DATETIME NOT NULL |  | Check-in time. |
| `check_out_at` | DATETIME |  | Check-out time. |
| `entry_method` | ENUM(QR_SCAN,MANUAL,RFID,DEVICE) NOT NULL |  | QR, device, manual. |
| `device_id` | VARCHAR(100) |  | The access device (access_devices.id). |
| `notes` | VARCHAR(300) |  | Free-text notes. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `audit_logs`

*tenant database · source `src/models/tenant/AuditLog.model.js`*

**Table COMMENT:** Append-only record of every consequential change inside the organization.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT |  | Primary key. |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `actor_user_id` | CHAR(36) bin |  | User who did it; NULL for system. |
| `actor_role_key` | VARCHAR(40) |  | Role key of the actor at the time. |
| `action` | VARCHAR(64) NOT NULL |  | Action taken / requested. |
| `target_type` | VARCHAR(40) |  | What is targeted. |
| `target_id` | VARCHAR(64) |  | Id of the target. |
| `before_state` | JSON |  | State before (JSON). |
| `after_state` | JSON |  | State after (JSON). |
| `ip` | VARCHAR(64) |  | IP address. |
| `user_agent` | VARCHAR(255) |  | Client user agent. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `branch_visibility_histories`

*tenant database · source `src/models/tenant/BranchVisibilityHistory.model.js`*

**Table COMMENT:** History of a branch’s traveller-visibility changes.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `status` | ENUM(pending,active,deactivated) NOT NULL |  | Lifecycle status (values in the type). |
| `reason` | TEXT |  | Reason given. |
| `changed_by` | CHAR(36) bin |  | Who changed it. |
| `changed_at` | DATETIME NOT NULL |  | When it changed. |

#### `branches`

*tenant database · source `src/models/tenant/Branch.model.js`*

**Table COMMENT:** One physical location of a business: address, hours, currency, timezone, visibility to travellers.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `gym_id` | CHAR(36) bin NOT NULL | `business_id` | The business this branch belongs to (gyms.id). |
| `gym_listing_id` | CHAR(36) bin | `DROP` | Copy of the business’s listing id (gym_listings.id). Redundant with gyms.gym_listing_id; can be NULL or stale. |
| `branch_name` | VARCHAR(200) NOT NULL |  | Branch name (e.g. "DHA Phase 5"). Travellers see "<Business> · <Branch>". |
| `address` | TEXT |  | Formatted address (from Google Places). |
| `city_id` | INT |  | City (cities.id). |
| `area_id` | INT |  | Official area (areas.id); NULL while an area request is pending or none was chosen. |
| `latitude` | DECIMAL(10,8) |  | Latitude (WGS84). |
| `longitude` | DECIMAL(11,8) |  | Longitude (WGS84). |
| `google_place_id` | VARCHAR(255) |  | Google Places id of this place. |
| `opening_time` | TIME |  | Opens at (HH:MM, branch timezone). |
| `closing_time` | TIME |  | Closes at (HH:MM, branch timezone). |
| `hours_json` | JSON |  | Weekly opening hours (JSON, per day, branch timezone). |
| `phone` | VARCHAR(25) |  | Branch phone. |
| `timezone` | VARCHAR(64) NOT NULL |  | IANA timezone; every business-date boundary uses it. |
| `currency` | VARCHAR(3) NOT NULL |  | ISO 4217 currency of every price, payment and invoice at this branch. |
| `facilities_json` | JSON |  | Array of facility strings e.g. ["AC", "Parking", "Shower"]. |
| `images_json` | JSON |  | Array of gallery image URLs. |
| `tagline` | VARCHAR(255) |  | One-line tagline. |
| `category` | VARCHAR(100) |  | Category key. |
| `tags_json` | JSON |  | Array of tag strings. |
| `description` | TEXT |  | Branch description. |
| `established_year` | INT |  | Year the place opened. |
| `floor_area` | INT |  | Floor area in square feet. |
| `address_line1` | TEXT |  | Address line 1. |
| `address_line2` | TEXT |  | Address line 2 (building, floor). |
| `postal_code` | VARCHAR(20) |  | Postal code. |
| `country` | VARCHAR(100) |  | Country name. |
| `status` | ENUM(ACTIVE,INACTIVE) NOT NULL |  | ACTIVE or INACTIVE (deleted, restorable). |
| `traveler_visibility_status` | ENUM(pending,active,deactivated) NOT NULL |  | Traveller visibility review: pending, active, deactivated. |
| `deactivation_reason` | TEXT |  | Why visibility was deactivated. |
| `deactivated_at` | DATETIME |  | When visibility was deactivated. |
| `deactivated_by` | CHAR(36) bin |  | Who deactivated visibility. |
| `admin_suspended` | BOOL NOT NULL |  | Suspended by a platform admin (hidden, no sales). |
| `admin_suspended_reason` | TEXT |  | Why the admin suspended it. |
| `admin_suspended_at` | DATETIME |  | When suspended. |
| `admin_suspended_by` | CHAR(36) bin |  | Admin who suspended it. |
| `billing_locked_at` | DATETIME |  | Locked because the plan no longer covers it. |
| `billing_lock_reason` | VARCHAR(255) |  | Why it is billing-locked. |
| `paused_at` | DATETIME |  | Paused by the host (hidden from travellers, keeps everything). |
| `paused_by` | CHAR(36) bin |  | Who paused it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `capacity_outbox`

*tenant database · source `src/models/tenant/CapacityOutbox.model.js`*

**Table COMMENT:** Outbox of capacity changes to send to the platform database (applied once, retried on failure).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `event_type` | VARCHAR(60) NOT NULL |  | Provider event type. |
| `payload_json` | JSON NOT NULL |  | Event payload (JSON). |
| `idempotency_key` | VARCHAR(191) NOT NULL |  | Idempotency key; the same key never applies twice. |
| `status` | ENUM(PENDING,PROCESSED,FAILED) NOT NULL |  | Lifecycle status (values in the type). |
| `attempts` | INT NOT NULL |  | How many attempts so far. |
| `last_error` | TEXT |  | Last error message. |
| `processed_at` | DATETIME |  | When it was processed. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `class_schedules`

*tenant database · source `src/models/tenant/ClassSchedule.model.js`*

**Table COMMENT:** Weekly class timetable of a branch.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `name` | VARCHAR(150) NOT NULL |  | Display name. |
| `instructor` | VARCHAR(100) NOT NULL |  | Instructor name. |
| `time` | VARCHAR(100) NOT NULL |  | Time of day. |
| `day` | VARCHAR(10) NOT NULL |  | Day of week. |
| `current_capacity` | INT NOT NULL |  | Places taken. |
| `max_capacity` | INT NOT NULL |  | Places available. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_access_events`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Every door event a device reports (who, when, allowed or refused).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `branch_id` | CHAR(36) NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `device_record_index` | BIGINT NOT NULL |  | Record number on the device. |
| `device_time` | DATETIME NOT NULL |  | Time on the device clock. |
| `utc_time` | DATETIME NOT NULL |  | Same time in UTC. |
| `pin` | VARCHAR(16) NULL |  | Device PIN (number the access device knows the person by). |
| `member_id` | CHAR(36) NULL |  | The member (platform users.id of the member). |
| `card_no` | VARCHAR(32) NULL |  | Access card number. |
| `event_code` | INT NOT NULL |  | Device event code. |
| `verify_type` | INT NULL |  | How the person was verified (finger, face, card, PIN). |
| `inout_status` | INT NULL |  | In or out. |
| `result` | VARCHAR(8) NOT NULL |  | Outcome. |
| `reason` | VARCHAR(24) NULL |  | Reason given. |
| `attendance_id` | CHAR(36) NULL |  | Attendance log row created. |
| `attendance_note` | VARCHAR(40) NULL |  | Why no attendance was made. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `device_admin_pins`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** PINs that hold admin privilege on a device.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `pin` | VARCHAR(16) NOT NULL |  | Device PIN (number the access device knows the person by). |
| `privilege` | TINYINT UNSIGNED NOT NULL |  | Device privilege level. |
| `source` | VARCHAR(10) NOT NULL |  | Where the row came from. |
| `seen_at` | DATETIME NOT NULL |  | When it was seen. |

#### `device_audit_pins`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** PINs found on a device during an audit.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `audit_id` | BIGINT UNSIGNED NOT NULL |  | Device audit (device_audits.id). |
| `pin` | VARCHAR(16) NOT NULL |  | Device PIN (number the access device knows the person by). |

#### `device_audits`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** A comparison of what is on a device with what should be on it.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `status` | VARCHAR(12) NOT NULL |  | Lifecycle status (values in the type). |
| `query_cmd_id` | BIGINT UNSIGNED NULL |  | Command that read users. |
| `count_cmd_id` | BIGINT UNSIGNED NULL |  | Command that read counts. |
| `packs_expected` | INT UNSIGNED NULL |  | Data packs expected. |
| `packs_received` | INT UNSIGNED NOT NULL DEFAULT 0 |  | Data packs received. |
| `device_user_count` | INT NULL |  | Users on the device. |
| `desired_count` | INT NULL |  | Users that should be on it. |
| `extra_count` | INT NULL |  | On the device but not wanted. |
| `missing_count` | INT NULL |  | Wanted but not on the device. |
| `unlinked_count` | INT NULL |  | On the device, matching no member. |
| `report_json` | TEXT NULL |  | Report details (JSON). |
| `started_at` | DATETIME NOT NULL |  | When it started. |
| `finished_at` | DATETIME NULL |  | When it finished. |

#### `device_branch_settings`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Per-branch device options (capture photos, alerts).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `branch_id` | CHAR(36) NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `capture_photos` | BOOL NOT NULL DEFAULT 0 |  | Devices take a photo at each door event. |
| `alerts_enabled` | BOOL NOT NULL DEFAULT 1 |  | Send device alerts. |
| `updated_by` | CHAR(36) NULL |  | User who last changed it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_capture_photos`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Photos a device took at a door event (encrypted, private storage).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `branch_id` | CHAR(36) NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `event_id` | BIGINT UNSIGNED NULL |  | Device access event (device_access_events.id). |
| `pin` | VARCHAR(16) NULL |  | Device PIN (number the access device knows the person by). |
| `device_time` | DATETIME NULL |  | Time on the device clock. |
| `storage_key` | VARCHAR(255) NOT NULL |  | Object storage key (private bucket). |
| `key_version` | SMALLINT UNSIGNED NOT NULL |  | Encryption key version. |
| `sha256` | CHAR(64) NOT NULL |  | SHA-256 of the content. |
| `size` | INT UNSIGNED NOT NULL |  | Size in bytes. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `device_commands`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Queue of commands to send to a device.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `member_id` | CHAR(36) NULL |  | The member (platform users.id of the member). |
| `push_request_id` | CHAR(26) NULL |  | Device push request (device_push_requests.id). |
| `kind` | VARCHAR(24) NOT NULL |  | Kind of row. |
| `args_json` | TEXT NULL |  | Command arguments (JSON). |
| `priority` | TINYINT UNSIGNED NOT NULL DEFAULT 5 |  | Higher runs first. |
| `status` | VARCHAR(12) NOT NULL DEFAULT 'queued |  | Lifecycle status (values in the type). |
| `claim_token` | CHAR(26) NULL |  | Token of the worker that claimed the command. |
| `attempts` | INT UNSIGNED NOT NULL DEFAULT 0 |  | How many attempts so far. |
| `sent_at` | DATETIME NULL |  | When it was sent. |
| `acked_at` | DATETIME NULL |  | When the device confirmed. |
| `return_code` | INT NULL |  | Device return code. |
| `not_before` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP |  | Do not send before. |
| `expires_at` | DATETIME NULL |  | When it expires. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_error_logs`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Errors a device or the sync reported.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `source` | VARCHAR(8) NOT NULL |  | Where the row came from. |
| `kind` | VARCHAR(32) NOT NULL |  | Kind of row. |
| `code` | INT NULL |  | Code. |
| `message` | VARCHAR(255) NULL |  | Message text. |
| `data_json` | TEXT NULL |  | Extra data (JSON). |
| `occurred_at` | DATETIME NOT NULL |  | When it happened. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `device_import_packs`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Data packs received while importing users from a device.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `import_id` | CHAR(26) NOT NULL |  | Device import (device_imports.id). |
| `cmd_id` | BIGINT UNSIGNED NOT NULL |  | Device command id. |
| `pack_idx` | INT UNSIGNED NOT NULL |  | Pack number. |
| `pack_cnt` | INT UNSIGNED NOT NULL |  | Total packs. |
| `records` | INT UNSIGNED NOT NULL DEFAULT 0 |  | Records in the pack. |
| `received_at` | DATETIME NOT NULL |  | When it was received. |

#### `device_import_templates`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Biometric templates read from a device during an import (encrypted).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `import_id` | CHAR(26) NOT NULL |  | Device import (device_imports.id). |
| `pin` | VARCHAR(16) NOT NULL |  | Device PIN (number the access device knows the person by). |
| `bio_type` | TINYINT UNSIGNED NOT NULL |  | Biometric type (fingerprint, face, palm). |
| `bio_no` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Finger / face number on the device. |
| `bio_index` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Template index. |
| `major_ver` | VARCHAR(8) NOT NULL |  | Template algorithm major version. |
| `minor_ver` | VARCHAR(8) NOT NULL DEFAULT '0 |  | Template algorithm minor version. |
| `format` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Template format. |
| `duress` | BOOL NOT NULL DEFAULT 0 |  | Duress finger (raises an alarm). |
| `valid` | BOOL NOT NULL DEFAULT 1 |  | Template is valid. |
| `template_enc` | MEDIUMBLOB NULL |  | Encrypted template. |
| `key_version` | SMALLINT UNSIGNED NULL |  | Encryption key version. |
| `template_sha256` | CHAR(64) NOT NULL |  | SHA-256 of the template. |
| `template_size` | INT UNSIGNED NOT NULL |  | Template size in bytes. |
| `outcome` | VARCHAR(16) NULL |  | Outcome. |
| `biometric_id` | CHAR(36) NULL |  | member_biometrics row created. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `device_import_users`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Users read from a device during an import, with the member they match.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `import_id` | CHAR(26) NOT NULL |  | Device import (device_imports.id). |
| `pin` | VARCHAR(16) NOT NULL |  | Device PIN (number the access device knows the person by). |
| `name` | VARCHAR(24) NULL |  | Display name. |
| `card_no` | VARCHAR(32) NULL |  | Access card number. |
| `privilege` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Device privilege level. |
| `member_id` | CHAR(36) NULL |  | The member (platform users.id of the member). |
| `match_source` | VARCHAR(8) NULL |  | How the user was matched to a member. |
| `remove_at_go_live` | BOOL NOT NULL DEFAULT 0 |  | Delete from the device when it goes live. |
| `identity_created` | BOOL NOT NULL DEFAULT 0 |  | A device identity was created for the member. |
| `card_adopted` | BOOL NOT NULL DEFAULT 0 |  | The device card number was kept. |
| `applied_at` | DATETIME NULL |  | When it was applied. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_imports`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** An import of existing users from a device.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(26) NOT NULL |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `status` | VARCHAR(12) NOT NULL |  | Lifecycle status (values in the type). |
| `requested_by` | CHAR(36) NULL |  | User who asked for it. |
| `query_cmd_ids_json` | TEXT NULL |  | Commands that read users (JSON). |
| `users_count` | INT UNSIGNED NOT NULL DEFAULT 0 |  | Users read. |
| `templates_count` | INT UNSIGNED NOT NULL DEFAULT 0 |  | Templates read. |
| `templates_too_large` | INT UNSIGNED NOT NULL DEFAULT 0 |  | Templates too large to store. |
| `truncated` | BOOL NOT NULL DEFAULT 0 |  | The read stopped early. |
| `result_json` | TEXT NULL |  | Result details (JSON). |
| `started_at` | DATETIME NOT NULL |  | When it started. |
| `ready_at` | DATETIME NULL |  | When the import was ready to review. |
| `applied_at` | DATETIME NULL |  | When it was applied. |
| `applied_by` | CHAR(36) NULL |  | User who applied it. |
| `live_at` | DATETIME NULL |  | When the device went live. |
| `live_by` | CHAR(36) NULL |  | Who made it live. |
| `finished_at` | DATETIME NULL |  | When it finished. |
| `finished_by` | CHAR(36) NULL |  | User who finished it. |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_member_sync`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Desired and applied state of one member on one device.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `member_id` | CHAR(36) NOT NULL |  | The member (platform users.id of the member). |
| `pin` | INT UNSIGNED NOT NULL |  | Device PIN (number the access device knows the person by). |
| `desired` | BOOL NOT NULL DEFAULT 0 |  | The member should be on the device. |
| `desired_hash` | CHAR(64) NULL |  | Hash of what should be on the device. |
| `desired_json` | TEXT NULL |  | What should be on the device (JSON). |
| `applied_hash` | CHAR(64) NULL |  | Hash of what is on the device. |
| `applied_json` | TEXT NULL |  | What is on the device (JSON). |
| `pending_batch_id` | CHAR(26) NULL |  | Command batch in flight. |
| `pending_hash` | CHAR(64) NULL |  | Hash the batch in flight will apply. |
| `state` | VARCHAR(16) NOT NULL DEFAULT 'removed |  | Current state. |
| `attempts` | INT UNSIGNED NOT NULL DEFAULT 0 |  | How many attempts so far. |
| `last_return_code` | INT NULL |  | Device return code of the last try. |
| `last_error_at` | DATETIME NULL |  | When the last error happened. |
| `undesired_since` | DATETIME NULL |  | Not wanted on the device since. |
| `incompatible_json` | TEXT NULL |  | Data the device cannot take (JSON). |
| `retry_day` | DATE NULL |  | Day of the retry budget. |
| `retry_count` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Retries used that day. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `device_pin_sequence`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Next free device PIN in this organization.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | TINYINT UNSIGNED NOT NULL |  | Primary key. |
| `next_pin` | INT UNSIGNED NOT NULL |  | Next free PIN. |

#### `device_push_requests`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** A manual push of members to devices.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(26) NOT NULL |  | Primary key. |
| `kind` | VARCHAR(8) NOT NULL |  | Kind of row. |
| `requested_by` | CHAR(36) NULL |  | User who asked for it. |
| `member_id` | CHAR(36) NULL |  | The member (platform users.id of the member). |
| `branch_id` | CHAR(36) NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `device_ids_json` | TEXT NOT NULL |  | Devices to push to (JSON). |
| `plan_json` | TEXT NULL |  | What will be pushed (JSON). |
| `dedupe_key` | VARCHAR(160) NOT NULL |  | Key that drops duplicate requests. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `deadline_at` | DATETIME NOT NULL |  | Give up after. |
| `finished_at` | DATETIME NULL |  | When it finished. |
| `result_json` | TEXT NULL |  | Result details (JSON). |

#### `device_state`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Raw state snapshots a device sent.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | BIGINT UNSIGNED NOT NULL AUTO_INCREMENT |  | Primary key. |
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `state_json` | TEXT NOT NULL |  | Device state (JSON). |
| `received_at` | DATETIME NOT NULL |  | When it was received. |

#### `device_unlinked_users`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Users on a device that match no member.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `device_id` | CHAR(36) NOT NULL |  | The access device (access_devices.id). |
| `pin` | VARCHAR(16) NOT NULL |  | Device PIN (number the access device knows the person by). |
| `name` | VARCHAR(24) NULL |  | Display name. |
| `card_no` | VARCHAR(32) NULL |  | Access card number. |
| `source` | VARCHAR(8) NOT NULL |  | Where the row came from. |
| `first_seen_at` | DATETIME NOT NULL |  | First time it was seen. |
| `last_seen_at` | DATETIME NOT NULL |  | Last time it was seen. |
| `hits` | INT UNSIGNED NOT NULL DEFAULT 1 |  | How many times it was seen. |

#### `expense_categories`

*tenant database · source `src/models/tenant/ExpenseCategory.model.js`*

**Table COMMENT:** Expense categories (system ones and the organization’s own).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `name` | VARCHAR(100) NOT NULL |  | Display name. |
| `is_system` | BOOL |  | Built in; cannot be deleted. |
| `gym_id` | CHAR(36) bin | `business_id` | Business of a custom category; NULL for system categories. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `expenses`

*tenant database · source `src/models/tenant/Expense.model.js`*

**Table COMMENT:** Expenses recorded against a branch (one-off or recurring template).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `category_id` | CHAR(36) bin NOT NULL |  | Expense category. |
| `title` | VARCHAR(255) NOT NULL |  | Title. |
| `amount` | DECIMAL(12,2) NOT NULL |  | Amount in major units of `currency`. |
| `expense_date` | DATE NOT NULL |  | Date of the expense. |
| `payment_method` | ENUM(cash,bank_transfer,card,other) |  | Payment method. |
| `vendor_name` | VARCHAR(255) |  | Who was paid. |
| `notes` | TEXT |  | Free-text notes. |
| `receipt_url` | VARCHAR(500) |  | Receipt image URL. |
| `is_recurring` | BOOL |  | Recurring template. |
| `recurrence_frequency` | ENUM(weekly,monthly,yearly) |  | How often it recurs. |
| `recurrence_end_date` | DATE |  | Last recurrence date. |
| `recurring_template_id` | CHAR(36) bin |  | Template this expense was generated from. |
| `status` | ENUM(pending,approved,rejected) |  | Lifecycle status (values in the type). |
| `created_by` | CHAR(36) bin NOT NULL |  | User who created it. |
| `reviewed_by` | CHAR(36) bin |  | User who reviewed it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `gym_staff`

*tenant database · source `src/models/tenant/GymStaff.model.js`*

**Table COMMENT:** Legacy staff list per branch (invites, device access). Being replaced by role_assignments.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | Branch of the staff member. |
| `user_id` | CHAR(36) bin |  | The user (users.id). |
| `email` | VARCHAR(255) |  | Email address. |
| `designation` | VARCHAR(100) |  | Job designation. |
| `employment_status` | ENUM(ACTIVE,INACTIVE,TERMINATED) NOT NULL |  | ACTIVE, INACTIVE or TERMINATED. |
| `status` | ENUM(pending,active,declined) NOT NULL |  | Lifecycle status (values in the type). |
| `device_access` | BOOL NOT NULL |  | Staff member may open doors. |
| `invite_token_hash` | VARCHAR(64) |  | Hash of the staff invite token. |
| `token_expires_at` | DATETIME |  | When the invite expires. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `gyms` → `businesses`

*tenant database · source `src/models/tenant/Gym.model.js`*

**Table COMMENT:** One row per business inside the organization’s tenant database: profile used by staff screens, refund defaults; linked to its platform listing.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `name` | VARCHAR(200) NOT NULL |  | Business name. Same value as gym_listings.title. |
| `description` | TEXT |  | Business description. |
| `contact_phone` | VARCHAR(25) |  | Public contact phone. |
| `contact_email` | VARCHAR(150) |  | Public contact email. |
| `website` | VARCHAR(300) |  | Website URL. |
| `gender_type` | ENUM(MIXED,MALE_ONLY,FEMALE_ONLY) NOT NULL |  | Who may train: MIXED, MALE_ONLY or FEMALE_ONLY. |
| `logo_url` | VARCHAR(500) |  | Logo image URL. |
| `cover_image_url` | VARCHAR(500) |  | Cover image URL. |
| `social_links_json` | JSON |  | JSON object of social media links. |
| `images_json` | JSON |  | Array of gallery image URLs. |
| `gym_listing_id` | CHAR(36) bin | `listing_id  (or DROP, see 1.4 option S)` | The platform listing of this business (gym_listings.id). |
| `refunds_allowed` | BOOL NOT NULL |  | Business default: refunds on cancellation allowed. |
| `refund_window_days` | SMALLINT UNSIGNED |  | Business default: days after payment a refund is allowed; NULL = no limit. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `idempotency_records`

*tenant database · source `src/models/tenant/IdempotencyRecord.model.js`*

**Table COMMENT:** Stored responses of tenant requests sent with an Idempotency-Key.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) |  | Primary key. |
| `idempotency_key` | VARCHAR(128) NOT NULL |  | Idempotency key; the same key never applies twice. |
| `user_id` | CHAR(36) |  | The user (users.id). |
| `route` | VARCHAR(255) NOT NULL |  | API route. |
| `request_hash` | VARCHAR(64) NOT NULL |  | Hash of the request body, to refuse a reused key with a different body. |
| `status` | ENUM(IN_PROGRESS,RESOLVED,FAILED) NOT NULL |  | Lifecycle status (values in the type). |
| `status_code` | INT |  | Stored HTTP status. |
| `response_body` | MEDIUMTEXT |  | Stored response returned for a retry. |
| `expires_at` | DATETIME NOT NULL |  | When it expires. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `invoice_sequences`

*tenant database · source `src/models/tenant/InvoiceSequence.model.js`*

**Table COMMENT:** Next invoice number per prefix (gap-free numbering).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `branch_id` | VARCHAR(64) |  | The branch (tenant branches.id; not a real FK across databases). |
| `prefix` | VARCHAR(32) NOT NULL |  | Number prefix. |
| `next_number` | INT UNSIGNED NOT NULL |  | Next number to use. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `invoices`

*tenant database · source `src/models/tenant/Invoice.model.js`*

**Table COMMENT:** Invoices and receipts the organization issues to its members.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `invoice_no` | VARCHAR(50) NOT NULL |  | Invoice number. |
| `invoice_type` | ENUM(MEMBERSHIP,TRAINER,PRODUCT) NOT NULL |  | Invoice or receipt. |
| `reference_entity_id` | CHAR(36) bin |  | Id of the related record. |
| `subtotal` | DECIMAL(10,2) NOT NULL |  | Total before tax and discount. |
| `discount_amount` | DECIMAL(10,2) |  | Discount. |
| `tax_amount` | DECIMAL(10,2) |  | Tax. |
| `total_amount` | DECIMAL(10,2) NOT NULL |  | Total to pay. |
| `due_date` | DATE |  | Payment due date. |
| `paid_at` | DATETIME |  | When it was paid. |
| `status` | ENUM(DRAFT,ISSUED,PAID,OVERDUE,CANCELLED) NOT NULL |  | Lifecycle status (values in the type). |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `created_by` | CHAR(36) bin |  | User who created it. |
| `created_by_role` | VARCHAR(30) |  | Role key of the creator at the time. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `ledger_adjustments`

*tenant database · source `src/models/tenant/LedgerAdjustment.model.js`*

**Table COMMENT:** Append-only corrections to a closed ledger day.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `ledger_day_id` | CHAR(36) bin NOT NULL |  | Ledger day (ledger_days.id). |
| `type` | ENUM(DISCREPANCY_NOTE,VARIANCE_ADJUSTMENT,REVERSAL,MISSED_DAY_RECONCILIATION) NOT NULL |  | Kind of row (values in the type). |
| `related_payment_id` | CHAR(36) bin |  | Original payment of a refund. |
| `amount` | DECIMAL(10,2) |  | Amount in major units of `currency`. |
| `reason` | TEXT NOT NULL |  | Reason given. |
| `created_by` | CHAR(36) bin NOT NULL |  | User who created it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |

#### `ledger_days`

*tenant database · source `src/models/tenant/LedgerDay.model.js`*

**Table COMMENT:** One row per branch per business date: the day’s close (expected vs verified cash).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `business_date` | DATE NOT NULL |  | The accounting day this row closes. |
| `status` | ENUM(OPEN,CLOSED) NOT NULL |  | Lifecycle status (values in the type). |
| `opened_at` | DATETIME NOT NULL |  | When it was opened. |
| `closed_by` | CHAR(36) bin |  | User who closed it. |
| `closed_at` | DATETIME |  | When it was closed. |
| `closed_expected_total` | DECIMAL(10,2) |  | Cash expected at close. |
| `closed_verified_total` | DECIMAL(10,2) |  | Cash counted at close. |
| `closed_collectors_json` | TEXT |  | Who collected what (JSON). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `member_biometric_consents`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** A member’s consent to biometric storage (and its withdrawal).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) NOT NULL |  | Primary key. |
| `member_id` | CHAR(36) NOT NULL |  | The member (platform users.id of the member). |
| `consented_at` | DATETIME NOT NULL |  | When consent was given. |
| `consented_by_user_id` | CHAR(36) NULL |  | Who recorded the consent. |
| `method` | VARCHAR(16) NOT NULL |  | Method used. |
| `revoked_at` | DATETIME NULL |  | When it was revoked. |
| `revoked_by_user_id` | CHAR(36) NULL |  | User who revoked it. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `member_biometric_photos`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** A member’s face photos for devices (encrypted).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) NOT NULL |  | Primary key. |
| `member_id` | CHAR(36) NOT NULL |  | The member (platform users.id of the member). |
| `kind` | VARCHAR(10) NOT NULL |  | Kind of row. |
| `bio_type` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Biometric type (fingerprint, face, palm). |
| `storage_key` | VARCHAR(255) NOT NULL |  | Object storage key (private bucket). |
| `key_version` | SMALLINT UNSIGNED NOT NULL |  | Encryption key version. |
| `sha256` | CHAR(64) NOT NULL |  | SHA-256 of the content. |
| `size` | INT UNSIGNED NOT NULL |  | Size in bytes. |
| `source_device_id` | CHAR(36) NULL |  | Device the data came from. |
| `consent_pending` | BOOL NOT NULL DEFAULT 0 |  | Captured before consent; deleted if consent is not given in time. |
| `pending_until` | DATETIME NULL |  | Deleted at this time unless consent arrives. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `member_biometrics`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** A member’s biometric templates (fingerprint, face; encrypted).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) NOT NULL |  | Primary key. |
| `member_id` | CHAR(36) NOT NULL |  | The member (platform users.id of the member). |
| `bio_type` | TINYINT UNSIGNED NOT NULL |  | Biometric type (fingerprint, face, palm). |
| `bio_no` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Finger / face number on the device. |
| `bio_index` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Template index. |
| `major_ver` | VARCHAR(8) NOT NULL |  | Template algorithm major version. |
| `minor_ver` | VARCHAR(8) NOT NULL DEFAULT '0 |  | Template algorithm minor version. |
| `format` | TINYINT UNSIGNED NOT NULL DEFAULT 0 |  | Template format. |
| `duress` | BOOL NOT NULL DEFAULT 0 |  | Duress finger (raises an alarm). |
| `valid` | BOOL NOT NULL DEFAULT 1 |  | Template is valid. |
| `template_enc` | MEDIUMBLOB NOT NULL |  | Encrypted template. |
| `key_version` | SMALLINT UNSIGNED NOT NULL |  | Encryption key version. |
| `template_sha256` | CHAR(64) NOT NULL |  | SHA-256 of the template. |
| `template_size` | INT UNSIGNED NOT NULL |  | Template size in bytes. |
| `source_device_id` | CHAR(36) NULL |  | Device the data came from. |
| `consent_pending` | BOOL NOT NULL DEFAULT 0 |  | Captured before consent; deleted if consent is not given in time. |
| `pending_until` | DATETIME NULL |  | Deleted at this time unless consent arrives. |
| `enrolled_at` | DATETIME NOT NULL |  | When it was enrolled. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `member_device_identity`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** A member’s device PIN and card number in this organization.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `member_id` | CHAR(36) NOT NULL |  | The member (platform users.id of the member). |
| `pin` | INT UNSIGNED NOT NULL |  | Device PIN (number the access device knows the person by). |
| `card_no` | VARCHAR(32) NULL |  | Access card number. |
| `retired_at` | DATETIME NULL |  | When it stopped being used. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `member_profiles`

*tenant database · source `src/models/tenant/MemberProfile.model.js`*

**Table COMMENT:** Health and contact profile of a member in this organization.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `date_of_birth` | DATE |  | Date of birth. |
| `gender` | ENUM(MALE,FEMALE,OTHER) |  | Gender. |
| `height_cm` | DECIMAL(5,2) |  | Height in cm. |
| `weight_kg` | DECIMAL(5,2) |  | Weight in kg. |
| `fitness_goal` | VARCHAR(200) |  | Fitness goal. |
| `medical_notes` | TEXT |  | Medical notes (private). |
| `emergency_contact_name` | VARCHAR(100) |  | Emergency contact name. |
| `emergency_contact_phone` | VARCHAR(25) |  | Emergency contact phone. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `member_subscriptions`

*tenant database · source `src/models/tenant/MemberSubscription.model.js`*

**Table COMMENT:** A member’s subscription to a membership plan at a branch.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `branch_id` | CHAR(36) bin NOT NULL |  | Branch the subscription is at. |
| `membership_plan_id` | CHAR(36) bin NOT NULL |  | Membership plan (membership_plans.id). |
| `start_date` | DATE NOT NULL |  | First day (date). |
| `end_date` | DATE NOT NULL |  | Last day (date). |
| `status` | ENUM(PENDING,ACTIVE,FROZEN,EXPIRED,CANCELLED) NOT NULL |  | Lifecycle status (values in the type). |
| `auto_renew` | BOOL |  | Renews automatically. |
| `qr_code` | VARCHAR(500) |  | QR payload. |
| `subscribed_at` | DATETIME NOT NULL |  | When the subscription started. |
| `cancelled_at` | DATETIME |  | When it was cancelled. |
| `freeze_from` | DATE |  | Freeze start. |
| `freeze_to` | DATE |  | Freeze end. |
| `remaining_visits` | INT |  | Visits left on a visit-limited plan. |
| `source_channel` | ENUM(ONLINE,WALK_IN,STAFF) |  | Where it was made (app, CMS, device). |
| `notes` | TEXT |  | Free-text notes. |
| `pending_plan_id` | CHAR(36) bin |  | Plan the subscription moves to at the next renewal. |
| `pending_change_effective_date` | DATE |  | When the pending plan change applies. |
| `created_by` | CHAR(36) bin |  | User who created it. |
| `created_by_role` | VARCHAR(30) |  | Role key of the creator at the time. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `membership_plans`

*tenant database · source `src/models/tenant/MembershipPlan.model.js`*

**Table COMMENT:** Plans (packages) a business sells to members, per branch.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `gym_id` | CHAR(36) bin NOT NULL | `business_id` | The business that sells the plan (gyms.id). |
| `branch_id` | CHAR(36) bin |  | The branch where the plan is sold. |
| `name` | VARCHAR(200) NOT NULL |  | Display name. |
| `description` | TEXT |  | Free-text description. |
| `duration_type` | ENUM(DAILY,WEEKLY,MONTHLY,QUARTERLY,YEARLY) NOT NULL |  | Plan length unit. |
| `duration_value` | INT NOT NULL |  | Plan length in units. |
| `price` | DECIMAL(10,2) NOT NULL |  | Price in major units of the branch currency. |
| `joining_fee` | DECIMAL(10,2) |  | One-time joining fee. |
| `security_fee` | DECIMAL(10,2) |  | Refundable security deposit. |
| `visit_limit` | INT |  | Visits allowed; NULL = unlimited. |
| `freeze_limit_days` | INT |  | Days the member may freeze. |
| `is_trial` | BOOL |  | Trial plan. |
| `status` | ENUM(ACTIVE,INACTIVE) NOT NULL |  | Lifecycle status (values in the type). |
| `is_deactivated` | BOOL NOT NULL |  | Hidden from new sales; existing subscriptions keep it. |
| `is_public` | BOOL NOT NULL |  | Shown to travellers. |
| `is_featured` | BOOL NOT NULL |  | Promoted in discovery. |
| `poster_url` | VARCHAR(500) |  | Plan poster image URL. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `payments`

*tenant database · source `src/models/tenant/Payment.model.js`*

**Table COMMENT:** Every money movement from members: collected, refunded, pending.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `payment_for` | ENUM(MEMBERSHIP,TRAINER,PRODUCT,OTHER) NOT NULL |  | What the payment is for. |
| `reference_entity_id` | CHAR(36) bin |  | Id of the related record. |
| `method` | ENUM(CASH,BANK_TRANSFER,CARD,WALLET,ONLINE,POS,TEST) NOT NULL |  | Method used. |
| `gateway_name` | VARCHAR(50) |  | Payment gateway used. |
| `gateway_transaction_id` | VARCHAR(200) |  | Gateway transaction id. |
| `amount` | DECIMAL(10,2) NOT NULL |  | Amount in major units of `currency`. |
| `currency` | VARCHAR(5) NOT NULL |  | ISO 4217 currency code. |
| `status` | ENUM(PENDING,STAFF_COLLECTED,COMPLETED,FAILED,REFUNDED,EXPIRED) NOT NULL |  | Lifecycle status (values in the type). |
| `paid_at` | DATETIME |  | When it was paid. |
| `verified_at` | DATETIME |  | When it was verified. |
| `created_by` | CHAR(36) bin |  | User who created it. |
| `created_by_role` | VARCHAR(30) |  | Role key of the creator at the time. |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `staff_collected_by` | CHAR(36) bin |  | Staff who collected it. |
| `collected_at` | DATETIME |  | When the cash was collected. |
| `shift` | VARCHAR(20) |  | Cash shift. |
| `verified_by` | CHAR(36) bin |  | Who verified it. |
| `notes` | TEXT |  | Free-text notes. |
| `proof_url` | VARCHAR(500) |  | URL of the payment proof. |
| `rejected_reason` | TEXT |  | Why it was rejected. |
| `business_date` | DATE |  | Accounting day of the payment in the branch timezone. |
| `idempotency_key` | VARCHAR(120) |  | Idempotency key; the same key never applies twice. |
| `printed_at` | DATETIME |  | When printed. |
| `printed_by` | CHAR(36) bin |  | Who printed it. |
| `pending_change_json` | TEXT |  | Change waiting for approval (JSON). |
| `expires_at` | DATETIME |  | When it expires. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `payouts`

*tenant database · source `src/models/tenant/Payout.model.js`*

**Table COMMENT:** Payout requests from the organization to its payout account.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `amount` | DECIMAL(10,2) NOT NULL |  | Amount in major units of `currency`. |
| `currency` | VARCHAR(3) NOT NULL |  | ISO 4217 currency code. |
| `status` | ENUM(PENDING,APPROVED,PROCESSING,COMPLETED,REJECTED,CANCELLED) NOT NULL |  | Lifecycle status (values in the type). |
| `destination_json` | JSON |  | Where the payout goes (JSON copy). |
| `notes` | TEXT |  | Free-text notes. |
| `idempotency_key` | VARCHAR(120) |  | Idempotency key; the same key never applies twice. |
| `requested_by` | CHAR(36) bin NOT NULL |  | User who asked for it. |
| `approved_by` | CHAR(36) bin |  | User who approved it. |
| `paid_at` | DATETIME |  | When it was paid. |
| `transaction_ref` | VARCHAR(255) |  | Transaction reference. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `refund_requests`

*tenant database · source `src/models/tenant/RefundRequest.model.js`*

**Table COMMENT:** A member’s request for a refund of a cancelled subscription.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `subscription_id` | CHAR(36) bin NOT NULL |  | Member subscription id in the tenant database. |
| `payment_id` | CHAR(36) bin NOT NULL |  | Payment (payments.id). |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `status` | VARCHAR(10) NOT NULL |  | Lifecycle status (values in the type). |
| `currency` | VARCHAR(3) NOT NULL |  | ISO 4217 currency code. |
| `suggested_amount` | DECIMAL(10,2) NOT NULL |  | Amount suggested by the system. |
| `approved_amount` | DECIMAL(10,2) |  | Amount approved. |
| `reason` | VARCHAR(500) |  | Reason given. |
| `decided_by` | CHAR(36) bin |  | User who decided. |
| `decided_at` | DATETIME |  | When it was decided. |
| `decision_reason` | VARCHAR(500) |  | Reason for the decision. |
| `ledger_adjustment_id` | CHAR(36) bin |  | Ledger adjustment. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `role_assignment_branches`

*tenant database · source `src/models/tenant/RoleAssignmentBranch.model.js`*

**Table COMMENT:** Which branches a BRANCH-scoped role assignment covers.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `assignment_id` | CHAR(36) bin NOT NULL |  | Role assignment (role_assignments.id). |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `role_assignments`

*tenant database · source `src/models/tenant/RoleAssignment.model.js`*

**Table COMMENT:** A user holds a role over the whole organization (ORG) or some branches (BRANCH).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin |  | The user (users.id). |
| `email` | VARCHAR(255) |  | Email address. |
| `role_key` | VARCHAR(40) NOT NULL |  | Role preset key (e.g. ORG_ADMIN, BRANCH_MANAGER). |
| `role_level` | SMALLINT NOT NULL |  | Rank of the role (higher = more senior). |
| `scope_type` | ENUM(ORG,BRANCH) NOT NULL |  | ORG = whole organization; BRANCH = only listed branches. |
| `status` | ENUM(INVITED,ACTIVE,SUSPENDED,REVOKED) NOT NULL |  | Lifecycle status (values in the type). |
| `job_title` | VARCHAR(100) |  | Job title shown to staff. |
| `valid_from` | DATETIME |  | Offer starts. |
| `valid_until` | DATETIME |  | Offer ends. |
| `invited_by` | CHAR(36) bin |  | Who invited. |
| `invited_at` | DATETIME |  | When invited. |
| `accepted_at` | DATETIME |  | When the invite was accepted. |
| `revoked_at` | DATETIME |  | When it was revoked. |
| `revoked_by` | CHAR(36) bin |  | User who revoked it. |
| `version` | INT NOT NULL |  | Version number. |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

#### `schema_migrations`

*tenant database · source `src/database/tenant-migration-runner.js`*

**Table COMMENT:** Which versioned migrations have run on this database (platform and every tenant database).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `version` | INT NOT NULL |  | Migration number. |
| `name` | VARCHAR NOT NULL |  | Migration name. |
| `applied_at` | DATETIME |  | When it ran. |

#### `staff_action_requests`

*tenant database · source `src/models/tenant/StaffActionRequest.model.js`*

**Table COMMENT:** Legacy staff requests waiting for owner approval. Superseded by approval_requests.

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `staff_id` | CHAR(36) bin NOT NULL |  | Staff member (gym_staff.id). |
| `branch_id` | CHAR(36) bin NOT NULL |  | The branch (tenant branches.id; not a real FK across databases). |
| `action_type` | ENUM(add_member,renew,change_plan,upgrade,submit_expense) NOT NULL |  | Requested action. |
| `payload_json` | JSON NOT NULL |  | Event payload (JSON). |
| `status` | ENUM(pending,approved,rejected) NOT NULL |  | Lifecycle status (values in the type). |
| `requested_at` | DATETIME NOT NULL |  | When it was asked for. |
| `reviewed_at` | DATETIME |  | When an admin reviewed it. |
| `reviewed_by` | CHAR(36) bin |  | User who reviewed it. |
| `rejection_reason` | TEXT |  | Why it was rejected. |

#### `trainers`

*tenant database · source `src/models/tenant/Trainer.model.js`*

**Table COMMENT:** Trainers of a branch (profile shown to members).

| Column | Type | Rename to | Description (= column COMMENT) |
|---|---|---|---|
| `id` | CHAR(36) bin |  | Primary key. |
| `user_id` | CHAR(36) bin NOT NULL |  | The user (users.id). |
| `branch_id` | CHAR(36) bin |  | The branch (tenant branches.id; not a real FK across databases). |
| `specialization` | VARCHAR(200) |  | Speciality. |
| `bio` | TEXT |  | Short biography. |
| `years_experience` | INT |  | Years of experience. |
| `certifications_json` | JSON |  | Array of certification strings or objects. |
| `availability_json` | JSON |  | Weekly availability schedule object. |
| `rating_avg` | DECIMAL(3,2) |  | Average rating. |
| `status` | ENUM(ACTIVE,INACTIVE) NOT NULL |  | Lifecycle status (values in the type). |
| `created_at` | DATETIME NOT NULL |  | When the row was created (UTC). |
| `updated_at` | DATETIME NOT NULL |  | When the row was last changed (UTC). |

---

## 6. Recommendation: before 5 Dec, and 1.0.1

**Before 5 Dec (iOS release; freeze 2026-11-30): documentation only.**
- Keep this file and the cleaned enterprise spec (both uncommitted now; commit on a `docs/` branch when approved).
- Record the owner decisions of 2026-11-22 and D-1 to D-7 in spec §14.
- Add the naming rule to AGENTS.md in all four repos (no new identifier with the old words).
- **No migration, no rename, no COMMENT** in production before the release. A COMMENT is metadata-only, but it is still a
  schema change during the freeze, and it is written again by the 1.0.1 `CHANGE COLUMN` statements anyway.
- Why not more: build 28 is the release candidate (handoff, R-117) and reads today's JSON keys. Tiers B/C would not affect
  it, but they touch the launch-wipe tools (R-79), which the owner runs on launch day. Changing those tools days before
  that run is the wrong risk.

**1.0.1 (first update after release):**
1. Week 1: B/C 0, C+B 1, C+B 2, S. Database only, invisible to every client; deploy as soon as green.
2. The enterprise spec's P1 (backend) is then written directly in the new names (no `gym_listings`, no `tenants` in new code).
3. A1 + A2 (+ B2/A3 if D-2 = rename) together with the enterprise P2/P3, in one coordinated cut-over:
   - Submit the new app build with **manual release** in App Store Connect (and the Play equivalent).
   - On approval, at one moment: run migrations → deploy API, CMS, web → release the app → set `MIN_APP_VERSION_IOS` /
     `MIN_APP_VERSION_ANDROID` to the new build (`app-version.config.js`). Build 28 users see the NEW-81 force-update
     screen (`force_update_gate.dart`, `GET /meta/app-config`). That endpoint and its keys must not be renamed (it is
     the one contract both builds share).
   - Access tokens issued before the cut-over carry `tenantId`. If A3 renames the claim, the API answers 401 to an
     old-claim token and the app refreshes (refresh rebuilds the payload from the database, `auth.service.js:166-226`).
     Verify in the cut-over rehearsal on staging.
   - No compatibility layer is needed, and none is kept.
4. Recommendation on D-2: **do B2+A3 in the same 1.0.1 cut-over.** The force update is needed anyway for the enterprise
   model. Doing `tenantId` later costs a second forced update, or a second compatibility window.

**Defer past 1.0.1:** retiring the legacy tables (F5), deleting dead scripts (§3.2), renaming CMS route folders
(`/gym/*`) and screen classes that keep "Gym" as the UI word (D-7).

---

## 7. Changes made to the enterprise spec (`docs/ENTERPRISE_ORG_BUSINESS_BRANCH.md`)

On top of the approved R-119 version (`d961e25`): a names note at the top (this file and `API_CONTRACT_V2.md` win);
§0.4 decision R-120 (D14 no old-build compatibility, D15 no backfill, D16 clean names with D-1..D-7, D17 fixes);
D2, D5, D12 (unused `gyms` refund columns dropped; owner may veto), D13 and Q3, Q4 reworded; §0.3 old-build checks
retired; §1.5 backfill replaced by "launch wipe (owner) and demo data"; §2 "additive only", removed fields, top-hosts
string rule, refund-policy old-build rule and compound ids removed; §2.4 replaced by the force-update cut-over;
§3.3 old draft keys not read; §5 one id per row; §6 no fallback; §7.1 backfill and old-build tests replaced by
contract tests; §7.5, §8.1-§8.4 accordingly (backend ≈ 11.75 → 10.5 days, total ≈ 37 → 35.5).

## 8. Decisions (owner, 2026-11-22, final: R-120)

Every row below is **decided as recommended**, except D-5 (`ORG-`). F9 is decided as "remove the fallback".

| # | Question | Decision |
|---|---|---|
| D-1 | Option S: one UUID per business (tenant `businesses.id` = `business_listings.id`)? | **Yes** (§1.4) |
| D-2 | Rename `tenant_id` / `tenantId` (19 tables, about 4,200 code occurrences, JWT claim) to `organization_id` / `organizationId`, or keep it as a documented exception? | **Rename, in the 1.0.1 cut-over** (§6 point 4) |
| D-3 | `tenants.gym_name` / `gym_description`: (a) rename to `first_business_name` / `first_business_description`, or (b) fold them with `logo_url`, `cover_image_url`, `gender_type` into `first_business_draft_json`? | **(a)** now; (b) only if the enterprise wizard rewrites the draft anyway |
| D-4 | New name of `user_gym_memberships` | **`member_subscription_index`** |
| D-5 | Organization code prefix for new codes: keep `GYM-` or use `ORG-`? | **Owner: `ORG-`** for new codes, one generator (F8) |
| D-6 | Legacy tables (`gym_staff`, `staff_action_requests`, `devices`, `device_members`, `platform_packages`): no rename, retire in their own issues? | **Yes** |
| D-7 | Traveller UI word: "gym" or "business"? | Keep **"gym"** in traveller copy (product language; website URLs `/gyms/…`); "Business" in host screens; identifiers never "gym" |


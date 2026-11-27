# Organization › Business › Branch: design spec

Status: **APPROVED by the owner 2026-11-22 (decision R-119, spec §14); revised 2026-11-22 by decision R-120: no old-build compatibility, no backfill, clean names (§0.4).** P1 backend restarts in the new names (`feat/enterprise-p1` `7f7b21b` is on hold).

**Names.** Table, column and field names in this file are the names in today's code, so each rule can be found. The names to build with are in [`NAMING_AND_DATA_DICTIONARY.md`](NAMING_AND_DATA_DICTIONARY.md) and the frozen API in [`API_CONTRACT_V2.md`](API_CONTRACT_V2.md). Where they differ, those two files win (for example `gym_listings` = `business_listings`, `tenants` = `organizations`, `gymListingId` / `gymId` = `businessId`).
Basis: owner decisions of 2026-11-22 (below), the read-only code review and the local simulator walkthrough of 2026-11-21/22 (build 28 copy, evidence in the walkthrough folder named in the session report). File:line references are to `origin/main` (`e966d2e`) and app `feat/build-27` (`ad5f703`).

## 0. Decisions this spec applies (owner, final)

| # | Decision |
|---|---|
| D1 | Three levels. **Organization** = platform `tenants` row. **Business** = tenant `gyms` row + platform `gym_listings` row. **Branch** = tenant `branches` row. |
| D2 | `tenants.business_name` means and is labelled **"Organization name"**. Column renamed `organizations.organization_name`; API field `organizationName` replaces `businessName` / `brandName`, which are removed (R-120). |
| D3 | The traveller-facing name is the **business name** (`gyms.name` = `gym_listings.title`). Travellers see **"<Business> · <Branch>"**. The organization name is private: host Profile and CMS only. |
| D4 | R-118 (`gym_listings.brand_name`, a per-business brand column) is **cancelled** (recorded in spec §14). R-112's "Brand name" step becomes the **Organization step**. |
| D5 | KYC in two layers: organization identity once; each business has its own documents and its own approval (columns on `gym_listings`). No backfill (R-120): data is recreated after the launch wipe. |
| D6 | A business is traveller-visible only with **its own KYC approved and a real (non-sandbox, entitling) plan**. |
| D7 | Capacity is **one pool per organization** over all branches of all businesses. A business that is not approved **cannot receive branches** (server-enforced). |
| D8 | One shared branch wizard and one create service for first-time Become a Host, Add Business, and Add Branch. Phone and hours always shown; hours default 06:00–22:00; **photo minimum 3**; **area or area request required everywhere**; one amenity list; one idempotent create with the same buy-capacity-then-retry path. |
| D9 | Listings tab = organization header, businesses as expandable cards with branches and status chips, Add Branch under each business, Add Business at the top. Gyms tab shows PENDING businesses as "Under review". Website and CMS follow the same hierarchy. |

### 0.1 Questions, with the owner's answers (2026-11-22, final)

| # | Question | Owner decision |
|---|---|---|
| Q1 | Receipts and invoices to **members** today print `businessName` (R-112 copy: "Shown on your gyms, invoices and receipts"). Under D3 the organization name is private. | **Member receipts show "<Business> · <Branch>". GymsEra's invoices to the host (plan billing) show the organization name.** |
| Q2 | Add Business today creates the first branch **ACTIVE** at once while the business is PENDING (walkthrough W3). D7 says a non-approved business cannot receive branches. | **Add Business reserves one unit and holds the first branch until the business is approved** (§2.3). |
| Q3 | QAbrand on production has 4 ACTIVE branches on a 1-branch plan. | ~~Leave QAbrand as it is. No deletes.~~ **Superseded by R-120:** all production data is test data and goes with the launch wipe (owner runs it, `docs/runbooks/launch-wipe.md`). Agents delete nothing. |
| Q4 | Android release date. | **Android cannot release on 5 Dec** (Google Play closed-test rule). It ships its **first eligible build**. Do not hold it for 1.1 unless 1.1 is within a week of that date (§8.4). At the cut-over (§2.4) every older build, iOS or Android, is stopped by the force-update gate. |

### 0.2 Further owner decisions (2026-11-22, final)

| # | Decision |
|---|---|
| D10 | **Business documents.** Registration (`BUSINESS_REGISTRATION`) is **optional**. **Proof of premises** (`PROOF_OF_PREMISES`) and **3 or more photos** are required for business approval. |
| D11 | **Verified badge.** `gym_listings.verified_at`, `gym_listings.verified_by` (p033). An admin sets them when approving the business's registration document; an admin can revoke (both back to NULL). Additive field **`businessVerified`** (bool) on every business and branch object in discovery, host listings, website and CMS responses. A small verified check beside the business name on every branch in the traveller app, the website and the host Listings tab. Hosts without it see **"Upload your registration to get Verified"**. Wording of the badge's explanation: **"Registration document checked by GymsEra"**, nothing more (no "trusted", "safe", "licensed"). The badge never affects visibility (D6). |
| D12 | **Refund policy belongs to the branch only** (§6). Replaces the override design. `branches.refunds_allowed`, `branches.refund_window_days`; no business default, no override flag. New branches start with refunds **off**. *(R-120: with no old builds and no backfill, the unused `gyms.refunds_allowed` / `gyms.refund_window_days` are **dropped** by the business naming migration instead of kept as deprecated. Owner may veto; see §1.3.)* |
| D13 | **Deploy order** (revised by R-120). No behaviour change on production before build 28 is live. Then: launch wipe (owner) → migrations → API → CMS / web → app release + force-update gate (§2.4). Launch timing is not decided; the work is the same either way. |

### 0.3 Read-only check of builds 27 / 28 (history)

The "by <brand>" and Top hosts checks of builds 27 / 28 (session 165) are no longer needed: old builds are not served after the cut-over (§2.4), so no response keeps a key or a type for them. Kept in git history (`d961e25`).

### 0.4 Decision R-120 (owner, 2026-11-22, final)

| # | Decision |
|---|---|
| D14 | **No old-build compatibility.** There are no real hosts; all data is test data. No legacy fields, no old-build matrix, no workaround for builds 27 / 28. |
| D15 | **No backfill** (NEW-303f dropped). The launch wipe (R-79) plus demo data created through the new flows replaces it (§1.5). |
| D16 | **Clean names everywhere** (`NAMING_AND_DATA_DICTIONARY.md`): option S (one UUID per business: tenant `businesses.id` = `business_listings.id`); `tenant_id` / `tenantId` → `organization_id` / `organizationId` in the same cut-over; `tenants.gym_name` / `gym_description` → `first_business_name` / `first_business_description`; `user_gym_memberships` → `member_subscription_index`; new organization codes start `ORG-`; legacy tables not renamed; traveller copy keeps "gym", host screens say "Business", identifiers never "gym". |
| D17 | Fixes inside this work: F1 (branch list matches either id / NULL), F2 (unordered `Gym.findOne()`), F3 (`organization_id` with two id spaces), F7 (compound admin ids), F8 (two code generators), F9 (no logo / cover fallback to the first business); F4 inside the route cleanup; F5 (legacy second systems) deferred. |

---

## 1. Data model

### 1.1 What stays the same

- `tenants` (Organization): meanings unchanged; renamed per the naming doc (`organizations`, `organization_code`, `organization_name`, `first_business_name`, `first_business_description`, `first_branch_draft_json`).
- `gyms` / `gym_listings` (Business): one row each per business. Option S: both rows have the **same id**, so the link column `gyms.gym_listing_id` and the copy `branches.gym_listing_id` are dropped.
- `branches` (Branch): unchanged columns, plus the branch refund policy (§1.3).
- Capacity: `subscription-quota.service.js#getUsedCapacity` already counts one pool per tenant (ACTIVE branches + `reserved_slots` of non-INACTIVE/REJECTED listings). No schema change.

### 1.2 Platform migrations (additive)

Latest platform migration on `main`: **p032** (`p032_area_requests`).

**p033_business_kyc_and_approval** (`gym_listings`):

| Column | Type | Default | Meaning |
|---|---|---|---|
| `kyc_status` | ENUM('NOT_SUBMITTED','PENDING','APPROVED','REJECTED') | 'NOT_SUBMITTED' | Business-level KYC (documents of this business). |
| `kyc_documents_json` | JSON NULL | NULL | Same shape as `tenants.kyc_documents_json` (R-85 types), only business types: `BUSINESS_REGISTRATION`, `PROOF_OF_PREMISES`. |
| `kyc_submitted_at` | DATETIME NULL | NULL | |
| `approved_at` | DATETIME NULL | NULL | Business approval (rejection columns already exist: `rejection_reason`, `rejected_at`, `rejected_by`). |
| `approved_by` | CHAR(36) NULL | NULL | Admin user id. |
| `verified_at` | DATETIME NULL | NULL | D11: set when an admin approves the business's `BUSINESS_REGISTRATION` document; NULL = not verified (never set, or revoked). |
| `verified_by` | CHAR(36) NULL | NULL | Admin user id who verified; NULL after revoke. |
| `first_branch_draft_json` | JSON NULL | NULL | The held first branch of an Add Business submission (Q2). Same shape as `organizations.first_branch_draft_json`. Cleared when built. |

Business approval needs (D10): `PROOF_OF_PREMISES` present and 3 or more photos (cover + gallery). `BUSINESS_REGISTRATION` is optional; it only drives the badge (D11). Every verify / revoke is audited (`business.verify`, `business.unverify`).

Organization identity KYC stays on `tenants.kyc_status` / `kyc_documents_json`, reduced to type `OWNER_ID`. Business document types are accepted only on the business. Nothing is copied (D15).

### 1.3 Tenant migrations (additive)

Latest tenant migration: **029** (`029_branch_hours_json`).

**030_branch_refund_policy** (`branches`), D12 (replaces the earlier override design):

| Column | Type | Default | Meaning |
|---|---|---|---|
| `refunds_allowed` | TINYINT(1) NOT NULL | 0 | The branch's own policy. New branches start with refunds off. |
| `refund_window_days` | SMALLINT UNSIGNED NULL | NULL | NULL = no limit (same meaning as on `gyms` today). |

No override flag, no business default, no copy from `gyms` (D15: data is recreated). `gyms.refunds_allowed` / `gyms.refund_window_days` are dropped by the business naming migration (D12 note).

No tenant migration for business KYC (it lives on the platform listing).

### 1.4 Derived rules (code, no schema)

- **Traveller-visible business** = `gym_listings.status = 'ACTIVE'` AND `gym_listings.kyc_status = 'APPROVED'` AND tenant `ACTIVE` AND an entitling, non-sandbox subscription (`discovery.service.js:75-100`, unchanged) AND at least one ACTIVE public plan at the branch (unchanged).
- **Traveller-visible branch** = visible business AND branch `ACTIVE`, `traveler_visibility_status = 'active'`, not admin-suspended (unchanged, `discovery.service.js:16-18`).
- **Business may receive branches** = `gym_listings.status = 'ACTIVE'` (approved). PENDING, REJECTED, INACTIVE: no.

### 1.5 Data: launch wipe and demo data (no backfill, D15)

1. The launch wipe (`docs/runbooks/launch-wipe.md`, R-79, `src/scripts/reset-platform-data.js`) is run by the **owner**. It empties the platform tables outside its keep list and drops the tenant databases named in `organizations.db_name`. Agents never run it.
2. Demo data is created **through the new flows** (Become a Host, Add Business, Add Branch, admin approval per business, sandbox purchases), so every row meets §1.4 from the start.
3. No rule has a "legacy row" exception and no transition state exists.

---

## 2. API contract

The frozen route, key, enum and error list is [`API_CONTRACT_V2.md`](API_CONTRACT_V2.md). This section keeps the rules; names below are today's.

### 2.1 New and changed fields

| Endpoint | New field(s) | Removed (D14) |
|---|---|---|
| `GET /host/status` | `organizationName` (= `tenants.business_name`) | `brandName` |
| `GET /tenants/me`, `GET /tenants/:id` | `organizationName` | `businessName` |
| `PATCH /tenants/me`, `POST /tenants/:id/gym-profile` | accepts `organizationName` (writes `business_name`) | `businessName` refused by the allow-list |
| `GET /host/listings`, `GET /host/listings/:id` | per business: `kycStatus`, `kycDocuments`, `approvedAt`, `canReceiveBranches` (bool), `travellerVisible` (bool), `branchCount`, `heldFirstBranch` (bool), **`businessVerified`** (bool, D11), `missingForApproval` (list: `PROOF_OF_PREMISES`, `PHOTOS_MIN_3`) | unchanged |
| `GET /host/branch-quota` | `pool: { max, used, reserved, free }` (one object, organization-wide) | per-listing keys move under the business (contract) |
| `POST /host/listings/:id/kyc-documents` (new) | business documents, same multipart and type rules as `POST /tenants/:id/kyc-documents` (R-85), business types only | — |
| `GET /host/listings/:id/kyc-documents`, `.../:documentId/stream` (new) | | — |
| Discovery (`GET /discovery/gyms/:id`, lists, nearby, map) | `businessName`, `branchName`, **`businessVerified`** (bool, D11) on the business and on every branch | **the organization name is not sent to travellers** (D3): no `tenant` object, no byline. |
| `GET /discovery/top-businesses` (was `top-hosts`) | one row per **business**: `businessId`, `businessName`, `businessVerified` | `organizationName` never sent; `top-hosts` route removed |
| Admin `GET /admin/tenants`, `/admin/tenants/:id` | `organizationName`, per business `kycStatus`, documents, approval, `businessVerified`, `verifiedAt` | compound ids `tenantId:listingId` (`admin.service.js:222`) removed: one `businessId` per row (F7) |
| `POST /admin/listings/:id/verify`, `DELETE /admin/listings/:id/verify` (new) | sets / clears `verified_at` / `verified_by` (D11). Verify needs an uploaded `BUSINESS_REGISTRATION` document on the business, else 422 `registration_missing` | — |
| Member receipts and member-facing emails (Q1) | issuer line "<Business> · <Branch>" | the organization name is no longer printed on anything a member receives; GymsEra's plan invoices / receipts to the host (`plan-payment.service.js`, `stripe-billing.service.js`, `email.service.js` host templates) keep the organization name. Each `businessName` use in these files is classified member-facing or host-facing in P1 (grep list in §13) |
| `GET/PUT /subscriptions/staff/refund-policy` | D12: `branchId` (one branch) or `applyToAllBranches: true` (every branch the caller can refund at, organization-wide); answers `{ branchId, refundsAllowed, refundWindowDays }`, and for a bulk write `{ updatedBranchIds: [...] }` | Neither `branchId` nor `applyToAllBranches` → 422 `branch_required`. No "oldest business" fallback, no old shape. |

### 2.2 Create endpoints: rules

All creates are idempotent (`Idempotency-Key`, NEW-282, unchanged). Capacity = one organization pool. Order of checks on each endpoint: auth → validation → **business state** → **capacity** → write.

| Endpoint | Used by | Business state rule (new) | Capacity rule | Result |
|---|---|---|---|---|
| `POST /tenants/:id/gym-profile` + `POST /tenants/:id/finalize` | first-time Become a Host | n/a (no business yet) | none at submit; plan bought before finalize | Draft; at organization + first business approval: business ACTIVE, first branch built (provisioning, `skipCapacityCheck` as today) |
| `POST /host/listings` | Add Business | n/a | **reserve 1 unit** (existing `branchSource: 'reserve'` path, `host.controller.js:543-640`), with the existing donor transfer when full; 403 `branch_limit_reached` when no unit anywhere | Business PENDING + `first_branch_data_json` held + `reserved_slots = 1`. No branch row yet (Q2). |
| `POST /host/branches`, `POST /gyms/branches` | Add Branch (app, CMS) | target business must be `ACTIVE` → else **409 `business_not_approved`** | as today, **plus** a donor transfer from another business's reserved slot when the target has none (fixes walkthrough W4: 403 at 3 used / 4 paid) | Branch ACTIVE, refunds off (D12) |
| `POST /admin/tenants/:id/branches` | admin | same 409 rule | as today | Branch ACTIVE |
| `POST /host/branches/:id/restore` | restore | same 409 rule | as today (`gym.service.js:1307-1325`) | Branch ACTIVE |
| membership-plan provisioning fallback (`membership-plan.service.js:224-238`) | provisioning | n/a | fix the shifted argument (`gym.id` passed as tenant id) and F2 (no unordered `Gym.findOne()`) in the same change | — |

`business_not_approved` copy: "This business is still under review. You can add branches once it is approved."

### 2.3 Held first branch (Add Business)

- Submit stores the branch fields in `gym_listings.first_branch_draft_json`, reserves one unit, returns `{ listing, branch: null, heldFirstBranch: true }`.
- Business approval builds the branch from that JSON through `gymService.createBranch` with `consumingReservedSlot` (records `SLOT_CONSUMED_BUILD`), clears the JSON.
- Business rejection releases the reservation (`getUsedCapacity` already excludes REJECTED); the JSON stays so a re-apply keeps the host's input.
- Host edits of a held branch: `PATCH /host/listings/:id/first-branch` (new) until approval.

### 2.4 Release cut-over (D14: no old-build compatibility)

Older builds are stopped by the force-update gate (NEW-81) instead of being served:

1. The new app build is submitted with **manual release** (App Store Connect, and the Play equivalent).
2. On approval, at one moment: (launch wipe by the owner, if not done) → platform and tenant migrations → API, CMS, website → release the app → `MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID` = the new build (`src/config/app-version.config.js`).
3. `GET /meta/app-config` and its keys are the one contract older builds still read; nothing in this work changes it.
4. Bodies of older builds are refused, not reinterpreted (for example `branchSource: 'new'`, `businessName`).

---

## 3. App

### 3.1 Screens and widgets

New feature module `lib/features/setup_wizard/`:

| Widget | Fields | Used in modes |
|---|---|---|
| `OrganizationStep` | Organization name (label "Organization name", helper "Only you and GymsEra see this"), from `brand_name.dart` rules | first-time |
| `BusinessStep` | Business name ("Business name (shown to travellers)"), description, gender, category | first-time, add business |
| `BranchDetailsStep` | Branch name ("Branch name", prefilled "<Business> – Main" for a first branch), tagline, year, floor area | all |
| `BranchLocationStep` | city (required), address with map pin, area or area request (**required**), address line 2, postcode (placeholder "e.g. 25000") | all |
| `BranchContactHoursStep` | phone, hours (always shown, 06:00–22:00 default, R-113 week editor reused) | all |
| `AmenitiesStep` | one list `kAmenities` (shared constant; today duplicated in `listing_step3_screen.dart` and `add_branch_screen.dart:194-220`) | all |
| `PhotosStep` | cover + gallery, **minimum 3**, all uploads through `POST /host/listings/staging-images` (first-time too) | all |
| `PackagesStep` | existing plan editor (already shared) | all |
| `ReviewStep` | summary "<Business> · <Branch>", terms tick, submit | all |
| `BusinessPicker` (top of Add Branch) | ACTIVE businesses only; PENDING shown disabled with "Under review" | add branch |
| `VerifiedCheck` (D11) | small check beside the business name; tap / long-press: "Registration document checked by GymsEra" | traveller gym detail, branch rows, search cards, top hosts; host Listings cards |
| Business documents | Proof of premises (required), Registration (optional, "Upload your registration to get Verified" while `businessVerified` is false) | business card › Documents |

`BranchSetupService.submit(draft, mode)`:
- `firstTime` → `gym-profile` saves as today, plan purchase, `finalize`.
- `addBusiness` → `POST /host/listings` with the business fields and the held branch.
- `addBranch(businessId)` → `POST /host/branches`.
- One `Idempotency-Key` per draft id. `BranchLimitReachedException` → upsell (purchase-intent with the target business) → retry. `business_not_approved` → message, back to Listings.

### 3.2 Deleted or merged

Deleted after the switch: `listing_step1..5_screen.dart`, `location_screen.dart`, `listing_preview_screen.dart`, `new_organization_source_screen.dart`, `add_branch_screen.dart` (2,422 lines). Merged: their providers into one `SetupDraftNotifier`. Kept: `host_plan_purchase_screen.dart`, `branch_plan_picker_screen.dart`, plan editor, `HoursPairFields`/week editor, `AreaPickerField`, `LocationMapPicker`, `PlaceSearchField`.

### 3.3 Draft and resume

- Draft = one JSON (`SetupDraft` v1: mode, businessId, step, all fields, uploaded photo URLs).
- First-time: saved to the server at each step as today (`first_branch_draft_json`, organization fields) so resume works across devices; plus local copy.
- Add Business / Add Branch: local only, key `setup_draft_v1:<mode>:<businessId|new>`. Old keys `add_branch_draft_v3:*` are not read (deleted on first launch).
- Resume lands on the first incomplete step (today: `onboarding_step`).

### 3.4 Tabs

- **Listings**: header with organization name and plan pool ("3 of 4 branches"); "Add Business" button; one expandable card per business (name, status chip: Live / Under review / Needs documents / Rejected, KYC chip), branches inside with status chips, "Add Branch" inside each ACTIVE business, "Documents" and "Edit business" in the card menu. Branch Management screen stays for delete/restore.
- **Gyms**: business sub-tabs include PENDING businesses with an "Under review" panel (today hidden, walkthrough W3); the FAB opens the wizard with the `BusinessPicker`.
- **Today / Profile**: header shows the business name; organization name on Profile (today Today shows the brand).

### 3.5 Copy fixes (from the walkthrough)

| Where | Today | New |
|---|---|---|
| Add Branch step 1 | "Gym Name" (sets the branch name) | "Branch name" |
| Become a Host step 3 button | "Continue to Packages" (next is Amenities) | "Continue" (every step: "Continue"; last: "Review") |
| Another business | starts at "Step 2 of 6" | step counter computed per mode ("Step 1 of 6" for Add Business) |
| Postcode | placeholder "78701" | "e.g. 25000" |
| Hours fields | "Opening …", "Closing Ti…" | "Opens" / "Closes", fields sized to fit |
| Gyms tab sub-tabs | "Subscr / iptions", "Payme", "Membe" | scrollable tab bar, full labels |
| Title | "Gyms & Operati…" | "Gyms" |
| Photos | "1 photo uploaded" before upload | "1 photo added" until uploaded |
| Phone keypad | cannot be dismissed (Become a Host step 3) | "Done" accessory + tap-outside dismiss on every wizard step |

Not part of this spec but found in the walkthrough (separate fixes): "+" in email breaks signup (`signup_screen.dart:91`, `login_screen.dart:65`; server side NEW-302, own PR); a build without a Maps key crashes on the first map (`AppDelegate.swift:11-17`).

---

## 4. CMS and website

**CMS (host side)**
- Settings › Profile: "Organization name".
- Gym › Businesses (new list page replacing the organisation picker): organization header, business cards with branches, Add Business, Add Branch per business; Branches page filters by business. Business detail: documents upload (premises required, registration optional), status, verified badge or "Upload your registration to get Verified".
- Branch form: business chosen at top (ACTIVE only), same field rules as the app (area required, hours default, photo minimum 3).
- Refund policy dialog (D12): branch picker + "Apply to all branches"; no business default.

**CMS (admin side)**: §5.

**Website**
- `gyms/[id]` (business page): title = business name with the verified check when `businessVerified` (D11); branch list; remove the "by <brand>" byline (NEW-269) per D3.
- `gyms/[id]/branches/[branchId]`: title "<Business> · <Branch>", verified check beside the business name.
- `gym-owner/register`: same Organization → Business → Branch order as the app.
- Search cards: "<Business> · <Branch>".

---

## 5. Admin approval per business

Queue rows: **Organization** (identity, first time only) and **Business** (each one), each with its own id (`organizationId`, `businessId`); no compound ids (F7).

| Step | Organization (first time) | Business |
|---|---|---|
| Needs | owner ID document; plan purchased | **proof of premises (required)**; photos (**minimum 3**); at least one branch draft with area and plan; organization identity APPROVED. Registration document **optional** (D10). Missing items → 422 `business_requirements_missing` with `missing: [...]` |
| Approve | tenant ACTIVE, provisioning (as today), `tenants.kyc_status = APPROVED` | `gym_listings.status = ACTIVE`, `kyc_status = APPROVED`, `approved_at/by`; build held first branch (first-time: from `organizations.first_branch_draft_json`; Add Business: from `business_listings.first_branch_draft_json`) |
| Verify (D11, any time after upload) | — | admin approves the registration document → `verified_at = now`, `verified_by = admin`; **revoke** clears both. Independent of approval and visibility. Audited. Host notification "<Business> is Verified" |
| Reject | reason; tenant REJECTED (as today) | reason; listing REJECTED; reservation released; draft kept |
| Notify host | as today | new notification "<Business> is approved" / "needs changes" |

First-time Become a Host = one review screen with both rows; approving the business implies approving the organization if it is still pending. The photo check (R-84) moves to the business row.

---

## 6. Refund policy per branch (D12)

- The policy lives **only on the branch**: `branches.refunds_allowed` (NOT NULL, default 0), `branches.refund_window_days` (NULL = no limit), tenant migration 030 (§1.3). No business default, no override flag.
- `gyms.refunds_allowed` / `gyms.refund_window_days` (tenant migration 028) are dropped (D12 note, R-120).
- `policyFor(branchId)` (`subscription-refund.service.js:41-53`) reads **only the branch**. Every subscription has a branch; none falls back.
- Every refund flow already passes the subscription's `branchId` (quote, staff cancel with refund, member request, decide), so they pick up the right policy with no flow change.
- New branches (every create path, including provisioning and the held first branch) start with refunds **off**.
- Writes: `PUT` with `branchId` → that branch. `PUT` with `applyToAllBranches: true` → every non-deleted branch of the organization at which the caller has direct `payments.refund`; branches without that grant are skipped and listed. One audit row per branch changed (`refunds.policy.update`, `targetType: 'branch'`).
- A write with neither `branchId` nor `applyToAllBranches` → 422 `branch_required`.
- Dialogs (app Profile › Refund policy, CMS Subscriptions › Refund policy): a **branch picker** and an **"Apply to all branches"** switch. This fixes the backlog item "refund policy only reaches the oldest business".

---

## 7. End-to-end test plan

### 7.1 Backend integration (local/Docker MySQL only, R-19)

| Test | Assert |
|---|---|
| p033 / 030 and the naming migrations up, dry-run, idempotent re-run | columns exist under the new names; re-run no-op |
| `POST /host/branches` into PENDING business | 409 `business_not_approved`, no row, no capacity event |
| `POST /host/branches` with the free unit parked on another business | 201, `SLOT_TRANSFERRED` then `SLOT_CONSUMED_BUILD` (walkthrough W4 regression) |
| `POST /host/listings` at full pool | 403, nothing written |
| `POST /host/listings` with free pool | listing PENDING, `reserved_slots = 1`, `first_branch_data_json` set, no branch row |
| Business approve | listing ACTIVE, branch built, `SLOT_CONSUMED_BUILD`, JSON cleared |
| Business reject | listing REJECTED, pool freed, JSON kept |
| Discovery | business with KYC not APPROVED hidden; sandbox plan hidden (existing); org name absent from traveller responses |
| Refund policy (D12) | `policyFor` reads only the branch; `branchId` PUT changes one branch; `applyToAllBranches` changes all permitted branches; no id → 422 `branch_required`; a new branch starts with refunds off |
| Business requirements (D10) | approve without premises → 422 `business_requirements_missing`; with premises, 3 photos and no registration → approved |
| Verified badge (D11) | a business is visible to travellers **without** the badge (`businessVerified: false`); verify after a registration upload → `businessVerified: true` on business and branches in discovery, top hosts, host listings, admin; verify without a registration document → 422; revoke → `false` again; audit rows for both |
| Top businesses | one row per business, `businessName` = business name; organization name absent |
| Contract | every route and key of `API_CONTRACT_V2.md` (key lists per response); removed keys absent; old bodies refused |

### 7.2 App on simulator (Maestro, local API; same harness as the walkthrough)

| Flow | Steps | Check in DB after |
|---|---|---|
| W1 first-time | sign up (email with "+"), Organization → Business → Branch steps (phone, hours left at default, area picked) → 3 photos → plan → (fake purchase) → admin approve org + business | tenant ACTIVE; business ACTIVE + KYC APPROVED; branch hours 06:00–22:00 in pair and week; area set |
| W2 Add Branch | Gyms › + Add Branch → picker → branch steps → submit at full pool → upsell → (fake purchase) → retry | 403 then 201; `SLOT_*` events; branch in the chosen business |
| W3 Add Business | Listings › Add Business → business + branch steps → submit | listing PENDING, held branch, no branch row; Listings card "Under review"; Gyms tab shows it "Under review" |
| W4 PENDING | try Add Branch under the PENDING business (picker shows it disabled); API call returns 409 | no branch |
| W5 approve business | admin approves W3 business | branch built; both tabs show it Live |
| W6 refund | turn refunds on for one branch, then "Apply to all branches" with a 14-day window, quote a refund on each branch | quotes follow each branch's policy |
| W9 verified | upload a registration, admin verifies, open the gym as a traveller, admin revokes | check shown beside the business name, then gone; host card shows "Upload your registration to get Verified" before and after |
| W7 resume | kill the app mid-wizard in each mode, relaunch | lands on the first incomplete step with the same data |
| W8 copy | screenshots of every wizard step at iPhone SE and Pro Max sizes | no cut-off labels; texts as §3.5 |

### 7.3 CMS (Vitest + manual on local)
Businesses page renders the hierarchy; Add Business / Add Branch rules equal to the app; admin queue approves a business by compound id; refund scope dialog.

### 7.4 Website (Vitest + manual)
Business page and branch page titles "<Business> · <Branch>"; no organization name anywhere public; hidden business returns 404; verified check present only when `businessVerified`.

### 7.5 Production smoke (after deploy, owner runs; agents never deploy)
1. After the owner's launch wipe: the verify step of `docs/runbooks/launch-wipe.md` passes.
2. Build 28 on a phone: the force-update screen shows and nothing else is reachable (§2.4).
3. New build: W1–W5 with a fresh "+"-alias account and sandbox purchases (this also creates the demo data).
4. Traveller search: the approved demo businesses show as "<Business> · <Branch>"; no organization name anywhere.

---

## 8. Phases, effort, risks, release timing

### 8.1 Phases

| Phase | Content | Depends on |
|---|---|---|
| P0 | Owner reviews this spec, answers Q1–Q4; spec §14 decision row | **DONE 2026-11-22 (R-118 cancelled, R-119)** |
| P1 backend | (after the naming tiers B/C and option S) p033 (incl. `verified_at/by`), 030 (branch refund columns), §2 fields and rules, admin approval per business, verify / revoke, refund per branch, top hosts per business, tests §7.1 | P0 |
| P2 app | wizard module, create service, Listings and Gyms tabs, KYC per business screens, refund dialog, copy fixes, tests §7.2 | P1 contract (can start on a mocked contract) |
| P3 CMS + web | §4, §5 admin screens, tests §7.3–7.4 | P1 |
| P4 release | D13: nothing changes production before build 28 is live. Then the cut-over of §2.4; smoke §7.5 | P1–P3, build 28 live |

### 8.2 Effort (agent-days, including tests and the §13 record)

| Layer | Items | Days |
|---|---|---|
| Backend | migrations 0.75; create rules, held branch, donor transfer, 409 2.0; business KYC routes + admin approval (D10 requirements) 2.5; verified badge (columns, verify / revoke, `businessVerified` everywhere) 1.0; discovery visibility + org privacy + top hosts per business 1.25; member receipts (Q1) 0.5; refund per branch (D12) 0.75; integration tests + contract key lists 1.75 | **10.5** (naming work separate: naming doc §4) |
| App | wizard steps + `SetupDraft` + service 6.5; Listings tree 1.5; Gyms tab pending 0.5; KYC organization/business screens 1.5; verified check + host prompt 0.5; refund branch dialog + apply to all 0.5; copy fixes 0.5; tests (unit + Maestro flows W1–W9) 2.25 | **13.75** |
| CMS | host businesses page + branch form 2.5; admin queue per business + documents + verify / revoke 2.5; refund branch dialog 0.5; tests 1.0 | **6.5** |
| Website | business/branch titles, byline removal, verified check, register order 1.75; tests 0.5 | **2.25** |
| E2E + release | cut-over rehearsal on staging (§2.4), staging run of §7.2, production smoke support | **2.5** |
| **Total** | | **≈ 35.5** |

Run in parallel by layer after P1's contract is fixed (`API_CONTRACT_V2.md`), about 3–4 calendar weeks. (Revised 2026-11-22: ≈ 37 → ≈ 35.5 by R-120, no backfill, no old-build fixtures.)

### 8.3 Risks

| Risk | Mitigation |
|---|---|
| Builds 27 / 28 stop working at the cut-over | Intended (D14): gate raised in the same step as the API deploy; rehearsed on staging |
| Held-branch path is new code in approval | Reuses provisioning's `createBranch` + reserved-slot path; dedicated tests |
| Large app rewrite (2,422-line Add Branch + 6 Become a Host screens) | Feature flag `setupWizardV2`; old screens kept until W1–W8 pass; delete in a later build |
| First-time resume across devices | Keep the server draft exactly as today for `firstTime` |
| Organization name leak (byline, top hosts, receipts) | Q1 decision; grep test for `businessName` in traveller-facing responses |
| Disk / tooling on the build Mac (walkthrough hit a full disk) | Run Maestro/E2E with cleanup of `~/.maestro/tests` between runs |

### 8.4 Before the 5 Dec iOS release, and Android

- **Safe before 5 Dec: nothing from this spec.** Agree with the owner's expectation. Every part changes either data, visibility, or the create flows that build 28 uses; none should land between now and the release.
  - The only server pieces that are harmless for build 28 are the 409 `business_not_approved` guard and the donor transfer in `POST /host/branches`. They still change production behaviour, so keep them in P1 with everything else.
- **Deploy order (D13, revised):** no behaviour change on production before build 28 is live in the App Store. Then the cut-over of §2.4.
- **Android (Q4, owner):** Android cannot release on 5 Dec because of the Google Play closed-test rule. It ships its **first eligible build** (the build current when the closed test qualifies). It does **not** wait for 1.1, unless 1.1 is expected within one week of that date. At the cut-over that Android build is stopped by the force-update gate like iOS (§2.4).

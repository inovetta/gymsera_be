# API contract v2 (frozen): Organization › Business › Branch, clean names

Status: **FROZEN 2026-11-22** (decision R-120). App, CMS and website build against this file; the server implements it
(spec §13 NEW-305 to NEW-311 and NEW-303). A change to this file needs the owner's word and a dated row in §9.
Basis: `gymsera_be` `origin/main` `e966d2e` (471 routes read from the live Express router, body keys from each route's
SEC-06 allow-list), the enterprise spec (`ENTERPRISE_ORG_BUSINESS_BRANCH.md`, R-119 + R-120) and
`NAMING_AND_DATA_DICTIONARY.md` (decided).

**Cut-over, no compatibility.** Nothing old is kept: no alias route, no old key, no old value. Older builds are stopped
by the force-update gate at the cut-over (enterprise spec §2.4). The one contract kept as it is: `GET /meta/app-config`
and `GET /meta/error-copy` (paths and keys).

---

## 1. Rules for every endpoint

1. **Base path, envelope, auth unchanged.** `/api/v1`; responses `{ success, message, data }` (errors
   `{ success: false, message, code, errors?, data? }`); `Authorization: Bearer <access token>`.
2. **Header** `X-Tenant-Id` → **`X-Organization-Id`** (same meaning: the organization the request acts in).
3. **Access-token claim** `tenantId` → **`organizationId`**. A token without the new claim gets 401; the client refreshes
   (the refresh builds the token from the database).
4. **Three ids, one meaning each.** `organizationId` (an `organizations` row), `businessId` (one business: option S,
   `businesses.id` = `business_listings.id`), `branchId`. No route or key accepts "either id" any more (F1, F4).
5. **Path parameters are named after what they hold**: `:organizationId`, `:businessId`, `:branchId`
   (never `:id` for these three).
6. **Names.** Inside an entity's own object the name is `name` (organization, business). On any other object it is
   `organizationName`, `businessName`, `branchName`. The traveller label "<Business> · <Branch>" is `displayName`.
   `title` stays only for real titles (announcements, notifications, expenses, reviews).
7. **The organization name never reaches a traveller** (enterprise D3). No traveller response carries
   `organizationName`, an `organization` object or a `tenant` object.
8. The renames of §2 apply everywhere: request bodies, query strings, path parameters, response bodies, nested objects,
   socket payloads and error `data`.

## 2. Global key renames

| Before | After | Where it meant |
|---|---|---|
| `tenantId` | `organizationId` | the organization (also JWT claim, query, socket room `tenant:<id>` → `organization:<id>`) |
| `tenantCode` | `organizationCode` | organization code (new codes start `ORG-`) |
| `businessName` (on a tenant / host object) | `organizationName` | the organization's own name |
| `brandName` | `organizationName` | same value (R-112 brand = organization name) |
| `gymName` (organization draft: `/tenants…`, host status) | `firstBusinessName` | Become a Host draft of the first business |
| `gymDescription` (organization draft) | `firstBusinessDescription` | |
| `gymName`, `gymDescription` (Add Business / edit business body) | `businessName`, `businessDescription` | the business being created or edited |
| `gymName` (any response naming a business: subscriptions, admin, payments) | `businessName` | |
| `gymName` (workspace / staff invite / data export: the organization) | `organizationName` | |
| `mainBranchDataJson`, `mainBranchData` | `firstBranchDraft` | first-branch draft |
| `mainBranchCurrency` | `firstBranchCurrency` | |
| `gymListingId`, `listingId`, `gymId`, `organizationId` (when it held a business) | `businessId` | the one business id |
| `toListingId` | `toBusinessId` | reserved-slot transfer |
| `title` (business), `shortDescription` (business) | `name`, `description` | on the business object |
| `title` (branch card, "<Business> · <Branch>") | `displayName` | discovery |
| `organizationName` (when it held a business name) | `businessName` | discovery, last-branch warning |
| `organization` (nested object holding a business) | `business` | discovery branch card |
| `organizations` (discovery list key) | `businesses` | |
| `gym` (detail response key) | `business` | `GET /discovery/businesses/:businessId` |
| `organizationBranches`, `organizationReservedSlots` | `businessBranches`, `businessReservedSlots` | branch quota with `businessId` |
| `branchesCount` | `branchCount` | top businesses |
| `branchId` (on the business object) | `primaryBranchId` | |
| `maxOrganizations` | `maxBusinesses` | legacy packages |
| `tenantSubscriptionId` | `organizationSubscriptionId` | plan payment requests, platform invoices |
| `confirmOrganizationDeletion` | `confirmBusinessDeletion` | deleting a business's last branch |
| `listingComplete` | `firstBusinessComplete` | host status |
| `tenant` (nested object) | `organization` (host / admin only), removed from traveller responses | |
| `ownerName` (top hosts) | removed | top businesses show the business, not the person |

**Removed with no replacement:** `gymListingId` on branches (F1), `refundsAllowed` / `refundWindowDays` on the
business profile (on the branch now), `gyms` (duplicate list key of the business-branches response), compound ids
`tenantId:listingId` (F7), the `branchSource: 'new'` Add Business body (the first branch is always held).

## 3. Objects

Key lists below are the model attributes after the renames, plus computed keys. Keys not listed are not sent.

#### Organization (host view: `GET /organizations/me`, `PATCH /organizations/me`, inside admin organization objects)

`id`, `organizationCode` (was `tenantCode`), `organizationName` (was `businessName`), `ownerUserId`, `email`, `phone`, `cityId`, `areaId`, `areaStatus`, `areaRequestId`, `address`, `firstBusinessName` (was `gymName`), `firstBusinessDescription` (was `gymDescription`), `logoUrl`, `coverImageUrl`, `genderType`, `latitude`, `longitude`, `firstBranchDraft` (was `mainBranchDataJson`), `firstBranchCurrency` (was `mainBranchCurrency`), `paymentMethod`, `bankTransferRef`, `status`, `kycStatus`, `onboardingStep`, `kycDocumentsJson`, `selectedPackageId`, `approvedAt`, `approvedBy`, `rejectedAt`, `rejectedBy`, `rejectionReason`, `provisioningState`, `provisioningLockedUntil`, `provisioningError`, `deletionRequestedAt`, `deletionScheduledFor`, `deletedAt`, `statusBeforeDeletion`, `paymentDetailsJson`, `paymentDetailsUpdatedAt`, `permissionVersion`, `createdAt`, `updatedAt`, `pendingArea` (computed)

Never sent: `dbName`, `connectionStringEncrypted`, `provisioningLockToken`. `kycDocumentsJson` is the list of file names only (as today).

#### Business (host and admin view: `/host/businesses…`, `/admin/businesses…`)

`id`, `organizationId` (was `tenantId`), `primaryBranchId` (was `branchId`), `cityId`, `areaId`, `areaStatus`, `areaRequestId`, `name` (was `title`), `description` (was `shortDescription`), `logoUrl`, `coverImageUrl`, `genderType`, `averageRating`, `latitude`, `longitude`, `isFeatured`, `contactPhone`, `website`, `facilitiesJson`, `imagesJson`, `category`, `establishedYear`, `floorArea`, `postalCode`, `country`, `minPrice`, `status`, `reservedSlots`, `rejectionReason`, `rejectedAt`, `rejectedBy`, `createdAt`, `updatedAt`, `kycStatus` (new), `kycDocuments` (new), `kycSubmittedAt` (new), `approvedAt` (new), `verifiedAt` (new), `businessVerified` (new), `canReceiveBranches` (new), `travellerVisible` (new), `branchCount` (new), `heldFirstBranch` (new), `missingForApproval` (new), `firstBranchDraft` (new), `pendingArea` (computed)

`id` is the one business id (option S): the same value names the tenant-database row. Removed: `gymListingId`, `gymId`.

#### BusinessProfile (staff view of the tenant-database row: `/organizations/me/businesses/:businessId/profile`)

`id`, `name`, `description`, `contactPhone`, `contactEmail`, `website`, `genderType`, `logoUrl`, `coverImageUrl`, `socialLinksJson`, `imagesJson`, `createdAt`, `updatedAt`

Removed: `gymListingId` (same id now), `refundsAllowed` / `refundWindowDays` (the refund policy is on the branch).

#### Branch (every branch object a host, staff or admin route sends)

`id`, `businessId` (was `gymId`), `branchName`, `address`, `cityId`, `areaId`, `latitude`, `longitude`, `googlePlaceId`, `openingTime`, `closingTime`, `phone`, `timezone`, `currency`, `facilitiesJson`, `imagesJson`, `tagline`, `category`, `tagsJson`, `description`, `establishedYear`, `floorArea`, `addressLine1`, `addressLine2`, `postalCode`, `country`, `status`, `travelerVisibilityStatus`, `deactivationReason`, `deactivatedAt`, `deactivatedBy`, `adminSuspended`, `adminSuspendedReason`, `adminSuspendedAt`, `adminSuspendedBy`, `billingLockedAt`, `billingLockReason`, `pausedAt`, `pausedBy`, `createdAt`, `updatedAt`, `refundsAllowed` (new), `refundWindowDays` (new), `hours` (computed), `utcOffsetMinutes` (computed), `hoursToday` (computed), `openNow` (computed), `openNowFor` (computed), `nextChange` (computed)

Removed: `gymListingId` (use `businessId`; the column is dropped, F1).

#### OrganizationSubscription (GymsEra plan: `/host/subscription/current`, admin subscriptions)

`id`, `organizationId` (was `tenantId`), `platformPackageId`, `billingPlanId`, `platform`, `branchCount`, `productId`, `externalOriginalTransactionId`, `externalTransactionId`, `environment`, `lastVerifiedAt`, `startDate`, `endDate`, `amount`, `currency`, `billingCycle`, `status`, `autoRenew`, `paymentStatus`, `bankTransferRef`, `overQuotaCount`, `statusNote`, `pendingChange`, `duplicateBilling`, `entitlementEndedAt`, `createdAt`, `updatedAt`

#### MembershipPlan

`id`, `businessId` (was `gymId`), `branchId`, `name`, `description`, `durationType`, `durationValue`, `price`, `joiningFee`, `securityFee`, `visitLimit`, `freezeLimitDays`, `isTrial`, `status`, `isDeactivated`, `isPublic`, `isFeatured`, `posterUrl`, `createdAt`, `updatedAt`

#### MemberSubscriptionSummary (`/me/subscriptions` list rows; index row)

`id`, `userId`, `organizationId` (was `tenantId`), `businessId` (was `gymListingId`), `subscriptionId`, `businessName` (was `gymName`), `planName`, `startDate`, `endDate`, `status`, `createdAt`, `updatedAt`

#### BranchCard (discovery lists: `/discovery/branches`, `/branches/featured`, `/top-rated`, `/nearby`, `/map`, `/discovery/businesses/:businessId/branches`)

`id` (= `branchId`), `branchId`, `businessId` (was `gymId` / `gymListingId`), `organizationId` (was `tenantId`),
`cityId`, `areaId`, `displayName` (was `title`), `businessName` (was `organizationName`), `branchName`,
`businessVerified` (new, D11), `description` (was `shortDescription`), `logoUrl`, `coverImageUrl`,
`business { name, description, logoUrl, coverImageUrl }` (was `organization`), `genderType`, `averageRating`,
`reviewCount`, `latitude`, `longitude`, `isFeatured`, `contactPhone`, `website`, `facilitiesJson`, `imagesJson`,
`category`, `minPrice`, `currency`, `status`, `createdAt`, `city { id, name }`, `area { id, name, cityId }`,
`openingTime`, `closingTime`, `hours`, `timezone`, `utcOffsetMinutes`, `hoursToday`, `openNow`, `openNowFor`,
`nextChange`. Only branches of a business with `status = ACTIVE` **and** `kycStatus = APPROVED` (enterprise §1.4).

#### BusinessPublic (`GET /discovery/businesses/:businessId` → `{ business, membershipPlans }`)

`business`: `id`, `organizationId`, `primaryBranchId`, `cityId`, `areaId`, `name`, `description`, `logoUrl`,
`coverImageUrl`, `genderType`, `averageRating`, `reviewCount`, `latitude`, `longitude`, `isFeatured`, `contactPhone`,
`website`, `facilitiesJson`, `imagesJson`, `category`, `establishedYear`, `floorArea`, `postalCode`, `country`,
`minPrice`, `currency`, `businessVerified`, `city`, `area`, `host { id, fullName, profileImageUrl, createdAt }`
(was `tenant.owner`; the person, never the organization name), `branches: [Branch]`.
`membershipPlans: [MembershipPlan + currency]`. Not sent: `tenant`, `organizationName`, `kyc*`, `reservedSlots`,
`rejection*`, `firstBranchDraft`.

#### BranchDetail (`GET /discovery/branches/:branchId` → `{ branch, business, membershipPlans }`, new)

`branch`: BranchCard keys; `business`: BusinessPublic keys without `branches`; `membershipPlans`: the plans sold at
this branch.

#### TopBusiness (`GET /discovery/top-businesses` → `[TopBusiness]`)

`id` (= `businessId`), `businessId`, `organizationId`, `businessName`, `businessVerified`, `logoUrl`, `coverImageUrl`,
`averageRating`, `reviewCount`, `branchCount`, `branches: [BranchCard]`. One row per business.

#### HostStatus (`GET /host/status`)

`status`, `nextAction`, `organizationId` (was `tenantId`), `organizationName` (was `brandName`),
`firstBusinessName` (was `gymName`), `applicationSubmitted`, `firstBusinessComplete` (was `listingComplete`),
`payment { done, entitled, method }`, `plan`, `verification { status, verified }`, `rejectionReason`, `area` (A3 J5; was written `pendingArea`).

#### BranchQuota (`GET /host/branch-quota[?businessId=]`)

`maxBranches`, `usedBranches`, `remainingBranches`, `activeBranches`, `buildableBranches`, `overQuotaCount`,
`overQuotaGraceDays`, `overQuotaGraceRemainingDays`, `isOverQuotaGraceExpired`,
`pool { max, used, reserved, free }` (new, organization-wide); with `businessId`: `businessBranches`,
`businessReservedSlots` (were `organization…`). `GET /host/business-quota` (was `organization-quota`) answers the
same keys for one business.

#### Workspace (`GET /me/context`, organization switcher)

`organizations: [{ organizationId (was tenantId), name (= organization name; was gymName || businessName),
isOwner, role { key, name, displayName, level }, scopeType ('ORG' | 'BRANCH'), orgPermissions, branches,
pendingApprovals }]`. ("org" in RBAC already means the organization; unchanged.)

#### Add Business request (`POST /host/businesses`) (superseded by A2 H2: nested `firstBranch`)

`businessName`, `businessDescription`, `genderType`, `contactPhone`, `logoUrl`, `coverImageUrl`, `images`,
`facilitiesJson`, and the held first branch: `address`, `cityId`, `areaId` or `areaRequestId` (one required),
`googlePlaceId`, `latitude`, `longitude`, `hours` (or `openingTime` / `closingTime`), `packages`. Answer:
`{ business: Business, branch: null, heldFirstBranch: true }`; 403 `branch_limit_reached` when no unit is free.
No logo or cover is copied from the organization or another business (F9).

#### Refund policy (`GET|PUT /subscriptions/staff/refund-policy`)

Query / body: `branchId` **or** `applyToAllBranches: true`; body `refundsAllowed`, `refundWindowDays`. Answer
`{ branchId, refundsAllowed, refundWindowDays }`, bulk `{ updatedBranchIds: [...], skippedBranchIds: [...] }`.
Neither id → 422 `branch_required`.

## 4. Routes before → after

All 471 routes of `origin/main`, in router order. "(same)" = path unchanged (the key renames of §2 still apply).
Body keys are the route's declared allow-list after §2; a route with none declares no body or validates it
another way (its validator file). Query parameters follow §2 (`?gymListingId=` → `?businessId=`,
`?organizationId=` → `?businessId=`, `?tenantId=` → `?organizationId=`, `?gymId=` → `?businessId=`).

| # | Method | Before (`/api/v1` …) | After (`/api/v1` …) | Body keys after (declared allow-list) | Note |
|---|---|---|---|---|---|
| 1 | GET | `/health` | (same) |  |  |
| 2 | GET | `/health/tenant-schema` | (same) |  |  |
| 3 | GET | `/system/socket-status` | (same) |  |  |
| 4 | GET | `/system/fcm-status` | (same) |  |  |
| 5 | POST | `/auth/register` | (same) | `email`, `fullName`, `password`, `phone` |  |
| 6 | POST | `/auth/otp/verify` | (same) | `code`, `email` |  |
| 7 | POST | `/auth/otp/resend` | (same) | `email` |  |
| 8 | POST | `/auth/login` | (same) | `email`, `password` |  |
| 9 | POST | `/auth/social/google` | (same) | `idToken` |  |
| 10 | POST | `/auth/social/google/staff` | (same) | `idToken` |  |
| 11 | POST | `/auth/social/apple` | (same) | `authorizationCode`, `email`, `fullName`, `identityToken`, `userIdentifier` |  |
| 12 | POST | `/auth/refresh` | (same) | `refreshToken` |  |
| 13 | POST | `/auth/password-reset/request` | (same) | `email` |  |
| 14 | POST | `/auth/password-reset/confirm` | (same) | `code`, `email`, `password` |  |
| 15 | GET | `/auth/me` | (same) |  |  |
| 16 | POST | `/auth/logout` | (same) | `refreshToken` |  |
| 17 | GET | `/auth/sessions` | (same) |  |  |
| 18 | DELETE | `/auth/sessions/:id` | (same) |  |  |
| 19 | DELETE | `/auth/sessions` | (same) |  |  |
| 20 | GET | `/auth/tenant-invitations/verify` | **`/auth/organization-invitations/verify`** |  |  |
| 21 | POST | `/auth/tenant-invitations/accept` | **`/auth/organization-invitations/accept`** | `fullName`, `password`, `phone`, `token` |  |
| 22 | GET | `/cities/` | (same) |  |  |
| 23 | GET | `/cities/:id/areas` | (same) |  |  |
| 24 | POST | `/cities/` | (same) | `imageUrl`, `isActive`, `name` |  |
| 25 | PATCH | `/cities/:id` | (same) | `imageUrl`, `isActive`, `name` |  |
| 26 | POST | `/cities/:id/areas` | (same) | `imageUrl`, `name` |  |
| 27 | PATCH | `/cities/:id/areas/:areaId` | (same) | `imageUrl`, `name` |  |
| 28 | DELETE | `/cities/:id` | (same) |  |  |
| 29 | DELETE | `/cities/:id/areas/:areaId` | (same) |  |  |
| 30 | POST | `/cities/:id/image` | (same) |  |  |
| 31 | POST | `/cities/:id/areas/:areaId/image` | (same) |  |  |
| 32 | GET | `/places/autocomplete` | (same) |  |  |
| 33 | GET | `/places/details/:placeId` | (same) |  |  |
| 34 | GET | `/places/reverse-geocode` | (same) |  |  |
| 35 | POST | `/places/area-requests/check` | (same) | `cityId`, `name` |  |
| 36 | POST | `/places/area-requests` | (same) | `cityId`, `confirmNotListed`, `name` |  |
| 37 | GET | `/places/area-requests/:id` | (same) |  |  |
| 38 | POST | `/places/areas` | (same) | `cityId`, `name` |  |
| 39 | GET | `/platform-packages/` | (same) |  |  |
| 40 | GET | `/platform-packages/:id` | (same) |  |  |
| 41 | POST | `/platform-packages/` | (same) | `billingCycle`, `description`, `featureFlags`, `featureFlagsJson`, `maxBranches`, `maxMembers`, `maxBusinesses` (was `maxOrganizations`), `maxTrainers`, `name`, `price` |  |
| 42 | PATCH | `/platform-packages/:id` | (same) | `billingCycle`, `description`, `featureFlagsJson`, `maxBranches`, `maxMembers`, `maxBusinesses` (was `maxOrganizations`), `maxTrainers`, `name`, `price`, `status` |  |
| 43 | GET | `/tenants/me` | **`/organizations/me`** |  |  |
| 44 | PATCH | `/tenants/me` | **`/organizations/me`** | `areaId`, `areaRequestId`, `organizationName` (was `businessName`), `cityId`, `email`, `phone` |  |
| 45 | POST | `/tenants/register` | **`/organizations/register`** | `areaId`, `areaRequestId`, `organizationName` (was `businessName`), `cityId`, `email`, `phone` | new organization codes `ORG-` (D-5, F8) |
| 46 | POST | `/tenants/:id/gym-profile` | **`/organizations/:organizationId/first-business`** | `address`, `organizationName` (was `businessName`), `coverImageUrl`, `genderType`, `firstBusinessDescription` (was `gymDescription`), `firstBusinessName` (was `gymName`), `kycDocumentsJson`, `latitude`, `logoUrl`, `longitude`, `firstBranchDraft` (was `mainBranchData`) |  |
| 47 | POST | `/tenants/:id/select-package` | **`/organizations/:organizationId/select-package`** | `packageId` |  |
| 48 | POST | `/tenants/:id/onboarding-images` | **`/organizations/:organizationId/first-business/images`** |  |  |
| 49 | PUT | `/tenants/:id/onboarding-images` | **`/organizations/:organizationId/first-business/images`** | `imagesJson` |  |
| 50 | POST | `/tenants/:id/reapply` | **`/organizations/:organizationId/reapply`** |  |  |
| 51 | POST | `/tenants/:id/finalize` | **`/organizations/:organizationId/finalize`** | `bankTransferRef`, `paymentMethod` |  |
| 52 | POST | `/tenants/:id/kyc-documents` | **`/organizations/:organizationId/kyc-documents`** | `documentType` |  |
| 53 | GET | `/tenants/:id/kyc-documents` | **`/organizations/:organizationId/kyc-documents`** |  |  |
| 54 | GET | `/tenants/:id/kyc-documents/:documentId/stream` | **`/organizations/:organizationId/kyc-documents/:documentId/stream`** |  |  |
| 55 | DELETE | `/tenants/:id/kyc-documents/:documentId` | **`/organizations/:organizationId/kyc-documents/:documentId`** |  |  |
| 56 | GET | `/billing/plans` | (same) |  |  |
| 57 | GET | `/billing/bank-instructions` | (same) |  |  |
| 58 | POST | `/billing/purchase-intent` | (same) | `billingCycle`, `planId`, `platform`, `targetPlanId`, `targetPlatform` |  |
| 59 | POST | `/billing/ios/sync` | (same) | `businessId` (was `organizationId`), `transactionId` |  |
| 60 | GET | `/billing/downgrade-preview` | (same) |  |  |
| 61 | PUT | `/billing/downgrade-choice` | (same) | `billingPlanId`, `keepBranchIds` |  |
| 62 | POST | `/billing/webhooks/apple` | (same) |  |  |
| 63 | POST | `/billing/android/sync` | (same) | `businessId` (was `organizationId`), `productId`, `purchaseToken` |  |
| 64 | POST | `/billing/webhooks/google` | (same) |  |  |
| 65 | POST | `/billing/stripe/checkout-session` | (same) | `billingCycle`, `billingPlanId`, `cancelUrl`, `currency`, `successUrl` |  |
| 66 | GET | `/billing/stripe/session/:id` | (same) |  |  |
| 67 | POST | `/billing/stripe/change-plan` | (same) | `billingCycle`, `billingPlanId` |  |
| 68 | POST | `/billing/stripe/portal-session` | (same) | `returnUrl` |  |
| 69 | POST | `/billing/webhooks/stripe` | (same) |  |  |
| 70 | GET | `/admin/billing-plans/` | (same) |  |  |
| 71 | GET | `/admin/billing-plans/:id` | (same) |  |  |
| 72 | POST | `/admin/billing-plans/` | (same) | `androidAnnualBasePlanId`, `androidMonthlyBasePlanId`, `androidProductId`, `annualPrice`, `branchCount`, `currency`, `iosAnnualProductId`, `iosMonthlyProductId`, `isActive`, `monthlyPrice`, `sortOrder` |  |
| 73 | PATCH | `/admin/billing-plans/:id` | (same) | `androidAnnualBasePlanId`, `androidMonthlyBasePlanId`, `androidProductId`, `annualPrice`, `branchCount`, `currency`, `iosAnnualProductId`, `iosMonthlyProductId`, `isActive`, `monthlyPrice`, `sortOrder` |  |
| 74 | POST | `/admin/billing-plans/:id/sync-stripe` | (same) |  |  |
| 75 | POST | `/admin/billing-plans/:id/mark-synced` | (same) | `provider` |  |
| 76 | PUT | `/admin/billing-plans/:id/prices/:currency` | (same) | `annualPrice`, `monthlyPrice`, `stripeAnnualPriceId`, `stripeMonthlyPriceId` |  |
| 77 | DELETE | `/admin/billing-plans/:id/prices/:currency` | (same) |  |  |
| 78 | POST | `/admin/billing-plans/:id/prices/:currency/sync-stripe` | (same) |  |  |
| 79 | POST | `/admin/tenants` | **`/admin/organizations`** | `organizationName` (was `businessName`), `cityId`, `email`, `ownerEmail`, `ownerFullName`, `ownerPhone`, `packageId`, `phone` |  |
| 80 | GET | `/admin/tenants` | **`/admin/organizations`** |  |  |
| 81 | GET | `/admin/tenants/:id` | **`/admin/organizations/:organizationId`** |  |  |
| 82 | POST | `/admin/tenants/:id/approve` | **`/admin/organizations/:organizationId/approve`** | `photosChecked` |  |
| 83 | DELETE | `/admin/tenants/:id/approval-photos` | **`/admin/organizations/:organizationId/approval-photos`** | `imageUrl` |  |
| 84 | POST | `/admin/tenants/:id/reject` | **`/admin/organizations/:organizationId/reject`** | `reason` |  |
| 85 | POST | `/admin/tenants/:id/suspend` | **`/admin/organizations/:organizationId/suspend`** | `reason` |  |
| 86 | POST | `/admin/tenants/:id/reactivate` | **`/admin/organizations/:organizationId/reactivate`** |  |  |
| 87 | GET | `/admin/tenants/:id/branches` | **`/admin/organizations/:organizationId/branches`** |  |  |
| 88 | PATCH | `/admin/tenants/:id/branches/:branchId/status` | **`/admin/organizations/:organizationId/branches/:branchId/status`** | `reason`, `status` |  |
| 89 | POST | `/admin/tenants/:id/branches/:branchId/suspend` | **`/admin/organizations/:organizationId/branches/:branchId/suspend`** | `reason` |  |
| 90 | POST | `/admin/tenants/:id/branches/:branchId/unsuspend` | **`/admin/organizations/:organizationId/branches/:branchId/unsuspend`** |  |  |
| 91 | DELETE | `/admin/tenants/:id/branches/:branchId` | **`/admin/organizations/:organizationId/branches/:branchId`** | `confirmBusinessDeletion` (was `confirmOrganizationDeletion`) |  |
| 92 | GET | `/admin/tenants/:id/members` | **`/admin/organizations/:organizationId/members`** |  |  |
| 93 | POST | `/admin/tenants/:id/members/:userId/reveal` | **`/admin/organizations/:organizationId/members/:userId/reveal`** | `reason` |  |
| 94 | GET | `/admin/tenants/:id/membership-plans` | **`/admin/organizations/:organizationId/membership-plans`** |  |  |
| 95 | POST | `/admin/tenants/:id/logo` | **`/admin/organizations/:organizationId/first-business/logo`** |  |  |
| 96 | POST | `/admin/tenants/:id/cover` | **`/admin/organizations/:organizationId/first-business/cover`** |  |  |
| 97 | GET | `/admin/area-requests` | (same) |  |  |
| 98 | POST | `/admin/area-requests/:id/approve` | (same) | `applyToGroup`, `latitude`, `longitude`, `name` |  |
| 99 | POST | `/admin/area-requests/:id/merge` | (same) | `applyToGroup`, `areaId` |  |
| 100 | POST | `/admin/area-requests/:id/reject` | (same) | `applyToGroup`, `reason` |  |
| 101 | POST | `/admin/area-requests/:id/retry` | (same) |  |  |
| 102 | GET | `/admin/areas/:areaId/aliases` | (same) |  |  |
| 103 | DELETE | `/admin/area-aliases/:id` | (same) |  |  |
| 104 | GET | `/admin/tenants/:id/gym-listing` | **`/admin/businesses/:businessId`** |  | one business id, no compound `tenantId:listingId` (F7) |
| 105 | POST | `/admin/tenants/:id/gym-listing` | **`/admin/organizations/:organizationId/businesses`** | `areaId`, `cityId`, `contactPhone`, `facilitiesJson`, `genderType`, `latitude`, `longitude`, `description` (was `shortDescription`), `name` (was `title`), `website` | one business id, no compound `tenantId:listingId` (F7) |
| 106 | PATCH | `/admin/tenants/:id/gym-listing` | **`/admin/businesses/:businessId`** | `areaId`, `cityId`, `contactPhone`, `facilitiesJson`, `genderType`, `isFeatured`, `latitude`, `longitude`, `description` (was `shortDescription`), `status`, `name` (was `title`), `website` | one business id, no compound `tenantId:listingId` (F7) |
| 107 | POST | `/admin/tenants/:id/gym-listing/logo` | **`/admin/businesses/:businessId/logo`** |  |  |
| 108 | POST | `/admin/tenants/:id/gym-listing/cover` | **`/admin/businesses/:businessId/cover`** |  |  |
| 109 | POST | `/admin/tenants/:id/gym-listing/images` | **`/admin/businesses/:businessId/images`** |  |  |
| 110 | DELETE | `/admin/tenants/:id/gym-listing/images` | **`/admin/businesses/:businessId/images`** | `imageUrl` |  |
| 111 | POST | `/admin/tenants/:id/branches` | **`/admin/organizations/:organizationId/branches`** | `address`, `addressLine1`, `addressLine2`, `areaId`, `branchName`, `category`, `cityId`, `closingTime`, `currency`, `description`, `establishedYear`, `facilities`, `facilitiesJson`, `floorArea`, `googlePlaceId`, `businessId` (was `gymListingId`), `hours`, `imagesJson`, `latitude`, `longitude`, `openingTime`, `packages`, `phone`, `postalCode`, `tagline`, `timezone` |  |
| 112 | PATCH | `/admin/tenants/:id/branches/:branchId` | **`/admin/organizations/:organizationId/branches/:branchId`** | `address`, `areaId`, `branchName`, `cityId`, `closingTime`, `facilities`, `facilitiesJson`, `googlePlaceId`, `hours`, `latitude`, `longitude`, `openingTime`, `phone`, `status` |  |
| 113 | POST | `/admin/tenants/:id/branches/:branchId/images` | **`/admin/organizations/:organizationId/branches/:branchId/images`** |  |  |
| 114 | DELETE | `/admin/tenants/:id/branches/:branchId/images` | **`/admin/organizations/:organizationId/branches/:branchId/images`** | `imageUrl` |  |
| 115 | PATCH | `/admin/branches/:branchId/traveler-visibility` | (same) | `reason`, `status` |  |
| 116 | GET | `/admin/branches/:branchId/traveler-visibility/history` | (same) |  |  |
| 117 | GET | `/admin/billing-events` | (same) |  |  |
| 118 | GET | `/admin/audit-logs` | (same) |  |  |
| 119 | GET | `/admin/tenants/:id/subscriptions` | **`/admin/organizations/:organizationId/subscriptions`** |  |  |
| 120 | GET | `/admin/tenants/:id/capacity-audit` | **`/admin/organizations/:organizationId/capacity-audit`** |  |  |
| 121 | POST | `/admin/tenants/:id/subscriptions` | **`/admin/organizations/:organizationId/subscriptions`** | `amount`, `autoRenew`, `billingCycle`, `createInvoice`, `packageId`, `startDate` |  |
| 122 | PATCH | `/admin/tenants/:id/subscriptions/:subId/revoke` | **`/admin/organizations/:organizationId/subscriptions/:subId/revoke`** |  |  |
| 123 | POST | `/admin/tenants/:id/subscriptions/:subId/verify-payment` | **`/admin/organizations/:organizationId/subscriptions/:subId/verify-payment`** | `bankTransferRef` |  |
| 124 | GET | `/admin/plan-payments` | (same) |  |  |
| 125 | GET | `/admin/plan-payments/:id/proof` | (same) |  |  |
| 126 | POST | `/admin/plan-payments/:id/approve` | (same) |  |  |
| 127 | POST | `/admin/plan-payments/:id/reject` | (same) | `reason` |  |
| 128 | GET | `/admin/tenants/:id/invoices` | **`/admin/organizations/:organizationId/invoices`** |  |  |
| 129 | POST | `/admin/tenants/:id/invoices` | **`/admin/organizations/:organizationId/invoices`** | `description`, `dueDate`, `notes`, `status`, `subtotal`, `taxAmount`, `organizationSubscriptionId` (was `tenantSubscriptionId`) |  |
| 130 | PATCH | `/admin/tenants/:id/invoices/:invoiceId` | **`/admin/organizations/:organizationId/invoices/:invoiceId`** | `dueDate`, `notes`, `paidAt`, `status` |  |
| 131 | POST | `/admin/tenants/:id/invoices/:invoiceId/send-reminder` | **`/admin/organizations/:organizationId/invoices/:invoiceId/send-reminder`** |  |  |
| 132 | POST | `/admin/tenants/:id/invoices/:invoiceId/send-confirmation` | **`/admin/organizations/:organizationId/invoices/:invoiceId/send-confirmation`** |  |  |
| 133 | GET | `/admin/reports/platform` | (same) |  |  |
| 134 | DELETE | `/admin/tenants/:id` | **`/admin/organizations/:organizationId`** |  |  |
| 135 | POST | `/admin/subscriptions/sync` | (same) |  |  |
| 136 | GET | `/admin/stats` | (same) |  |  |
| 137 | GET | `/admin/analytics` | (same) |  |  |
| 138 | GET | `/admin/reviews` | (same) |  |  |
| 139 | POST | `/admin/reviews/:id/moderate` | (same) | `action`, `adminNote` |  |
| 140 | GET | `/admin/reports` | (same) |  |  |
| 141 | GET | `/admin/reports/:id` | (same) |  |  |
| 142 | PATCH | `/admin/reports/:id` | (same) | `action`, `adminNote` |  |
| 143 | GET | `/admin/moderation/words` | (same) |  |  |
| 144 | PUT | `/admin/moderation/words` | (same) | `words` |  |
| 145 | PATCH | `/admin/reviews/:id/moderate` | (same) | `action`, `adminNote` |  |
| 146 | GET | `/gyms/profile` | **`/organizations/me/businesses/:businessId/profile`** |  | one business per call; the caller names it (no "the" gym, F2) |
| 147 | POST | `/gyms/profile/logo` | **`/organizations/me/businesses/:businessId/profile/logo`** |  |  |
| 148 | POST | `/gyms/profile/cover` | **`/organizations/me/businesses/:businessId/profile/cover`** |  |  |
| 149 | POST | `/gyms/profile/images` | **`/organizations/me/businesses/:businessId/profile/images`** |  |  |
| 150 | DELETE | `/gyms/profile/images` | **`/organizations/me/businesses/:businessId/profile/images`** | `imageUrl` |  |
| 151 | PATCH | `/gyms/profile` | **`/organizations/me/businesses/:businessId/profile`** | `address`, `category`, `contactEmail`, `contactPhone`, `coverImageUrl`, `description`, `email`, `establishedYear`, `genderType`, `idToken`, `imagesJson`, `latitude`, `logoUrl`, `longitude`, `name`, `password`, `paymentDetailsJson`, `phone`, `provider`, `socialLinksJson`, `tagline`, `website` | one business per call; the caller names it (no "the" gym, F2) |
| 152 | GET | `/gyms/branches` | **`/organizations/me/branches`** |  |  |
| 153 | POST | `/gyms/branches` | **`/organizations/me/branches`** | `address`, `addressLine1`, `addressLine2`, `areaId`, `areaRequestId`, `branchName`, `category`, `cityId`, `closingTime`, `currency`, `description`, `establishedYear`, `facilities`, `facilitiesJson`, `floorArea`, `googlePlaceId`, `businessId` (was `gymListingId`), `hours`, `imagesJson`, `latitude`, `longitude`, `openingTime`, `packages`, `phone`, `postalCode`, `tagline`, `timezone` |  |
| 154 | GET | `/gyms/branches/:branchId` | **`/organizations/me/branches/:branchId`** |  |  |
| 155 | PATCH | `/gyms/branches/:branchId` | **`/organizations/me/branches/:branchId`** | `address`, `areaId`, `areaRequestId`, `branchName`, `cityId`, `closingTime`, `currency`, `facilities`, `facilitiesJson`, `googlePlaceId`, `hours`, `imagesJson`, `latitude`, `longitude`, `openingTime`, `phone`, `status`, `timezone` |  |
| 156 | DELETE | `/gyms/branches/:branchId` | **`/organizations/me/branches/:branchId`** | `confirmBusinessDeletion` (was `confirmOrganizationDeletion`), `idToken`, `password`, `provider`, `reauthIdToken`, `reauthProvider` |  |
| 157 | POST | `/gyms/branches/:branchId/images` | **`/organizations/me/branches/:branchId/images`** |  |  |
| 158 | DELETE | `/gyms/branches/:branchId/images` | **`/organizations/me/branches/:branchId/images`** | `imageUrl` |  |
| 159 | GET | `/gyms/branches/:branchId/staff` | **`/organizations/me/branches/:branchId/staff`** |  |  |
| 160 | POST | `/gyms/branches/:branchId/staff` | **`/organizations/me/branches/:branchId/staff`** | `designation`, `userId` |  |
| 161 | DELETE | `/gyms/branches/:branchId/staff/:staffId` | **`/organizations/me/branches/:branchId/staff/:staffId`** |  |  |
| 162 | GET | `/gyms/members/search` | **`/organizations/me/members/search`** |  |  |
| 163 | POST | `/gyms/members/enroll` | **`/organizations/me/members/enroll`** | `branchId`, `email`, `fullName`, `idempotencyKey`, `notes`, `paymentMethod`, `phone`, `planId`, `startDate` |  |
| 164 | GET | `/gyms/members` | **`/organizations/me/members`** |  |  |
| 165 | GET | `/gyms/staff` | **`/organizations/me/staff`** |  |  |
| 166 | POST | `/gyms/staff` | **`/organizations/me/staff`** | `assignToAllBranches`, `branchIds`, `designation`, `email`, `fullName`, `password`, `phone` |  |
| 167 | DELETE | `/gyms/staff/:userId` | **`/organizations/me/staff/:userId`** |  |  |
| 168 | GET | `/discovery/cities` | (same) |  |  |
| 169 | GET | `/discovery/stats` | (same) |  |  |
| 170 | GET | `/discovery/organizations` | **`/discovery/businesses`** |  |  |
| 171 | GET | `/discovery/organizations/:gymId/branches` | **`/discovery/businesses/:businessId/branches`** |  |  |
| 172 | GET | `/discovery/top-hosts` | **`/discovery/top-businesses`** |  |  |
| 173 | GET | `/discovery/gyms/featured` | **`/discovery/branches/featured`** |  |  |
| 174 | GET | `/discovery/gyms/top-rated` | **`/discovery/branches/top-rated`** |  |  |
| 175 | GET | `/discovery/gyms/nearby` | **`/discovery/branches/nearby`** |  |  |
| 176 | GET | `/discovery/gyms/map` | **`/discovery/branches/map`** |  |  |
| 177 | GET | `/discovery/gyms` | **`/discovery/branches`** |  | returns branch cards; the duplicate registration is removed (F4) |
| 178 | GET | `/discovery/gyms/:id` | **`/discovery/businesses/:businessId`** |  | takes a business id only; a branch id is no longer accepted (F4); branch detail is `GET /discovery/branches/:branchId` (new) |
| 179 | GET | `/discovery/gyms/:id/payment-details` | **`/discovery/businesses/:businessId/payment-details`** |  | takes a business id only; a branch id is no longer accepted (F4); branch detail is `GET /discovery/branches/:branchId` (new) |
| 180 | GET | `/discovery/gyms/:id/reviews` | **`/discovery/businesses/:businessId/reviews`** |  | takes a business id only; a branch id is no longer accepted (F4); branch detail is `GET /discovery/branches/:branchId` (new) |
| 181 | POST | `/discovery/gyms/:id/reviews` | **`/discovery/businesses/:businessId/reviews`** | `body`, `branchId`, `rating`, `text`, `title` | takes a business id only; a branch id is no longer accepted (F4); branch detail is `GET /discovery/branches/:branchId` (new) |
| 182 | GET | `/discovery/gyms` | — (removed: duplicate registration) |  |  |
| 183 | GET | `/discovery/gyms/:id` | — (removed: duplicate registration) |  |  |
| 184 | POST | `/discovery/branches/:branchId/inquiries` | (same) | `message` |  |
| 185 | GET | `/discovery/branches/:branchId/reviews/summary` | (same) |  |  |
| 186 | GET | `/discovery/branches/:branchId/reviews` | (same) |  |  |
| 187 | POST | `/discovery/branches/:branchId/reviews` | (same) | `rating`, `text`, `title` |  |
| 188 | GET | `/host/devices/` | (same) |  |  |
| 189 | POST | `/host/devices/` | (same) | `branchId`, `direction`, `importFirst`, `linkMode`, `name`, `serialNumber` |  |
| 190 | GET | `/host/devices/unlinked-users` | (same) |  |  |
| 191 | GET | `/host/devices/branch-settings/:branchId` | (same) |  |  |
| 192 | PUT | `/host/devices/branch-settings/:branchId` | (same) | `alertsEnabled`, `capturePhotos` |  |
| 193 | GET | `/host/devices/capture-photos/:photoId` | (same) |  |  |
| 194 | GET | `/host/devices/:id` | (same) |  |  |
| 195 | PATCH | `/host/devices/:id` | (same) | `attOptions`, `direction`, `enabled`, `name`, `pollDelaySeconds` |  |
| 196 | POST | `/host/devices/:id/repair` | (same) |  |  |
| 197 | DELETE | `/host/devices/:id` | (same) | `confirmName`, `wipeDevice` |  |
| 198 | GET | `/host/devices/members/:memberId/biometric-consent` | (same) |  |  |
| 199 | POST | `/host/devices/members/:memberId/biometric-consent` | (same) | `method` |  |
| 200 | DELETE | `/host/devices/members/:memberId/biometric-consent` | (same) |  |  |
| 201 | GET | `/host/devices/staff/by-user/:userId` | (same) |  |  |
| 202 | PATCH | `/host/devices/staff/:staffId/device-access` | (same) | `deviceAccess` |  |
| 203 | POST | `/host/devices/:id/enroll` | (same) | `memberId`, `type` |  |
| 204 | GET | `/host/devices/:id/members` | (same) |  |  |
| 205 | GET | `/host/devices/:id/access-events` | (same) |  |  |
| 206 | GET | `/host/devices/:id/errors` | (same) |  |  |
| 207 | GET | `/host/devices/:id/commands` | (same) |  |  |
| 208 | GET | `/host/devices/:id/audits` | (same) |  |  |
| 209 | GET | `/host/devices/:id/unlinked-users` | (same) |  |  |
| 210 | POST | `/host/devices/:id/sync` | (same) | `mode` |  |
| 211 | POST | `/host/devices/:id/unlinked-users/:pin/link` | (same) | `memberId` |  |
| 212 | POST | `/host/devices/:id/unlinked-users/:pin/dismiss` | (same) | `removeFromDevice` |  |
| 213 | GET | `/host/devices/:id/imports` | (same) |  |  |
| 214 | GET | `/host/devices/:id/imports/:importId` | (same) |  |  |
| 215 | GET | `/host/devices/:id/imports/:importId/users` | (same) |  |  |
| 216 | GET | `/host/devices/:id/imports/:importId/preview` | (same) |  |  |
| 217 | GET | `/host/devices/:id/cutover` | (same) |  |  |
| 218 | POST | `/host/devices/:id/imports` | (same) |  |  |
| 219 | PUT | `/host/devices/:id/imports/:importId/users/:pin` | (same) | `memberId`, `removeAtGoLive` |  |
| 220 | POST | `/host/devices/:id/imports/:importId/mapping` | (same) | `csv` |  |
| 221 | POST | `/host/devices/:id/imports/:importId/apply` | (same) |  |  |
| 222 | POST | `/host/devices/:id/imports/:importId/rollback` | (same) |  |  |
| 223 | POST | `/host/devices/:id/imports/:importId/cancel` | (same) |  |  |
| 224 | POST | `/host/devices/:id/imports/:importId/reread` | (same) |  |  |
| 225 | POST | `/host/devices/:id/cutover/go-live` | (same) | `removeUnmatched` |  |
| 226 | POST | `/host/devices/:id/cutover/gymbiosync-stopped` | (same) |  |  |
| 227 | PUT | `/host/devices/:id/branch` | (same) | `branchId` |  |
| 228 | POST | `/host/members/:memberId/device-push` | (same) | `deviceIds` |  |
| 229 | POST | `/host/members/:memberId/device-remove` | (same) | `deviceIds` |  |
| 230 | GET | `/host/members/:memberId/device-status` | (same) |  |  |
| 231 | POST | `/host/members/:memberId/biometrics/enroll` | (same) | `deviceId`, `no`, `type` |  |
| 232 | DELETE | `/host/members/:memberId/biometrics/:bioId` | (same) |  |  |
| 233 | GET | `/host/device-push-requests/:requestId` | (same) |  |  |
| 234 | POST | `/host/branches/:branchId/device-push` | (same) |  |  |
| 235 | GET | `/host/branches/:branchId/access-events` | (same) |  |  |
| 236 | GET | `/host/payouts/balance` | (same) |  |  |
| 237 | GET | `/host/payouts` | (same) |  |  |
| 238 | POST | `/host/payouts` | (same) | `amount`, `branchId`, `idempotencyKey`, `notes` |  |
| 239 | GET | `/host/payout-account` | (same) |  |  |
| 240 | PUT | `/host/payout-account` | (same) | `details`, `idToken`, `password`, `provider`, `reauthIdToken`, `reauthProvider` |  |
| 241 | GET | `/host/expense-categories` | (same) |  |  |
| 242 | POST | `/host/expense-categories` | (same) | `name` |  |
| 243 | GET | `/host/branches/:branchId/expenses` | (same) |  |  |
| 244 | POST | `/host/branches/:branchId/expenses` | (same) | `amount`, `categoryId`, `expenseDate`, `isRecurring`, `notes`, `paymentMethod`, `receiptUrl`, `recurrenceEndDate`, `recurrenceFrequency`, `title`, `vendorName` |  |
| 245 | GET | `/host/branches/:branchId/expenses/summary` | (same) |  |  |
| 246 | GET | `/host/branches/:branchId/expenses/:expenseId` | (same) |  |  |
| 247 | PATCH | `/host/branches/:branchId/expenses/:expenseId` | (same) | `amount`, `categoryId`, `expenseDate`, `isRecurring`, `notes`, `paymentMethod`, `receiptUrl`, `recurrenceEndDate`, `recurrenceFrequency`, `title`, `vendorName` |  |
| 248 | DELETE | `/host/branches/:branchId/expenses/:expenseId` | (same) |  |  |
| 249 | GET | `/host/status` | (same) |  |  |
| 250 | GET | `/host/today-summary` | (same) |  |  |
| 251 | GET | `/host/branch-quota` | (same) |  |  |
| 252 | GET | `/host/organization-quota` | **`/host/business-quota`** |  |  |
| 253 | GET | `/host/listings` | **`/host/businesses`** |  | `[Business]`, every non-deleted business of the organization |
| 254 | POST | `/host/listings/staging-images` | **`/host/businesses/staging-images`** |  |  |
| 255 | POST | `/host/listings` | **`/host/businesses`** | `businessName` (was `gymName`), `businessDescription` (was `gymDescription`), `genderType`, `contactPhone`, `logoUrl`, `coverImageUrl`, `facilitiesJson`, `firstBranch` (A3 J8: the first branch is nested; no top-level branch keys, no `branchSource`) | Add Business (§3, A2 H2): the first branch is held until approval |
| 256 | GET | `/host/listings/:id` | **`/host/businesses/:businessId`** |  |  |
| 257 | PUT | `/host/listings/:id` | **`/host/businesses/:businessId`** | `areaId`, `areaRequestId`, `category`, `cityId`, `contactEmail`, `contactPhone`, `coverImageUrl`, `establishedYear`, `genderType`, `businessDescription` (was `gymDescription`), `businessName` (was `gymName`), `imagesJson`, `latitude`, `logoUrl`, `longitude`, `website` |  |
| 258 | PATCH | `/host/listings/:id` | **`/host/businesses/:businessId`** | `areaId`, `areaRequestId`, `category`, `cityId`, `contactEmail`, `contactPhone`, `coverImageUrl`, `establishedYear`, `genderType`, `businessDescription` (was `gymDescription`), `businessName` (was `gymName`), `imagesJson`, `latitude`, `logoUrl`, `longitude`, `website` |  |
| 259 | DELETE | `/host/listings/:id` | **`/host/businesses/:businessId`** | `cascade`, `cascadeDelete`, `idToken`, `password`, `provider`, `reauthIdToken`, `reauthProvider`, `strategy` |  |
| 260 | POST | `/host/listings/:id/reserved-slots/transfer` | **`/host/businesses/:businessId/reserved-slots/transfer`** | `count`, `toBusinessId` (was `toListingId`) |  |
| 261 | POST | `/host/branches/:branchId/restore` | (same) |  |  |
| 262 | POST | `/host/branches/:branchId/pause` | (same) |  |  |
| 263 | POST | `/host/branches/:branchId/resume` | (same) |  |  |
| 264 | GET | `/host/subscription/current` | (same) |  |  |
| 265 | GET | `/host/plan-payments` | (same) |  |  |
| 266 | POST | `/host/plan-payments` | (same) | `billingCycle`, `billingPlanId`, `method`, `payerReference` |  |
| 267 | POST | `/host/subscription/upgrade` | (same) | `newPlanId`, `planId` |  |
| 268 | GET | `/host/branches` | (same) |  |  |
| 269 | POST | `/host/branches` | (same) | `address`, `addressLine1`, `addressLine2`, `areaId`, `areaRequestId`, `branchName`, `category`, `cityId`, `closingTime`, `country`, `currency`, `description`, `establishedYear`, `facilities`, `facilitiesJson`, `floorArea`, `googlePlaceId`, `businessId` (was `gymListingId`), `hours`, `imagesJson`, `latitude`, `longitude`, `openingTime`, `packages`, `phone`, `postalCode`, `tagline`, `timezone` |  |
| 270 | GET | `/host/listings/:listingId/branches` | **`/host/businesses/:businessId/branches`** |  |  |
| 271 | GET | `/host/gyms/:gymId/branches` | — (removed) |  | duplicate of `GET /host/businesses/:businessId/branches` |
| 272 | GET | `/host/branches/:branchId/listing-content` | **`/host/branches/:branchId/public-content`** |  |  |
| 273 | PATCH | `/host/branches/:branchId/listing-content` | **`/host/branches/:branchId/public-content`** | `address`, `addressLine1`, `addressLine2`, `areaId`, `areaRequestId`, `branchName`, `category`, `cityId`, `closingTime`, `country`, `description`, `establishedYear`, `facilitiesJson`, `floorArea`, `googlePlaceId`, `hours`, `imagesJson`, `latitude`, `longitude`, `openingTime`, `phone`, `postalCode`, `tagline`, `tagsJson` |  |
| 274 | DELETE | `/host/branches/:branchId` | (same) | `confirmBusinessDeletion` (was `confirmOrganizationDeletion`), `idToken`, `password`, `provider`, `reauthIdToken`, `reauthProvider` |  |
| 275 | GET | `/host/branches/:branchId/dashboard` | (same) |  |  |
| 276 | GET | `/host/branches/:branchId/members/lookup` | (same) |  |  |
| 277 | POST | `/host/branches/:branchId/members` | (same) | `email`, `fullName`, `notes`, `paymentMethod`, `phone`, `planId`, `startDate` |  |
| 278 | GET | `/host/branches/:branchId/members` | (same) |  |  |
| 279 | GET | `/host/branches/:branchId/checkins` | (same) |  |  |
| 280 | GET | `/host/branches/:branchId/announcements` | (same) |  |  |
| 281 | POST | `/host/branches/:branchId/announcements` | (same) | `message`, `status`, `tag`, `title` |  |
| 282 | DELETE | `/host/branches/:branchId/announcements/:announcementId` | (same) |  |  |
| 283 | GET | `/host/branches/:branchId/schedule` | (same) |  |  |
| 284 | POST | `/host/branches/:branchId/schedule` | (same) | `day`, `instructor`, `maxCapacity`, `name`, `time` |  |
| 285 | PATCH | `/host/branches/:branchId/resubmit-visibility` | (same) |  |  |
| 286 | GET | `/host/inbox/inquiries` | (same) |  |  |
| 287 | POST | `/host/inbox/conversations` | (same) | `branchId`, `initialMessage`, `userId` |  |
| 288 | GET | `/host/inbox/inquiries/:inquiryId` | (same) |  |  |
| 289 | POST | `/host/inbox/inquiries/:inquiryId/reply` | (same) | `clientMessageId`, `client_message_id`, `text` |  |
| 290 | PATCH | `/host/inbox/inquiries/:inquiryId/read` | (same) |  |  |
| 291 | POST | `/host/inbox/inquiries/:inquiryId/block` | (same) |  |  |
| 292 | DELETE | `/host/inbox/inquiries/:inquiryId/block` | (same) |  |  |
| 293 | GET | `/host/inbox/blocks` | (same) |  |  |
| 294 | GET | `/membership-plans/` | (same) |  |  |
| 295 | GET | `/membership-plans/host` | (same) |  |  |
| 296 | GET | `/membership-plans/:id` | (same) |  |  |
| 297 | POST | `/membership-plans/` | (same) | `branchId`, `description`, `durationType`, `durationValue`, `freezeLimitDays`, `isPublic`, `isTrial`, `joiningFee`, `name`, `price`, `securityFee`, `visitLimit` |  |
| 298 | PATCH | `/membership-plans/:id` | (same) | `description`, `durationType`, `durationValue`, `freezeLimitDays`, `isPublic`, `isTrial`, `joiningFee`, `name`, `price`, `securityFee`, `status`, `visitLimit` |  |
| 299 | DELETE | `/membership-plans/:id` | (same) |  |  |
| 300 | POST | `/membership-plans/:id/status` | (same) |  |  |
| 301 | POST | `/membership-plans/:id/public` | (same) |  |  |
| 302 | POST | `/membership-plans/:id/featured` | (same) |  |  |
| 303 | POST | `/membership-plans/:id/poster` | (same) |  |  |
| 304 | POST | `/subscriptions/` | (same) | `autoRenew`, `branchId`, `businessId` (was `gymListingId`), `planId`, `sourceChannel` |  |
| 305 | GET | `/subscriptions/quote` | (same) |  |  |
| 306 | POST | `/subscriptions/:id/freeze` | (same) | `freezeFrom`, `freezeTo` |  |
| 307 | POST | `/subscriptions/:id/cancel` | (same) |  |  |
| 308 | POST | `/subscriptions/:id/renew` | (same) | `planId`, `startDate` |  |
| 309 | POST | `/subscriptions/:id/change-plan` | (same) | `planId` |  |
| 310 | GET | `/subscriptions/:id/detail` | (same) |  |  |
| 311 | GET | `/subscriptions/:id/refund-request` | (same) |  |  |
| 312 | POST | `/subscriptions/:id/refund-request` | (same) | `reason` |  |
| 313 | GET | `/subscriptions/:id/qr-token` | (same) |  |  |
| 314 | POST | `/subscriptions/:id/proof` | (same) |  |  |
| 315 | POST | `/subscriptions/preview` | (same) | `autoRenew`, `branchId`, `planId`, `startDate` |  |
| 316 | GET | `/subscriptions/staff` | (same) |  |  |
| 317 | GET | `/subscriptions/staff/refund-requests` | (same) |  |  |
| 318 | POST | `/subscriptions/staff/refund-requests/:requestId/decide` | (same) | `amount`, `decision`, `reason` |  |
| 319 | GET | `/subscriptions/staff/refund-policy` | (same) |  |  |
| 320 | PUT | `/subscriptions/staff/refund-policy` | (same) | `branchId`, `applyToAllBranches` (new), `refundWindowDays`, `refundsAllowed` | A1 G9 / A2 H4 |
| 321 | GET | `/subscriptions/staff/:id` | (same) |  |  |
| 322 | POST | `/subscriptions/staff/:id/activate` | (same) |  |  |
| 323 | POST | `/subscriptions/staff` | (same) | `branchId`, `notes`, `paymentMethod`, `planId`, `startDate`, `userId` |  |
| 324 | POST | `/subscriptions/staff/:id/freeze` | (same) | `freezeFrom`, `freezeTo` |  |
| 325 | POST | `/subscriptions/staff/:id/cancel` | (same) | `refund`, `refundAmount`, `refundReason` |  |
| 326 | GET | `/subscriptions/staff/:id/refund-quote` | (same) |  |  |
| 327 | GET | `/member/branches/:branchId/subscription-status` | (same) |  |  |
| 328 | GET | `/member/subscriptions/:id/upgrade-options` | (same) |  |  |
| 329 | POST | `/member/subscriptions/:id/upgrade` | (same) | `newPlanId` |  |
| 330 | GET | `/me/profile` | (same) |  |  |
| 331 | PUT | `/me/profile` | (same) | `dateOfBirth`, `fitnessGoal`, `fullName`, `gender`, `heightCm`, `phone`, `weightKg` |  |
| 332 | PATCH | `/me/profile` | (same) | `dateOfBirth`, `fitnessGoal`, `fullName`, `gender`, `heightCm`, `phone`, `weightKg` |  |
| 333 | POST | `/me/password` | (same) | `currentPassword`, `newPassword` |  |
| 334 | POST | `/me/change-password` | (same) | `currentPassword`, `newPassword` |  |
| 335 | POST | `/me/profile-image` | (same) |  |  |
| 336 | POST | `/me/profile/image` | (same) |  |  |
| 337 | GET | `/me/subscriptions` | (same) |  |  |
| 338 | GET | `/me/account-statement` | (same) |  |  |
| 339 | GET | `/me/account-statement/export` | (same) |  |  |
| 340 | GET | `/me/payment-requests` | (same) |  |  |
| 341 | POST | `/me/payment-request` | (same) | `amount`, `method`, `notes`, `subscriptionId` |  |
| 342 | POST | `/me/payment-requests/:id/proof` | (same) |  |  |
| 343 | GET | `/me/payments` | (same) |  |  |
| 344 | POST | `/me/payments` | (same) | `amount`, `method`, `notes`, `subscriptionId` |  |
| 345 | POST | `/me/payments/:id/proof` | (same) |  |  |
| 346 | GET | `/me/subscriptions/:id` | (same) |  |  |
| 347 | GET | `/me/subscriptions/:id/qr-token` | (same) |  |  |
| 348 | GET | `/me/attendance` | (same) |  |  |
| 349 | GET | `/me/biometric-consents` | (same) |  |  |
| 350 | DELETE | `/me/biometric-consents/:tenantId` | **`/me/biometric-consents/:organizationId`** |  |  |
| 351 | GET | `/me/saved-gyms` | **`/me/saved-businesses`** |  |  |
| 352 | POST | `/me/saved-gyms/:gymId` | **`/me/saved-businesses/:businessId`** |  |  |
| 353 | DELETE | `/me/saved-gyms/:gymId` | **`/me/saved-businesses/:businessId`** |  |  |
| 354 | GET | `/me/data-export` | (same) |  |  |
| 355 | GET | `/me/deletion-preflight` | (same) |  |  |
| 356 | POST | `/me/request-deletion` | (same) | `idToken`, `password`, `provider` |  |
| 357 | POST | `/me/cancel-deletion` | (same) |  |  |
| 358 | GET | `/me/inbox` | (same) |  |  |
| 359 | GET | `/me/inbox/:conversationId` | (same) |  |  |
| 360 | POST | `/me/inbox/:conversationId/reply` | (same) | `clientMessageId`, `client_message_id`, `text` |  |
| 361 | PATCH | `/me/inbox/:conversationId/read` | (same) |  |  |
| 362 | POST | `/me/inbox/:conversationId/block` | (same) |  |  |
| 363 | DELETE | `/me/inbox/:conversationId/block` | (same) |  |  |
| 364 | GET | `/me/blocks` | (same) |  |  |
| 365 | GET | `/me/staff-status` | (same) |  |  |
| 366 | GET | `/me/context` | (same) |  |  |
| 367 | GET | `/me/bootstrap` | (same) |  |  |
| 368 | GET | `/notifications/` | (same) |  |  |
| 369 | GET | `/notifications/unread-count` | (same) |  |  |
| 370 | PATCH | `/notifications/:id/read` | (same) |  |  |
| 371 | PATCH | `/notifications/read-all` | (same) |  |  |
| 372 | POST | `/notifications/read-all` | (same) |  |  |
| 373 | POST | `/notifications/token` | (same) | `appVersion`, `deviceId`, `deviceName`, `locale`, `platform`, `timezone`, `token` |  |
| 374 | DELETE | `/notifications/token` | (same) | `token` |  |
| 375 | POST | `/notifications/test-push` | (same) | `body`, `title` |  |
| 376 | POST | `/payments/` | (same) | `amount`, `branchId`, `currency`, `gatewayName`, `gatewayTransactionId`, `idempotencyKey`, `method`, `notes`, `paymentFor`, `referenceEntityId`, `shift`, `userId` |  |
| 377 | GET | `/payments/` | (same) |  |  |
| 378 | GET | `/payments/:id` | (same) |  |  |
| 379 | POST | `/payments/:id/verify` | (same) | `notes` |  |
| 380 | POST | `/payments/:id/action` | (same) | `action`, `notes`, `rejectedReason`, `shift`, `waiveJoiningFee` |  |
| 381 | GET | `/payments/:id/proof` | (same) |  |  |
| 382 | POST | `/payments/:id/proof` | (same) |  |  |
| 383 | POST | `/payments/:id/printed` | (same) |  |  |
| 384 | POST | `/payments/collection-action` | (same) | `paymentIds` |  |
| 385 | POST | `/payments/:id/refund` | (same) | `amount`, `idempotencyKey`, `reason` |  |
| 386 | GET | `/invoices/` | (same) |  |  |
| 387 | GET | `/invoices/:id` | (same) |  |  |
| 388 | POST | `/attendance/qr-scan` | (same) | `branchId`, `deviceId`, `qrCode` |  |
| 389 | POST | `/attendance/manual` | (same) | `branchId`, `notes`, `subscriptionId`, `userId` |  |
| 390 | GET | `/attendance/` | (same) |  |  |
| 391 | POST | `/attendance/device-notify` | (same) |  |  |
| 392 | GET | `/attendance/today` | (same) |  |  |
| 393 | GET | `/attendance/range` | (same) |  |  |
| 394 | GET | `/attendance/customer/:userId` | (same) |  |  |
| 395 | GET | `/attendance/report/:period` | (same) |  |  |
| 396 | GET | `/attendance/report` | (same) |  |  |
| 397 | POST | `/attendance/check-in` | (same) | `branchId`, `notes`, `subscriptionId`, `userId` |  |
| 398 | PATCH | `/attendance/:id/check-out` | (same) |  |  |
| 399 | GET | `/trainers/` | (same) |  |  |
| 400 | POST | `/trainers/` | (same) | `availabilityJson`, `bio`, `branchId`, `certificationsJson`, `specialization`, `userId`, `yearsExperience` |  |
| 401 | PATCH | `/trainers/:id` | (same) | `availabilityJson`, `bio`, `branchId`, `certificationsJson`, `specialization`, `status`, `yearsExperience` |  |
| 402 | POST | `/trainers/:id/assign` | (same) | `branchId` |  |
| 403 | POST | `/reports/` | (same) | `note`, `reason`, `targetId`, `targetType` |  |
| 404 | GET | `/reports/dashboard` | (same) |  |  |
| 405 | GET | `/reports/monthly` | (same) |  |  |
| 406 | GET | `/reports/monthly/export-pdf` | (same) |  |  |
| 407 | GET | `/reports/monthly/print-layout` | (same) |  |  |
| 408 | GET | `/reports/monthly/export` | (same) |  |  |
| 409 | GET | `/reports/yearly` | (same) |  |  |
| 410 | GET | `/reports/weekly-attendance` | (same) |  |  |
| 411 | GET | `/reports/branch/:branchId` | (same) |  |  |
| 412 | GET | `/team/meta/roles` | (same) |  |  |
| 413 | GET | `/team/meta/permissions` | (same) |  |  |
| 414 | GET | `/team/` | (same) |  |  |
| 415 | GET | `/team/audit` | (same) |  |  |
| 416 | POST | `/team/invites` | (same) | `assignToAllBranches`, `branchIds`, `email`, `fullName`, `jobTitle`, `overrides`, `phone`, `roleKey`, `scopeType`, `validFrom`, `validUntil` |  |
| 417 | GET | `/team/:assignmentId` | (same) |  |  |
| 418 | PATCH | `/team/:assignmentId` | (same) | `assignToAllBranches`, `branchIds`, `expectedVersion`, `jobTitle`, `roleKey`, `scopeType`, `status`, `validFrom`, `validUntil` |  |
| 419 | PUT | `/team/:assignmentId/permissions` | (same) | `expectedVersion`, `overrides` |  |
| 420 | DELETE | `/team/:assignmentId` | (same) |  |  |
| 421 | GET | `/approvals/` | (same) |  |  |
| 422 | GET | `/approvals/mine` | (same) |  |  |
| 423 | GET | `/approvals/policies` | (same) |  |  |
| 424 | PUT | `/approvals/policies/:actionKey` | (same) | `approverPermission`, `autoExpireHours`, `branchId`, `escalateToLevel`, `minApproverLevel`, `slaHours` |  |
| 425 | POST | `/approvals/:id/approve` | (same) | `reason` |  |
| 426 | POST | `/approvals/:id/reject` | (same) | `reason` |  |
| 427 | POST | `/approvals/:id/collect` | (same) | `method`, `notes` |  |
| 428 | POST | `/approvals/:id/cancel` | (same) |  |  |
| 429 | GET | `/actions/available` | (same) |  |  |
| 430 | POST | `/actions/:actionKey` | (same) |  |  |
| 431 | GET | `/ledger/today` | (same) |  |  |
| 432 | GET | `/ledger/open-days` | (same) |  |  |
| 433 | GET | `/ledger/day/:businessDate` | (same) |  |  |
| 434 | GET | `/ledger/weekly` | (same) |  |  |
| 435 | GET | `/ledger/monthly` | (same) |  |  |
| 436 | POST | `/ledger/:ledgerDayId/adjustments` | (same) | `amount`, `branchId`, `idempotencyKey`, `reason`, `relatedPaymentId`, `type` |  |
| 437 | GET | `/users/` | (same) |  |  |
| 438 | POST | `/users/` | (same) | `dateOfBirth`, `email`, `fullName`, `gender`, `password`, `phone`, `role` |  |
| 439 | GET | `/users/:id` | (same) |  |  |
| 440 | PUT | `/users/:id` | (same) | `dateOfBirth`, `email`, `emergencyContactName`, `emergencyContactPhone`, `fitnessGoal`, `fullName`, `gender`, `heightCm`, `medicalNotes`, `phone`, `weightKg` |  |
| 441 | POST | `/users/:id/status` | (same) | `reason`, `status` |  |
| 442 | POST | `/users/:id/password` | (same) | `newPassword` |  |
| 443 | POST | `/users/:id/profile-image` | (same) |  |  |
| 444 | GET | `/users/:id/account-statement` | (same) |  |  |
| 445 | GET | `/users/:id/account-statement/export` | (same) |  |  |
| 446 | GET | `/staff-invites/:staffId` | (same) |  |  |
| 447 | POST | `/staff-invites/:staffId/accept` | (same) | `organizationId` (was `tenantId`) |  |
| 448 | POST | `/staff-invites/:staffId/decline` | (same) | `organizationId` (was `tenantId`) |  |
| 449 | POST | `/staff/branches/:branchId/action-requests` | (same) | `actionType`, `payload` |  |
| 450 | GET | `/staff/host/branches/:branchId/action-requests` | (same) |  |  |
| 451 | POST | `/staff/host/action-requests/:requestId/approve` | (same) |  |  |
| 452 | POST | `/staff/host/action-requests/:requestId/reject` | (same) | `rejectionReason` |  |
| 453 | GET | `/staff/branches/:branchId/my-expenses` | (same) |  |  |
| 454 | GET | `/admin/devices/` | (same) |  |  |
| 455 | POST | `/admin/devices/` | (same) | `branchId`, `ipAddress`, `model`, `name`, `serialNumber`, `organizationId` (was `tenantId`) |  |
| 456 | GET | `/admin/devices/:id` | (same) |  |  |
| 457 | PUT | `/admin/devices/:id` | (same) | `ipAddress`, `name`, `status` |  |
| 458 | DELETE | `/admin/devices/:id` | (same) |  |  |
| 459 | GET | `/admin/devices/:id/members` | (same) |  |  |
| 460 | POST | `/admin/devices/:id/members` | (same) | `label`, `userId`, `zkPin` |  |
| 461 | DELETE | `/admin/devices/:id/members/:memberId` | (same) |  |  |
| 462 | GET | `/devices/` | (same) |  |  |
| 463 | POST | `/devices/` | (same) | `branchId`, `ipAddress`, `model`, `name`, `serialNumber` |  |
| 464 | PUT | `/devices/:id` | (same) | `ipAddress`, `name`, `status` |  |
| 465 | DELETE | `/devices/:id` | (same) |  |  |
| 466 | GET | `/devices/:id/members` | (same) |  |  |
| 467 | POST | `/devices/:id/members` | (same) | `label`, `userId`, `zkPin` |  |
| 468 | DELETE | `/devices/:id/members/:memberId` | (same) |  |  |
| 469 | GET | `/cron/subscription-expiry` | (same) |  |  |
| 470 | GET | `/meta/app-config` | (same) |  |  |
| 471 | GET | `/meta/error-copy` | (same) |  |  |

**New routes** (enterprise P1, new names):

| Method | Route | Note |
|---|---|---|
| GET | `/discovery/branches/:branchId` | branch detail: `{ branch, business, membershipPlans }` as §3 BranchDetail (`branch` = BranchCard keys, `business` = BusinessPublic keys without `branches`); replaces the branch-id form of `/discovery/gyms/:id` |
| POST | `/host/businesses/:businessId/kyc-documents` | body `type` (`PROOF_OF_PREMISES` / `BUSINESS_REGISTRATION`), files `documents` (enterprise D10; A2 H3) |
| GET | `/host/businesses/:businessId/kyc-documents` | business documents |
| GET | `/host/businesses/:businessId/kyc-documents/:documentId/stream` | one document (private) |
| PATCH | `/host/businesses/:businessId/first-branch` | edit the held first branch until approval (body = `FirstBranch`, A2 H2) |
| POST | `/admin/businesses/:businessId/approve` | approve the business (builds the held first branch); 422 `business_requirements_missing` |
| POST | `/admin/businesses/:businessId/reject` | body `reason` |
| POST | `/admin/businesses/:businessId/verify` | verified badge on; 422 `registration_missing` |
| DELETE | `/admin/businesses/:businessId/verify` | verified badge off |
| GET | `/admin/review-queue` | A1 G1: `{ items: [ReviewItem] }` |
| GET | `/admin/businesses/:businessId/documents` | A1 G4 |
| GET | `/admin/businesses/:businessId/documents/:documentId/stream` | A1 G4 |
| POST | `/admin/businesses/:businessId/documents/:documentId/approve` | A1 G4 |
| POST | `/admin/businesses/:businessId/documents/:documentId/reject` | A1 G4, body `reason` |

## 5. Enum values

Stored values as the API sends them. Renamed values are marked; every other value is unchanged.

| Table (new name) | Column | JSON key | Values (after) |
|---|---|---|---|
| `area_requests` | `source` | `source` | `typed`, `google_road`, `google_landmark` |
| `area_requests` | `status` | `status` | `pending_review`, `approved`, `merged`, `rejected` |
| `area_request_links` | `target` | `target` | `organization` (was `tenant`), `first_branch_draft` (was `main_branch`), `business` (was `listing`), `branch` |
| `billing_events` | `provider` | `provider` | `APPLE`, `GOOGLE`, `STRIPE` |
| `billing_events` | `status` | `status` | `RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED` |
| `billing_offers` | `discount_type` | `discountType` | `PERCENTAGE`, `FIXED_AMOUNT`, `FREE_PERIOD` |
| `billing_offers` | `platform` | `platform` | `ALL`, `IOS`, `ANDROID`, `WEB` |
| `billing_plans` | `ios_sync_status` | `iosSyncStatus` | `SYNCED`, `PENDING`, `MISMATCH`, `NOT_CONFIGURED` |
| `billing_plans` | `android_sync_status` | `androidSyncStatus` | `SYNCED`, `PENDING`, `MISMATCH`, `NOT_CONFIGURED` |
| `billing_plans` | `stripe_sync_status` | `stripeSyncStatus` | `SYNCED`, `PENDING`, `MISMATCH`, `NOT_CONFIGURED` |
| `billing_plan_price_checks` | `status` | `status` | `VERIFIED`, `MISMATCH`, `UNVERIFIABLE` |
| `capacity_events` | `action` | `action` | `BRANCH_DELETED`, `BRANCH_RESTORED`, `SLOT_TRANSFERRED`, `SLOT_TRIMMED_DOWNGRADE`, `SLOT_ATTRIBUTED_UPGRADE`, `SLOT_CONSUMED_BUILD`, `BUSINESS_DELETED` (was `ORG_DELETED`), `BUSINESS_BRANCHES_MOVED` (was `ORG_BRANCHES_MOVED`), `BRANCH_BILLING_LOCKED`, `BRANCH_BILLING_UNLOCKED` |
| `capacity_events` | `actor_type` | `actorType` | `HOST`, `ADMIN`, `SYSTEM` |
| `conversations` | `type` | `type` | `MEMBER`, `INQUIRY` |
| `devices` | `status` | `status` | `ACTIVE`, `INACTIVE` |
| `device_tokens` | `platform` | `platform` | `android`, `ios`, `web` |
| `business_listings` | `gender_type` | `genderType` | `MIXED`, `MALE_ONLY`, `FEMALE_ONLY` |
| `business_listings` | `status` | `status` | `ACTIVE`, `INACTIVE`, `PENDING`, `DRAFT`, `REJECTED` |
| `business_reviews` | `status` | `status` | `PENDING`, `APPROVED`, `REJECTED` |
| `idempotency_records` | `status` | `status` | `IN_PROGRESS`, `RESOLVED`, `FAILED` |
| `messages` | `sender_type` | `senderType` | `USER`, `HOST`, `SYSTEM` |
| `notifications` | `role` | `role` | `traveler`, `host`, `admin`, `staff` |
| `notifications` | `priority` | `priority` | `normal`, `high` |
| `otps` | `type` | `type` | `EMAIL_VERIFICATION`, `PASSWORD_RESET` |
| `platform_invoices` | `status` | `status` | `DRAFT`, `ISSUED`, `PAID`, `OVERDUE`, `CANCELLED` |
| `platform_packages` | `billing_cycle` | `billingCycle` | `MONTHLY`, `QUARTERLY`, `YEARLY` |
| `platform_packages` | `status` | `status` | `ACTIVE`, `INACTIVE` |
| `organizations` | `gender_type` | `genderType` | `MIXED`, `MALE_ONLY`, `FEMALE_ONLY` |
| `organizations` | `status` | `status` | `DRAFT`, `PENDING_REVIEW`, `UNDER_REVIEW`, `APPROVED`, `REJECTED`, `SUSPENDED`, `ACTIVE`, `PENDING_DELETION`, `DELETED` |
| `organizations` | `kyc_status` | `kycStatus` | `NOT_SUBMITTED`, `PENDING`, `APPROVED`, `REJECTED` |
| `organization_invitations` | `status` | `status` | `PENDING`, `ACCEPTED`, `EXPIRED`, `REVOKED` |
| `organization_subscriptions` | `platform` | `platform` | `MANUAL`, `IOS`, `ANDROID`, `STRIPE` |
| `organization_subscriptions` | `environment` | `environment` | `SANDBOX`, `PRODUCTION` |
| `organization_subscriptions` | `billing_cycle` | `billingCycle` | `MONTHLY`, `QUARTERLY`, `YEARLY` |
| `organization_subscriptions` | `status` | `status` | `ACTIVE`, `EXPIRED`, `CANCELLED`, `PENDING_MIGRATION`, `PENDING_CANCEL`, `SCHEDULED`, `REVOKED`, `GRACE`, `ON_HOLD`, `PAUSED` |
| `organization_subscriptions` | `payment_status` | `paymentStatus` | `PENDING`, `PAID`, `FAILED` |
| `users` | `role` | `role` | `PLATFORM_ADMIN`, `GYM_HOST`, `BRANCH_MANAGER`, `TRAINER`, `MEMBER` |
| `users` | `status` | `status` | `ACTIVE`, `INACTIVE`, `SUSPENDED`, `PENDING_DELETION`, `DELETED` |
| `member_subscription_index` | `status` | `status` | `PENDING`, `ACTIVE`, `FROZEN`, `EXPIRED`, `CANCELLED` |
| `user_organization_index` | `scope_type` | `scopeType` | `ORG`, `BRANCH` |
| `user_organization_index` | `status` | `status` | `INVITED`, `ACTIVE`, `SUSPENDED`, `REVOKED` |
| `announcements` | `status` | `status` | `draft`, `sent` |
| `approval_requests` | `status` | `status` | `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELLED` |
| `assignment_overrides` | `effect` | `effect` | `ALLOW`, `DENY` |
| `assignment_overrides` | `data_scope` | `dataScope` | `ALL`, `ASSIGNED`, `OWN` |
| `attendance_logs` | `attendance_type` | `attendanceType` | `CHECK_IN`, `CHECK_OUT` |
| `attendance_logs` | `entry_method` | `entryMethod` | `QR_SCAN`, `MANUAL`, `RFID`, `DEVICE` |
| `branches` | `status` | `status` | `ACTIVE`, `INACTIVE` |
| `branches` | `traveler_visibility_status` | `travelerVisibilityStatus` | `pending`, `active`, `deactivated` |
| `branch_visibility_histories` | `status` | `status` | `pending`, `active`, `deactivated` |
| `capacity_outbox` | `status` | `status` | `PENDING`, `PROCESSED`, `FAILED` |
| `expenses` | `payment_method` | `paymentMethod` | `cash`, `bank_transfer`, `card`, `other` |
| `expenses` | `recurrence_frequency` | `recurrenceFrequency` | `weekly`, `monthly`, `yearly` |
| `expenses` | `status` | `status` | `pending`, `approved`, `rejected` |
| `businesses` | `gender_type` | `genderType` | `MIXED`, `MALE_ONLY`, `FEMALE_ONLY` |
| `gym_staff` | `employment_status` | `employmentStatus` | `ACTIVE`, `INACTIVE`, `TERMINATED` |
| `gym_staff` | `status` | `status` | `pending`, `active`, `declined` |
| `idempotency_records` | `status` | `status` | `IN_PROGRESS`, `RESOLVED`, `FAILED` |
| `invoices` | `invoice_type` | `invoiceType` | `MEMBERSHIP`, `TRAINER`, `PRODUCT` |
| `invoices` | `status` | `status` | `DRAFT`, `ISSUED`, `PAID`, `OVERDUE`, `CANCELLED` |
| `ledger_adjustments` | `type` | `type` | `DISCREPANCY_NOTE`, `VARIANCE_ADJUSTMENT`, `REVERSAL`, `MISSED_DAY_RECONCILIATION` |
| `ledger_days` | `status` | `status` | `OPEN`, `CLOSED` |
| `member_profiles` | `gender` | `gender` | `MALE`, `FEMALE`, `OTHER` |
| `member_subscriptions` | `status` | `status` | `PENDING`, `ACTIVE`, `FROZEN`, `EXPIRED`, `CANCELLED` |
| `member_subscriptions` | `source_channel` | `sourceChannel` | `ONLINE`, `WALK_IN`, `STAFF` |
| `membership_plans` | `duration_type` | `durationType` | `DAILY`, `WEEKLY`, `MONTHLY`, `QUARTERLY`, `YEARLY` |
| `membership_plans` | `status` | `status` | `ACTIVE`, `INACTIVE` |
| `payments` | `payment_for` | `paymentFor` | `MEMBERSHIP`, `TRAINER`, `PRODUCT`, `OTHER` |
| `payments` | `method` | `method` | `CASH`, `BANK_TRANSFER`, `CARD`, `WALLET`, `ONLINE`, `POS`, `TEST` |
| `payments` | `status` | `status` | `PENDING`, `STAFF_COLLECTED`, `COMPLETED`, `FAILED`, `REFUNDED`, `EXPIRED` |
| `payouts` | `status` | `status` | `PENDING`, `APPROVED`, `PROCESSING`, `COMPLETED`, `REJECTED`, `CANCELLED` |
| `role_assignments` | `scope_type` | `scopeType` | `ORG`, `BRANCH` |
| `role_assignments` | `status` | `status` | `INVITED`, `ACTIVE`, `SUSPENDED`, `REVOKED` |
| `staff_action_requests` | `action_type` | `actionType` | `add_member`, `renew`, `change_plan`, `upgrade`, `submit_expense` |
| `staff_action_requests` | `status` | `status` | `pending`, `approved`, `rejected` |
| `trainers` | `status` | `status` | `ACTIVE`, `INACTIVE` |

Also: `role_assignments.scope_type` / Workspace `scopeType` `ORG` | `BRANCH` (unchanged, ORG = the organization);
`user_blocks.blocked_by` `USER` | **`ORGANIZATION`** (was `TENANT`); business `kycStatus`
`NOT_SUBMITTED` | `PENDING` | `APPROVED` | `REJECTED` (new); business document `type` (A2 H3)
`PROOF_OF_PREMISES` | `BUSINESS_REGISTRATION` (new); organization document type `OWNER_ID`; `missingForApproval`
items `PROOF_OF_PREMISES` | `PHOTOS_MIN_3` (new).

## 6. Error codes

Every `code` the server sends today, plus the new ones. HTTP "—" = the status is set where the error is built (`err.code` pattern) and is unchanged. Renamed codes are marked; the copy in
`src/constants/error-copy.js` (`GET /meta/error-copy`) is keyed by the new code.

| Code (after) | HTTP | Note |
|---|---|---|
| `account_over_quota` | — | |
| `account_pending_deletion` | — | |
| `action_not_allowed` | 422 | |
| `approval_pending` | — | |
| `area_alias_not_found` | 404 | |
| `area_change_not_allowed` | 422 | |
| `area_choice_conflict` | 422 | |
| `area_coordinates_invalid` | 422 | |
| `area_exists` | 409 | |
| `area_name_blocked` | 422 | |
| `area_name_invalid` | 422 | |
| `area_not_found` | 404 | |
| `area_not_listed` | 422 | |
| `area_outside_city` | 422 | |
| `area_request_decided` | 409 | |
| `area_request_not_found` | 404 | |
| `area_request_rejected` | 422 | |
| `area_similar_exists` | 409 | |
| `bank_days_lost` | — | |
| `biometric_consent_required` | 409 | |
| `branch_billing_locked` | — | |
| `branch_currency_locked` | — | |
| `branch_inactive` | 409 | |
| `branch_limit_reached` | — | |
| `branch_not_found` | 404 | |
| `branch_status_immutable_here` | — | |
| **`organization_name_blocked`** | 422 | was `brand_name_blocked` |
| **`organization_name_invalid`** | 422 | was `brand_name_invalid` |
| `cancel_needs_approval` | — | |
| `city_not_found` | 404 | |
| `city_required` | — | |
| `consent_not_found` | 404 | |
| `content_blocked` | 422 | |
| `conversation_blocked` | 403 | |
| `cooling_period_active` | — | |
| `csv_header` | 422 | |
| `csv_too_large` | 422 | |
| `deletion_window_ended` | — | |
| `device_admin` | 422 | |
| `device_disabled` | 409 | |
| `device_in_import` | 409 | |
| `device_key_unavailable` | 503 | |
| `device_not_connected` | 409 | |
| `device_not_found` | 404 | |
| `device_not_in_import` | 409 | |
| `device_wiping` | 409 | |
| `enroll_not_supported` | 409 | |
| `forbidden` | 403/— | |
| `grants_changed` | 409 | |
| **`business_not_available`** | 404 | was `gym_not_available` |
| **`branch_not_bookable`** | 409 | was `gym_not_bookable` |
| `hours_invalid` | 422 | |
| `hours_schedule_newer` | 409 | |
| `iap_subscription_active` | — | |
| `idempotency_key_required` | — | |
| `idempotency_key_reuse` | — | |
| `import_applied` | 409 | |
| `import_applied_not_live` | 409 | |
| `import_closed` | 409 | |
| `import_conflicts` | 409 | |
| `import_live` | 409 | |
| `import_not_applied` | 409 | |
| `import_not_found` | 404 | |
| `import_not_ready` | 409 | |
| `insufficient_balance` | — | |
| `invalid_amount` | — | |
| `invalid_bio_type` | 422 | |
| `invalid_consent_method` | — | |
| `invalid_credentials` | — | |
| `invalid_direction` | 422 | |
| `invalid_document_type` | 422 | |
| `invalid_idempotency_key` | — | |
| `invalid_link_mode` | 422 | |
| `invalid_membership_status` | 422 | |
| `invalid_payout_details` | — | |
| `invalid_poll_delay` | 422 | |
| `invalid_refund_amount` | — | |
| `invalid_serial_number` | 422 | |
| `invalid_strategy` | — | |
| `invalid_user_authorize` | 422 | |
| `invalid_user_command_form` | 422 | |
| `invalid_validity_mode` | 422 | |
| **`last_branch_in_business`** | — | was `last_branch_in_organization` |
| `last_visible_plan` | 422 | |
| `ledger_day_closed` | — | |
| `manual_plan_removed` | — | |
| `member_already_matched` | 409 | |
| `member_checkin_grace_expired` | — | |
| `member_entitled` | 409 | |
| `member_has_pin` | 409 | |
| `member_not_found` | 404 | |
| `multiple_currencies` | — | |
| `name_required` | 422 | |
| `no_author` | 422 | |
| `no_deletion_pending` | — | |
| `no_devices` | 409 | |
| `no_payout_destination` | 409 | |
| `not_att_device` | 422 | |
| `not_found` | 404 | |
| `not_pay_later_grace` | — | |
| `not_rejected` | — | |
| `not_reportable` | 400 | |
| **`business_has_branches`** | — | was `organization_has_branches` |
| **`business_limit_reached`** | — | was `organization_limit_reached` |
| **`business_needs_branch`** | 422 | was `organization_needs_branch` |
| `own_content` | 400 | |
| `payment_already_refunded` | — | |
| `payment_not_refundable` | — | |
| `payouts_not_available` | 404 | |
| `photo_not_found` | 404 | |
| `photos_not_checked` | 422 | |
| `pin_in_use` | 409 | |
| `pin_not_numeric` | 422 | |
| `pin_not_on_device` | 404 | |
| `place_not_found` | 404 | |
| `places_not_configured` | 503 | |
| `places_quota` | 503 | |
| `places_unavailable` | 503 | |
| `plan_not_available` | 404 | |
| `proof_missing` | — | |
| `proof_not_found` | — | |
| `provisioning_in_progress` | — | |
| `push_request_not_found` | 404 | |
| `reauth_required` | — | |
| `refund_exceeds_refundable` | — | |
| `refund_not_permitted` | — | |
| `report_closed` | 409 | |
| `request_in_progress` | — | |
| `same_branch` | 422 | |
| `serial_in_use` | 409 | |
| `serial_pairing_off` | 422 | |
| `staff_not_found` | 404 | |
| `store_bundle_mismatch` | — | |
| `store_plan_active` | — | |
| `store_subscription_active` | — | |
| `subscription_owned_by_other_account` | — | |
| `template_not_found` | 404 | |
| **`organization_not_found`** | — | was `tenant_not_found` |
| `tenant_schema_incomplete` | — | |
| `tenant_unavailable` | — | |
| `unauthorized` | — | |
| `unknown_field` | — | |
| `unlinked_user_not_found` | 404 | |
| `validation_error` | 422 | |
| `visible_plan_required` | 422/— | |
| `web_card_payments_disabled` | — | |
| `wipe_confirmation_required` | 422 | |
| **`organization_not_active`** | 409 | was `tenant_not_active` (A1 G16) |
| **`missing_organization_context`** | 400 | was `missing_tenant_context` (A1 G16) |
| `branch_delete_blocked` | 409 | unchanged (A1 G16) |
| `organization_delete_blocked` | 409 | unchanged code; raised on deleting a business (A1 G16) |
| **`first_branch_already_built`** | 409 | new (A2 H6) |
| **`business_not_approved`** | 409 | new: branch create / restore into a business that is not approved |
| **`business_requirements_missing`** | 422 | new: approve without proof of premises or 3 photos; `data.missing` |
| **`registration_missing`** | 422 | new: verify without a registration document |
| **`branch_required`** | 422 | new: refund policy without `branchId` or `applyToAllBranches` |

## 7. What each client changes

- **App, CMS, website:** every call path of §4, every key of §2, the header and claim of §1, the objects of §3, the
  enums of §5, the error codes of §6. Clients never build a business from two ids: there is one `businessId`.
- **App:** branch cards are `BranchCard`, business pages `BusinessPublic`, branch pages `BranchDetail`; Top hosts
  becomes Top businesses; no byline with an organization name; force-update screen unchanged.
- **CMS:** admin queue rows carry one `organizationId` or `businessId` (no compound id); business documents, approve,
  reject, verify routes of §4 "New routes".
- **Website:** public URLs `/gyms/[id]` and `/gyms/[id]/branches/[branchId]` stay (D-7), but the `id` is the
  `businessId` and the data comes from `/discovery/businesses/:businessId` and `/discovery/branches/:branchId`.

## 8. Out of scope (unchanged on purpose)

`GYM_HOST` role key, `isHost`, `businessDate` (accounting day), `traveler*` spelling in keys and values,
`facilitiesJson` / `imagesJson` / `kycDocumentsJson` key style, R2 URL prefixes, `/health/tenant-schema` (tenant
database mechanism), `tenant_unavailable` / `tenant_schema_incomplete` codes (mechanism; `tenant_not_active` and `missing_tenant_context` are renamed by A1 G16), device protocol routes
(`/iclock…`, `cutover/gymbiosync-stopped`: a product name), legacy device routes `/devices…`, `/admin/devices…`.

## 10. Amendment A1 (owner, 2026-11-22, final)

Where this section and §1-§8 differ, this section wins. Items G1-G16 are the owner's numbering (G12-G14 were not
issued).

### G1. Admin organization list and review queue

- `GET /admin/organizations` (was `GET /admin/tenants`) → `{ organizations: [Organization], page, total }`.
- **New** `GET /admin/review-queue` → `{ items: [ReviewItem] }`. One item per organization waiting for identity
  review and one per business waiting for approval (replaces the compound `tenantId:listingId` rows, F7):

| Key | Value |
|---|---|
| `kind` | `ORGANIZATION` \| `BUSINESS` |
| `organizationId` | always |
| `businessId` | `BUSINESS` items only (absent on `ORGANIZATION` items) |
| `name` | organization name (`ORGANIZATION`) or business name (`BUSINESS`) |
| `status` | the organization's or the business's `status` |
| `kycStatus` | the organization's or the business's `kycStatus` |
| `submittedAt` | when it was submitted for review (organization: finalize; business: `kycSubmittedAt`, else creation) |

### G2. Organization detail

`GET /admin/organizations/:organizationId` → `{ organization: Organization, businesses: [Business], ... }`: the
organization's businesses are listed under **`businesses`** (each a §3 Business, with its own `id`).

### G3. Admin business wrapper

`GET /admin/businesses/:businessId` and `PATCH /admin/businesses/:businessId` → `{ business: Business }` (was
`{ gymListing }`).

### G4. Admin business documents

| Method | Route | Answer / body |
|---|---|---|
| GET | `/admin/businesses/:businessId/documents` | `{ documents: [KycDocument] }` (item shape: A2 H3) |
| GET | `/admin/businesses/:businessId/documents/:documentId/stream` | the file (private) |
| POST | `/admin/businesses/:businessId/documents/:documentId/approve` | — → `{ document }` |
| POST | `/admin/businesses/:businessId/documents/:documentId/reject` | body `reason` → `{ document }` |

Document `status`: `PENDING` \| `APPROVED` \| `REJECTED`. Approving a `BUSINESS_REGISTRATION` document is what the
verified badge reads (enterprise D11); `POST/DELETE /admin/businesses/:businessId/verify` stay.

### G5. Business quota

`GET /host/business-quota` → `{ pool: { max, used, reserved, free }, canAddBusiness, blockingBusinessStatus }`.
`canAddBusiness` (bool): a unit is free in the organization pool (or can be transferred) and no business blocks it.
`blockingBusinessStatus`: `null`, or the `status` of the business that blocks adding another (for example
`PENDING` while one is under review, if that rule applies), so the app can say why. Replaces the per-business keys of
§3 BranchQuota for this route.

### G6. Branch delete answer

`organizationDeleted` → **`businessDeleted`** (true when deleting the last branch also deleted its business).

### G7. Two more keys

`tenantName` → **`organizationName`** (admin billing events, `billing-event.service.js:321`); `gymTitle` →
**`businessName`** (data export saved items `data-export.service.js:134`; review lists `discovery.service.js:1067`).

### G8. Capacity audit

`GET /admin/organizations/:organizationId/capacity-audit` → `audit`: `listings` → **`businesses`**,
`driftedListings` → **`driftedBusinesses`** (each row keyed `businessId`); also, as the same rename,
`emptyActiveOrgs` → `emptyActiveBusinesses`, `hasEmptyActiveOrgs` → `hasEmptyActiveBusinesses`;
`tenantId` → `organizationId`, `businessName` → `organizationName` (§2).

### G9. Refund policy

- `GET /subscriptions/staff/refund-policy?branchId=` → `{ branchId, refundsAllowed, refundWindowDays }` (as §3).
- `GET` **without** `branchId` → `{ branches: [{ branchId, branchName, businessId, refundsAllowed,
  refundWindowDays }] }`, every non-deleted branch the caller can see (replaces the 422 `branch_required` on GET).
- `PUT` takes `branchId` **or** `applyToAllBranches: true`, with `refundsAllowed` and `refundWindowDays`; neither id →
  422 `branch_required` (PUT only). Answers as §3.

### G10. Payout account scope

`scope`: **`ORGANIZATION`** (organization-wide account) \| **`BUSINESS`** (one business; `businessId` set).
Today the values are `TENANT` (organization-wide) and `ORGANIZATION` (one business, `payout-account.service.js:49`),
so **`ORGANIZATION` changes meaning**: clients map by the new table, never by the old word.

### G11. Notification deep links (every string the server sends, new names)

| Before | After | Sent by |
|---|---|---|
| `/traveler/subscriptions` | (same) | subscription events (6) |
| `/traveler/inbox` | (same) | chat (3) |
| `/traveler/staff-invite-confirmation?staffId=<id>&tenantId=<id>` | `/traveler/staff-invite-confirmation?staffId=<id>&organizationId=<id>` | staff invite |
| `/host/subscriptions` | (same) | GymsEra plan events (5) |
| `/host/listings` | **`/host/businesses`** | business approval / rejection (4) |
| `/host/profile` | (same) | (3) |
| `/host/branches` | (same) | (3) |
| `/host/today` | (same) | (2) |
| `/host/devices` | (same) | access devices (2) |
| `/host/inbox` | (same) | chat |
| `/host/gyms/<branchId>/staff` | **`/host/branches/<branchId>/staff`** | staff joined / left (2) |
| `/host/gyms/<branchId>/staff-requests` | **`/host/branches/<branchId>/staff-requests`** | staff requests (2) |
| `/host/gyms?tab=subscriptions&filter=PENDING&subscriptionId=<id>` | **`/host/operations?tab=subscriptions&filter=PENDING&subscriptionId=<id>`** | member subscription to approve (the host tab shown as "Gyms" today; identifiers never "gym", D-7) |
| `/staff/dashboard` | (same) | (4) |
| `/admin/tenants/<id>` | **`/admin/organizations/<organizationId>`** | admin alerts (2) |
| `/admin/plan-payments` | (same) | plan payment requests |
| `/notifications` | (same) | generic |

New with the enterprise model: `/host/businesses/<businessId>` (business approved / needs changes / verified).
No other deep link is sent; a test lists them (server work).

### G15. Area-request groups (admin, `GET /admin/area-requests`)

Each group: `gyms` → **`businesses`**, `gymCount` → **`businessCount`**; inside each item `title` → **`name`**
(the organization, business or branch name waiting on the area; `listingId` → `businessId`, `tenantId` →
`organizationId` by §2).

### G16. Error codes

| Code | HTTP | Note |
|---|---|---|
| **`organization_not_active`** | 409 | was `tenant_not_active` (`tenantContext.js:326`, `plan-payment.service.js:118`) |
| **`missing_organization_context`** | 400 | was `missing_tenant_context` (`tenantContext.js:331`) |
| `branch_delete_blocked` | 409 | unchanged |
| `organization_delete_blocked` | 409 | unchanged code (owner); raised when **deleting a business** whose branches cannot be deleted (`gym.service.js:1419,1449`); `data.businessId` (was `listingId`) |

## 11. Amendment A2 (owner, 2026-11-22, final)

Where this section and earlier sections differ, this section wins (except H5, where §3 wins by the owner's word).

### H1. Notification types (`notifications.type`, push `data.type`)

| Before | After | When |
|---|---|---|
| `tenant_approved` | **`organization_approved`** | admin approves the organization (`admin.service.js:474`) |
| `tenant_rejected` | **`organization_rejected`** | admin rejects it (`:596`) |
| `tenant_suspended` | **`organization_suspended`** | admin suspends it (`:631`) |
| metadata `event: 'tenant_status_updated'` | **`organization_status_updated`** | every organization status change (`metadataJson.event` on the four rows above; key `tenantId` → `organizationId`, §2) |
| `tenant_reactivated` | **`organization_reactivated`** | admin reactivates it (`:684`); final (A3 J1) |
| `tenant_submitted_review` | `organization_submitted_review` | to admins, on finalize (`tenant.service.js:404`); follows §2 |
| `listing_approved` / `listing_rejected` | `business_approved` / `business_rejected` | business approval (`admin.service.js:391,534`); deep link `/host/businesses/<businessId>` (A1 G11); follows §2 |

Every other type is unchanged.

### H2. `FirstBranch` schema

The branch-create body of `POST /host/branches` **without `businessId`** (the business it belongs to is the one
being created or the one in the path). Used as `firstBranch` in `POST /host/businesses` and as the whole body of
`PATCH /host/businesses/:businessId/first-branch`.

| Key | Type | Rule (enterprise D8) |
|---|---|---|
| `branchName` | string | required |
| `cityId` | int | required |
| `areaId` / `areaRequestId` | int | exactly one required |
| `address`, `addressLine1`, `addressLine2`, `postalCode`, `country` | string | `address` required |
| `googlePlaceId` | string | optional |
| `latitude`, `longitude` | number | required (map pin) |
| `phone` | string | required |
| `hours` | WeeklyHours (R-113) | optional; default every day 06:00–22:00. `openingTime` / `closingTime` accepted as the one-slot form |
| `timezone`, `currency` | string | optional (server defaults) |
| `tagline`, `description`, `category` | string | optional |
| `establishedYear`, `floorArea` | int | optional |
| `facilitiesJson` | string[] | optional (one amenity list; `facilities` is accepted as the same list) |
| `imagesJson` | string[] (URLs from `POST /host/businesses/staging-images`) | **at least 3** |
| `packages` | MembershipPlan create bodies | at least 1 |

`PATCH /host/businesses/:businessId/first-branch`: any subset of the keys; allowed only while the business is not
approved (409 `business_not_approved` is not used here; after approval the branch is a real branch: 409
`first_branch_already_built`). Answer `{ business: Business }` with `firstBranchDraft` updated.

**Add Business body** (replaces §3 "Add Business request"): `businessName` (required), `businessDescription`,
`genderType`, `contactPhone`, `logoUrl`, `coverImageUrl`, `facilitiesJson`, **`firstBranch: FirstBranch`**
(required). Top-level branch keys are no longer accepted. Answer unchanged: `{ business, branch: null,
heldFirstBranch: true }`.

### H3. Business `kycDocuments` item

`kycDocuments: [{ id, type, status, uploadedAt, reviewedAt, rejectionReason }]` on Business (host and admin views).

| Key | Value |
|---|---|
| `type` | `BUSINESS_REGISTRATION` (optional; drives the verified badge) \| `PROOF_OF_PREMISES` (required for approval) |
| `status` | `PENDING` \| `APPROVED` \| `REJECTED` |
| `uploadedAt`, `reviewedAt` | ISO date-time; `reviewedAt` null until reviewed |
| `rejectionReason` | string or null |

No storage keys, file names or URLs are sent; the file is read only through the `…/stream` routes. The same item
shape is used by `GET /host/businesses/:businessId/kyc-documents` and by the admin `GET
/admin/businesses/:businessId/documents` (A1 G4: `documentType` → `type`; `originalName` removed). Upload body key:
`type` (was `documentType`).

### H4. Refund policy route

`PUT /subscriptions/staff/refund-policy` body keys: `branchId`, **`applyToAllBranches`**, `refundsAllowed`,
`refundWindowDays` (§4 row 320 corrected). Rules as A1 G9.

### H5. Branch detail (§3 wins)

`GET /discovery/branches/:branchId` → `{ branch, business, membershipPlans }`: `branch` has the BranchCard keys,
`business` the BusinessPublic keys without `branches`, `membershipPlans` the plans sold at this branch (§3
BranchDetail). The "New routes" row of §4 now says the same.

### H6. Error code

| Code | HTTP | Note |
|---|---|---|
| **`first_branch_already_built`** | 409 | new: `PATCH …/first-branch` after the business was approved (H2) |

## 12. Amendment A3 (owner, 2026-11-23, final)

Where this section and earlier sections differ, this section wins.

### J1. `organization_reactivated`

Notification type `tenant_reactivated` → **`organization_reactivated`** (A2 H1 had it as "owner may rename"; now final).

### J2. List keys

| Route | Items under | Was |
|---|---|---|
| `GET /discovery/branches`, `/branches/featured`, `/branches/top-rated`, `/branches/nearby`, `/branches/map` | **`branches`** | `gyms` |
| `GET /discovery/businesses/:businessId/branches` | **`branches`** (the duplicate `gyms` key is removed) | `gyms` + `branches` |
| `GET /host/branches`, `GET /host/businesses/:businessId/branches`, `GET /organizations/me/branches` | **`branches`** | (as today) |
| `GET /me/saved-businesses` | **`businesses`** (each the BusinessPublic keys of §3 without `branches`: `id` = `businessId`, `name`, `description`, `logoUrl`, `coverImageUrl`, `city`, `area`, `facilitiesJson`, `businessVerified`, …) | `gyms` |
| `GET /discovery/businesses` | `businesses` (§2) | `organizations` |

### J3. My subscriptions

`GET /me/subscriptions` → `{ memberships: [MemberSubscriptionSummary] }`, each row: `id`, `organizationId`, `businessId`,
**`branchId`**, `businessName`, `subscriptionId`, `planName`, `startDate`, `endDate`, `status`. `branchId` and `businessId`
are new on the row (today the index has no branch). **Server note:** `member_subscription_index` gets a `branch_id` column
(new migration, written with the subscription; rows of a database created before it are filled from the tenant
`member_subscriptions` row); tracked in NEW-312.

### J4. Error table

`branch_delete_blocked` (409) and `organization_delete_blocked` (409) are in the §6 table and in §10 G16; both are
listed again here as the owner asked. `data` for `branch_delete_blocked`: `{ branchId, branchName, counts, reasons, canPause }`;
for `organization_delete_blocked`: `{ businessId, branches, canPause }` (a business whose branches cannot be deleted).

### J5. HostStatus area

`GET /host/status` key is **`area`** (null, or the pending / rejected area request of the organization or its draft first
branch, as `hostStatusArea` sends it today), **not** `pendingArea`. §3 HostStatus is corrected. (`pendingArea` stays on
Organization and Business objects, where the server sends it.)

### J6. Inbox conversations

Every conversation (`GET /host/inbox/inquiries`, `GET /host/inbox/inquiries/:inquiryId`, `GET /me/inbox`, `GET /me/inbox/:conversationId`) nests
**`business { id, name }`** (was `gymListing { id, title, logoUrl, branchId }`) and **`branchName`**. The conversation's own
`branchId` and `organizationId` stay. `logoUrl` is no longer sent inside `business` (owner's shape; ask if a client needs it).

### J7. Staff roles are scoped ORG or BRANCH

A staff role is a `role_assignments` row: `scopeType` **`ORG`** (the whole organization, every branch of every business,
including ones created later) or **`BRANCH`** (the branches listed in `role_assignment_branches`). A response never shows
one business or branch name where the scope is a list.

**`GET /me/staff-status`** → `{ isStaff, organizations: [StaffOrganization] }` (was a flat `branches` list):

| Key | Value |
|---|---|
| `organizationId` | |
| `organizationName` | the organization's name (was `gymName` on each branch) |
| `scopeType` | `ORG` \| `BRANCH`. With several assignments in the organization: `ORG` if any is `ORG`, else `BRANCH` |
| `roleKey` | the highest-level role among the user's active assignments there |
| `designation` | job title, else the role's display name (as today) |
| `branches` | `[{ branchId, branchName, businessId, businessName }]`: **empty for `ORG`**; for `BRANCH` the union of the linked branches that are ACTIVE |

`isStaff` is true when the list is not empty. The client lists an `ORG` user's branches from `GET /me/context`.

**`GET /staff-invites/:staffId`** → `{ staff, organization { id, name }, scopeType, roleKey, branches, host }`
(replaces `branch { id, name }` and `gym { id, name }`); `branches` has the same item shape and is empty for `ORG`. An
invite from the legacy `gym_staff` row has one branch (`scopeType` `BRANCH`, `branches` of length 1). Accept and decline
bodies take `organizationId` (was `tenantId`).

### J8. Add Business

`POST /host/businesses` takes the business fields plus **`firstBranch`**; the schema is the one of `PATCH
/host/businesses/:businessId/first-branch` (A2 H2: `FirstBranch`; the PATCH takes any subset of it). Body keys:
`businessName`, `businessDescription`, `genderType`, `contactPhone`, `logoUrl`, `coverImageUrl`, `facilitiesJson`,
`firstBranch`. §4 row 255 corrected.

### J9. Report only (not changed): staff and role responses that show one name where the scope can be a list

| Response | What it shows | Observation |
|---|---|---|
| `GET /team`, `GET /team/:id` rows (`team.service.js#serializeAssignment`) | `branches: [{ id, name }]` | A list, as it should be, but items lack `businessId` / `businessName` and use `id` / `name`, not the J7 item shape |
| `GET /me/context` `organizations[].branches` (`context.controller.js:56-70`) | `{ id, name, permissions, scopes }` per branch | A list; no `businessId` / `businessName`; `name` is the branch name |
| Approval requests (`approvals.controller.js:48`, `approval.service.js:417,432`) | `branch { id, name }` or null | One branch is correct (a request is made at one branch); `null` means organization-wide |
| `GET /gyms/staff`, `GET /gyms/branches/:branchId/staff` (legacy `gym_staff`) | one row per (person, branch), `branch` single | Scope is represented by several rows; no `scopeType` / `roleKey` (legacy table, F5, deferred) |
| Team welcome e-mail and "You're now {role} at {gymName}" notification (`team.service.js:338-346,752`) | the organization name in `gymName`, branches as text in `scopeText` | Correct, but the payload key `gymName` follows §2 → `organizationName` |
| Approval notification text (`approval.service.js:465`) | "at {branchName}" or "your gym" | One branch for a one-branch request; "your gym" for organization-wide requests (copy only) |

## 9. Change log

| Date | Change | By |
|---|---|---|
| 2026-11-22 | Frozen (R-120). | Claude Code (Opus 5.5), session 166 |
| 2026-11-22 | Amendment A1 (§10, owner G1-G11, G15, G16): admin list and review queue, organization detail, business wrapper, admin business documents, business quota, `businessDeleted`, `organizationName` / `businessName` for `tenantName` / `gymTitle`, capacity audit keys, refund-policy list, payout scope values, deep links, area-request groups, error codes. | Claude Code (Opus 5.5), session 166 |
| 2026-11-22 | Amendment A2 (§11, owner): notification types `organization_*`, `FirstBranch` schema and nested Add Business body, business `kycDocuments` item (no storage keys; admin documents use it), `applyToAllBranches` on the refund-policy PUT, branch detail aligned with §3; new code `first_branch_already_built`. | Claude Code (Opus 5.5), session 166 |
| 2026-11-23 | Amendment A3 (§12, owner): `organization_reactivated`; list keys `branches` / `businesses`; my-subscriptions rows with `branchId` + `businessId`; error-table rows listed; HostStatus key `area`; inbox `business { id, name }` + `branchName`; staff roles scoped ORG / BRANCH (`/me/staff-status`, staff invite) with the report of other responses; Add Business nested `firstBranch`. | Claude Code (Sonnet 5.5), session 166 |


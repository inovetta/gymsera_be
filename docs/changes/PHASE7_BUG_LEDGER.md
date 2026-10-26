# Phase 7 — P0 bug ledger (intake and verification, no code changed)

Date: 2026-10-24. Agent: Claude Code (Opus 5.5). Source: `docs/GYMSERA_PRODUCTION_FIX_PROMPTS.md` §4 and the owner's four flow images (Become a Host, Host area unpaid, Host area approved, Traveller area).

Code read at: gymsera_be `dbc7707` (origin/main), gyms_era `57cb2a0` (origin/master), gymsera_cms `f4699e7` (origin/main), gymsera_web `3c99802` (origin/main). Paths below are relative to each repo (`be/`, `app/`, `cms/`, `web/` prefixes).

**How each bug was checked:** code trace with file:line only. No test, script, device or database query was run in P0. "VERIFIED" means the trace shows the defect; P1–P9 must still write the failing test first (Prompt G rule 2). "NEEDS DEVICE / DATA / LOG" means the code does not explain the screenshot on its own.

## Summary

| Status | Count | Bugs |
|---|---|---|
| VERIFIED | 31 | 01, 02, 04–09, 12–20, 24–27, 29, 31–35, 37, 38 |
| VERIFIED, cause differs from the ledger text | 2 | 10 (two different *store* prices), 16 (server privilege escalation, not only a cache) |
| VERIFIED in part, rest NEEDS DEVICE / DATA | 4 | 03, 11, 21, 22 |
| NEEDS SERVER LOG | 1 | 23 |
| NEEDS DATA | 1 | 28 |
| NOT REPRODUCED in code (probably data) | 1 | 30 |
| Feature, no code exists yet | 1 | 36 |
| Already fixed | 0 | (NEW-104 left one invented "(124)" in the wishlist, see BUG-27) |

Severity changes: **BUG-16 stays P0 and is wider than reported** (any host can get owner rights in another gym, see below). BUG-34 is raised to P0 (money: the screen asks for more than the server records). New P0: NEW-108. New P1s: NEW-109 to NEW-114.

## Ledger

| BUG | Status | Root cause (file:line) | Repos | Prompt | Risk |
|---|---|---|---|---|---|
| 01 | VERIFIED | City and area are `DropdownButtonFormField`s fed by our `GET /cities` and `GET /cities/:id/areas`: `app/lib/features/host_onboarding/presentation/screens/location_screen.dart:148,204,300`, `app/lib/features/cities/data/repositories/cities_repository.dart:19-35`, `be/src/controllers/cities.controller.js:6-21`. Same in CMS branch form (`cms/src/app/(dashboard)/gym/branches/page.tsx:35,215`). | app, be, cms | P3 | Medium (new Google dependency, keys, billing) |
| 02 | VERIFIED | The "map" is a fixed Unsplash photo with a centred pin and a hard-coded "Gym Location Selected" label: `app/.../listing_step2_screen.dart:299-360` (URL at :308). `google_maps_flutter` is in `pubspec.yaml:52` but unused here. | app | P3 | Low |
| 03 | VERIFIED in part, NEEDS DEVICE | `_useCurrentLocation` (`listing_step2_screen.dart:44-147`) sets lat/lng and fills the address only when the device reverse-geocoder answers; a geocoder failure is swallowed (:124-126) and the screen still says "Location and address updated from GPS!" (:128-133). City and area are never filled. Before the button is used, lat/lng default to a hard-coded Peshawar point (:27-29, "Mock coordinates"), which is saved if the host never taps it (see NEW-111). | app | P3 | Medium |
| 04 | VERIFIED | Address is a plain `TextFormField` (`listing_step2_screen.dart:399-411`); no autocomplete anywhere. | app, cms | P3 | Low |
| 05 | VERIFIED | Client: the "Show to Travellers" switch is free on every plan (`app/lib/features/membership_plans/presentation/widgets/create_or_edit_plan_dialog.dart:638-697`); onboarding only checks `plans.isEmpty` (`listing_step5_screen.dart:27,578`). Server: onboarding submit checks only plan count (`be/src/services/tenant.service.js:263`); `_validateRemainingPlansForBranch` (`be/src/services/membership-plan.service.js:350-371`) runs only when the branch is ACTIVE, answers 400 without a code, and `createPlan` defaults `isPublic` to **false** (:341). CMS has no visibility control at all (NEW-112). | app, be, cms | P4 | Medium (existing branches may already have zero visible plans) |
| 06 | VERIFIED | Literal "GymConnect": `app/.../become_host_landing_screen.dart:115,193`, `listing_step3_screen.dart:65`, `listing_step4_screen.dart:84`, `listing_step5_screen.dart:139`, and the traveller Home header `app/lib/features/discovery/presentation/screens/home_screen.dart:344`. CMS and web: none. | app | P8 | Low |
| 07 | VERIFIED | Invented stats and city: `become_host_landing_screen.dart:291` ("Peshawar and beyond"), :326-334 ("12k+ active users"), :365-373 ("98% growth"), :397 ("24/7"). | app | P8 | Low (store-review risk) |
| 08 | VERIFIED | Location screen has no step label (`location_screen.dart`); steps 1–5 say "Step N of 5" (`listing_step1_screen.dart:155`, step2 :262, step3 :79, step4 :109, step5 :153) and step 4 also says "80% Complete" (`listing_step4_screen.dart:117`). The Location screen comes before step 1 but is not counted, and the owner's capture of the plan modal is labelled "Step 5" while the list screen says "Step 5 of 5". One stepper with Location counted would be 6 steps. | app | P8 | Low |
| 09 | VERIFIED | Hard-coded "PKR": `create_or_edit_plan_dialog.dart:448-450`, plan card `listing_step5_screen.dart:332`. CMS: `cms/src/app/(dashboard)/gym/plans/page.tsx:368`, `cms/src/app/(dashboard)/gym/payments/page.tsx:611,752`. | app, cms | P4 | Low |
| 10 | VERIFIED, cause differs | Both prices in the images are **store** prices: the Become-a-Host capture is Android (Play, Pakistan account → "Rs 2,000.00"), the unpaid-host capture is iOS (App Store US sandbox → "$6.99"). Both screens call the same `displayPrice` (`app/lib/features/billing/presentation/providers/billing_provider.dart:238-243`). The real code defect is the fallback at :241-242: when the store product has not loaded it shows the catalog price (`PKR 2000`), so one device can show catalog then store. Needs D4 and a Pakistan sandbox tester to confirm. | app (cms/web show catalog) | P2 | Low |
| 11 | VERIFIED in part, NEEDS DEVICE | Two causes found. (a) `GET /host/today-summary` reads only the JWT's `tenantId` (`be/src/controllers/host.controller.js:41`) and `authorize('GYM_HOST')` reads the JWT role (`be/src/routes/host.routes.js:34`); a token issued before the traveller became a host carries `role: MEMBER`, `tenantId: null` (`be/src/services/auth.service.js:168-192`) until a refresh. (b) `hostTodaySummaryProviderNew` (`app/lib/features/host/presentation/providers/host_providers.dart:17`) is not autoDispose and is **not** reset in `resetIdentityScopedCache` (`app/lib/core/utils/session_cache.dart:39-75`) and nothing refetches it when the tenant changes state, so a stale "A"/empty answer stays until reload. Also: if the tenant DB connection fails the server answers state "B" + `APPROVED` (`host.controller.js:70-77`), which the app renders as the full dashboard with no data (`host_today_screen.dart:130-132`). | be, app | P2 | Medium |
| 12 | VERIFIED | `_checkIsUnderReview` returns true for summary state "A" (DRAFT, i.e. unpaid/unsubmitted) as well as "B" (`app/lib/features/host/presentation/screens/host_gyms_overview_screen.dart:362-392`, check at :384; same check at :454), so a DRAFT host sees "Application Under Review … Once approved by the admin" (:696-709). The same copy is hard-coded in `add_staff_screen.dart:118`, `add_admin_screen.dart:117`, `staff_management_screen.dart:145,259`, `admin_management_screen.dart:157,276`, `invoices_screen.dart:343,436`. No server field says "payment due". | app, be | P2 | Low |
| 13 | VERIFIED | "Verified ✓" is a constant (`app/lib/features/host/presentation/screens/host_profile_screen.dart:365-384`); not read from `kycStatus` or the tenant status. | app | P2 | Low |
| 14 | VERIFIED | Unpaid host's tenant is DRAFT. `tenantContext` resolves only ACTIVE tenants (`be/src/middleware/tenantContext.js:46-52` `loadActiveTenant`), so JWT, header and branch steps all fail, step 4 returns null for a host with no other membership, and the middleware answers 400 `missing_tenant_context` with the raw developer sentence (:294-300). The app shows `error.message` verbatim (`app/lib/core/utils/error_handler.dart:4-23` via `ErrorStateView`, `app/lib/core/widgets/state_views.dart:36-38`). Analytics calls `yearlyRevenueProvider` → `/reports/*` behind `tenantContext` (`app/lib/features/host/presentation/screens/analytics_screen.dart:19`). | be, app, cms | P1 | Low |
| 15 | VERIFIED | Same path as BUG-14 via `GET /team` (`be/src/routes/team.routes.js:16,55`); app `team_access_screen.dart:66`. The CMS keeps the server's sentence for generic codes too (`cms/src/lib/team/access.ts:212-219`). | be, app, cms | P1 | Low |
| 16 | **VERIFIED (code trace), P0, wider than reported** | See "BUG-16 trace" below. Server: a user with account role `GYM_HOST` gets **owner grants in any tenant `tenantContext` resolves to**, and `tenantContext` accepts tenants where the user is only a traveller (member). Client: several host providers survive logout. | be, app, cms, web | P1 | **High** (cross-tenant read and write) |
| 17 | VERIFIED | "Switch to Traveler" `host_today_screen.dart:278`; "Switch to Traveling" `host_profile_screen.dart:254`; "Switch to Traveler Mode" `host_profile_screen.dart:490`; "Yes, switch to Traveler" `switch_to_traveler_sheet.dart:74`; "Host Mode" / "Switch to Host Mode" `app/lib/features/me/presentation/screens/profile_screen.dart:122,354`, `settings_screen.dart:535`. Spelling also mixes "Traveler" and "Traveller". | app | P8 | Low |
| 18 | VERIFIED | "Gym Companies: $used / $max (your plan)" and "Limit reached" are shown regardless of payment (`app/lib/features/host/presentation/screens/listings_overview_screen.dart:1226,1243`); for an unpaid host the server's organization quota defaults to 1 (`be/src/controllers/host.controller.js:227-235`). | app, be | P2 | Low |
| 19 | VERIFIED | Today cards open routes that live in the **Gyms** shell branch (`/host/gyms/:id/dashboard?tab=…`, `host_today_screen.dart:458,479,493,507,754`), so `push` switches tab and Back pops inside Gyms; with no selected branch they call `context.go('/host/gyms')` (:343,436,460,481,495,509,758), which replaces the stack. Router: shell branches at `app/lib/core/router/app_router.dart:547-830`. | app | P5 | Medium |
| 20 | VERIFIED | "+12.4%" literal (`host_today_screen.dart:566`); the New Subs card always gets a `trending` icon (:517, :908-910). | app | P5 | Low |
| 21 | VERIFIED in part, NEEDS DATA | Two counts with different meanings: the banner uses tenant-wide `usedBranches` (includes paid unbuilt `reservedSlots`) while each organization chip uses ACTIVE branches with `gymListingId = org` (`be/src/services/branch-quota.service.js:36-45`); errors are swallowed to zeros (:47-49). The branch list provider turns any error into an empty list (`app/.../host_providers.dart:99-108`) and the list endpoint is `GET /host/branches` (`be/src/routes/host.routes.js:57`). Which of these hit "savayora" needs a read-only query of that tenant's `branches.status`, `branches.gym_listing_id` and `gym_listings.reserved_slots`. | be, app, cms | P5 | Medium |
| 22 | VERIFIED (header), flows NEEDS DEVICE | Header literal "Host Dashboard" on My Listings (`listings_overview_screen.dart:62`). New / Edit / Delete Organization and "Move an existing branch" need a device walk on an approved tenant (routes `/host/organizations/new-source`, `/host/organizations/:orgId/edit`, `app_router.dart:947-1023`). | app | P5 | Medium |
| 23 | NEEDS SERVER LOG | The text comes from the generic Sequelize `DatabaseError` mapper (`be/src/middleware/errorHandler.js:40-47`); the detail is hidden in production. `GET /team` runs `RoleAssignment.findAll` with two includes and a platform `users` read (`be/src/services/team.service.js:74-131`); `/team/meta/roles` and `/team/meta/permissions` also load on that screen. The API log line for request id `c5d4dd12-43e5-4105-8eb7-90c925c99d4d` names the failing SQL. | be | P1 | Medium |
| 24 | VERIFIED | "Growth Plan" is a constant (`host_profile_screen.dart:389-396`). The tier table that does exist is `_friendlyName` in `app/lib/features/billing/presentation/screens/branch_plan_picker_screen.dart:70-75` (1 = Starter, ≤4 Professional, ≤7 Growth, else Scale); the CMS/backend have no shared table. | app, be, cms | P2 | Low |
| 25 | VERIFIED | Inbox header avatar is a fixed Unsplash portrait (`app/lib/features/host/presentation/screens/inbox_screen.dart:123`). | app | P5 | Low |
| 26 | VERIFIED | `GET /discovery/cities` returns **every** active city with `gymCount` (0 included) (`be/src/services/discovery.service.js:508-527`). "Live" today means tenant ACTIVE + branch ACTIVE only; no subscription-entitlement or visible-plan check in `_getAllActiveBranches`. Web uses the same endpoint (`web/src/lib/api/discovery.ts:46`). | be, app, web | P6 | Medium |
| 27 | VERIFIED | "(124)" literal: `home_screen.dart:983,1241`, `wishlist_screen.dart:179` (left after NEW-104), `search_results_screen.dart:31` (dead list). Server sends `averageRating: ratingMap.get(b.id) \|\| 0` and no review count (`discovery.service.js:158`), so no-review gyms print "0.0" (`gym_detail_screen.dart:323`, `organization_overview_screen.dart:112,219`, web `gym-card.tsx:85-86`, `gyms/[id]/page.tsx:236`). | be, app, web | P6 | Low |
| 28 | NEEDS DATA | Branch cards take `b.imagesJson[0]` else listing cover (`discovery.service.js:156,165`). Likely cause for org-level cards: the listing's `coverImageUrl`/`logoUrl` are copied from `tenant.coverImageUrl` at approval (`be/src/services/tenant-provisioning.service.js:372-380`), but onboarding photos live in `mainBranchDataJson.imagesJson` and go only to the branch (:435,451). Needs the listing rows for "Inovetta fitness" and "savesto". | be, app, web | P6 | Low |
| 29 | VERIFIED | Server builds `` `${gym.name} - ${b.branchName}` `` for every branch (`discovery.service.js:153,466,793`). Web and app print that title as is. | be (app, web inherit) | P6 | Low |
| 30 | NOT REPRODUCED in code | Home "Near You" cards render only `gym.coverImageUrl` / `imagesJson` (`home_screen.dart:1288-1400`, image at :1356-1358); the "Submitted!" text exists only in `pending_verification_screen.dart:177,187`, which Home never renders. Most likely a **screenshot of that screen was uploaded as the gym's photo**. Confirm by opening that listing's `cover_image_url` / `images_json`. If so, the real gap is photo moderation, not discovery. | data (be) | P6 | Low |
| 31 | VERIFIED | Server sets `startDate`/`endDate` when the PENDING request is created (`be/src/services/subscription.service.js:184-185,193-197`); the app prints "Expires …" for any status (`app/lib/features/me/presentation/screens/my_subscriptions_screen.dart:240,485`); detail screen says "Expires (Est.)" (`subscription_detail_screen.dart:208`). `qr_full_screen.dart:80` defaults to "Expires Oct 24, 2026". | be, app, cms | P7a | Low |
| 32 | VERIFIED | Tab label "Inbox" (`app/lib/features/traveler_shell/presentation/traveler_shell.dart:98`); screen title "Messages" (`app/lib/features/me/presentation/screens/subscription_history_screen.dart:403`, the traveller inbox lives in this file). | app | P8 | Low |
| 33 | VERIFIED | Invented suffixes: "`${plan.name} Athlete Pass`" and "BEST SELLER" (`app/lib/features/subscriptions/presentation/screens/package_detail_screen.dart:216,227`), "`Full-Access ${plan.name} Plan`" (`order_review_screen.dart:285`), "`$planName Pass`" (`subscription_confirmed_screen.dart:157`). | app | P4 | Low |
| 34 | VERIFIED, **raised to P0** | The 5% fee exists **only in the app**: `order_review_screen.dart:192-203,431` and `payment_screen.dart:63-68`. The server prices plan + joining + security, no fee (`be/src/services/subscription.service.js:132-146,221-233`). So the app tells the traveller to transfer Rs 5,250 while the server records Rs 5,000. Clients computing a price breaks AGENTS rule 6. Check that the `amount` the app sends (`checkout_provider.dart:171-181`) is ignored by the server. | app (be already right) | P7a | **High** (money) |
| 35 | VERIFIED | `GET /discovery/gyms/:id/payment-details` returns `tenant.paymentDetailsJson` (`be/src/services/discovery.service.js:1190-1201`); it is null unless the host filled the gym-profile payment block. The app treats null as "still loading" forever (`app/lib/features/subscriptions/presentation/screens/payment_screen.dart:229-259`) and always prints "Transfer … to the above account" (:261). Note: host "Payout & Banking" is a different store (`be/src/services/payout.service.js`), so a host who entered bank details there still shows nothing to travellers (two systems for one concern). | be, app | P7a | Medium |
| 36 | Feature (no code) | No Stripe Connect / payout-account code exists in `be/src` (no `accounts.create`, `account_links`, connected-account fields). Needs D2. | be, app, cms, web | P7b | — |
| 37 | VERIFIED (list below) | See "BUG-37: CMS and web screens that share a root cause". | cms, web | P9 | Medium |
| 38 | VERIFIED (list below) | See "BUG-38: mock and invented data in production paths". | app (cms, web clean for the searched strings) | P8 | Medium |

## BUG-16 trace (P0)

**Server, proven by code (no test run yet):**

1. Becoming a host sets the account role at once, even for a DRAFT tenant: `User.update({ role: GYM_HOST, isHost: true })` (`be/src/services/tenant.service.js:58`). The JWT carries this role (`be/src/services/auth.service.js:184-192`).
2. `tenantContext` treats a **traveller member** as "belongs to the tenant": `_userBelongsToTenant` step 3 accepts any `UserGymMembership` row, any status, including a PENDING booking request (`be/src/middleware/tenantContext.js:163-168`). That row is written the moment a traveller requests a plan (`be/src/services/subscription.service.js:208-215`).
3. The tenant can be chosen two ways: the client sends `X-Tenant-Id: <other gym>` (accepted because of step 2, `tenantContext.js:206-216, 277-291`), or, when the host's own tenant is not ACTIVE, the fallback `resolveDefaultTenantForUser` returns **the last gym the user booked as a traveller** (`be/src/services/membership.service.js:148-165`, used at `tenantContext.js:243-246`).
4. Permission check: `can()` first calls `hasAllBranches(req)`, which returns **true for any `req.user.role === 'GYM_HOST'`** without checking which tenant (`be/src/utils/branchAccess.utils.js:55-58`), and then grants `ownerGrants()` (`be/src/middleware/can.js:69-75,103-108,143-148`). `applyLegacyRoleShim` leaves the role as `GYM_HOST` when the caller has no assignment in that tenant (`tenantContext.js:106`).

Result: any host (even unpaid) who has sent a booking request to gym X gets owner rights in X on every `can()` route: `/team` (list, invite, change permissions, revoke), `/approvals`, `/reports`, ledger, payouts, members, payments. An unpaid host does not even need to send a header: step 3's fallback picks gym X by itself. This matches "Team & Access sometimes shows another host's data" (it happens exactly when the host has booked another gym).

Not covered by any test: no test combines `UserGymMembership` with `/team`; `tests/regression/new-47-owner-member-role-access.test.js` covers the opposite case (owner with role MEMBER).

**Client:**

- Reset on logout misses: `hostTodaySummaryProviderNew` (`app/.../host_providers.dart:17`), `hostOnboardingProvider` (the whole Become-a-Host draft, `app/lib/features/host_onboarding/presentation/providers/host_onboarding_providers.dart:962`), `hostListingDataProvider` (`app/lib/features/host/presentation/providers/listings_provider.dart:9`), `billingProvider` (`billing_provider.dart:780`). Reset list: `app/lib/core/utils/session_cache.dart:39-75`.
- No client ETag / If-None-Match store exists in the app (`grep` finds none), so the B3 304 path cannot serve another user's body on mobile. CMS/web not yet checked for a shared HTTP cache (P1 task).
- Team list itself is `autoDispose` (`team_provider.dart:8`); roles and permission catalogue are reset (`session_cache.dart`).
- Socket rooms: already staff-only since NEW-85/NEW-86 (`userIsTenantStaff`, `tenantContext.js:143-146`).

**Fix direction for P1 (not done):** `hasAllBranches` must check that the caller owns *this* tenant (role alone is not enough); `userBelongsToTenant` must not count `UserGymMembership` for staff/admin routes (use `userIsTenantStaff`); `resolveDefaultTenantForUser` must not fall back to a member gym for host routes; return a clear `tenant_not_active` code for a host whose own tenant is DRAFT/PENDING instead. Persona test first: host A (DRAFT) with a PENDING booking at gym B calls `GET /team` with and without `X-Tenant-Id: B` → must not get B's rows.

## BUG-11 / 14 / 15: what the app sends as the tenant selector

- Host screens send **no** `X-Tenant-Id`; only the team workspace, payouts and one payments call pass one (`app/lib/features/host/data/repositories/team_repository.dart:27`, `payouts_repository.dart:16,57`, `payments_repository.dart:140`, `app/lib/features/me/data/repositories/workspace_repository.dart:45-136`).
- So the server falls back to: JWT `tenantId` (owner's newest tenant, any status, `auth.service.js:171-178`) → `userBelongsToTenant` fails because the tenant is not ACTIVE → branch param (none) → default tenant (another gym if the user has one, see BUG-16; else null) → 400 `missing_tenant_context`.
- `/host/today-summary`, `/host/branch-quota`, `/host/organization-quota` do **not** use `tenantContext`; they read the JWT `tenantId` directly (`host.controller.js:41,209,229`). That is why Today shows "Complete your listing" while Team & Access errors.

## BUG-10 / 24: where plan tier names and subscription prices come from

| Value | Where shown | Source |
|---|---|---|
| Tier name "Starter/Professional/Growth/Scale" | Choose Your Plan | `branch_plan_picker_screen.dart:70-75` (client table, branch count) |
| "Growth Plan" | Host Profile | constant, `host_profile_screen.dart:390` |
| Plan name on My Subscription | My subscription | branch count, comment at `app/lib/features/billing/presentation/screens/my_subscription_screen.dart:187` |
| "Pro" / "Starter" | traveller package comparison | constants, `app/lib/features/subscriptions/presentation/screens/package_detail_screen.dart:51-52,119`, `order_review_screen.dart:158`, `payment_screen.dart:34`, `qr_full_screen.dart:96` (fallback plan objects) |
| Hosting price (device) | Choose Your Plan (onboarding and later) | `billingProvider.displayPrice` → store `ProductDetails.price`, else catalog `currency + monthly/annualPrice` (`billing_provider.dart:238-243`) |
| Hosting price (catalog) | CMS admin billing plans | `cms/src/app/(dashboard)/admin/billing-plans/page.tsx:291,302` ("(PKR)" labels), backend `be/src/services/billing-plan-catalog.service.js` |

## BUG-37: CMS and web screens that share a root cause

| Mobile bug | CMS | Web |
|---|---|---|
| 01/04 our city/area lists | `/gym/branches` form uses `citiesApi.getCities` (`cms/src/app/(dashboard)/gym/branches/page.tsx:35,215`); `/admin/cities` | `/gyms` filter uses `/discovery/cities` and city areas (`web/src/app/(public)/gyms/page.tsx:46,205-214`) |
| 05 plan visibility | no "Show to travellers" control; plans created in the CMS are hidden from travellers by the server default (NEW-112) | `web/src/lib/format-plans.ts:95` treats a missing `isPublic` as visible |
| 09 PKR label | `gym/plans/page.tsx:368`, `gym/payments/page.tsx:611,752`, admin packages `:249` | `formatCurrency` defaults to PKR (`web/src/lib/utils.ts:9`) |
| 14/15 raw server text | `teamErrorMessage` keeps the server sentence for generic codes (`cms/src/lib/team/access.ts:212-219`) | not checked (no team screen on web) |
| 16 isolation | Same server routes; CMS client cache reset on logout to be checked in P1 | same |
| 26/27/29 discovery | — | city list, "0.0" ratings, doubled names: `web/src/components/features/gym-card.tsx:85-86`, `web/src/app/(public)/gyms/[id]/page.tsx:236,537` |
| 34 platform fee | none found | none found |
| Brand | "GymsEra" ×38, "GYMSERA" ×6 | "GymsEra" ×63, "Gymsera" ×3 |

## BUG-38: mock and invented data in production paths (mobile)

Grep for Unsplash/stock URLs, "GymConnect", "Peshawar", invented names, counts, ratings and trends. CMS and web had no hits for these strings.

| # | File:line | What |
|---|---|---|
| 1 | `app/lib/features/host/presentation/providers/host_profile_provider.dart:11-35` | **`myTenantProvider` returns a fake tenant on any error**: "Ahmed Khan Gym & Fitness", "Elite Fitness Center", Peshawar address, phone, `status: active`, `kycStatus: approved`, stock logo/cover. A failed load shows a made-up verified business. (P1) |
| 2 | `app/lib/features/host_onboarding/presentation/screens/listing_preview_screen.dart:302,351,356,515,581-585,670,719,724,879` | Listing preview: stock photos, "4.9 (128 reviews)", fallback gym "Iron Forge Athletic Club", fake description, "782 Industrial Way, Peshawar" |
| 3 | `app/lib/features/discovery/presentation/screens/gym_gallery_screen.dart:21-28,111,148,204` | Six stock photos shown when a gym has none; the counter and item count always use the stock list length |
| 4 | `app/lib/features/discovery/presentation/screens/home_screen.dart:33,465,983,1241,2385-2410` | stock fallback image, stock avatar, "(124)", "Explore by type" stock tiles |
| 5 | `app/lib/core/widgets/app_image_widget.dart:27` | global default image is a stock gym photo |
| 6 | `app/lib/features/discovery/presentation/screens/gym_detail_screen.dart:99,109,1205` | stock cover fallback; invented hours "06:00 AM - 11:00 PM" when the branch has none |
| 7 | `app/lib/features/discovery/presentation/screens/search_results_screen.dart:25-70` | `_mockResults` ("Iron Temple Elite", "4.9", "124") — declared, not rendered (dead code, delete) |
| 8 | `app/lib/features/discovery/presentation/widgets/filters_bottom_sheet.dart:45-57` | stock category tiles |
| 9 | `app/lib/features/discovery/presentation/screens/wishlist_screen.dart:179` | "(124)" (NEW-104 left it) |
| 10 | `app/lib/features/subscriptions/presentation/screens/package_detail_screen.dart:51-52,119,185,216,227` | fallback plan "Pro" Rs 6,500 quarterly, "Starter/Pro" comparison, stock poster, "BEST SELLER", "Athlete Pass" |
| 11 | `app/lib/features/subscriptions/presentation/screens/order_review_screen.dart:158,263,285` | fallback plan "Pro", stock image, "Full-Access … Plan" |
| 12 | `app/lib/features/subscriptions/presentation/screens/payment_screen.dart:34` | fallback plan "Pro" |
| 13 | `app/lib/features/subscriptions/presentation/screens/qr_full_screen.dart:80,96-98` | "Expires Oct 24, 2026" default, "Pro Plan" default |
| 14 | `app/lib/features/me/presentation/screens/my_subscriptions_screen.dart:19`, `subscription_history_screen.dart:203`, `subscription_detail_screen.dart:116` | stock gym image fallback |
| 15 | `app/lib/features/host/presentation/screens/inbox_screen.dart:123` | stock portrait as header avatar (BUG-25) |
| 16 | `app/lib/features/host/presentation/screens/member_profile_screen.dart:225`, `add_member_screen.dart:566`, `renew_subscription_screen.dart:400`, `package_editor_screen.dart:297`, `listings_overview_screen.dart:632`, `host_gyms_overview_screen.dart:1290` | stock photos as member avatar / plan poster / listing fallback |
| 17 | `app/lib/features/host/presentation/providers/host_providers.dart:220`, `members_list_screen.dart:308`, `member_subscriptions_history_screen.dart:191`, `check_ins_screen.dart:235`, `qr_scanner_screen.dart:248,287`, `staff_gyms_tab_screen.dart:974` | invented plan names "Daily Pass" / "Gym Pass" / "Membership Plan" / "Active Plan" when the plan is missing |
| 18 | `app/lib/features/host/presentation/screens/host_today_screen.dart:517,566` | "+12.4%" and trending icon (BUG-20) |
| 19 | `app/lib/features/host/presentation/screens/host_profile_screen.dart:377,390` | "Verified ✓", "Growth Plan" (BUG-13/24) |
| 20 | `app/lib/features/host_onboarding/presentation/screens/become_host_landing_screen.dart:291,326-397` | invented stats and city (BUG-07) |
| 21 | `app/lib/features/host_onboarding/presentation/screens/listing_step2_screen.dart:27-29,308` | mock Peshawar coordinates, stock map (BUG-02, NEW-111) |
| 22 | `app/lib/features/host_onboarding/presentation/screens/business_info_screen.dart:168-171` | city pre-selected to Peshawar |
| 23 | Backend: `be/src/services/discovery.service.js:142` and `be/src/services/tenant-provisioning.service.js:360` | unknown city falls back to city id **1** (see NEW-113) |

## New findings (not in the ledger)

| ID | Sev | Finding | Evidence | Prompt |
|---|---|---|---|---|
| NEW-108 | **P0** | Cross-tenant owner grants for any `GYM_HOST` who is a member of another gym (full trace above). Filed separately from BUG-16 because it is a server privilege escalation, not a display bug. | `branchAccess.utils.js:55-58`; `tenantContext.js:163-168`; `membership.service.js:148-165` | P1 |
| NEW-109 | P1 | A Google Maps API key is committed in plain text in `app/android/app/src/main/AndroidManifest.xml:53-54` and `app/ios/Runner/AppDelegate.swift:11` (same key in both). Rotate, restrict, and move to build config in P3. (Firebase `apiKey` values in `firebase_options.dart` are public by design and are not part of this.) | files named | P3 |
| NEW-110 | P1 | Logout leaves the previous user's Become-a-Host draft, listing data, Today summary and billing state in memory (same device, next account). | `session_cache.dart:39-75` vs providers listed in BUG-16 client | P1 |
| NEW-111 | P1 | Location step saves hard-coded Peshawar coordinates when the host never taps "Use current location", so the pin, "Near You" and distances are wrong. | `listing_step2_screen.dart:27-29,192-195` | P3 |
| NEW-112 | P1 | Plans created in the CMS are hidden from travellers: the CMS never sends `isPublic` and the server default is `false`; the CMS has no control to change it. | `cms/src/app/(dashboard)/gym/plans/page.tsx:164,175`; `be/src/services/membership-plan.service.js:341` | P4 |
| NEW-113 | P2 | Branches with a missing or unknown city are filed under city id 1 in discovery and at approval. | `discovery.service.js:142`; `tenant-provisioning.service.js:360` | P6 |
| NEW-114 | P2 | `hostBranchesProvider` and `branch-quota.service.js` turn errors into empty lists / zeros (UX-08 rule: a failed load must not look empty). | `host_providers.dart:99-108`; `branch-quota.service.js:47-49` | P5 |
| NEW-115 | P2 | Traveller bank details read `tenant.paymentDetailsJson`, while the host enters bank details in "Payout & Banking" (`payout.service.js`), a separate store. Two systems for one concern (AGENTS rule 2). | `discovery.service.js:1190-1201` | P7a |
| NEW-116 | P3 | Repo state: local `gyms_era` `master` is one merge behind origin (PR #31) and has uncommitted `pubspec.yaml` (build 18 → 20) and `ios/Podfile.lock` changes the handoff does not explain. Not touched. | `git status` | owner |

## What P0 did not do

- No test, device run, staging call or database query. Every VERIFIED row is a code trace; NEEDS rows list the exact evidence still missing.
- CMS/web client caches after logout (BUG-16) were not traced; P1 must do it.
- Google, Stripe and store behaviour were not exercised.

## P1 status (2026-10-26, Claude Code Opus 5.5)

Branches (local, not pushed): be `fix/new-108-cross-tenant-owner`, app `fix/p1-new-110-111-session-and-mock-data`, cms `fix/p1-bug-14-15-tenant-error-copy`, web `fix/p1-new-110-clear-cache-on-logout`. Each fix has a test that was run red on the old code and green on the new.

| ID | P1 result | Fix | Test |
|---|---|---|---|
| NEW-108 / BUG-16 (server) | **FIXED** | `tenantContext` records how the caller is linked to the resolved tenant (`OWNER` / `STAFF` / `MEMBER`; a gym membership is checked last and only ever means `MEMBER`); the legacy role shim demotes the account role `GYM_HOST` / `isHost` to MEMBER in any tenant the caller does not own, before any await (fail closed); `hasAllBranches` no longer trusts the role and checks ownership of the resolved tenant; the default-tenant fallback no longer places a host whose own gym is not live in a gym they only booked; `/host/*` routes that acted on `req.user.tenantId` after `tenantContext` now re-check ownership there (`ownerHere`); the traveller `/member/*` routes use `tenantContext.forMemberRoutes`, which keeps the member-gym fallback (member rights only). Existing test `payments-access.test.js` "the owner always passes" built an owner request from the account role alone; its fixture now carries `isOwner: true`, which is what `tenantContext` sets for a real owner (assertions unchanged). `tenant.service.js` `registerTenant` is unchanged (the account flag is still needed for onboarding routes); a comment says it grants nothing inside any tenant. | `tests/regression/new-108-cross-tenant-owner-grants.test.js` (32 cases): red 26/31 on old code (invite 201, permissions 200, org admin **revoked**, listing-content PATCH 200, invoices of other travellers listed, no-header `GET /team` 200 with gym B's team), green 32/32 (the 32nd case, a member route without header, was added with the member-route variant and is red without it: 409) |
| BUG-14 / BUG-15 | **FIXED** | API: 409 `tenant_not_active` ("Your gym is not live yet…") for a host whose own gym is not ACTIVE; `missing_tenant_context` text is plain copy. Both codes added to the shared error-copy catalog (be, app, CMS, web); clients map by code, so they show the copy even against an API that still sends the old sentence. Team & Access (CMS `teamErrorMessage`) uses it too. | be (above, 2 cases); app `bug_14_15_no_raw_tenant_error_test.dart`; cms and web `tests/lib/bug-14-15-tenant-error-copy.test.ts` |
| BUG-23 | **NEEDS SERVER LOG** (unchanged) | Not reproduced with an approved tenant in the persona harness (`GET /team` as owner is 200). The API log line for request `c5d4dd12-43e5-4105-8eb7-90c925c99d4d` is still needed. | — |
| NEW-110 | **FIXED** | App: `resetIdentityScopedCache` now resets every non-autoDispose provider that can hold one person's data (Today summary, onboarding draft, listing data and editor, billing (re-read so the NEW-16 listener stays), workspace tenant choice, checkout choices, 20+ family providers, filters), and removes recent searches on logout / account switch. Web: logout is a client-side navigation and **kept the React Query cache**; the cache is now cleared when the signed-in user goes away or changes (same in CMS, where logout also reloads). CMS: logout forgets the organization picked in the switcher. | app `new_110_logout_resets_user_state_test.dart` (incl. a guard that fails on any new non-autoDispose provider not reset or listed); web `tests/lib/new-110-clear-cache-on-sign-out.test.ts`; cms `tests/lib/new-110-clear-state-on-sign-out.test.ts` |
| NEW-111 | **FIXED** | No default coordinates on the Location step; nothing is saved until GPS sets them (API accepts null); label says "Location not set yet". | app `new_111_no_mock_coordinates_test.dart` (old code saved 34.0151) |
| BUG-38 (host profile) | **FIXED** | `myTenantProvider` no longer returns the invented "Elite Fitness Center"; Host Profile shows its error state with Try again. Rest of the BUG-38 list stays for P8. | app `bug_38_host_profile_no_mock_test.dart` |

New findings in P1 (not fixed unless noted):

| ID | Sev | Finding | Status |
|---|---|---|---|
| NEW-117 | P0 | Part of NEW-108: `/host/listings`, `/host/branches` (create, list, listing-content, delete, move, restore) ran `authorize('GYM_HOST')` *before* `tenantContext` and then trusted `req.user.tenantId`, so with `X-Tenant-Id` of a gym the host had booked they could write to that gym (listing-content PATCH returned 200 in the red run). | FIXED in the NEW-108 commit (`ownerHere`) |
| NEW-118 | P1 | Web logout (`router.push('/')`) kept the React Query cache for the next person on the tab. | FIXED with NEW-110 (web) |
| NEW-119 | P2 | `verificationDocsProvider` (`app/lib/features/host/presentation/providers/host_profile_provider.dart`) shows invented KYC document statuses ("CNIC uploaded", "business registration pending") on the Verification documents screen instead of the tenant's real `kycDocumentsJson`. | open, P8 sweep |
| NEW-120 | P3 | The `/member/subscriptions/:id/upgrade*` routes run `tenantContext` only as a gate (the service ignores `req.tenantDb`), and the app sends no `X-Tenant-Id`, so the tenant is guessed. Works, but the gate adds nothing; consider removing it or sending the subscription's tenant. | open |

## P2 status (2026-10-26, Claude Code Opus 5.5)

P1 merged and deployed (be #171, app #33, cms #39, web #24). Branches (local, not pushed): be `fix/p2-host-status-and-plan`, app `fix/p2-host-status-and-plan`, cms and web `fix/p2-error-copy-new-codes`. Owner decision R-75 (D4) applied. Each fix has a test run red on the old code and green on the new.

| ID | P2 result | Fix | Test |
|---|---|---|---|
| BUG-10 | **FIXED** (R-75) | The app shows only the store's localized price: `displayPrice` no longer falls back to the catalog "PKR 2000"; the picker says the price is loading / not available and keeps Continue disabled; My Subscription prints the stored currency (the store's charged amount) instead of "Rs". CMS / web keep the catalog price. Needs a Pakistan-region sandbox tester to see "Rs" from the store. | app `bug_10_store_price_only_test.dart` |
| BUG-11 | **FIXED** (server and client causes from P0) | `/host/today-summary` resolves the owned tenant (not the token's `tenantId`); an unreachable tenant DB is 503 `tenant_unavailable`, not an empty "APPROVED" dashboard; Today shows a skeleton until the host status is known, then the status panel or the dashboard; the summary refetches when the status changes; the status is re-read on `tenant_*` / `listing_*` notifications, register, submit, purchase. | be `p2-host-status.test.js`; app `p2_host_status_test.dart` (slow status; tenant record fails) |
| BUG-12 | **FIXED** | One server status (`GET /host/status`); AWAITING_PAYMENT = "Finish your subscription to submit your gym" + Choose Your Plan on Gyms, Today and every screen that used `HostUnderReviewView` (Staff, Admins, Add staff / admin, Invoices). "Under review" only for PENDING_REVIEW. | same |
| BUG-13 | **FIXED** | "Verified ✓" only when the API says `verification.verified` (KYC approved). | app `p2_host_status_test.dart` |
| BUG-18 | **FIXED** | Listings quota header ("Gym Companies 1 / 1 · Limit reached") only once the plan is paid. | app `p2_host_status_test.dart` |
| BUG-24 | **FIXED** | One tier table on the API (`src/constants/plan-tiers.js`: 1 = Starter, 2–4 Professional, 5–7 Growth, 8+ Scale); Host Profile shows "<Tier> Plan" from `hostStatus.plan` only once paid; `GET /billing/plans` sends `tierName` per plan and the app's plan picker shows it (its own `_friendlyName` table removed). CMS / web adopt the API names in P9. | be `p2-host-status.test.js`, `bug-24-plan-tier-names.test.js`; app `p2_host_status_test.dart`, `bug_24_picker_tier_from_api_test.dart` |
| NEW-113 | **FIXED** | No city id 1 default: discovery leaves an unknown city null; approval uses the tenant city, else the onboarding main-branch city, else 422 `city_required` before any change. | be `new-113-no-default-city.test.js` |
| NEW-114 | **FIXED** (server and client) | `branch-quota.service.js` and `hostBranchesProvider` no longer turn failures into zeros / an empty list. | be `new-114-branch-quota-errors.test.js`; app `new_114_branches_error_test.dart` |
| NEW-115 | **NOT REPRODUCED** | Host Payout & Banking and the traveller's bank details read and write the same `tenants.payment_details_json` with the same keys. The traveller "Loading host bank details…" forever is BUG-35 (null treated as loading), still P7a. | be `new-115-one-bank-details-store.test.js` (locks the single store) |

New in P2:

| ID | Sev | Finding | Status |
|---|---|---|---|
| NEW-121 | P2 | Gyms & Operations read two badge counts with `.value`; a failed unread-count or pending-requests call threw during build and took the tab down. | FIXED (app `4b1ac32`, `new_121_gyms_badge_failure_test.dart`) |
| NEW-122 | P3 | `docs/sql` checks need `tenants.db_name` on the same MySQL server as the platform DB (true today). If tenant databases move to another server, `phase7-open-data-checks.sql` 21c / 28b / 30b / 05 must run per server. | open, note only |

Open data checks: `docs/sql/phase7-open-data-checks.sql` (read-only, one run against the platform DB): BUG-21 (savayora branches, listings, reserved slots), BUG-28 (Inovetta fitness / savesto image fields), BUG-30 (every live image URL), BUG-05 (branches with no traveller-visible plan, and onboarding plans of not-yet-approved applications).

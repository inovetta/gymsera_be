# GYMSERA_PRODUCTION_ARCHITECTURE.md

**Master production specification for GymsEra.** Covers the Flutter app (`gyms_era`), the API (`gymsera_be`), the admin/host portal (`gymsera_cms`), and the public website (`gymsera_web`).

**Audience:** the AI coding agent (and senior engineers) who will change the real code.

**Sources this spec was written from:**
- `MOBILE_APP_ARCHITECTURE.md`
- `PLATFORM_ARCHITECTURE.md`
- The four screen maps: Mobile Screen Map, Host Console Map, Admin Console Map, Public Site Map.

> **Version 2 — mobile-first.** The owner has built and refined the **mobile app** most; the website, CMS and parts of the backend fell behind it. From v2 on, **the mobile app is the reference implementation** for product behaviour and UX (§0.5). The job for the web, CMS and backend is to *catch up with mobile*, not the other way round.
>
> What changed from v1:
> - New §0.5 (source-of-truth order) and §3.3 (feature-by-feature parity matrix).
> - §8.3 now documents the mobile **Team & Access** design as the approved RBAC architecture.
> - RBAC-01 is reversed: the 3-choice permission editor is correct.
> - New issues RBAC-07…09, UX-18…25, BILL-18.
> - Mobile navigation changes from v1 (drawer → More, label renames) are now **optional proposals**; mobile stays as it is unless the owner approves them.

> **Important honesty note.** This document was written from architecture documents and screen maps, **not from reading the source code**.
> - Every issue below says how it is known (see §0.3).
> - Nothing in §13 is marked "implemented" until the agent has changed the code **and** a test proves it.
> - Nothing may be declared production-ready from reading code alone (§17).

> **Multi-agent work.** Several AI agents (Claude Code, Gemini, others) work on this spec in turn. The live "where are we right now" state is kept in `AGENT_HANDOFF.md` next to this file. Read it before starting and update it at every checkpoint (see `AGENTS.md` in any repo).

---

## 0. How the agent must use this document

### 0.1 Ground rules (non-negotiable)

1. **Verify before you fix.** For every issue, first find the code that proves or disproves it. If the code already does the right thing, mark the issue `NOT REPRODUCED` in §13 with the file/line, and move on. Do not "fix" working code.
2. **Reuse before you build.** Before adding any table, service, provider, hook, or component, search the repo for an existing one that does the job.
   - Extend what exists.
   - A second system for the same concern is a defect, not a fix.
3. **Locked architecture stays locked.** These may only change where a listed issue proves a real defect, and then only in the way the issue describes:
   - The capacity invariant `activeBranches + Σ reservedSlots ≤ maxBranches`
   - `reconcileCapacity`, `subscription-quota.service.js`
   - `CapacityEvent` and its `idempotencyKey`
   - The branch lifecycle (`deleteBranch`/`restoreBranch` as the only status doors)
   - The one-ACTIVE-row subscription invariant, `requestProviderChange`, `reconcileRenewalStatus`
   - The single `BillingPlan` catalog
   - The two-database model
   - The approval engine
4. **Every fix follows one format:**
   `Issue → Root cause (with file:line) → Existing pattern reused → Fix → Regression test (file name) → Result`.
   Record it in §13.
5. **Small, reviewable changes.**
   - One issue (or one tightly-coupled group) per PR/commit.
   - Each change ships with its test in the same commit.
   - No drive-by refactors.
6. **Backend first, then clients.** The server is the only authority on capacity, permissions, prices, and entitlement. Clients show what the API returns; they never decide these things themselves.
7. **Never weaken a guard to make a test pass.** If a test fails, the code or the test expectation is wrong. Find out which, and write down why.
8. **No secrets or personal data in code, logs, fixtures, or commit messages.**
9. **Mobile is the reference.** When the mobile app, the CMS, and the website do the same thing differently, the mobile behaviour is the intended product (§0.5). Port it; don't redesign it. The only exception is a listed defect.
10. **Redis resilience and test independence.** Redis is an optional accelerator and cache, never a hard runtime dependency or single point of failure. Any backend code or service touching Redis must provide an in-process or MySQL fallback (e.g. MySQL `GET_LOCK` for distributed locks, bounded in-process cache for permission versions, direct notification dispatch). **Tests touching Redis must also pass cleanly with Redis off (`DISABLE_REDIS=true`).** Tests must guard or skip Redis-specific cache key assertions when Redis is offline or disabled.

### 0.2 Order of work

Do the phases in order. Within a phase, do P0 before P1 before P2.

| Phase | Theme | Issue groups |
|---|---|---|
| **1** | Stop money/entitlement leaks and security holes | Every **P0** in BILL, CAP, FLOW, PAY, AUTH, RBAC, SEC, RT (e.g. BILL-01/02/03/06/12/13/14, CAP-01/03/04, FLOW-02/03, PAY-01/02/03/04/07/10, AUTH-01/04/07/09, RBAC-03/07, UX-12, SEC-01/02/03/06/07/09/10/13, RT-04) |
| **2** | Reliability of every mutation | REL-*, API-01…05, remaining FLOW-*, remaining BILL-* and CAP-* |
| **3** | CMS and website reach mobile parity (§3.3) | UX-13/14/18…25, RBAC-01/02/04/05/06/08/09, §3 layering rules (applied only to code touched by an issue) |
| **4** | Speed | PERF-*, API-06…08 |
| **5** | Global readiness and observability | GLB-*, OBS-*, RT-* |
| **6** | Test matrix complete, staging verification, deployment checklist | §15–§17 |

### 0.3 Evidence levels used on every issue

| Tag | Meaning | Agent action |
|---|---|---|
| `DOC` | Stated directly in the architecture docs or screen maps | Confirm in code, then fix |
| `INFER` | Strongly implied by the documented design; very likely present | Look for it specifically; fix if found |
| `CHECK` | A standard enterprise requirement the docs don't mention either way | Audit; fix only if missing |

### 0.4 Severity

| Level | Meaning |
|---|---|
| **P0** | Money, entitlement, security, or data-loss defect. Blocks production. |
| **P1** | Correctness or reliability defect users will hit. Fix before scale. |
| **P2** | UX, performance, or maintainability. Fix during hardening. |

### 0.5 Source-of-truth order (v2)

When two parts of the system disagree, resolve it in this order:

| Question | Source of truth | Why |
|---|---|---|
| What should the product **do** and how should it **feel**? (flows, screens, wording, RBAC model) | **Mobile app** (`gyms_era`) | It is the most complete and most recently refined surface |
| What is **allowed**, and what does it **cost**? (permissions, capacity, prices, entitlement) | **Backend** (`gymsera_be`) | Only the server can enforce anything |
| Where the mobile flow expects something the backend doesn't enforce yet | **Mobile defines the rule, the backend implements the enforcement** | e.g. the mobile 3-choice permission editor → the server must cap and validate those tiers |
| Where mobile has a listed defect (§12) | **The fix in §12** | Mobile is the reference, not infallible |
| Website and CMS | **Follow mobile + backend** | They are clients to bring up to parity (§3.3) |

Practical rules:
- **Before changing a CMS/web screen**, open the matching mobile screen and its provider/notifier. Copy the flow, the states, the error handling, and the API calls it makes.
- **If the CMS/web calls a different endpoint** than mobile for the same job, switch it to the mobile endpoint. Then retire the old endpoint (return `410 Gone` after one release) unless something else still needs it.
- **If a CMS/web feature has no mobile equivalent** (for example the CMS Trainers screen, or the web Account statement), keep it. Record it in §3.3 as "web-only" and decide later whether mobile needs it.

---

## 1. Current architecture (as documented)

### 1.1 Systems

| System | Stack | Role |
|---|---|---|
| `gyms_era` | Flutter, Riverpod, go_router (`StatefulShellRoute`), `in_app_purchase` | One app with two modes. **Host Mode** tabs: Today / Gyms / Listings / Inbox / Profile, plus an app-wide drawer. **Traveler Mode** tabs: Home / Search / My Plans / Inbox / Profile. |
| `gymsera_be` | Node/Express, Sequelize, MySQL | The only thing that touches databases. Holds all business rules. |
| `gymsera_cms` | Next.js | One app with a role-gated sidebar: Gym Management + Settings for hosts, Platform Admin for admins. |
| `gymsera_web` | Next.js | Three audiences: public discovery and marketing; host sign-up wizard (`/gym-owner/register`); member self-service portal (`(dashboard)` group). |

### 1.2 Data

**Platform DB (one database, shared):**
- `Tenant`, `User`, `GymListing` (= Organization), `TenantSubscription`, `BillingPlan`, `PlatformPackage` (legacy)
- `CapacityEvent`, `PlatformInvoice`, `City`, `Area`, and others

**Tenant DB (one MySQL database per tenant, `gymsera_{tenantCode}`):**
- `Branch`, `Gym`, `MembershipPlan`, `MemberSubscription`, `GymStaff`
- `Payment`, `Invoice`, `LedgerDay`, `RoleAssignment`, `ApprovalRequest`, and others
- Connections come from `TenantDbManager`: a lazily-created, in-process cache with one connection per tenant.

### 1.3 Commercial model (locked)

- **Tenant** has exactly one ACTIVE `TenantSubscription`.
- The entitlement is `branchCount`, for store/Stripe subscriptions. The legacy `PlatformPackage` path is used for MANUAL.
- **Organizations are free** but may never have zero branches.
- **Branches consume capacity.**
- Invariant: `activeBranches + Σ reservedSlots ≤ maxBranches`.
- `reservedSlots` = paid but not yet built capacity, parked on an organization.
- Slot-donor mechanism: a new organization can borrow a sibling organization's reserved slot.
- Every slot mutation writes `CapacityEvent` with an `idempotencyKey`.
- `auditCapacity` detects ledger drift (read-only).

### 1.4 Authorization (as documented)

- **Layer 1:** coarse JWT role — `PLATFORM_ADMIN | GYM_HOST | BRANCH_MANAGER | TRAINER | MEMBER`.
- **Layer 2:** `can(permission, scope)` over `RoleAssignment`.
  - Role levels: OWNER 100, ORG_ADMIN 80, MANAGER 60, BR_ADMIN 40, DESK/TRAINER 20, SUPPORT 5.
  - Six tiers: `NONE / VIEW / REQUEST / APPROVE / DIRECT / FULL`.
  - Anything at `REQUEST` tier runs through `approvalService.perform`.

### 1.5 Already fixed

These are documented as fixed (mobile doc §9.1–§9.8). The agent must add a regression test for each if one doesn't exist yet:
- `updateBranch` status bypass
- Purchase-stream product matching
- New-org submit skipped the real attempt
- Renewal resurrection
- Per-org cached tenant numbers
- `getConnection` mass-reactivation
- Fake tenant rows per org
- Delete-button `StatefulBuilder`

### 1.6 Documented open items

- Listings tab is stale after an organization is created.
- Play upgrade/downgrade has not been verified live.
- Stripe live keys are not configured.
- Traveler-visibility toggle semantics.

### 1.7 Conflicts between the documents (agent must resolve from code first)

| # | Conflict | Resolve by |
|---|---|---|
| D-1 | `PLATFORM_ARCHITECTURE.md` says the web wizard's Package step shows the **legacy** catalog and Stripe checkout is **not live**. The Public Site Map says the Package step **reads `BillingPlan`** and `card` → **Stripe Checkout** → `/gymsera-billing?checkout=success`. | Read `gymsera_web/src/app/gym-owner/register/page.tsx`, then update both docs to match the code. **→ Resolved from code in §1.8.** |
| D-2 | The Mobile Screen Map says Team & Access uses **3 tiers** (Off / Needs approval / Direct). The backend has **6** (`NONE/VIEW/REQUEST/APPROVE/DIRECT/FULL`). | **Resolved (v2): mobile is correct.** The editor edits 3 tiers per person; VIEW/APPROVE/FULL come from the role preset. See §8.3 and RBAC-01. |
| D-3 | The mobile map shows a **Cleaner** role. The backend role levels have no Cleaner. | **Resolved (v2): "Cleaner" is the mobile label.** Confirm which backend level it maps to (probably `SUPPORT`). Every client uses the mobile label table. See RBAC-02. |
| D-4 | The mobile app merged Admin + Staff management into Team & Access. The CMS still has separate **Staff** and **Trainers** screens. | **Resolved (v2): the CMS ports mobile Team & Access.** See UX-12 and RBAC-07. |


### 1.8 Verified against the code (Prompt 0, 2026-09-26)

#### 1.8.1 Repository map

| Repo | Stack (from manifests) | Layout | Tests today | Start | Env files (names only) |
|---|---|---|---|---|---|
| `gymsera_be` | Node ≥ 20, Express 4, Sequelize 6 + mysql2, Redis (ioredis, Bull), Socket.IO 4, node-cron, Stripe SDK, google-auth-library, firebase-admin, helmet, express-rate-limit, express-validator; Jest 30 | `app.js`, `server.js`, `api/index.js` (Vercel); `src/{config,constants,controllers,database,jobs,middleware,models/{platform,tenant},routes,services,services/commands,socket,utils,validators,scripts,seeders}`; `docs/`; ~20 loose debug/one-off scripts at the root | `tests/*.test.js` (14 files) call a **running server at `http://localhost:3000`** with seeded users (`tests/helpers.js:1-12`); no isolated DB harness, no CI | `npm run dev` (nodemon) / `npm start`; deployed on Vercel (`vercel.json`) and IIS/iisnode (`web.config`, `iisnode/`); `docker-compose.yml` provides platform MySQL (3306), tenant MySQL (3307), Redis | `.env` (git-ignored, not tracked), `.env.example` |
| `gyms_era` | Flutter (Dart ≥ 3.12), Riverpod 2 (+ generator), go_router 14, dio 5, freezed/json_serializable, in_app_purchase (+ android), firebase_messaging, socket_io_client, google_sign_in, sign_in_with_apple, mobile_scanner, print_bluetooth_thermal | `lib/core/{constants,errors,network,router,services,storage,utils,widgets}`, `lib/features/<22 features>/{data,domain,presentation}` (297 Dart files); legacy `lib/features/gym_host` + `host` coexist | `test/widget_test.dart` is the default **counter** template and will fail against this app; nothing else | `flutter run`; one `ProviderContainer` in `lib/main.dart:30-39` | none in repo; Firebase files git-ignored (`android/app/google-services.json`, `ios/Runner/GoogleService-Info.plist`) |
| `gymsera_cms` | Next.js 14.2 (app router), React 18, TanStack Query 5, zustand, react-hook-form + zod, Radix/shadcn, axios, recharts, leaflet | `src/app/{(auth),(dashboard)/{admin,gym,settings,dashboard}}`, `src/components/{features,layout,ui}`, `src/lib/api/*` (one axios client), `src/stores`, `src/hooks` | none (no test runner in `package.json`) | `npm run dev` (port 3001); IIS via `server.js` | `.env.example`, `.env.local.example` |
| `gymsera_web` | Next.js 14.2, React 18, TanStack Query 5, zustand, react-hook-form + zod, Radix, axios, `@vis.gl/react-google-maps`, `react-qr-code` | `src/app/{(public),(dashboard),auth,gym-owner/register,onboarding}`, `src/middleware.ts` (cookie-presence redirect only), `src/lib/api/*` | none | `npm run dev` (port 3002); IIS via `server.js` | `.env.exmaple` (sic), `.env.local.example` |

No CI configuration exists in any repo (no `.github/`, no pipeline files).

#### 1.8.2 §1 facts checked

| § | Documented | In the code | Evidence |
|---|---|---|---|
| 1.1 | Mobile Host tabs Today/Gyms/Listings/Inbox/Profile + drawer; Traveler Home/Search/My Plans/Inbox/Profile | Matches (`/host/today`, `/host/gyms`, `/host/listings`, `/host/inbox`, `/host/profile`; `/home`, `/home/search`, `/home/my-plans`, `/home/inbox`, `/home/profile`). The old `/host/admins` and `/host/profile/staff` routes still exist next to `/host/team`. | `app/lib/core/router/app_router.dart` |
| 1.1 | Backend is the only thing touching databases | True | — |
| 1.2 | Platform tables | Present, plus `BillingOffer`, `Conversation`, `Message`, `Notification`, `DeviceToken`, `RefreshToken` (reuse for AUTH-02), `Otp`, `UserOrgIndex`, `UserGymMembership`, `SavedGym`, `GymReview`, `Device`, `DeviceMember`. **No** `AuditLog` model (SEC-12), no `BillingEvent`, no `IdempotencyRecord`. | `be/src/models/platform/` |
| 1.2 | Tenant tables incl. `LedgerEntry` | Present, plus `RoleAssignmentBranch`, `AssignmentOverride`, `ApprovalPolicy`, `StaffActionRequest`, `AuditLog` (tenant), `LedgerAdjustment`, `Expense*`, `Trainer`, `ClassSchedule`, `Announcement`. **No `LedgerEntry`**: the ledger is computed from `payments` (PAY-03). | `be/src/models/tenant/` |
| 1.2 | `TenantDbManager` lazy in-process cache | True; pool `max: 5` per tenant, unbounded `Map`, and it still runs DDL/UPDATE backfills on first connect (NEW-10). | `be/src/database/TenantDbManager.js:17-195` |
| 1.3 | One ACTIVE `TenantSubscription` | Enforced only inside `requestProviderChange`/`reconcileRenewalStatus`; no DB constraint. Broken by BILL-01 (a moved row can make two ACTIVE rows for the caller) and by the manual paths (NEW-06, NEW-14, NEW-15). | `be/src/services/subscription-migration.service.js` |
| 1.3 | Entitlement = `branchCount`; legacy package for MANUAL | True, **plus an undocumented fallback**: no ACTIVE row → `selectedPackage.maxBranches` → `1`. A lapsed tenant is never at 0. | `be/src/services/subscription-quota.service.js:36-51` |
| 1.3 | Orgs free, never empty; invariant; slot donor; `CapacityEvent.idempotencyKey`; `auditCapacity` read-only | True (unique key at `be/src/models/platform/CapacityEvent.model.js:70-84`; donor in `be/src/controllers/host.controller.js:505-527`). Gaps: CAP-03/05/06/07. | — |
| 1.4 | JWT role `PLATFORM_ADMIN/GYM_HOST/BRANCH_MANAGER/TRAINER/MEMBER` | The JWT carries the **platform `users.role`**, which legacy flows set to `BRANCH_MANAGER` globally; `tenantContext` then rewrites `req.user.role` per request (`be/src/middleware/tenantContext.js:40-83`). | SEC-02, AUTH-08 |
| 1.4 | `can(permission, scope)` over `RoleAssignment`; levels OWNER 100 … SUPPORT 5; six tiers; REQUEST → `approvalService.perform` | True. The six tiers exist only in the role **presets** (`N/V/R/A/D/F`) and compile into a base permission key plus a `.direct` twin; `Grants.tierFor` returns `DIRECT/REQUEST/OFF`. | `be/src/constants/permissions.js:36-50`, `be/src/services/access.service.js:69-75` |
| 1.5 | Already fixed (§9.1–§9.8) | §9.1 fixed (`be/src/services/gym.service.js:747-754`); §9.2 fixed (`_pendingProductId`, `billing_provider.dart:117-122`, `:246`); §9.3 backend donor path present; §9.4 fixed (`reconcileRenewalStatus`); §9.6 status mass-reactivation removed **but other UPDATEs remain** (NEW-10 — the planned regression test will fail); §9.7 fixed (`be/src/services/admin.service.js:59-84` comment + logic); §9.5, §9.8 are mobile UI — to be proven by Prompt 1 tests. | — |
| 1.6 | Open items | Listings stale → FLOW-05 (NEEDS RUNTIME CHECK); Play upgrade unverified → R-9; Stripe live keys → no `STRIPE_*` keys in the backend `.env` (names checked), R-7; visibility toggle → UX-06. | — |

#### 1.8.3 Conflicts D-1 … D-4 resolved from the code

| # | Resolution |
|---|---|
| D-1 | **Both documents are partly right.** The web wizard's Package step lists the **legacy `PlatformPackage`** catalog (`web/src/app/gym-owner/register/page.tsx:216-217` → `GET /platform-packages`). The Payment step offers Bank transfer / Pay later (legacy path) **and**, when a `BillingPlan` with the same branch count exists, a **Card** option that starts a real Stripe Checkout (`:355-372`) returning to `/gymsera-billing?checkout=success`. Stripe code is complete but no Stripe keys are configured, so it is not live. Per R-7 the card option must be hidden behind `WEB_CARD_PAYMENTS_ENABLED=false`. `PLATFORM_ARCHITECTURE.md` still needs the same correction; Prompt 0 may only edit this spec and the handoff, so that edit is left for the next docs change. |
| D-2 | Confirmed: presets use six tiers; per-person editing is ALLOW/DENY overrides on the base and `.direct` keys, i.e. Off / Needs approval / Direct. The save is a whole-set overwrite (RBAC-01, RBAC-08). |
| D-3 | Confirmed: "Cleaner" is backend `SUPPORT`, level 5 (`be/src/constants/roles.js:116-118`); mobile maps `SUPPORT` to the cleaning icon (`app/lib/features/host/presentation/screens/add_team_member_screen.dart:607`). No shared label table (RBAC-02). |
| D-4 | Confirmed: CMS still has separate Staff and Trainers screens (`cms/src/components/layout/sidebar.tsx:71`, `:76`) on the legacy `/gyms/staff` API (UX-12, RBAC-07). |


---

## 2. UI/UX architecture

### 2.1 Principles (apply to every screen on every platform)

1. **One vocabulary everywhere.** The same noun means the same thing on mobile, CMS, web, in API error messages, and in push notifications (see §2.2).
2. **One primary action per screen.** Secondary actions go into an overflow menu or a "More" sheet. Destructive actions are never the primary button.
3. **Progressive disclosure.** A first-time host sees Today, their branches, members, and check-in. Enterprise features (Team & Access, Approvals, Ledger, Payouts, Analytics) appear once they are relevant, and always according to the user's permissions.
4. **The server decides; the UI explains.** The UI never pre-blocks an action on its own quota or permission guess. It attempts the action, then explains the server's answer in plain words with one next step (mobile doc §6.1 generalised to every module).
5. **Every async surface has all its states designed** (§2.5). "Spinner forever" and "blank screen" are defects.
6. **Every screen works at 320 px width, at 200% text size, in RTL, and on a slow 3G connection.**

### 2.2 Canonical vocabulary (UI copy, API error messages, docs)

| Concept | UI label | Never call it | Code/DB name (unchanged) |
|---|---|---|---|
| Brand/business a tenant runs | **Organization** | "Gym", "Listing", "Gym Profile" | `GymListing` |
| Physical location | **Branch** | "Gym" (as a list of branches) | `Branch` |
| Public page of an org/branch | **Public listing** | "Listing" alone | listing content |
| What a branch sells to customers | **Membership plan** | "Plan" alone, "Package" | `MembershipPlan` |
| A customer's purchase of a membership plan | **Membership** | "Subscription" | `MemberSubscription` |
| The host's own GymsEra plan | **GymsEra plan** / **Billing** | "Subscription", "Package" | `TenantSubscription` |
| Paid branch capacity | **Branches in your plan** | "Slots", "Quota" | `maxBranches`, `reservedSlots` |
| Staff member with a role | **Team member** | "Admin", "Staff" (as separate concepts) | `RoleAssignment` |

**Concrete label changes** (v2: apply to the **CMS and website now**; apply to **mobile only if the owner approves**, R-13). Change labels and headings only; do not rename routes, so no deep links break.
- Mobile Gyms tab, inner tab "Gyms" → **Branches**.
- Inner tab "Subscriptions" → **Memberships**.
- Inner tab "Plans" → **Membership plans**.
- Bottom tab "Gyms" → **Operations**. This removes the "Gyms › Gyms" collision.
- CMS "Gym Profile" → **Organization profile**.
- CMS host "Subscriptions" → **Memberships**.
- CMS "Subscription & Billing" → **GymsEra plan & billing**.
- Admin "Packages" → **Legacy packages**.

### 2.3 Target information architecture

#### 2.3.1 Mobile — Host Mode

> **v2: the current mobile navigation is the reference and stays as it is by default.** It has 5 tabs, the app-wide `HostAppDrawer`, and Profile links. Everything in this subsection is an **optional proposal (P2)**, shown on the UI canvas. The agent implements it **only after the owner approves it** (§14, R-13). CMS and web parity work (§3.3) does **not** depend on this proposal.

The proposal: mobile has three overlapping ways to reach screens (5 bottom tabs, an app-wide drawer that duplicates "Gyms & Operations", and Profile links to about 9 more screens). They could collapse into **tabs plus one "More" hub**:

```
Bottom tabs (visible set depends on permissions — see §8.4)
 ├─ Today         /host/today        check-ins, revenue, "needs attention" cards
 │                                   (pending approvals, over-quota, failed payments,
 │                                    expiring memberships), each linking to the fix
 ├─ Operations    /host/gyms         org selector strip + inner tabs:
 │                                   Branches · Members · Memberships · Payments · Membership plans
 ├─ Listings      /host/listings     organizations and their public listings
 ├─ Inbox         /host/inbox        conversations; notifications live here as a
 │                                   second segment ("Messages | Alerts"), one badge
 └─ More          /host/profile      grouped hub (replaces drawer + scattered links):
      Business:   GymsEra plan & billing (/host/subscription/mine), Invoices & billing,
                  Payouts & earnings, Ledger
      Team:       Team & access, Approvals (badge)
      Insights:   Analytics & reports, Branch performance
      Account:    Profile, Settings, Language, Help, Switch to Traveler mode, Log out
```

- **The drawer:** keep `HostAppDrawer` only as a **side rail on tablets/foldables** (width ≥ 840 dp), rendering the same `More` item list from **one** source array. On phones, remove the hamburger.
- **Quick action.** Add a persistent **Scan / Check-in** FAB on Today and Operations. It is shown only when the user has `checkins.create ≥ REQUEST`. Front desk staff live in this action.
- **Front-desk minimal shell** (also a proposal). A user whose highest role is DESK sees these tabs: **Check-in · Members · Payments · Inbox · More**. Same routes, fewer tabs, driven by permissions (§8.4). Do not make a separate app.

#### 2.3.2 Mobile — Traveler Mode

The structure is sound. Required changes:
- Checkout (`/home/checkout/*`) must never collect raw card numbers in Flutter widgets. `add-card` must use the payment provider's SDK or hosted fields (SEC-09).
- My Plans → rename to **My memberships**. Put the check-in QR one tap from the tab root.
- Staff-invite confirmation stays in Traveler Mode, per the design. Accepting it sends the user to Host Mode with the invited tenant preselected (see §8.5).

#### 2.3.3 CMS — Host console

**Keep:** the sidebar gated by `gymOwnerOnly` / `requiresActive`.

**Add, for parity with mobile:**
- An **organization switcher** in the header (hosts can own several organizations; `/gym/profile` is currently singular). Verify first — UX-14.
- **Team & access** — a port of the mobile screen (§8.3). It replaces the separate Staff screen and uses the same endpoints, the same role chips with counts, the same 3-choice editor, the same before/after diff, and the same "revoke keeps the record" behaviour (UX-12, RBAC-07).
- **Approvals.**
- **Ledger.**
- **Payouts.**
- **Branch-quota banner** on Branches, the same component contract as mobile.

**Trainers:** keep it as "bookable trainer profiles," but link each one to its team member record (one person, one record).

#### 2.3.4 CMS — Admin console

- Tenant detail (about 1,365 lines in one page) → split into one component per tab, **fetching only the active tab** (PERF-10).
- Packages → "Legacy packages". Make it read-only for new sales once BILL-10 lands.
- Add **Admin audit log** view (SEC-12).
- Add **Billing events** view per tenant: webhook/RTDN inbox with processing status (OBS-05).

#### 2.3.5 Website

- Delete the duplicate host onboarding flow `/onboarding`. Make it a **301 redirect** to `/gym-owner/register` and remove its code and its homepage button (UX-01).
- Move the host billing page out of the **member** portal. `/gymsera-billing` becomes a thin Stripe-return route that verifies the session server-side, then redirects to the canonical host billing page (UX-02, BILL-14).
- The member portal (`(dashboard)`) renders only for members. Hosts who land there are redirected to the CMS.

### 2.4 Design system (one set of tokens for Flutter and web)

- **Single source:** `design-tokens.json`, covering color roles (not raw hexes), spacing scale (4-pt), radius, elevation, typography scale, and motion durations. Generate:
  - Flutter `ThemeExtension`s.
  - CSS custom properties for both Next.js apps.
  - Reuse any existing token/theme files; do not create a parallel theme.
- **Color roles:** `surface`, `surfaceVariant`, `onSurface`, `primary`, `onPrimary`, `success`, `warning`, `danger`, `info`, and `roleOwner/Manager/Desk/Trainer`. Role colors come from the mobile Team & Access chips.
  - Every role pair must meet WCAG AA contrast (4.5:1 for text, 3:1 for large text and icons) in both light and dark themes.
- **Typography:**
  - Use the platform font with fallbacks that cover Arabic/Urdu/Devanagari/CJK (for example Noto families) so localized text never renders as tofu boxes.
  - Never hard-code a line height that clips diacritics.
- **Component inventory:** build these once per platform and reuse them everywhere. Audit for one-off duplicates and replace them.
  - `AppButton` (primary/secondary/destructive/ghost, with a busy state)
  - `AppTextField` (label, helper, error, counter)
  - `PhoneField` (E.164, country picker)
  - `MoneyText` / `MoneyField` (currency-aware)
  - `DateTimeText` (locale + branch timezone)
  - `StatusChip` (one mapping table from status enum → label + color)
  - `EmptyState`, `ErrorState`, `SkeletonList`, `OfflineBanner`, `StaleDataBar`
  - `ConfirmDestructiveSheet`, `PermissionGate`, `PaginatedList`, `SearchBar` (debounced)
  - `OrgSwitcher`, `QuotaBanner`, `ApprovalBadge`

### 2.5 Universal screen-state contract

Every data-driven screen or section implements **all** of these. Test with widget/component tests (§15).

| State | Trigger | Must show |
|---|---|---|
| **Initial loading** | No cached data | Skeleton shaped like the content. No full-screen spinner after 300 ms. |
| **Refreshing** | Cached data exists | Cached data plus a subtle progress indicator. Never blank the screen. |
| **Empty** | 200 with zero items | Plain explanation and the one action that fixes it (e.g. "Add your first branch"), gated by permission. |
| **Error (retryable)** | Network / 5xx / timeout | Message, **Retry** button, and a short `requestId` the user can quote to support. |
| **Error (not retryable)** | 4xx business error | The server's `error.message`, mapped through the error-code copy table (§4.2), plus the one next step. |
| **Permission denied** | 403 `forbidden` | "You don't have access to X. Ask your owner." Never a raw 403. |
| **Offline** | Connectivity lost | Persistent banner. Mutations disabled with an explanation. Cached reads still visible, with an age ("Updated 5 min ago"). |
| **Stale** | Realtime event says data changed | In-place refresh; no scroll jump. |
| **Partial** | One section of a dashboard failed | That section alone shows its error; the rest render. |

### 2.6 Forms and validation

- **One schema per form, owned by the backend.** Validation runs on the server for every request (SEC-06).
- Clients mirror the same rules for instant feedback:
  - Web: a shared schema module.
  - Flutter: validators in the feature's domain layer.
- A server `422 validation_failed` returns `error.details.fields = { fieldName: code }`. Forms map it back onto the fields.
- Validate on blur, then on change once a field has been touched. Never validate on first keystroke.
- **Multi-step wizards** (Add Branch, onboarding, web registration, checkout):
  - Persist the draft **locally after every step** (Flutter: local store; web: server-side draft keyed to the user, because registration already has server steps).
  - Resume after app kill or tab close.
  - On final submit, send one **idempotency key** created when the draft was created (REL-01).
- **Phone numbers:** stored and sent in E.164 format, displayed in national format (GLB-04).
- **Money input:** locale decimal separator, currency from context, integer minor units sent to the API (PAY-02).
- **Names and addresses:** no ASCII-only validation. Allow any Unicode letters. Don't require a postal code or state everywhere (GLB-06).

### 2.7 Destructive actions

One pattern: `ConfirmDestructiveSheet`.
1. State exactly what will happen, including cascades. For deleting a branch: its membership plans deactivate, member memberships are cancelled, staff are removed.
2. Re-authenticate for high-impact actions: delete branch/organization, revoke an owner-level team member, refund above a threshold, change payout account. Reuse the existing password or Google/Apple re-auth from branch deletion.
3. Show the server's second-level confirmations verbatim. The existing `409 last_branch_in_organization` flow is the reference pattern.
4. Keep the button disabled until the conditions are met (the §9.8 fix is the reference implementation).
5. After success: show a toast with **Undo** where the server supports restore (branch restore), and invalidate the affected caches per §5.3.

### 2.8 Lists: search, filter, sort, pagination

- **Cursor pagination everywhere** (API-08). Page size 20 on mobile, 25–50 on the web.
- **Search:** 300 ms debounce, minimum 2 characters. Cancel in-flight requests when the query changes (dio `CancelToken` / `AbortController`).
- **Web:** filters, sort, and page cursor live in the **URL query string** so views are shareable and survive a refresh.
- **Mobile:** filter state is kept per tab (the StatefulShellRoute already keeps stacks alive).
- Restore scroll position on back navigation.
- Always show the result count or "no results for X" with a clear-filters action.

### 2.9 Dialogs vs bottom sheets

| Platform | Use for | Pattern |
|---|---|---|
| Mobile | Choices, confirmations, short forms (≤ 3 fields) | Bottom sheet |
| Mobile | Blocking alerts | Center dialog |
| Web | Confirmations | Modal dialogs |
| Web | Editing a record while seeing the list | Side sheet (drawer) |

- Every sheet and dialog is dismissible with back/Escape unless a mutation is in flight.
- Focus is trapped (web), and returned to the trigger element on close.

### 2.10 Deep links and notification navigation

- **One route table** per app drives the router, deep links, and notification taps.
- **Notification payload contract** (all platforms):

```json
{ "type": "approval.requested", "tenantId": "t_1", "orgId": "o_2", "branchId": "b_3",
  "entityId": "apr_9", "route": "/host/approvals/apr_9", "mode": "host", "v": 1 }
```

- **Resolver order:**
  1. Is the user authenticated? Otherwise log in, then resume.
  2. Is the device user the notification's user? Otherwise drop it silently.
  3. Switch mode (host/traveler) and tenant/org context **before** pushing the route.
  4. Check the permission.
  5. Navigate.
  6. If the entity is gone, show "This item is no longer available" and fall back to the list.
- **Universal links / App Links:** `https://gymsera.com/gyms/:id` opens the app's gym detail if it's installed, otherwise the website. Keep one mapping table shared with the web routes.

### 2.11 Accessibility (WCAG 2.2 AA target)

- Touch targets at least 48×48 dp (Android) / 44×44 pt (iOS). Icon buttons have semantic labels / `aria-label`.
- Supports 200% text scaling without clipping: no fixed-height text containers; wrap or scroll instead.
- Screen reader order follows visual order. Status chips announce their text, not their color.
- Every chart has a data-table alternative.
- **Web:** keyboard reachable, visible focus ring, skip-to-content link, form errors linked with `aria-describedby`.
- Honor reduced-motion settings.

### 2.12 Duplicate actions and race conditions (UI side)

- Every mutating button has a **busy state** that ignores taps while its request is in flight.
- Every mutation carries an **Idempotency-Key** created per user intent and reused on retry (REL-01). The server is the real guard; the busy state is courtesy.
- Pull-to-refresh and realtime refresh coalesce: one in-flight fetch per query key.
- Optimistic updates are allowed only for reversible, non-money actions (mark notification read, favourite). Money, capacity, and permissions are always server-confirmed.

### 2.13 Confusing or unnecessary flows (fix list)

Each is detailed in §12:
- UX-01: two host onboarding flows.
- UX-02: host billing inside the member portal.
- UX-03: three host navigation systems.
- UX-04: "Subscriptions" meaning two different things.
- UX-05: "Gyms › Gyms".
- UX-12: separate Staff screen in the CMS.
- UX-13: missing CMS parity.
- UX-06: Traveler-visibility toggle reads like a request queue.
- UX-07: "pay later" registration with no explained consequence.


---

## 3. Module-by-module architecture

### 3.1 Layering rules (enforced in review; add lint rules where possible)

#### Flutter (`gyms_era`)

```
lib/
  core/            router, theme/tokens, http client, error mapping, logging, env
  core/session/    AuthSession (tokens, refresh, logout, active context)   ← one owner
  core/realtime/   RealtimeClient (Socket.IO lifecycle)                     ← one owner
  core/push/       PushService (FCM token lifecycle, tap routing)          ← one owner
  core/storage/    secure storage (tokens), local cache (drafts, last-known data)
  features/<module>/
     data/         <Module>Api (dio calls only, DTO <-> model), <Module>Repository
     domain/       models (immutable), pure rules (formatting, validation mirrors)
     application/  Riverpod Notifiers/Providers — state + orchestration
     presentation/ screens/widgets — read providers, call notifier methods, nothing else
  platform/        billing (StoreKit/Play), printer, QR scanner, biometrics — behind interfaces
```

Rules:
- Widgets never call `dio` or repositories directly. They read providers and call notifier methods.
- Repositories never import Flutter UI.
- Platform plugins are used only from `platform/`, behind an interface, so tests can fake them.
- Realtime events never mutate widget state. `RealtimeClient` → repository/provider invalidation (§9.3).
- **Reuse:** keep the existing Riverpod setup and the existing billing notifier with `_pendingProductId`. Move code into this layout only when touching it for an issue — no big-bang move.

#### Backend (`gymsera_be`)

```
routes/        path + middleware chain only
middleware/    requestContext → rateLimit → authenticate → resolveTenant → authorize/can
               → validate(schema) → idempotency → controller ; errorHandler last
controllers/   parse req, call ONE service method, shape response — no business logic
services/      business rules, transactions, cross-DB orchestration (the only place)
models/        Sequelize models (platform/ and tenant/)
jobs/          cron + outbox processors + reconciliation sweeps
integrations/  apple, google, stripe, fcm, email, sms, storage — thin clients
```

Rules:
- Controllers never open transactions.
- Services receive `(ctx, input)`, where `ctx = { requestId, user, tenant, tenantDb, grants }`.
- Nothing reads `req` below the controller.

#### Next.js (`gymsera_cms`, `gymsera_web`)

- `app/` routes contain server components for data reads where possible. Client components hold interactive state only.
- There is **one API client module** per app, with auth, `requestId` propagation, and error mapping.
- Server state uses **the data-fetching library already in the repo** (check for TanStack Query or SWR). If neither exists, adopt TanStack Query in the CMS only. Never mix two libraries.
- Role gating in the UI uses `PermissionGate`, fed by `/me` grants. It is never the security boundary (§8).

### 3.2 Module catalogue

Each module lists its owner service(s), invariants, surfaces, and the related issues.

| Module | Owner (backend) | Key invariants | Surfaces | Issues |
|---|---|---|---|---|
| **Identity & sessions** | `auth.*` services, `/auth`, `/me` | Refresh rotation; one session per device; logout revokes refresh + FCM token | all | AUTH-01…08 |
| **Tenant onboarding & KYC** | `/tenants/*`, `tenant-provisioning.service.js` | Every application → PENDING_REVIEW; provisioning idempotent and resumable | web wizard, admin | FLOW-01…04, SEC-10 |
| **Organization & branch** | `/host` branch/org services | Org never empty; status changes only via `deleteBranch`/`restoreBranch`; all creators call one `createBranch` | app, CMS, admin | CAP-*, FLOW-05 |
| **Capacity** | `subscription-quota.service.js`, `reconcileCapacity`, `CapacityEvent` | Invariant §1.3; ledger idempotent; drift audited | all | CAP-01…07 |
| **GymsEra billing (host plan)** | `/billing`, `subscription-migration.service.js`, `stripe-billing.service.js` | One catalog; one ACTIVE entitlement row; server-verified purchases only | app, CMS, web, admin | BILL-01…16 |
| **Membership plans & memberships** | `/membership-plans`, `/subscriptions` | Membership state machine; expiry in branch timezone | app, CMS, member web | FLOW-06…08, GLB-01 |
| **Check-in / attendance** | `/attendance` | One check-in per membership per rule window; QR tokens short-lived | app, CMS | FLOW-09, SEC-11 |
| **Payments, invoices, ledger** | `/payments`, `/invoices`, `/ledger` | Integer minor units; append-only ledger; closed days immutable; idempotent | app, CMS, member web | PAY-01…12 |
| **Team & access / approvals** | `/team`, `/approvals`, `approval.service.js`, `constants/permissions.js` | Assign only below your own level; approval execution idempotent | app, CMS | RBAC-01…06 |
| **Discovery, listings, reviews** | `/discovery`, listing content, `/admin/reviews` | Only approved and visible entities are public; reviews require verified membership | web, traveler app | FLOW-10, PERF-06 |
| **Messaging (inbox)** | messaging service + Socket.IO | Conversation membership checked on every read, write, and room join | app | RT-04…06 |
| **Notifications** | `/notifications`, FCM | Server-authoritative unread counts; dedupe by `notificationId` | app, CMS | RT-01…03, RT-07 |
| **Payouts** | `/host/payouts` | Payout requests go through approvals; bank details changes re-authenticated | app | PAY-10, SEC-13 |
| **Admin** | `/admin/*` | Every admin mutation audited; admin sub-roles | CMS | SEC-12, RBAC-06 |
| **Reporting & analytics** | `/reports`, admin analytics | Read replicas / pre-aggregates; tenant timezone bucketing | app, CMS | PERF-09, GLB-01 |

### 3.3 Parity matrix — mobile is the reference (v2)

**How to read it:**
- ✅ = exists and matches mobile.
- ⚠️ = exists but differs from mobile (bring it in line).
- ❌ = missing.
- — = not applicable to that surface.
- The **Backend** column lists what the server must provide so every client can use the same endpoints. The agent confirms each cell against the code first (§0.1 rule 1) and corrects this table in the same PR.

#### Host features

| Feature (mobile route) | Mobile | CMS host | Website | Backend requirement | Issue |
|---|---|---|---|---|---|
| Today dashboard (`/host/today`) | ✅ reference | ⚠️ Dashboard shows different cards | — | One `GET /host/dashboard?branchId=` used by both | UX-18 |
| Organization selector (strip above Gyms tabs) | ✅ | ❌ single-org `/gym/profile` | — | Every `/host/*` list accepts `orgId` | UX-14 |
| Tenant capacity banner → My plan | ✅ | ❌ | — | `GET /host/branch-quota` (exists) | UX-13 |
| Add branch: 5-step wizard, attempt first, upsell only on 403, replay | ✅ | ⚠️ plain Add/Edit form, no attempt-first/upsell | — | `createBranch` + `403 branch_limit_reached` (exists) | UX-19 |
| Delete / restore branch (re-auth, last-branch 409, restore re-checks capacity) | ✅ | ⚠️ verify it uses the same endpoints and dialogs | — | `POST /host/branches/:id/delete|restore` only | CAP-03, UX-19 |
| New organization: build new branch **or** move existing | ✅ | ❌ | ⚠️ only first-time signup | `POST /host/organizations` (`branchSource`) | UX-20 |
| Organization editor: photos, info, amenities, hours, location, membership packages, boost | ✅ | ⚠️ logo/cover/gallery/info/business details only | — | One listing-content API for both | UX-21, BILL-18 |
| Branch listing content (`/host/branches/:id/listing-content`) | ✅ | ❌ | — | same | UX-21 |
| Members / memberships / payments / plans (inner tabs) | ✅ | ✅ (separate pages) | — | Same list endpoints, cursor pagination | API-05 |
| **Team & access** (unified RBAC) | ✅ **reference** | ⚠️ old Staff screen + Trainers | — | `/team` only; legacy staff/admin endpoints retired | UX-12, RBAC-07 |
| **Approvals** (Waiting on you / Your requests) | ✅ | ❌ | — | `/approvals` (exists) | UX-13 |
| Staff requests per branch (`/host/gyms/:branchId/staff-requests`) | ✅ | ❌ | — | same endpoint | UX-22 |
| Invoices & billing (`/host/invoices`) | ✅ | ✅ `/gym/invoices` | — | same | — |
| Ledger & daily close | ✅ | ❌ | — | `/ledger` | UX-13 |
| Payouts & request payout | ✅ | ❌ | — | `/host/payouts` | UX-13 |
| Analytics / branch performance | ✅ | ⚠️ Reports (3 charts) | — | One reports API, branch-timezone buckets | UX-18 |
| Notifications | ✅ | ❌ (no bell / feed) | — | `/notifications` + socket | UX-23 |
| Inbox (conversations) | ✅ | ❌ | — | messaging API | UX-23 (decide: CMS phase 2) |
| My GymsEra plan (`/host/subscription/mine`) | ✅ | ✅ `/settings/billing` (read-only for IAP) | ⚠️ `/gymsera-billing` inside the member portal | `GET /host/subscription/current` | UX-02 |
| Buy/change plan (`/host/subscription/upsell`) | ✅ (App Store / Play) | — (links to the app) | ⚠️ Stripe at signup only | purchase-intent + sync + Stripe | BILL-07, BILL-14 |
| Become a host (onboarding wizard) | ✅ `/become-host/listing/step1..5` | — | ⚠️ `/gym-owner/register` (7 steps) + legacy `/onboarding` | One `/tenants/*` flow; same fields and validation | UX-01, UX-24 |
| Scan QR / check-in | ✅ | ⚠️ manual check-in only | — | `POST /attendance/check-in` | — |
| Trainers (bookable profiles) | not in the mobile map | ✅ `/gym/trainers` | — | same | **web-only** — decide (R-14) |

#### Traveler / member features

| Feature | Mobile | Website | Backend | Issue |
|---|---|---|---|---|
| Discovery: home, search, gym detail, organization detail | ✅ | ✅ public pages | `/discovery/*` | — |
| Wishlist | ✅ | ❌ | same | UX-25 (optional) |
| Checkout (plan → review → pay → confirmed) | ✅ | ❌ (members can't buy on the web) | same checkout API | UX-25 |
| My memberships + check-in QR | ✅ | ⚠️ "My Subscriptions" (list/detail, no QR) | same | UX-25 |
| Payment history | ⚠️ inside plan detail | ✅ `/payments` | same | — |
| Account statement | ❌ | ✅ `/account-statement` | same | **web-only** — decide (R-14) |
| Staff-invite acceptance | ✅ in Traveler inbox | ❌ | `/staff-invites/*` | UX-22 |
| Profile, sessions, delete account | ⚠️ verify | ⚠️ verify | AUTH-02, AUTH-07 | — |

#### Verified status (Prompt 0, 2026-09-26)

The tables above are the target. This is what the code actually does today. Paths as in §12.13.

**Host features**

| Feature | Mobile | CMS host | Website | Evidence |
|---|---|---|---|---|
| Today dashboard | ✅ `/host/today-summary` | ⚠️ `/reports/dashboard` + admin stats, different cards | — | `app/lib/core/constants/api_constants.dart:133`; `cms/src/app/(dashboard)/dashboard/page.tsx:35-76` |
| Organization selector | ✅ | ❌ single org (first `Gym` row) | — | `be/src/services/gym.service.js:165-166` |
| Capacity banner | ✅ `/host/branch-quota` | ❌ (quota shown only on `/settings/billing`) | — | `cms/src/app/(dashboard)/settings/billing/page.tsx:68` |
| Add branch (attempt-first / upsell) | ✅ | ⚠️ plain form, generic error | — | `cms/src/app/(dashboard)/gym/branches/page.tsx:154-188` |
| Delete / restore branch | ✅ (re-auth sent) | ⚠️ delete without re-auth, no restore, no last-branch confirm | — | `be/src/controllers/gyms.controller.js:70-100` |
| New organization (new / move / reserve) | ✅ | ❌ | ⚠️ first signup only | `be/src/controllers/host.controller.js:396-640` |
| Organization editor | ✅ (Boost is fake — NEW-BOOST) | ⚠️ logo/cover/gallery/info | — | `cms/src/app/(dashboard)/gym/profile/page.tsx` |
| Branch listing content | ✅ | ❌ | — | |
| Members / memberships / payments / plans | ✅ | ✅ separate pages (legacy `/gyms/*` routes) | — | `cms/src/lib/api/gym.ts` |
| Team & access | ✅ `/team` (old `/host/admins`, `/host/profile/staff` routes still present) | ❌ old Staff screen on `/gyms/staff` | — | UX-12 |
| Approvals | ✅ `/approvals` | ❌ | — | |
| Staff requests per branch | ✅ | ❌ | — | |
| Invoices & billing | ✅ | ✅ `/gym/invoices` | — | |
| Ledger & daily close | ✅ `/ledger` | ❌ | — | |
| Payouts | ❌ **fake UI** (hard-coded success, no API) | ❌ | — | PAY-10 / NEW-09 |
| Analytics / branch performance | ✅ `/reports/*` | ⚠️ monthly report page | — | `cms/src/app/(dashboard)/gym/reports/page.tsx:40` |
| Notifications | ✅ | ❌ | — | UX-23 |
| Inbox | ✅ | ❌ (out of scope, R-18) | — | |
| My GymsEra plan | ✅ `/host/subscription/mine` | ⚠️ `/settings/billing`, but "Request a Manual Plan" self-grants a paid plan (NEW-06) | ⚠️ `/gymsera-billing` in member portal | `cms/src/lib/api/host-billing.ts:47-49` |
| Buy / change plan | ✅ App Store / Play | — | ⚠️ Stripe card option live in signup (must be off, R-7) | `web/src/app/gym-owner/register/page.tsx:355-372` |
| Become a host | ✅ `/become-host/*` | — | ⚠️ `/gym-owner/register` + legacy `/onboarding` | UX-01, UX-24 |
| Scan QR / check-in | ✅ `/attendance/qr-scan` + `/manual` | ⚠️ manual only, via a second alias `/attendance/check-in` | — | `be/src/routes/attendance.routes.js:344-352` |
| Trainers | not in mobile | ✅ `/gym/trainers` | — | web-only (R-14) |

**Traveler / member features**

| Feature | Mobile | Website | Evidence |
|---|---|---|---|
| Discovery | ✅ | ✅ | |
| Wishlist | ✅ `/me/saved-gyms` | ❌ | |
| Checkout | ⚠️ bank transfer / proof only; card screen is "coming soon" with a fake saved card | ❌ | SEC-09 |
| My memberships + QR | ✅ | ✅ list/detail **with QR** (`web/src/app/(dashboard)/subscriptions/[id]/page.tsx`, `web/src/components/features/qr-code-display.tsx`) | the §3.3 target table said "no QR" — corrected here |
| Payment history | ⚠️ inside plan detail | ✅ `/payments` | |
| Account statement | ❌ | ✅ | web-only (R-14) |
| Staff-invite acceptance | ✅ (legacy `/staff-invites`) | ❌ | FLOW-12 |
| Profile / sessions / delete account | ⚠️ "Delete account" only sets INACTIVE; no sessions screen | ⚠️ same; the privacy page promises purging that doesn't happen (`web/src/app/(public)/privacy/page.tsx:191`) | AUTH-02, AUTH-07 |

**Parity work order:**
1. Team & access + Approvals.
2. Organization selector + capacity banner.
3. Add/delete/restore branch flows.
4. New organization.
5. Ledger + Payouts.
6. Listing editor.
7. Notifications.
8. Traveler web features (optional).

---

## 4. API map

### 4.1 Conventions (apply to every endpoint; migrate gradually with a version flag)

- **Base:** `/api/v1`. There are no breaking changes without `/v2` or an additive field.
- **Success:** `200/201 { "data": ..., "meta": { "requestId", "nextCursor?" } }`.
- **Error:** `4xx/5xx { "error": { "code": "branch_limit_reached", "message": "human text", "details": {...}, "requestId": "..." } }`.
  - `code` is stable and machine-readable. Clients switch on `code`, never on `message`.
  - Keep the existing codes: `branch_limit_reached`, `account_over_quota`, `last_branch_in_organization`, `iap_subscription_active`, `branch_status_immutable_here`.
- **Pagination:** `?limit=&cursor=`, with an opaque cursor built from `(sortKey, id)`. Never `OFFSET` on large tables.
- **Idempotency:** every non-GET mutation accepts an `Idempotency-Key` header. It is **required** for money, capacity, billing, check-in, and enrollment (REL-01).
- **Timeouts:**
  - Server request timeout: 15 s (provisioning is the exception; see FLOW-02).
  - Client: 10 s connect/read on mobile, 15 s for uploads.
- **Retries (client):** only for GET and idempotent-key mutations, on network error, 408, 429 (honor `Retry-After`), 502, 503, and 504. Maximum 3, with exponential backoff and jitter. Never retry 4xx business errors.
- **Caching:** GETs return `ETag`, and clients send `If-None-Match`. Public discovery GETs set `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`. Authenticated GETs set `Cache-Control: private, no-store` unless ETag-validated.
- **Tenant resolution:** the tenant comes from the authenticated user's verified membership or `RoleAssignment` (plus the `X-Tenant-Id` header only as a *selector* among the tenants the user belongs to). It never comes from a body field (SEC-02).
- **Validation:** every route has a schema. Unknown fields are rejected (`strict`), which prevents mass-assignment (SEC-06).

### 4.2 Error-code copy table (single source)

- Keep a JSON map `code → { en: "...", ur: "...", ar: "..." , action: "open_upsell|retry|contact_owner|none" }` in the backend.
- Serve it via `GET /meta/error-copy` (cached for 24 h) so every client explains errors identically and translations live in one place.

### 4.3 Endpoint map (domains; the agent fills in the exact paths from the routers)

| Domain | Key endpoints | Auth | Idempotency-Key | Cache | Notes |
|---|---|---|---|---|---|
| Bootstrap | **`GET /me/bootstrap`** *(new, replaces startup waterfall)* | user | — | ETag | Returns user, contexts (tenants/roles/mode), active tenant summary, branch quota, unread counts, feature flags, min app version, error-copy version. PERF-01 |
| Auth | `/auth/login`, `/auth/otp/*`, `/auth/social/google`, `/auth/social/apple`, `/auth/refresh`, `/auth/logout`, `/auth/sessions` | public / user | OTP send: rate-limited, not idempotent | none | AUTH-* |
| Tenant onboarding | `/tenants/register`, `/:id/verify-otp`, `/:id/submit-gym-profile`, `/:id/select-package`, `/:id/finalize-application` | applicant | finalize: yes | none | FLOW-01 |
| Host capacity | `GET /host/branch-quota` | host grants | — | ETag, 30 s | Tenant-wide; single provider on clients (mobile doc §9.5) |
| Organizations | `GET /host/organizations`, `POST /host/organizations` (`branchSource: new|existing`) | `can(org.create)` | yes | ETag | Slot donor inside the transaction |
| Branches | `POST /host/branches`, `PATCH /host/branches/:id` (no status), `POST /:id/delete`, `POST /:id/restore`, `POST /:id/move` | `can(branches.*, {branch})` | yes | ETag | Only doors for status |
| Billing (host) | `GET /billing/plans` (public catalog), **`POST /billing/purchase-intent`** *(new, BILL-07)*, `POST /billing/{ios|android}/sync`, `POST /billing/stripe/checkout-session`, `POST /billing/restore`, `GET /host/subscription/current` | host owner/ORG_ADMIN | yes | plans: public 5 min | Webhooks below |
| Billing webhooks | `POST /billing/webhooks/apple`, `/google` (Pub/Sub push), `/stripe` | signature only | provider event ID | none | BILL-12 inbox |
| Legacy manual plan | `POST /host/subscription/upgrade` | host owner | yes | — | 409 guard kept; frozen for new sales per BILL-10 |
| Membership plans | `/membership-plans` CRUD | `can(plans.*)` | create: yes | ETag | |
| Memberships | `/subscriptions` list/detail, enroll, freeze, cancel, renew | `can(subscriptions.*)` | yes | ETag | Via approval engine where tiered |
| Check-in | `POST /attendance/check-in` (QR token or manual) | `can(checkins.create)` | yes (key = QR token nonce) | — | FLOW-09 |
| Payments | `POST /payments` (record), `POST /payments/:id/verify`, `POST /payments/:id/refund` | `can(payments.*)` | **required** | — | PAY-* |
| Invoices | list/detail, issue, void | `can(invoices.*)` | yes | ETag | void via approval |
| Ledger | `GET /ledger/days`, `POST /ledger/days/:date/close`, adjustments | `can(ledger.*)` | yes | ETag | PAY-06 |
| Team | `/team` list, invite, update grants, revoke | `can(governance.*)` + level rule | yes | ETag | RBAC-* |
| Approvals | `/approvals` list (waiting on me / mine), approve, reject | `can(<module>.approve)` | yes | ETag | execute idempotent |
| Discovery | `/discovery/gyms`, `/discovery/gyms/:id`, `/discovery/cities` | public | — | public CDN | PERF-06 |
| Member portal | `/member/*` | member (self only) | yes for mutations | ETag | SEC-01 IDOR |
| Notifications | list, mark-read, mark-all-read, `POST /notifications/devices` (register FCM), `DELETE /notifications/devices/:id` | user | — | ETag | RT-01 |
| Messaging | conversations, messages (cursor), send | participant | yes (client message ID) | — | RT-05 |
| Admin | `/admin/tenants*`, `/:id/approve|reject|suspend|reactivate`, `/:id/capacity-audit`, `/admin/billing-plans*`, `/admin/packages*`, `/admin/reviews*`, `/admin/cities*`, `/admin/reports*` | admin sub-roles | yes for mutations | ETag | SEC-12 audit |

### 4.4 Backend query rules

- **No N+1.** List endpoints load their relations with `include` or a second batched `WHERE id IN (...)` query. Add a test that counts queries for every list endpoint (§15).
- **Select only the columns the response uses.** List DTOs are smaller than detail DTOs.
- **Cross-DB counts** (for example, active branches per org for the admin tenant list) use cached aggregates refreshed by events. Never loop over tenant databases inside one request (PERF-08).
- **Index every foreign key and every `(tenant-scope, status, createdAt)` list filter.** The agent generates a list of missing indexes from the slow-query log in staging (OBS-04).

---

## 5. State-management map

### 5.1 Flutter provider graph (Riverpod) — target

```
authSessionProvider (keepAlive)                ← tokens, user, active mode/tenant
 └─ bootstrapProvider (keepAlive, refetch on resume >5 min, on tenant switch)
     ├─ tenantQuotaProvider (keepAlive)         ← THE ONLY reader of maxBranches/buildable/remaining (mobile §9.5)
     ├─ grantsProvider (keepAlive)              ← permissions for PermissionGate
     ├─ unreadCountsProvider (keepAlive)        ← updated by realtime + push, seeded by bootstrap
     └─ organizationsProvider (keepAlive)       ← list of orgs
          └─ selectedOrgIdProvider              ← persisted per user
               ├─ branchesProvider.family(orgId)      (derives capacity numbers FROM tenantQuotaProvider)
               ├─ membersProvider.family(orgId, filter)   paginated, autoDispose
               ├─ membershipsProvider.family(orgId, filter)
               ├─ paymentsProvider.family(orgId, filter)
               └─ membershipPlansProvider.family(orgId)
billingNotifierProvider (keepAlive)             ← purchase stream owner (one listener, app-wide)
realtimeClientProvider (keepAlive)              ← socket lifecycle
```

Rules:
- A mutation calls the repository, then **invalidates exactly the keys in §5.3**. It never hand-edits another provider's state.
- `family` + `autoDispose` for anything filter- or page-shaped. `keepAlive` only for app-wide singletons above.
- Use `ref.watch(provider.select(...))` in widgets to avoid rebuilding on unrelated fields (PERF-02).
- Exactly **one** listener on `InAppPurchase.purchaseStream`, created at startup (it must exist before any purchase, so redelivered transactions are processed). This is already the design; add a test for it.

### 5.2 Web (CMS/web) query keys

```
['me','bootstrap'] · ['quota'] · ['orgs'] · ['branches', orgId] · ['members', orgId, filters]
['memberships', orgId, filters] · ['payments', orgId, filters] · ['ledger', branchId, date]
['approvals', 'waiting'|'mine'] · ['team', orgId] · ['billing','current'] · ['billing','plans']
['admin','tenants', filters] · ['admin','tenant', id, tab]
```

### 5.3 Invalidation matrix (mutation → invalidate)

| Mutation | Invalidate (mobile provider / web key) |
|---|---|
| Create/restore/delete/move branch | `tenantQuota`, `organizations`, `branches(orgId)` (+ source and target org for move), `bootstrap` if the org count changed |
| Create organization | `organizations`, `tenantQuota`, `branches(newOrgId)`, **Listings screen provider** (FLOW-05 / stale Listings bug) |
| Purchase / restore / webhook-driven plan change | `billing/current`, `tenantQuota`, `bootstrap` |
| Enroll member / record payment / freeze | `members(orgId)`, `memberships(orgId)`, `payments(orgId)`, `today` dashboard |
| Close ledger day / adjustment | `ledger(branchId, date)`, `today` |
| Approve/reject | `approvals(*)`, `unreadCounts`, plus the module the approval executed into |
| Team grant change | `team(orgId)`; **the affected user's** `grants` (via realtime `grants.changed` event, RT-08) |
| Mark notification read | `unreadCounts` (optimistic) |

---

## 6. Database and data-flow map

### 6.1 Ownership

| Table | DB | Written by (only) |
|---|---|---|
| `Tenant` | platform | tenants/admin services |
| `GymListing` (+ `reservedSlots`) | platform | org services, `subscription-quota.service.js` |
| `TenantSubscription` | platform | billing sync services, `requestProviderChange`, `reconcileRenewalStatus`, admin assign (through the same service) |
| `BillingPlan` | platform | admin billing-plans service |
| `CapacityEvent` | platform | capacity service only (append-only) |
| **`BillingEvent`** *(new unless an equivalent exists — BILL-12)* | platform | webhook receivers (append) + billing processor (status) |
| **`AdminAuditLog`** *(new unless equivalent — SEC-12)* | platform | admin middleware |
| **`UserSession`**, **`DeviceToken`** *(reuse if present — AUTH-02, RT-01)* | platform | auth / notifications services |
| **`IdempotencyRecord`** *(REL-01)* | platform (for platform ops) + tenant (for tenant ops) | idempotency middleware |
| `Branch` | tenant | `createBranch`, `deleteBranch`, `restoreBranch`, `moveBranch`, `updateBranch` (non-status) |
| `Payment`, `Invoice`, `LedgerDay`, `LedgerEntry` | tenant | payments/ledger services |
| `RoleAssignment`, `ApprovalRequest` | tenant | team/approval services |
| **`Outbox`** *(new in tenant DB — CAP-02)* | tenant | any service whose tenant-DB transaction needs a platform-DB side effect |

### 6.2 Cross-database writes — the outbox rule

- MySQL cannot commit a transaction across two databases. The current `deleteBranch` commits the tenant DB, then credits the platform DB with 3 in-process retries.
- If the process dies between those two steps, or all 3 retries fail, the credit is lost and only `auditCapacity` notices.

**Rule:** any tenant-DB change that requires a platform-DB effect writes an `Outbox` row **in the same tenant transaction**. The payload carries the `idempotencyKey` that the platform side already honors.

- A processor (runs after the request, plus a sweep every minute) applies it and marks it done.
- The existing idempotent `CapacityEvent` write makes replays safe.
- This reuses the existing idempotency mechanism; it only makes delivery durable.

**Applies to:** branch delete, restore, create, and move (when they touch `reservedSlots`), org auto-deactivation, and member-count aggregates for admin lists.

### 6.3 Money representation

- Store amounts as **integer minor units** (`BIGINT amountMinor`) plus `currency CHAR(3)`, or as `DECIMAL(14,2)` if that's what exists today and the migration is too risky.
- **Never** use JS `Number` arithmetic on money. Use integer minor units end to end (PAY-02).

### 6.4 Time representation

- All timestamps are stored in **UTC** (`DATETIME` in UTC, or `TIMESTAMP`).
- Every Branch has an **IANA timezone** (`Asia/Karachi`, `Europe/London`, …).
- Business dates (ledger day, membership expiry, "today" on the dashboard) are computed **in the branch timezone** and stored as a `DATE` alongside (GLB-01).

### 6.5 Migration policy

- Every schema change is a reversible migration: expand → migrate → contract.
- Tenant-DB migrations run through a versioned runner across all tenant databases.
  - It records `schemaVersion` per tenant.
  - It is resumable and has a per-tenant failure report.
  - It is **never** run as a side effect of `getConnection`. That is exactly what caused §9.6.


---

## 7. Subscription and payment architecture

There are **two separate money systems. Never mix them.**

| | **A. GymsEra plan (host → GymsEra)** | **B. Memberships (member → gym)** |
|---|---|---|
| What is sold | Branch capacity (`BillingPlan` tiers 1…10) | A branch's `MembershipPlan` |
| Rails | Apple IAP, Google Play Billing, Stripe (web), Manual (bank transfer) | Cash, bank transfer, card, wallet, online, POS — recorded or collected by the gym |
| Store IAP required? | Yes, on iOS/Android for a digital service sold in-app (unless the product decision in BILL-16 changes this) | **No.** Gym access is a real-world service consumed outside the app, so a card/payment gateway is allowed. Verify against current store rules. |
| Entitlement | `TenantSubscription` (one ACTIVE row) → `maxBranches` | `MemberSubscription` state machine |
| Ledger | Platform invoices (`PlatformInvoice`) | Tenant `Payment` / `Invoice` / ledger |

### 7.1 One catalog (locked, extended)

- **`BillingPlan` is the only commercial catalog.** Each row holds:
  - `branchCount`
  - Per-currency prices
  - Provider mappings (`iosProductId`, `androidProductId` + `basePlanIds`, `stripePriceIds` per currency)
- **Legacy `PlatformPackage` is frozen (BILL-10):**
  - It cannot be selected for new sales.
  - Existing MANUAL subscribers are grandfathered.
  - A manual/bank-transfer sale is **a MANUAL `TenantSubscription` against a `BillingPlan` tier**. The payment method is manual; the catalog is still the same one.
  - The website's Package step and the CMS "Request a Manual Plan" both read `BillingPlan`.
- **Prices:**
  - `BillingPlan` gets a currency dimension (BILL-11).
  - Apps **always display the store's localized price** from `ProductDetails`, never the catalog number.
  - The web displays the Stripe price for the visitor's currency.
  - The catalog price is the reference and the admin intent.

### 7.2 Three prices (refined)

1. **Catalog price.** Admin intent. Editing it never changes live provider prices or subscriber prices (unchanged).
2. **Provider price.** The live store/Stripe price.
   - Stripe sync stays automatic.
   - Add a **read-back verifier** (BILL-15): a daily job reads the actual provider prices and flags any mismatch with the catalog in admin.
3. **Subscriber price.** `TenantSubscription.amount` + `currency`.
   - Captured at purchase.
   - Not rewritten by catalog edits.
   - **Updated when the provider actually charges a different amount**: store price increases, country pricing, a Stripe price migration. The mirror must tell the truth (BILL-05).

### 7.3 `TenantSubscription` additions (additive migration; same table, no new entitlement system)

```
state            extend enum: + GRACE, ON_HOLD, PAUSED, REVOKED      (keep existing values)
autoRenew        BOOLEAN                    -- separate from state
currentPeriodEnd DATETIME (UTC)             -- from provider, never computed locally
pendingChange    JSON NULL {branchCount, productId, effectiveAt}      -- deferred downgrade
appAccountToken  CHAR(36) NULL              -- tenant binding sent at purchase (BILL-01)
currency         CHAR(3)
storefront       VARCHAR(8) NULL            -- country of the store account
lastVerifiedAt   DATETIME
duplicateBilling BOOLEAN DEFAULT false      -- superseded row still billing at provider
UNIQUE (platform, externalOriginalTransactionId)   -- if not already unique
```

The **one-ACTIVE-row invariant stays**, with one change: `resolveMaxBranches` treats `ACTIVE` **and `GRACE`** as entitling (BILL-04).

### 7.4 Subscription state machine (extended)

```
                 purchase verified
   (none) ─────────────────────────────▶ ACTIVE ◀──────────── recovered ──────┐
                                            │                                   │
          payment fails at renewal          ▼                                   │
                                          GRACE  (entitled; banner + email)     │
                                            │ grace ends unpaid                 │
                                            ▼                                   │
                                         ON_HOLD (not entitled; branches lock) ─┘
                                            │ hold ends unpaid
                                            ▼
     auto-renew off + period end ──────▶ EXPIRED (not entitled; read-only)
     refund / chargeback / revoke ─────▶ REVOKED (not entitled immediately)
     Google pause ─────────────────────▶ PAUSED  (not entitled until resume)
     replaced (cross-provider) ────────▶ PENDING_CANCEL / SCHEDULED ─▶ CANCELLED   (existing, unchanged)
```

- `autoRenew=false` **does not** change the state; the host stays entitled until `currentPeriodEnd`.
- `PENDING_MIGRATION` stays transaction-internal. Add an assertion or test that no committed row ever has it.

### 7.5 Flows (each is a test in §15)

#### 7.5.1 Purchase (new or upgrade)

```
UI (BranchPlanPickerScreen, the ONE purchase screen)
 → POST /billing/purchase-intent {planId, platform}             (BILL-07, new, thin)
     server returns: {mechanism: new|upgrade|downgrade|blocked,
                      replacementMode, appAccountToken, blocker?: {provider, manageUrl}}
     'blocked' when another provider's subscription is live with autoRenew on
     → UI shows "Your plan is billed through Apple — manage it there" (no purchase)
 → store purchase with applicationUserName/appAccountToken = tenant UUID
 → purchaseStream (single app-wide listener, _pendingProductId matching kept)
 → POST /billing/{ios|android}/sync {transaction}
     server: verify with store API → check binding (BILL-01) → Android: acknowledge
             SERVER-SIDE (BILL-06) → upsert row (direct path) or requestProviderChange
             (new externalId) → reconcileCapacity → respond with fresh entitlement
 → client: completePurchase ONLY after server 200
 → pending payment (Android PENDING) → "Payment pending" state; no replay (BILL-08)
 → entitled → replay the blocked action's identical payload (existing pattern)
```

#### 7.5.2 Restore

The same pipeline as purchase (existing). Add: a transaction bound to a **different** tenant returns `409 subscription_owned_by_other_account`. The UI then offers an explicit **Move my plan to this account** action, which requires re-authenticating on both accounts (BILL-01).

#### 7.5.3 Renewal

Direct upsert on a known `externalOriginalTransactionId` (existing) plus `reconcileRenewalStatus` (existing). Add:
- Update `amount`/`currency`/`currentPeriodEnd` from the provider response.
- If the row is superseded and the provider still reports it billing, set `duplicateBilling=true`, show a banner to the host, and send an email (BILL-09).

#### 7.5.4 Downgrade (BILL-03)

1. The picker shows a preview from the server: "Your plan covers 3 branches from Oct 25. You use 6. Choose 3 to keep."
2. If `activeBranches > newBranchCount`, the host **selects which branches remain entitled**. The server stores this as `pendingChange.keepBranchIds`.
3. Apply at the store:
   - Google: `ReplacementMode.deferred`.
   - Apple: in-group downgrade, which applies at renewal automatically. Read `renewalInfo.autoRenewProductId` into `pendingChange`.
   - Stripe: `schedule` / `proration_behavior: none` at period end.
4. At `effectiveAt` (webhook), `reconcileCapacity` runs as today. `reservedSlots` are trimmed first (existing). Real branches beyond the plan get `billingLock` per CAP-01, starting with the ones the host didn't keep.

#### 7.5.5 Cancel

The app never pretends to cancel a store subscription:
- iOS: deep link `https://apps.apple.com/account/subscriptions`.
- Android: `https://play.google.com/store/account/subscriptions?sku=<productId>&package=<pkg>`.
- Stripe: `cancel_at_period_end=true` via API or the Stripe Customer Portal.
- The UI then shows "Active until {date}".

#### 7.5.6 Cross-provider

Prevented before purchase by `purchase-intent` when possible. When it happens anyway, the existing `requestProviderChange` → `SCHEDULED` (Stripe) / `PENDING_CANCEL` (stores) applies, plus the `duplicateBilling` banner.

#### 7.5.7 Refund / chargeback / revoke (BILL-02)

- **Inputs:** Apple `REFUND` / `REVOKE`; Google `SUBSCRIPTION_REVOKED` + the **Voided Purchases API** in the daily sweep; Stripe `charge.refunded` / `charge.dispute.created` / `customer.subscription.deleted`.
- **Effect:** row → `REVOKED` → `reconcileCapacity` → CAP-01 locks.

#### 7.5.8 Expiry and lapse

- EXPIRED or ON_HOLD → `maxBranches = 0`.
- Every branch gets `billingLock` (read-only: data visible, no new members, sales, or plans).
- Existing members' check-ins continue for a **configurable member grace** (default 7 days), so the gym's own customers aren't punished on day one. This is a product decision, recorded in §14.
- Data is retained per policy; there is no automatic deletion without repeated notices.

#### 7.5.9 Admin assign/revoke

- Goes through the **same service** as a MANUAL provider sale, with a required `expiresAt`, a reason, and an `AdminAuditLog` row.
- The existing `409 iap_subscription_active` guard stays.

#### 7.5.10 Web registration with card (FLOW-03)

- The Stripe Checkout that starts at the wizard's Payment step must not create a second entitlement when admin approval later auto-creates a subscription from the selected package.
- **Rule:** at approval, `tenant-provisioning` looks for an existing provider-backed row for the tenant.
  - If one exists, it links and activates it and does **not** create another.
  - If none exists, it creates MANUAL / pending-payment per the chosen method.
- **Payment timing:** use Checkout in `setup` mode (save the card) and start the subscription at approval, **or** charge immediately and **auto-refund on rejection**. Pick one, and write it into the refund policy.

#### 7.5.11 "Pay later" (UX-07, BILL-13)

- Approval with `payment=later` creates a MANUAL row in `GRACE` with `branchCount=1` and `currentPeriodEnd = approval + N days` (config).
- The host sees a countdown.
- It becomes ACTIVE when the admin verifies the bank transfer (an audited action), or EXPIRED when the period ends.
- This closes the "approved but never pays" leak.

### 7.6 Webhook / RTDN pipeline (BILL-12)

```
receive → verify signature (Apple JWS chain / Google Pub/Sub OIDC / Stripe secret)
       → INSERT BillingEvent (provider, providerEventId UNIQUE, rawPayload, receivedAt)
            duplicate → 200, stop
       → 200 immediately (never make the provider wait on business logic)
processor (inline after response, plus 1-minute sweep for unprocessed):
       → REFETCH truth from provider API (App Store Server API subscription statuses /
         Play subscriptionsv2.get / Stripe subscription) — ignore payload ordering
       → same sync function the client /sync uses (one code path)
       → reconcileCapacity → notify host if entitlement changed
       → mark processed | record error + attempt count (alert after 5)
daily reconciliation sweep: every non-EXPIRED row refetched through the same function
       + Google voided purchases since last run
```

### 7.7 Member payments (system B) — see §12 PAY-* for issues

**Record payment flow:**
```
POST /payments  (Idempotency-Key required)
  → can('payments.create') → approval engine (REQUEST tier → ApprovalRequest)
  → tenant tx: Payment(PENDING_VERIFICATION|COMPLETED) + LedgerEntry(append) +
    membership activation if applicable + invoice number from per-branch sequence row
    (SELECT … FOR UPDATE)
  → commit → receipt (print/share) → notify member
```

- **Refunds and voids** are new, reversing ledger entries. Nothing is ever updated in place.
- **Closed ledger days** are immutable. Corrections go on today's date as adjustments that reference the original.

---

## 8. RBAC and security model

### 8.1 Identity and contexts

- One `User` account can hold several **contexts**:
  - Traveler/member (always).
  - Host owner of tenant T.
  - Team member (role R at org O or branch B) of tenant T.
  - Platform admin with sub-role.
- **Access token** (short-lived, ≤ 15 min) contains: `sub` (userId), `sid` (session ID), `ctx` (active context: `mode`, `tenantId`), `ver` (the user's permissions version).
  - It does **not** carry fine-grained permissions.
- **Refresh token** (opaque, 30–90 days, rotated on every use, reuse detection revokes the whole session family). Stored hashed in `UserSession`.
- **Switching context** (`POST /auth/context {mode, tenantId}`) returns a new access token. The server checks that the user actually holds that context.
- **Coarse role** (`GYM_HOST`, …) stays for route-level gating but is **derived from DB on token issue**, never supplied by the client.

### 8.2 Authorization pipeline (every request)

```
authenticate (JWT sig, exp, sid not revoked)
 → resolveTenant (ctx.tenantId ∈ user's tenants; tenant.status allows this op;
                  open tenantDb via TenantDbManager)
 → authorize(coarse roles)                         [route level]
 → can(permission, {orgId?, branchId?})            [service level, BEFORE any read of the target]
      target entity loaded WITH scope filter (branchId IN grantedBranchIds)
      → not found (404) when out of scope — don't leak existence (SEC-01)
 → approval engine decides DIRECT vs REQUEST
```

**Grants cache:** in-memory per `(userId, tenantId, ver)` for 60 s. It is dropped immediately when `ver` changes (bumped on every grant change or revoke).

### 8.3 Team & Access — the approved RBAC design (reference: mobile)

**History.** The mobile app used to have two separate screens: **Admin Management** and **Staff Management**. Both wrote the same record and resolved to the same privileges, so the owner replaced them with one **Team & Access** screen. That design is **approved and final**. The backend must enforce it exactly, and the CMS must copy it.

#### 8.3.1 One record per person per place

```
RoleAssignment (tenant DB)            ← the ONLY thing that grants staff access
  id, userId, role, scopeType (ORG | BRANCH), scopeId,
  overrides  { "<permission>": "NONE" | "REQUEST" | "DIRECT" }   ← what the editor changes
  status     ACTIVE | REVOKED          ← "revoke" never deletes the row
  grantedBy, grantedAt, revokedBy, revokedAt, version
```

A person's **effective tier** for a permission is computed in one function, `resolveGrant()`:
1. Start from the **role preset** in `constants/permissions.js`.
2. Apply the person's **override** (Off / Needs approval / Direct), if any.
3. **Cap** it at what the person who granted it could grant (you can't give more than you have).
4. It is `NONE` if the assignment is REVOKED, or its branch or organization is deleted.

**Reuse:** `can()`, `approvalService.perform`, and `constants/permissions.js` all exist. `resolveGrant` is the one place that reads presets and overrides together. No other code computes permissions.

#### 8.3.2 Roles and labels (mobile's names win)

| Mobile label | Backend role | Level | Typical scope |
|---|---|---|---|
| Owner | `OWNER` | 100 | Tenant (all organizations) |
| Org admin *(shown only if anyone holds it)* | `ORG_ADMIN` | 80 | Organization |
| Manager | `MANAGER` | 60 | Organization or branch |
| Branch admin *(shown only if anyone holds it)* | `BR_ADMIN` | 40 | Branch |
| Front desk | `DESK` | 20 | Branch |
| Trainer | `TRAINER` | 20 | Branch |
| Cleaner | `SUPPORT` *(confirm, RBAC-02)* | 5 | Branch |

- One shared `roleLabels` table (per locale) is used by the app, CMS, notifications and emails.
- The filter chips show a live count for each role, and **roles with nobody in them are hidden** (mobile behaviour).
- **Level rule:** a person may only assign roles **strictly below** their own level. It is enforced on invite, on edit, and again on invite acceptance.

#### 8.3.3 The permission editor (3 choices — by design)

| UI choice (mobile wording) | Backend tier | Meaning |
|---|---|---|
| **Off** | `NONE` | Can't see or do it |
| **Needs approval** | `REQUEST` | Doing it creates an `ApprovalRequest` for someone with `APPROVE` |
| **Direct** | `DIRECT` | Does it immediately |

- `VIEW`, `APPROVE` and `FULL` **are not edited per person**. They come from the role preset: for example, a Manager can approve requests at their branch, and an Owner has FULL.
- If a person's effective tier comes from the preset and isn't one of the three choices, the editor shows it as a **read-only label** (for example "Can approve · from Manager role"). **Saving never changes it** (RBAC-01).
- **Saving:**
  1. The editor sends only the rows the user changed: `PATCH /team/:assignmentId/grants { changes:[{permission, tier}], expectedVersion }`.
  2. Before sending, the app shows the **before/after diff sheet** (mobile behaviour).
  3. The server re-checks the level rule and the grantor cap.
  4. It bumps `version` and the user's `ver` claim, which invalidates grants caches (§8.2).
  5. It emits `grants.changed` to the affected user (RT-08).
  6. If someone else saved first, the server returns `409 grants_changed` and the editor reloads (RBAC-08).
- **Revoke access:**
  - Sets `status = REVOKED`. The row is **kept**, so past approvals, payments and cash collections stay traceable to the person.
  - The person loses access on their next request (AUTH-08).
  - "Restore access" creates a new assignment; it doesn't reactivate the old one. That keeps the history honest.

#### 8.3.4 Invites (mobile flow)

```
Host: Team & access → Invite (phone or email, role, scope)
  → POST /team/invites        (level rule checked; single-use token; 7-day expiry)
  → invite appears in the invitee's Traveler-mode Inbox (push + in-app), or by SMS/email if they have no account
Invitee: /traveler/staff-invite-confirmation → Accept
  → POST /team/invites/:token/accept  (re-checks the level rule + that the inviter still has the right)
  → RoleAssignment created → Host mode for that tenant appears in the mode switcher
```

#### 8.3.5 Approvals (mobile flow)

- **Two tabs:** *Waiting on you* (requests where you hold `APPROVE` for that module and scope) and *Your requests*.
- The badge count comes from the server and updates live over the socket.
- **Approve/Reject** re-checks permissions at decision time, then executes idempotently by `approvalId` (RBAC-04).
- The requester is notified.
- Per-branch **staff requests** (`/host/gyms/:branchId/staff-requests`) use the same `ApprovalRequest` model filtered by branch. They are not a separate system.

#### 8.3.6 What this replaces (must be retired — RBAC-07)

- The mobile *Admin Management* and *Staff Management* screens, and their endpoints if they still exist.
- The CMS `/gym/staff` Add/Remove Staff screen.
- Any code that grants access from `GymStaff` (or any other table) **without** a `RoleAssignment`.
  - `GymStaff` may stay as an HR/profile record (name, photo, phone, pay details). It must never be an access source.
- Branch deletion's cascade "staff assignments → TERMINATED" must set the branch-scoped `RoleAssignment`s to REVOKED, with `revokedBy = system:branch_deleted` (RBAC-09).

#### 8.3.7 CMS port

`/gym/team` in the CMS is the same design on a wide screen:
- A table with the same role chips and counts on the left.
- A side sheet on the right with the same 3-choice editor, read-only preset labels, and diff confirmation.
- The same endpoints, the same error codes, and the same copy from the error-copy table.
- **Acceptance test:** the same person shows identical effective permissions in the app and in the CMS.

### 8.4 Persona matrix and role-based UI

The backend is the source of truth for enforcement; the mobile role presets are the source of truth for *what each role should be able to do*.

| Capability | Owner | Org admin | Manager | Front desk | Trainer | Cleaner | Member | Platform admin |
|---|---|---|---|---|---|---|---|---|
| GymsEra plan: buy/change/cancel | ✅ | ✅ (configurable) | ❌ | ❌ | ❌ | ❌ | ❌ | assign manual only (audited) |
| Create/delete/restore branch | ✅ | ✅ | needs approval | ❌ | ❌ | ❌ | ❌ | on behalf, audited, same service |
| Create organization | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | approve/reject |
| Team: invite / edit / revoke | ✅ below own level | ✅ below own level | ✅ below own level | ❌ | ❌ | ❌ | ❌ | ❌ |
| Approve requests | ✅ | ✅ | ✅ (own scope) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Enroll member | ✅ | ✅ | direct | needs approval / direct (per editor) | ❌ | ❌ | ❌ | read-only |
| Record cash payment | ✅ | ✅ | direct | needs approval / direct (per editor) | ❌ | ❌ | ❌ | ❌ |
| Refund / void invoice | ✅ | ✅ | needs approval | ❌ | ❌ | ❌ | ❌ | ❌ |
| Check in member | ✅ | ✅ | ✅ | ✅ | ✅ (own clients) | ❌ | self (QR) | ❌ |
| Close ledger day | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| View member personal data | ✅ | ✅ | ✅ | limited (name, photo, status) | own clients | ❌ | self | audited, masked |

**This table is illustrative.** The agent regenerates it from `constants/permissions.js` and commits it as `docs/PERMISSIONS.md`. That file is generated by a script, so it can never drift from the code.

**Role-based UI (every client):**
- `grantsProvider` (mobile) and `['me','bootstrap'].grants` (web/CMS) expose `can(permission, scope)`.
- Tabs, drawer/More items, buttons and FABs render through `PermissionGate`:
  - **Off** → not rendered.
  - **Needs approval** → the same button, labelled "Send for approval", which creates a request.
  - **Direct/Full** → the normal action.
- The server still enforces everything. The permission-matrix test suite (§15) calls every mutating endpoint as every persona.

### 8.5 Tenant and mode switching

- Mode switch (Host ↔ Traveler) and tenant switch both call `POST /auth/context`.
- On success:
  - Clear every tenant-scoped provider/query cache.
  - Rejoin realtime rooms (§9.2).
  - Re-register the device token's tenant association (RT-01).
  - Navigate to that context's root.
- Last-used context is persisted per user on the device and restored on launch **only if** bootstrap confirms it's still valid.

### 8.6 Admin model

`PLATFORM_ADMIN` gains sub-roles:

| Sub-role | Can do |
|---|---|
| `SUPPORT` | Read tenants, masked PII |
| `REVIEWER` | Tenant/org/review approvals |
| `FINANCE` | Billing plans, manual assignments, bank-transfer verification |
| `SUPER_ADMIN` | Everything, plus admin management |

Every admin mutation writes `AdminAuditLog {adminId, action, target, before, after, reason, requestId, ip}` (SEC-12).


---

## 9. Realtime and notification architecture

### 9.1 Division of labour

| Channel | Used for | Never used for |
|---|---|---|
| **Socket.IO** | Live updates while the app/tab is open: new message, approval created/decided, check-in on Today, grants changed, quota changed | Anything that must survive the app being closed |
| **FCM push** | Reaching a user whose app is backgrounded or terminated | Being the only record of anything |
| **Notifications table** | The durable truth: list, unread count, read state | — |

**Rule:** every user-visible notification is **first written** to the notifications table. Push and socket are only delivery hints that carry the `notificationId`. Clients dedupe by `notificationId`.

### 9.2 Socket lifecycle (one client per app: `RealtimeClient`)

**Connect:**
- Connect after bootstrap succeeds, with the access token in the `auth` payload (not a query string, so it isn't logged).
- The server verifies the JWT and `sid` on connect.

**Rooms:**
- The server **computes** the rooms from the DB: `user:{id}`, `tenant:{tid}:org:{oid}`, `tenant:{tid}:branch:{bid}` (only branches the user has grants on), `conversation:{cid}` (participant check).
- Clients never name rooms (RT-04).

**Token refresh:**
- On token refresh, emit `auth:refresh` with the new token. The server re-validates it.
- If the server rejects it, it disconnects the socket.

**Reconnect:**
- Exponential backoff (1 s → 30 s, jitter).
- On reconnect, the client sends `lastEventId`s. The server replays anything missed from the notifications table, **or** the client refetches the affected query keys. Either way, no silent gaps.

**App lifecycle:**
- Mobile:
  - Disconnect when the app has been backgrounded for more than 30 s (saves battery; push covers that period).
  - Reconnect and refetch `unreadCounts` and the visible screen on resume.
- Web: pause when the tab is hidden for more than 5 min.

**Logout / context switch:**
- Disconnect, clear all listeners (no leaks), and reconnect in the new context.

**Scaling:**
- Use the Socket.IO Redis adapter when there is more than one API instance, plus sticky sessions or a WebSocket-only transport.

### 9.3 Event → client effect

| Event | Client effect |
|---|---|
| `notification.created {notificationId, type, ...}` | Increment `unreadCounts` if not already seen; show an in-app banner if relevant |
| `approval.created` / `approval.decided` | Invalidate `approvals`, `unreadCounts` |
| `checkin.created {branchId}` | Invalidate Today for that branch (throttled to 1 per 5 s) |
| `quota.changed` | Invalidate `tenantQuota`, `billing/current` |
| `grants.changed` | Refetch `grants`. If the current screen is no longer permitted, navigate to the context root with a message |
| `message.created {conversationId, clientMessageId}` | Append if the conversation is open; replace the optimistic message with the matching `clientMessageId` |

### 9.4 FCM token lifecycle (RT-01)

- **Register:** `POST /notifications/devices {token, platform, appVersion, locale, timezone}` after login and on every `onTokenRefresh`. Upsert by token. A token belongs to exactly **one user at a time**: re-registering it moves it.
- **Logout:** `DELETE` the device token **before** clearing the session, and call `FirebaseMessaging.deleteToken()`.
- **Cleanup:** the server removes a token when FCM returns `UNREGISTERED` / `INVALID_ARGUMENT`.

**Permissions:**
- Ask for push permission in context (for example, after the first membership purchase or the first branch creation), not on first launch.
- Android 13+ needs the `POST_NOTIFICATIONS` runtime permission.

**Handlers:**
- Foreground: show an in-app banner, not a system notification.
- Background/terminated: a system notification; tapping it goes through the deep-link resolver (§2.10).
- `getInitialMessage()` is handled after the router is ready.

**Payload:**
- Minimal: IDs and route only.
- Never personal data or amounts in the push body beyond what a lock screen may safely show.
- Localized on the server using the device's registered locale.

**Unread counts:** server-authoritative (`GET` included in bootstrap). Mark-read endpoints return the new counts. The app icon badge is set from the server count.

---

## 10. Performance architecture

### 10.1 Budgets (measured in staging on a mid-range Android device over "Fast 3G", and on web with Lighthouse mobile)

| Metric | Budget |
|---|---|
| Mobile cold start → first meaningful screen (cached session) | ≤ 2.5 s |
| Mobile startup network calls before first screen | **≤ 2** (refresh if needed + `/me/bootstrap`) |
| API p95 latency (reads) | ≤ 300 ms |
| API p95 latency (mutations) | ≤ 600 ms |
| API p95 latency (provisioning) | async (see FLOW-02) |
| DB queries per list request | ≤ 5, independent of page size |
| Web public pages | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 |
| Web public JS per route | ≤ 170 KB gzip |
| Image payload per list screen (first viewport) | ≤ 300 KB |

### 10.2 Startup

1. The splash screen reads tokens from secure storage and the **last bootstrap snapshot** from the local cache.
2. Render the shell immediately from the snapshot, marked stale.
3. Refresh the token only if the access token is expired or close to expiry.
4. `GET /me/bootstrap` (ETag). A 304 means nothing more to do.
5. Deferred until after first frame: FCM registration, the purchase-stream listener (must be attached before any purchase UI, but not block first paint), and the socket connection.
6. **Never** fetch per-tab data for tabs that aren't visible. `StatefulShellRoute` branches load lazily.

### 10.3 Caching layers

| Layer | What | TTL / invalidation |
|---|---|---|
| CDN | Public discovery pages, images, catalog (`/billing/plans`) | `s-maxage` + tag revalidation on listing/plan change |
| Next.js server | Public pages via **ISR** (`revalidate` 60–300 s + `revalidateTag` on update); gym detail pages statically generated for popular gyms | tag per `gymId`/`cityId` |
| API | ETag on every GET; Redis for bootstrap pieces, grants, quota (event-invalidated) | event-driven |
| Client memory | Riverpod / query cache | §5.3 matrix |
| Client disk | Last bootstrap, last-viewed lists (read-only when offline), drafts | overwritten on fetch; wiped on logout |

**Never cache:** anything with money totals across tenants, tokens in non-secure storage, or authenticated responses on a CDN.

### 10.4 Images

- Upload through presigned URLs straight to object storage (SEC-08).
- Resize server-side (or with a CDN image service) into variants: 160, 480, 1080 px, as WebP/AVIF, with a JPEG fallback.
- Store a **blurhash** per image for placeholders.

**Flutter:**
- `cached_network_image` with `memCacheWidth`/`memCacheHeight` set to the display size (avoids decoding 4K images into memory).
- Precache only the next page's thumbnails.

**Next.js:** `next/image` with `sizes`, lazy below the fold, `priority` only for the LCP hero.

### 10.5 Rendering

**Flutter:**
- `const` constructors.
- `select` in `ref.watch`.
- Split large `build` methods into widgets.
- `ListView.builder`/slivers for all lists.
- No `setState` over whole screens for a text field.
- Profile with DevTools: no jank frames over 16 ms on list scroll.

**Next.js (rendering strategy per area):**

| Area | Strategy |
|---|---|
| Public site | Server components + ISR |
| Member portal / CMS | SSR shell + client queries, or RSC data reads with suspense |
| Admin tenant detail | Per-tab lazy components (PERF-10) |
| Charts | Lazy-loaded (`dynamic(() => import(...), { ssr:false })`) |

### 10.6 Network hygiene

- Parallelize independent requests (`Future.wait` / `Promise.all`). No waterfalls where B doesn't depend on A.
- One in-flight request per query key (dedupe).
- Cancel on dispose or navigation.
- Compress responses (gzip/br). HTTP keep-alive on dio.
- Mobile list DTOs exclude heavy fields (descriptions, galleries) until the detail view.

### 10.7 Backend scaling

**`TenantDbManager` (PERF-07):**
- One pool **per tenant** does not scale: tenants × pool size will hit MySQL `max_connections`.
- Cap each tenant pool at `max: 2–5`, `idle: 10 s`.
- Add LRU eviction of idle tenant pools (e.g. keep ≤ 200 open), and metrics for open pools.
- At larger scale, consider pooling per database *server* with schema-qualified queries. That is a documented future decision, not now.

**Other:**
- Move reporting and analytics queries to a read replica or pre-aggregated daily tables.
- Cron/sweeps are batched (e.g. 500 rows) and throttled. They never open every tenant DB at once.

---

## 11. Error and recovery strategy

### 11.1 Error taxonomy (client behaviour)

| Class | Examples | Client behaviour |
|---|---|---|
| Transient | timeout, 502/503/504, network drop | Automatic retry per §4.1 (idempotent only), then retryable error state |
| Rate-limited | 429 | Wait `Retry-After`, then retry once; show "Too many attempts" for auth |
| Auth | 401 `token_expired` | Single-flight refresh, then replay the original request once; refresh failure → logout to login with a message |
| Business | 403/404/409/422 with `code` | Copy table (§4.2) plus the action; no retry |
| Server bug | 500 | Error state with `requestId`; reported to error tracking |

**Single-flight refresh (AUTH-03):** concurrent 401s wait for one refresh call. The refresh token is used exactly once.

### 11.2 Mutation reliability contract (REL-01)

**Client:**
1. Create an `Idempotency-Key` (UUIDv4) when the user starts the intent.
2. Persist it with the draft.
3. Reuse it on every retry and after an app restart.

**Server (idempotency middleware):**
- Store `(key, userId, route, requestHash) → status, responseBody` for 24 h.
- Same key and hash → replay the stored response.
- Same key, different hash → `422 idempotency_key_reuse`.
- A request with the same key already in flight → `409 request_in_progress`.

Keys are scoped per tenant DB for tenant operations. Capacity/billing already have `idempotencyKey` on `CapacityEvent`; the middleware sits in front of them. It does not replace them.

### 11.3 Interrupted flows

| Situation | Recovery |
|---|---|
| App killed mid-wizard | Draft restored from local storage on next open ("Continue where you left off?") |
| App killed after the store charged, before `/sync` | On next launch, the purchase stream redelivers the transaction. The single listener sends it to `/sync`. The server-side ack (Android) means no auto-refund. |
| `/sync` succeeded, app killed before `completePurchase` | Redelivery → `/sync` is idempotent (known `externalOriginalTransactionId`) → complete |
| Payment succeeded, blocked action replay failed | Existing "payment succeeded but create failed" dialog, retry with the **same** idempotency key |
| Server crashed between tenant commit and platform effect | Outbox (§6.2) delivers later |
| Webhook processor crashed | `BillingEvent.processedAt IS NULL` sweep |
| Tenant provisioning failed halfway | Resumable step machine (FLOW-02) |
| Network lost during a cash payment | Busy state stays until a definitive answer. On timeout: "We couldn't confirm. Check Payments before recording again." Retry with the same key cannot double-record. |

### 11.4 Offline behaviour

- Reads show cached data with its age.
- Mutations are **disabled** offline by default, with an explanation.
- **Optional, later:** an offline check-in queue for front desk. It stores QR scans with device time, and the server validates membership state at the scan time when it syncs. Conflicts show on a reconciliation screen. Money is never queued offline.


---

## 12. Complete issue list

### 12.0 How issues are written

**Full cards** are used for P0/P1 issues that come from the documents (`DOC`/`INFER`). Each card has:

| Field | Meaning |
|---|---|
| **Where** | Code area to look in |
| **Evidence** | Why we believe it exists |
| **Root cause** | What the agent should confirm |
| **Reuse** | Existing pattern the fix must build on |
| **Fix** | What to change |
| **Test** | Regression test that proves it |

**`CHECK` items** are audit rows in tables. The agent audits each one, and fixes it only if the protection is missing.

---

### 12.1 Billing — GymsEra plan (BILL)

#### BILL-01 · P0 · INFER — Store purchases are not bound to one tenant
- **Where:** `billing` sync services (iOS/Android), Flutter billing notifier (purchase params), `/billing/restore`.
- **Evidence:** Restore Purchases replays everything the store account owns (mobile doc §6.6). There is no documented binding between a store transaction and a tenant.
- **Root cause to confirm:** a second GymsEra account on the same phone taps Restore → `/sync` finds a known `externalOriginalTransactionId` and updates or attaches it to the *calling* tenant, or creates an entitlement there as well.
- **Reuse:** the existing `/sync` → verify → upsert pipeline; `_pendingProductId`.
- **Fix:**
  1. Send the tenant UUID with every purchase (`PurchaseParam.applicationUserName`). Confirm it arrives as `appAccountToken` in Apple's signed transaction and as `obfuscatedExternalAccountId` in Google's `subscriptionsv2` response.
  2. Server: `UNIQUE(platform, externalOriginalTransactionId)`. When a sync's transaction is already owned by tenant X and the caller is Y, return `409 subscription_owned_by_other_account` and do not attach it.
  3. Add an explicit transfer endpoint that re-authenticates the owner of X, is audited, and is capacity-reconciled on both tenants.
- **Test:** `billing.binding.test.js` — tenant A purchases; tenant B restores the same transaction and gets a 409; the entitlement count is unchanged; the transfer path moves it once, idempotently.

#### BILL-02 · P0 · DOC — Refunds and revocations never remove entitlement
- **Where:** `TenantSubscription.status` enum, webhook handlers.
- **Evidence:** the enum has no REVOKED/REFUNDED state (mobile doc §3.1).
- **Fix:**
  - Add `REVOKED`.
  - Handle Apple `REFUND`/`REVOKE`, Google `SUBSCRIPTION_REVOKED` plus the Voided Purchases API in the daily sweep, and Stripe `charge.refunded` / `charge.dispute.created`.
  - Each one → `REVOKED` → `reconcileCapacity` → CAP-01 locks → host notification.
- **Test:** one fixture per provider: refund event → `maxBranches` drops → branches locked → a second copy of the same event changes nothing.

#### BILL-03 · P0 · INFER — Downgrade applied at the wrong time, with no branch choice
- **Where:** iOS/Android sync (reading the product ID), `ChangeSubscriptionParam` (`withTimeProration` is used for every change, mobile doc §5.3), Stripe `changeSubscriptionPlan`.
- **Root cause to confirm:**
  - Apple applies in-group downgrades at the next renewal. If sync reads the *new* product at purchase time, it removes capacity the host already paid for.
  - Google `withTimeProration` on a downgrade applies it immediately.
- **Fix:**
  - Read the *current* product from the transaction and the *upcoming* one from `renewalInfo.autoRenewProductId` → `pendingChange`.
  - Android: upgrades `withTimeProration` (or `chargeProratedPrice`), downgrades `deferred`.
  - Stripe: downgrade at period end.
  - UI: preview plus "choose branches to keep" (§7.5.4). Show `pendingChange` on My Subscription.
- **Reuse:** `reconcileCapacity` (it already trims reserved slots first); the direct-upsert path.
- **Test:** sandbox/fixture — 6→3 downgrade: entitlement stays 6 until `effectiveAt`, then 3, and the chosen 3 branches remain unlocked.

#### BILL-04 · P1 · DOC — No grace, hold, or pause states
- **Fix:** extend the enum (§7.3). `resolveMaxBranches` entitles `ACTIVE`+`GRACE`. The UI shows a payment-failed banner with the store's manage link.
- **Test:** state-transition table test covering every provider notification type → expected state and entitlement.

#### BILL-05 · P1 · DOC — Subscriber price is frozen even when the provider charges a different amount
- **Evidence:** "amount … never rewritten by a later catalog price change … or by a plain renewal sync" (mobile doc §3.1, §5.5).
- **Fix:** renewal sync writes `amount`/`currency` **from the provider's actual charge**. Catalog edits still never write them.
- **Test:** a renewal fixture with an Apple price increase updates the amount; a catalog edit leaves it untouched.

#### BILL-06 · P0 · CHECK — Android acknowledgement depends on the client
- **Fix:** acknowledge through the Play Developer API **on the server** after verification (`purchases.subscriptions.acknowledge`, idempotent). The client `completePurchase` becomes a backup only.
- **Test:** sync without a client ack → the server acknowledges; a second sync → no error.

#### BILL-07 · P1 · INFER — Cross-provider double billing is repaired afterwards instead of prevented
- **Fix:** add a thin `POST /billing/purchase-intent` in front of the picker (§7.5.1). It uses the **existing** `requestProviderChange` rules to decide `blocked | new | upgrade | downgrade`. This is not a new engine; it's a read of the same rules before the purchase happens.
- **Test:** tenant with a live Apple subscription (auto-renew on) opens Android purchase → `blocked` with the manage URL.

#### BILL-08 · P1 · CHECK — Pending purchases (Android PENDING: cash, carrier, and slow methods)
- **Fix:** add a `pending` state to the billing notifier UI ("Payment pending — we'll unlock branches when it completes"). No action replay. The server processes the RTDN `SUBSCRIPTION_PURCHASED` when it completes.
- **Test:** a notifier unit test with a fake store emitting `PurchaseStatus.pending`.

#### BILL-09 · P1 · INFER — A superseded row that is still billing is invisible to the host
- **Fix:** set `duplicateBilling` whenever the provider reports a superseded row as auto-renewing. Show a host banner with the manage link, plus an admin flag.
- **Test:** fixture — two independent purchases → banner flag true on the old row; `reconcileRenewalStatus` still refuses to resurrect it.

#### BILL-10 · P1 · DOC — Two commercial catalogs (`BillingPlan` + legacy `PlatformPackage`)
- **Fix:**
  - Freeze `PlatformPackage` for new sales. Its admin screen becomes read-only "Legacy".
  - Manual/bank-transfer becomes a MANUAL-platform `TenantSubscription` with `billingPlanId` and `branchCount` set.
  - Migrate new flows: the website Package step, CMS "Request a Manual Plan", and admin assign.
  - Existing legacy subscribers stay untouched until renewal, then move to the matching tier (documented in §14).
- **Reuse:** `resolveMaxBranches` already reads `branchCount` first.
- **Test:** a new manual sale produces a row with `branchCount` set and `platformPackageId` null; legacy rows still resolve.

#### BILL-11 · P1 · DOC — Catalog is PKR-only
- **Evidence:** Admin Console Map: "Monthly & annual PKR price per tier."
- **Fix:**
  - Add `BillingPlanPrice(billingPlanId, currency, monthlyMinor, annualMinor, stripePriceId)`. Keep the PKR columns as the default currency during migration.
  - Apps show the store's localized price.
  - The web picks the currency by the visitor's country, with a manual override.
- **Test:** `GET /billing/plans?currency=USD` returns USD prices; the Stripe session uses the USD price ID.

#### BILL-12 · P0 · CHECK — Webhook durability and ordering
- **Fix:** the `BillingEvent` inbox, re-fetching truth, and the one shared sync path (§7.6). **Reuse** any existing webhook-dedupe table if present.
- **Test:** replay the same event 3× → one state change; deliver events out of order → final state equals the provider's truth.

#### BILL-13 · P0 · INFER — "Pay later" registration can yield indefinite free service
- **Fix:** §7.5.11 — approval creates a time-limited GRACE MANUAL row, then EXPIRED unless an admin verifies payment.
- **Test:** approve with `later`, advance the clock past the grace period → EXPIRED → branches locked.

#### BILL-14 · P0 · INFER — Stripe return page trusts `?checkout=success`
- **Fix:** the return route calls `GET /billing/stripe/session/:id` (server verifies with Stripe). It shows "Confirming payment…" until the webhook-driven entitlement exists, then redirects to host billing. The query param is never used as proof.
- **Test:** opening `/gymsera-billing?checkout=success` without a real session shows no success and grants no entitlement.

#### BILL-15 · P2 · DOC — iOS/Android prices are "admin-attested" only
- **Fix:** a daily read-only verifier. Google Play Developer API (monetization subscriptions/base plans) and the App Store Connect API can **read** configured prices. Flag mismatches in the Billing Plans screen. Writing prices can stay manual.
- **Test:** a verifier unit test with mocked API responses flags the mismatch.

#### BILL-16 · P2 · DECISION — Should in-app purchase be the primary channel?
Record a product decision, not a code change:
- Stores take 15–30%.
- Many B2B SaaS products sell on the web and keep the app as a companion.
- Rules on in-app links to web purchases differ by storefront and change over time.

Decide per region after checking the current App Store and Play policies. Whatever you choose, the architecture already supports it (one catalog, many providers).

#### BILL-17 · P1 · CHECK — Stripe availability and tax
- **Fix:**
  - Confirm your legal entity's country is supported by Stripe **before** going live. If it isn't, use an entity in a supported country, or a merchant of record (Paddle / Lemon Squeezy / FastSpring) as the web provider behind the same catalog and provider abstraction.
  - If you use Stripe directly, enable Stripe Tax and country-compliant invoices.
  - Apple and Google handle tax as merchant of record for in-app sales.

#### BILL-18 · P1 · CHECK — "Boost" in the organization editor
- **Where:** the mobile organization editor's **Boost** screen.
- **Question:** is Boost paid? If a host pays in the app for extra visibility, that is a digital service used inside the app. Apple and Google generally require their in-app purchase systems for that.
- **Fix if paid:**
  - Sell it through the **same** catalog and provider abstraction as the GymsEra plan (a consumable or non-renewing product with its own entry in the one catalog, same `/sync` + webhook pipeline, same idempotency).
  - **Never** use a separate payment path.
  - If Boost is free or admin-granted, document that and move on.
- **Test:** purchase → server-verified → boost active for exactly its paid duration; a refund revokes it.

---

### 12.2 Capacity and branch lifecycle (CAP)

The locked model stays. These are defects **inside** it.

#### CAP-01 · P0 · DOC — Over-quota is never enforced on real branches (revenue leak)
- **Evidence:** `overQuotaCount` "blocks new consumption … never touches an existing real branch" (mobile doc §4.1). Buy 10 → build 10 → downgrade to 1 → keep running 10 branches.
- **Fix:**
  - Add a computed/stored **`billingLock`** on `Branch`, **separate from `status`**. This follows the lesson from §9.1/§9.6: never mix billing with lifecycle status.
  - `reconcileCapacity` already computes `overQuotaCount`. After a grace window (config, default 7 days, shown as a countdown), it locks `overQuotaCount` branches:
    - The ones the host did not keep (BILL-03).
    - Otherwise, the most recently created first.
  - A locked branch: data visible; no new members, sales, plans, or staff; existing members' check-ins allowed for the member-grace period (§7.5.8).
  - Unlock happens automatically when capacity returns (upgrade, deleting another branch).
  - Every lock/unlock writes a `CapacityEvent` (`BRANCH_BILLING_LOCKED` / `UNLOCKED`) with the idempotency key.
- **Reuse:** `reconcileCapacity`, `CapacityEvent`, the existing daily cron.
- **Test:** `capacity.overquota.test.js` — downgrade below the active count → grace → locks exactly N → upgrade → unlocks; a double run is idempotent.

#### CAP-02 · P1 · DOC — Cross-DB capacity credit can be lost
- **Evidence:** `deleteBranch` step 6 runs separately with 3 retries (mobile doc §7.2).
- **Fix:** the tenant-DB `Outbox` (§6.2) is written inside the step-5 transaction, and the processor applies it with the **existing** `idempotencyKey`. Same for restore/create/move whenever `reservedSlots` changes.
- **Test:** kill the process after the tenant commit (inject a failure) → the outbox sweep applies the credit exactly once; `auditCapacity` reports no drift.

#### CAP-03 · P0 · INFER — Not every branch creator uses `createBranch`
- **Where:**
  - CMS Branches "Add/Edit Branch"
  - Admin "create/edit/disable a branch on the tenant's behalf" (platform doc §2.5)
  - Tenant provisioning (initial branch)
  - Onboarding wizard reuse (`createListing(branchSource:'new')`)
  - `moveBranch`
- **Fix:** grep for every `Branch.create` and every `status:` write on Branch. All paths must route through `createBranch`/`deleteBranch`/`restoreBranch`. Add a lint/test guard: a unit test that scans the source for direct `Branch.update({status` / `Branch.create(` outside the branch service.
- **Test:** the source-guard test, plus an API test per surface asserting the capacity effect.

#### CAP-04 · P0 · DOC — Admin "disable branch" may bypass lifecycle doors
- **Fix:**
  - An admin **disabling for policy reasons** is a different concept (`adminSuspended`, no capacity change, audited).
  - An admin **deleting** calls `deleteBranch`.
  - Neither writes `status` directly.
- **Test:** admin disable → capacity unchanged, branch hidden from public, audit row written.

#### CAP-05 · P1 · INFER — Capacity when a pending organization is rejected
- **Fix:**
  - The new org's first branch counts from creation (the host used a unit).
  - Rejection calls `deleteBranch` with `confirmOrganizationDeletion`, crediting capacity via the normal path.
  - The host is told the capacity was returned.
- **Test:** create org (consumes 1) → admin rejects → `usedBranches` back to its previous value → `CapacityEvent` recorded.

#### CAP-06 · P1 · INFER — Restoring into an organization that was auto-deactivated
- **Fix:** `restoreBranch` on a branch whose org is INACTIVE reactivates the org **in the same flow**, and consumes that org's preserved `reservedSlots` first (the existing rule "this org's own reserved slot first").
- **Test:** delete the last branch (org deactivated, slot preserved) → restore → org ACTIVE, slot consumed, no fresh capacity used.

#### CAP-07 · P1 · CHECK — "Organization never empty" everywhere
- **Fix:**
  - Extend `auditCapacity` to also report ACTIVE organizations with zero ACTIVE branches.
  - Verify the guard exists on: CMS delete, admin delete, `moveBranch`, org-level operations, and tenant reject/suspend.
- **Test:** a property-based test over random sequences of create/delete/move/restore → after every step, no ACTIVE org has zero branches, and the invariant holds.

#### CAP-08 · P1 · CHECK — Concurrency
- **Test** (no code change expected if it passes): 20 parallel `createBranch` calls with capacity for 3 → exactly 3 succeed. Also parallel delete + restore of the same branch, and parallel org creation competing for one donor slot.

---

### 12.3 Core flows (FLOW)

#### FLOW-01 · P2 · CHECK — Registration wizard resilience
- Every `/tenants/*` step is idempotent and resumable after a browser close.
- Abandoned DRAFT tenants older than 30 days are purged (with their KYC files).
- Email OTP rules per AUTH-04.

#### FLOW-02 · P0 · DOC — Tenant provisioning runs synchronously inside the approve request
- **Evidence:** platform doc §2.4 (`CREATE DATABASE`, model sync, rows, subscription, email — all in one request).
- **Risks:** HTTP timeout, a double-click approve, partial failure (database created but tenant not ACTIVE), a retry creating duplicates.
- **Fix — keep it serverless-compatible:**
  - Add `Tenant.provisioningState` with steps `DB_CREATED → MODELS_SYNCED → LISTING_CREATED → BRANCH_CREATED → SUBSCRIPTION_LINKED → ACTIVE`.
  - Each step is idempotent: `CREATE DATABASE IF NOT EXISTS`, find-or-create by natural keys.
  - `approve` records the intent and runs the steps. On a timeout, the admin sees "Provisioning… (step 3/6)" with a **Resume** button, and a sweep also resumes it.
  - Lock the Tenant row so a second approve returns the in-progress state.
  - The approve endpoint takes an Idempotency-Key.
- **Test:** inject a failure at each step → resume completes → exactly one DB, listing, branch, and subscription.
- **Known gap (tracked as NEW-34, P2, §12.13.11):** a tenant rejected while a provisioning run is in progress (or after one failed) keeps its partial database as an orphan. The run stops without activating; `gymsera-flow02-provisioning-check.js` reports it as `ORPHAN_DATABASE`; cleanup is a manual decision.

#### FLOW-03 · P0 · INFER — Card payment at registration plus auto-created subscription at approval
Two entitlements. See §7.5.10.
- **Test:** register with card → approve → exactly one ACTIVE row (the Stripe one).

#### FLOW-04 · P1 · CHECK — Rejection path
- Show the rejection reason (the CMS already has a card for it).
- Allow re-application that edits the same tenant.
- Refund any card charge (FLOW-03).
- Apply the retention policy to KYC files.

#### FLOW-05 · P1 · DOC — Listings tab stale after creating an organization (open item)
Hypotheses to test, in order. Add temporary debug logs of provider creation/dispose and HTTP cache hits:
1. **HTTP-layer cache:** an interceptor (for example `dio_cache_interceptor`) or an in-memory repository cache returns the pre-create GET even after provider invalidation. A restart clears it, which fits the symptom.
2. **A different provider instance:** the create flow runs under the `/become-host/*` routes, which may sit outside the host `StatefulShellRoute` or under a nested `ProviderScope`, so it invalidates another container's provider. Another variant: a `family` argument mismatch (for example `tenantId` vs `null`).
3. **Local copy:** the Listings screen copies provider data into widget `State` in `initState`, so later `ref.watch` updates are ignored.
4. **Filtering:** the list endpoint filters to ACTIVE, while the new org is PENDING. A restart shows it because a different endpoint (bootstrap) includes PENDING. **If this is the cause, show PENDING orgs with a "Under review" chip.**

- **Fix:** the one confirmed by logs. Then add the invalidation to the §5.3 matrix.
- **Test:** a widget/integration test: create org → pop to Listings → the new org is visible without a restart.

#### FLOW-06 · P1 · CHECK — Membership lifecycle
- Statuses: Pending Payment / Active / Frozen / Expired / Cancelled.
- Transitions happen only in the service. Expiry is computed at end of day **in the branch timezone** by a batched cron.
- Renewal extends from `max(now, currentEnd)`.
- Freeze extends the end date by the frozen days and has a maximum.

#### FLOW-07 · P2 · CHECK — Enrollment deduplication
Match on normalized E.164 phone/email per tenant. Offer "Existing member found — add membership instead?"

#### FLOW-08 · P1 · CHECK — Traveler checkout
- Server-side price recomputation (never trust the client amount).
- Payment via provider SDK/hosted page.
- Membership activates only on the verified payment webhook.
- Idempotency key per checkout.
- The confirmation screen polls the membership state.

#### FLOW-09 · P1 · INFER — QR check-in replay
- A static member QR can be screenshotted and shared.
- **Fix:** a rotating signed QR (for example a TOTP-style token valid for 30–60 s, signed with a per-member secret). The server rejects stale or reused nonces. Manual check-in requires the permission and is logged.
- One check-in per membership per configurable window.

#### FLOW-10 · P1 · CHECK — Reviews
- Only members with a membership or check-in at that gym can review, once per membership.
- Moderation queue (it exists).
- Rate limit.
- Store raw text; escape on render (SEC-14).

#### FLOW-11 · P2 · DOC — Additional-organization admin review slows down self-serve
Option: auto-approve additional orgs for tenants in good standing (ACTIVE for more than N days, no rejections), with post-moderation of the public listing. This is a product decision; record it in §14.

#### FLOW-12 · P1 · CHECK — Staff invites
- The token is single-use, expires in 7 days, is bound to the invited phone/email, and can be revoked.
- Accepting creates a `RoleAssignment` below the inviter's level (re-checked at acceptance time).

#### FLOW-13 · P1 · CHECK — Trainer session bookings
Prevent double-booking with a unique constraint on `(trainerId, slotStart)`, or with a row lock on the slot. Handle cancellations and refunds via PAY-07.


---

### 12.4 Payments and ledger — member money (PAY)

All `CHECK` unless noted. Money must be atomic, auditable, and idempotent.

| ID | Sev | Requirement | Fix if missing | Test |
|---|---|---|---|---|
| PAY-01 | P0 | Recording a payment is idempotent | `Idempotency-Key` required on `POST /payments`; unique `(tenant, idempotencyKey)` | Double-tap/retry → one payment, one ledger entry |
| PAY-02 | P0 | Money is never a float | Integer minor units + `currency` end to end; `MoneyField` on clients | Property test: sums of random amounts match exactly |
| PAY-03 | P0 | Ledger is append-only | No UPDATE/DELETE on ledger entries; corrections are reversing entries referencing the original | DB permission or repository guard test; void → reversal pair |
| PAY-04 | P0 | Daily close | Close computed in **branch timezone**; closed day immutable; late entries post to today as adjustments; close needs permission and is idempotent | Close twice → one close; post into a closed day → 409 `ledger_day_closed` |
| PAY-05 | P1 | Invoice numbers | Gapless per-branch sequence via a counter row `SELECT … FOR UPDATE` inside the payment transaction; voids keep their number | 50 parallel invoices → no gaps or duplicates |
| PAY-06 | P1 | Collector accountability | Every cash payment records `collectedBy` + shift; daily close shows cash per collector vs expected | Report test |
| PAY-07 | P0 | Refunds | Only through the approval engine per tier; amount ≤ remaining refundable; reversing ledger entry; membership state adjusted; receipt | Refund > paid → 422; concurrent refunds → only the first succeeds |
| PAY-08 | P1 | Online / pending payments | Gateway webhook is the source of truth (same inbox pattern as BILL-12); pending payments expire; UI never marks paid from a client callback | Webhook replay → one state change |
| PAY-09 | P2 | Thermal printing | Print **after** the server commit; reprints marked "DUPLICATE"; Urdu/Arabic receipts rendered as raster images (ESC/POS code pages lack them); printer failure never blocks the payment | Golden-image test of the receipt renderer |
| PAY-10 | P0 | Payouts | Balance computed from the ledger (not a stored number edited by hand); request → approval → execution idempotent; bank-detail change requires re-auth + notification + 24–72 h cooling period | Payout twice with the same key → one |
| PAY-11 | P2 | Weekly/monthly reports | Built from ledger entries (single source), bucketed by branch timezone; pre-aggregated tables for speed | Reports equal the sum of ledger days |
| PAY-12 | P1 | Adjustments | Require a reason + approval tier + audit row | Missing reason → 422 |
| NEW-33 | P1 | **Mobile (`gyms_era`):** host payout screens show the real PAY-10 data | The payout history (`gyms_era/lib/features/host/presentation/providers/analytics_provider.dart:30-70`, fake "Bank Transfer ···4291" rows) and the request-payout screen (`screens/request_payout_screen.dart:21-27`, fake "HBL Bank ···9821" account and a pre-filled "42,300") are hard-coded fixtures. Wire them to the PAY-10 endpoints (ledger-derived balance, payout requests and their approval state, the account from `paymentDetailsJson`), honour the SEC-13 cooling-period error (`422 cooling_period_active`), and show loading / empty / error states (§2.5). CMS and web copy mobile afterwards (§0.5) | Widget/provider test with a fake API client: balance and history come from the API, never a fixture; a scan of `lib/` finds no hard-coded payout/bank fixture |

---

### 12.5 Authentication and RBAC (AUTH, RBAC)

#### AUTH-05 · P1 · DOC — Several Google sign-in implementations
- **Evidence:** the web uses "its own direct Google Identity Services call, not the CMS staff route"; mobile has its own flow.
- **Fix:**
  - One backend verifier (`POST /auth/social/google`) that verifies the ID token signature and checks `aud` against the **allow-list of all client IDs** (web, CMS, iOS, Android).
  - Delete any separate verifier.
  - Link accounts by verified email only.

#### AUTH-07 · P0 · CHECK — Self-service account and tenant deletion
- **Why:** Apple requires in-app account deletion (guideline 5.1.1(v)). The docs only allow an admin to delete *pending* tenants.
- **Fix — a flow:**
  1. Preflight: live store subscriptions → tell the user to cancel in the store (link). Stripe → cancel automatically.
  2. Re-auth.
  3. The tenant goes to `PENDING_DELETION` with a 30-day undo window.
  4. Then: drop the tenant DB, delete personal data, keep invoices and ledger data anonymized for the legal retention period, revoke the Apple Sign-In token, delete device tokens.
  5. A member-only account deletes immediately, subject to its gyms' retention of payment records.

#### AUTH-09 · P0 · DOC — Admin "Add Tenant" creates or links accounts by email
- **Evidence:** "an existing account is linked, a new one auto-created" (Admin Console Map).
- **Risk:** an admin typo attaches a stranger's existing account as a tenant owner; an auto-created account has no proven email ownership.
- **Fix:** send an **invitation**. The owner accepts through an email link (verifying ownership); only then does the link happen. Audit it.

#### CHECK rows

| ID | Sev | Requirement | Fix if missing | Test |
|---|---|---|---|---|
| AUTH-01 | P0 | Refresh-token rotation + reuse detection | Opaque refresh stored hashed; rotate on use; reuse → revoke session family | Reuse an old refresh → 401 + all session tokens dead |
| AUTH-02 | P1 | Sessions & devices | `UserSession` table; "Signed-in devices" screen; revoke one/all; password change revokes others | Revoke → that device's next call 401 |
| AUTH-03 | P1 | Single-flight refresh on clients | One refresh promise/future shared by concurrent 401s | 10 parallel 401s → 1 refresh call |
| AUTH-04 | P0 | OTP security | 6 digits, hashed, 5–10 min expiry, max 5 attempts, resend cooldown 60 s, per-IP and per-identifier rate limits, constant-time compare | Brute-force test → locked |
| AUTH-06 | P1 | Apple Sign-In | Server verifies identity token; stores refresh for revocation on deletion; handles private-relay email | Fixture test |
| AUTH-08 | P1 | Permission revocation is immediate | `ver` claim checked against the DB/cache on each request (§8.2) | Revoke grant → next request 403 without re-login |
| AUTH-10 | P1 | Password policy & reset | Reset tokens single-use, 30 min, hashed; reset revokes sessions | Reused reset token → 400 |

| ID | Sev | Evidence | Requirement / Fix | Test |
|---|---|---|---|---|
| RBAC-01 | P1 | **v2: design confirmed correct.** The 3-choice editor (Off / Needs approval / Direct) is the approved design (§8.3.3). **No UI change.** Only verify safety. | The server applies only the changed rows (`changes[]`), never a full overwrite. Preset-derived VIEW/APPROVE/FULL are never written by the editor. The server caps the result at the grantor's own tier. | Manager preset with APPROVE on payments: edit another row and save → APPROVE still effective; a full-overwrite payload is rejected with 400 |
| RBAC-02 | P2 | DOC: "Cleaner" is a mobile label with no backend level of that name | One `roleLabels` table (§8.3.2) mapping each mobile label to its backend role; all clients use it | Snapshot test of the mapping; the CMS shows "Cleaner", not "Support" |
| RBAC-07 | **P0** | INFER: mobile unified access into Team & Access, but the CMS Staff screen (and possibly old mobile admin/staff endpoints) still exist | Find every code path that creates or removes staff access. Everything must go through the `/team` service and `RoleAssignment`. Legacy endpoints: alias to the team service for one release, then `410 Gone`. `GymStaff` must never grant access (§8.3.6). | A person removed via any old path still has access? → must fail. A staff row with no `RoleAssignment` → every protected endpoint returns 403 |
| RBAC-08 | P1 | CHECK: two admins editing the same person at once | `expectedVersion` on grant edits → `409 grants_changed` → the editor reloads and shows the other change | Parallel PATCHes → one wins, one 409 |
| RBAC-09 | P1 | CHECK: branch deletion cascade | `deleteBranch` sets branch-scoped `RoleAssignment`s to REVOKED (system actor); `restoreBranch` does **not** restore access automatically (the owner re-grants) | Delete branch → its desk staff get 403 on that branch; restore → still 403 until re-granted |
| RBAC-03 | P0 | CHECK | Generated **endpoint × persona** test: every mutating route called as each persona and as a member of another tenant → only allowed ones succeed | §15 |
| RBAC-04 | P1 | INFER | Approval execution **re-checks** at execute time: approver still has APPROVE, requester still exists, target still valid (e.g. membership price unchanged); execution idempotent by `approvalId` | Approver loses grant → approve 403; double-approve → one execution |
| RBAC-05 | P1 | DOC: level rule | "Assign only strictly below your own level" enforced on invite, update, **and** acceptance | Manager tries to create Org admin → 403 |
| RBAC-06 | P1 | CHECK | Admin sub-roles + audit (§8.6) | Support admin tries billing edit → 403 |

---

### 12.6 Security (SEC)

| ID | Sev | Requirement | Fix if missing | Test |
|---|---|---|---|---|
| SEC-01 | P0 | No IDOR | Every by-ID read/write loads the target **with** scope filters (`userId` for member routes, granted `branchIds` for staff); out-of-scope → 404 | Member A requests member B's `/subscriptions/:id` → 404; branch-A manager reads branch-B payment → 404 |
| SEC-02 | P0 | Tenant from auth, not input | `resolveTenant` ignores body `tenantId`; the header is only a selector validated against the user's tenants | Forged header → 403 |
| SEC-03 | P0 | Webhook authenticity | Apple JWS x5c chain to Apple root; Google push OIDC token audience + service account; Stripe `constructEvent` with raw body | Tampered payload → 400, no state change |
| SEC-04 | P1 | Rate limiting | Redis-backed limits: auth/OTP strict, public search moderate, mutations per user; 429 + `Retry-After` | Load test |
| SEC-05 | P1 | Secrets | No secrets in repos/app bundles (scan with gitleaks in CI); the `connectionStringEncrypted` key held in a KMS/secret manager with a rotation procedure; separate keys per environment | CI secret scan |
| SEC-06 | P0 | Strict validation / no mass assignment | Schema per route, unknown keys rejected, explicit allow-lists on update (the §9.1 bug was mass assignment) | Send an extra `status` / `tenantId` / `role` field → 400 |
| SEC-07 | P0 | No sensitive data in logs | Redaction list: authorization, cookies, tokens, OTP, passwords, card data, bank account, CNIC/ID numbers, receipts; hash emails/phones in logs | Log-capture test asserts redaction |
| SEC-08 | P1 | Uploads | Presigned upload with size and content-type limits; server re-checks magic bytes; images re-encoded (strips EXIF/GPS); documents virus-scanned; private bucket for KYC with short-lived signed read URLs | Upload an `.html` renamed `.jpg` → rejected |
| SEC-09 | P0 | PCI | `/home/checkout/add-card` must not collect raw card numbers in Flutter fields. Use the gateway's native SDK / hosted fields / tokenization so card data never touches GymsEra servers | Code review + grep for card-number fields |
| SEC-10 | P0 | KYC data | Encrypted at rest, access logged, admin views watermarked, retention and deletion policy | Access audit test |
| SEC-11 | P1 | QR check-in replay | See FLOW-09 | — |
| SEC-12 | P1 | Admin audit log | Middleware on `/admin/*` mutations writes `AdminAuditLog` | Every admin mutation creates a row |
| SEC-13 | P0 | Payout account changes | Re-auth + notify owner by email and push + cooling period | Change then immediate payout → blocked |
| SEC-14 | P1 | XSS | Escape user content (reviews, listing text, chat); no `dangerouslySetInnerHTML` without a sanitizer; strict CSP on both Next.js apps | Stored-XSS payload renders inert |
| SEC-15 | P1 | Web token storage / CSRF | Prefer httpOnly, Secure, SameSite=Lax cookies for web sessions plus a CSRF token on mutations; if tokens are in localStorage, CSP is mandatory and moving to cookies is scheduled | CSRF test |
| SEC-16 | P1 | SQL injection | No string-built SQL; sort/filter fields validated against allow-lists; raw queries use replacements | Injection strings in `sort`/`q` → 400 |
| SEC-17 | P2 | Admin access to member PII | Admin tenant "Members" tab masks phone/email by default; reveal is audited | Reveal writes an audit row |
| SEC-18 | P1 | Security headers | HSTS, X-Content-Type-Options, frame-ancestors, Referrer-Policy on both web apps and the API | Header check test |

---

### 12.7 Reliability (REL) and API (API)

| ID | Sev | Requirement | Fix if missing | Test |
|---|---|---|---|---|
| REL-01 | P0 | Idempotency middleware (§11.2) on all listed mutations; clients keep key per intent | Implement middleware; client helper `withIdempotency(intentId)` | Retry after simulated timeout → same response, one effect |
| REL-02 | P1 | Busy state on every mutating control | `AppButton.busy` everywhere | Widget test: 5 taps → 1 call |
| REL-03 | P1 | Cron/sweeps safe with >1 instance | Distributed lock (Redis `SET NX PX` or MySQL `GET_LOCK`) per job; jobs resumable and batched | Two instances → one run |
| REL-04 | P1 | DOC: nightly cron opened a connection for every billing subscription regardless of tenant status | Skip SUSPENDED/deleted tenants; never mutate tenant status from billing jobs | Suspended tenant untouched by cron |
| REL-05 | P2 | Graceful shutdown | Stop accepting, drain in-flight requests (30 s), flush outbox/log buffers | Deploy test: no 5xx spike |
| API-01 | P1 | One response/error envelope (§4.1) | Error-handler middleware maps all thrown errors; clients use one parser | Contract tests per route |
| API-02 | P1 | Timeouts + retry policy (§4.1) | dio/fetch interceptors; server timeouts | Fault-injection test |
| API-03 | P1 | INFER: startup waterfall | `GET /me/bootstrap` aggregating the startup reads | Startup makes ≤ 2 calls |
| API-04 | P1 | INFER: N+1 and cross-tenant loops (admin tenant list needs branch/org counts from many tenant DBs) | Batched includes; event-maintained aggregates on platform tables | Query-count test per list route |
| API-05 | P1 | Cursor pagination on every list | Standard `limit/cursor` helper | Page through 10k rows with stable ordering |
| API-06 | P2 | ETag / 304 | Middleware hashing the response | Second call → 304 |
| API-07 | P2 | Over-fetching | List DTOs vs detail DTOs | Payload size budget test |
| API-08 | P2 | Sequential awaits that could be parallel | `Promise.all` in services; `Future.wait` in clients | Review + latency test |

---

### 12.8 Realtime and notifications (RT)

| ID | Sev | Requirement | Fix if missing | Test |
|---|---|---|---|---|
| RT-01 | P1 | FCM token lifecycle (§9.4) | Device registry + logout delete + refresh | Logout → no push delivered to that device |
| RT-02 | P2 | No duplicate notifications | Dedupe by `notificationId` across push/socket/list | Same event via both channels → one banner |
| RT-03 | P2 | Unread counts accurate | Server-authoritative counts; mark-read returns counts | Multi-device read sync |
| RT-04 | P0 | Room authorization | Server computes rooms; no client-named joins; tenant/branch rooms from grants | Client emits `join tenant:other` → ignored |
| RT-05 | P1 | Message send idempotency | `clientMessageId` unique per conversation | Resend → one message |
| RT-06 | P2 | Reconnect without gaps | Replay since `lastEventId` or refetch | Drop the socket 30 s → no missing messages |
| RT-07 | P1 | Notification tap routing with context switch | §2.10 resolver | Tap a tenant-B approval while in tenant A → switches, then opens |
| RT-08 | P2 | Live permission changes | `grants.changed` event | Revoke → screen closes gracefully |
| RT-09 | P2 | Socket memory leaks | Listeners removed on dispose/logout | Repeated login/logout → listener count stable |

---

### 12.9 UX issues (UX)

| ID | Sev | Evidence | Fix | Test |
|---|---|---|---|---|
| UX-01 | P1 | DOC: `/onboarding` duplicates `/gym-owner/register` | 301 redirect, delete code and the homepage "Start Onboarding" button | Visiting `/onboarding` redirects |
| UX-02 | P1 | DOC: `/gymsera-billing` lives in the **member** portal and "doubles as host billing" | Canonical host billing = CMS `/settings/billing` (web) and `/host/subscription/mine` (app). `/gymsera-billing` becomes a Stripe-return verifier → redirect (BILL-14). Member layout guards role | Host lands on billing correctly; member cannot see host billing |
| UX-03 | P2 · **proposal** | DOC: tabs + drawer + profile links | **Mobile unchanged unless the owner approves (R-13).** If approved: §2.3.1 More hub; drawer only as tablet rail from the same item list | Nav snapshot tests per persona |
| UX-04 | P2 | DOC: "Subscriptions" = member memberships **and** host plan | CMS/web: apply vocabulary §2.2 now. Mobile: only if R-13 is approved | Copy lint (string table review) |
| UX-05 | P2 · **proposal** | DOC: "Gyms › Gyms" | Mobile label rename only if R-13 is approved | — |
| UX-06 | P2 | DOC: visibility toggle reads like a request queue | Toggle labelled "Show in Travelers feed (admin setting)" + caption (partly done); confirm on web too | — |
| UX-07 | P1 | INFER: "pay later" consequence unexplained | Registration Payment step states: "Your plan starts after approval. Pay within N days to keep access." | — |
| UX-08 | P1 | CHECK | Every screen meets §2.5 | Widget/component tests per state |
| UX-09 | P1 | CHECK | All user-facing strings externalized (ARB / next-intl), no concatenated sentences | CI check for hard-coded strings |
| UX-10 | P1 | CHECK | Accessibility pass (§2.11) | Automated a11y (axe on web; Flutter semantics tests) |
| UX-11 | P2 | DOC: Notifications screen separate from Inbox | Inbox segments "Messages · Alerts", one badge | — |
| UX-12 | **P0** | DOC: CMS still has separate Staff (and Trainers) while mobile unified them into Team & Access | Port the mobile Team & Access to the CMS exactly (§8.3.7): same endpoints, role chips with counts, 3-choice editor, diff sheet, revoke-keeps-record. Trainers = a bookable profile linked to a team member | The same person shows identical effective permissions in the app and the CMS |
| UX-13 | P1 | DOC: CMS lacks Approvals, Ledger, Payouts, quota banner | Add, reusing the same endpoints | Parity checklist test |
| UX-14 | P1 | INFER: CMS `/gym/*` is single-org (`/gym/profile`) | Org switcher; every `/gym/*` query keyed by `orgId` | Multi-org host sees correct data per org |
| UX-15 | P2 | DOC: bank transfer instructions show one specific bank's details | Bank-transfer instructions served from backend config per country/currency | Config change reflects without deploy |
| UX-16 | P2 | CHECK | Front-desk minimal shell (§2.3.1) | Persona nav test |
| UX-17 | P2 | DOC: admin tenant detail is one ~1,365-line page | Split per tab (PERF-10) | — |
| UX-18 | P2 | DOC: CMS dashboard and reports differ from mobile Today / Analytics | Same `GET /host/dashboard` and reports API as mobile; the same "needs attention" items | Same numbers on both for the same branch and date |
| UX-19 | P1 | INFER: CMS Add/Edit Branch is a plain form | Port the mobile pattern: attempt first → on `403 branch_limit_reached` explain and link to plan (the web can't sell IAP, so offer "Continue in the app" or Stripe once live). The same delete/restore sheet with re-auth and last-branch confirmation | CMS create at capacity → upsell message, no silent failure |
| UX-20 | P1 | DOC: new-organization flow (build new / move existing) is mobile-only | CMS: the same two-source flow on the same endpoint | Org created from the CMS appears in the mobile Listings tab |
| UX-21 | P2 | DOC: mobile organization editor has amenities, hours, location, membership packages, boost; CMS Gym Profile has fewer | One listing-content API; the CMS editor gets the same sections | Edit on either → identical public page |
| UX-22 | P1 | DOC: staff requests per branch and staff-invite acceptance exist only on mobile | CMS: staff requests list (same approval model). Invitees without the app get an SMS/email link that opens the app or a minimal web accept page | Invite accepted from the web link → access in the app |
| UX-23 | P2 | DOC: CMS has no notifications feed or inbox | Notification bell + feed using the same API and socket; inbox on the CMS is a phase-2 decision | Unread counts match across app and CMS |
| UX-24 | P1 | DOC: two signup implementations (mobile become-host wizard vs web 7-step wizard) | Both call the same `/tenants/*` steps with the same fields and validation; the web step order follows mobile's | One contract test suite for both clients |
| UX-25 | P2 | DOC: traveler checkout, QR and wishlist exist only on mobile | Optional: web "My memberships" gains the same membership detail; buying on the web is a product decision (R-14) | — |

---

### 12.10 Performance (PERF)

| ID | Sev | Requirement | Fix | Test |
|---|---|---|---|---|
| PERF-01 | P1 | Startup budget (§10.1–10.2) | Bootstrap + snapshot + deferred init | Startup trace in CI (integration_test + timeline) |
| PERF-02 | P2 | Rebuilds | `select`, `const`, split widgets | DevTools rebuild counts on key screens |
| PERF-03 | P1 | Images (§10.4) | Variants, blurhash, decode sizes | Memory budget test on the gallery screen |
| PERF-04 | P1 | Lists | Cursor pagination + builders | 1,000 members scroll with no jank |
| PERF-05 | P1 | Web public pages | ISR + tags, `next/image`, route bundle budget | Lighthouse CI thresholds |
| PERF-06 | P1 | Discovery API | CDN cache headers, indexed geo/city queries, payload budget | Load test 200 RPS p95 < 300 ms |
| PERF-07 | P1 | INFER: `TenantDbManager` pools per tenant | Pool caps + LRU eviction + metrics (§10.7) | Soak test with 1,000 simulated tenants |
| PERF-08 | P1 | Cross-tenant aggregates | Event-maintained counters on platform tables | Admin list ≤ 5 queries |
| PERF-09 | P2 | Reports | Replica / pre-aggregates | Report p95 |
| PERF-10 | P2 | Admin tenant detail | Per-tab lazy components + per-tab queries | Only the active tab fetches |
| PERF-11 | P2 | Leaks | Dispose controllers, streams, timers, socket listeners | Leak tracker in widget tests (`leak_tracker`) |

---

### 12.11 Global readiness (GLB)

| ID | Sev | Requirement | Fix | Test |
|---|---|---|---|---|
| GLB-01 | P1 | Timezones | IANA tz per branch; UTC storage; business dates in branch tz; show times in branch tz with a label when it differs from the device tz | Branch in `America/New_York`, server in UTC: ledger day boundaries correct across DST |
| GLB-02 | P1 | Currency | Currency per tenant (default) and branch; formatting via ICU (`intl` / `Intl.NumberFormat`) | Format tests for PKR, USD, EUR, AED, JPY (0 decimals), KWD (3 decimals) |
| GLB-03 | P1 | Localization | ARB (Flutter) + next-intl (web) + server-side notification/email templates per locale; English first, then Urdu and Arabic (RTL) | Pseudo-locale build (long strings, accents) shows no clipping |
| GLB-04 | P1 | Phone numbers | libphonenumber on all platforms; store E.164 | Parse/format tests |
| GLB-05 | P2 | RTL | `EdgeInsetsDirectional`, `AlignmentDirectional`, directional icons; CSS logical properties | Golden tests in `ar` |
| GLB-06 | P2 | Names/addresses | Unicode names; flexible address model (line1/line2/city/region/postal optional/country) | Validation tests |
| GLB-07 | P1 | Tax & payment availability | BILL-17 | — |
| GLB-08 | P2 | Slow networks | Timeouts §4.1, payload budgets, skeletons | Network-throttled E2E |
| GLB-09 | P1 | Privacy law | Data export (JSON/CSV) per user and tenant; deletion (AUTH-07); consent for marketing; cookie banner on web where required; published data-retention policy | Export contains all personal data |

---

### 12.12 Observability (OBS)

| ID | Sev | Requirement | Fix |
|---|---|---|---|
| OBS-01 | P1 | Structured JSON logs (pino) with `requestId`, `tenantId`, `userId` (ID only), `route`, `latencyMs`, `status` via AsyncLocalStorage; `X-Request-Id` accepted from clients and returned | Middleware + client interceptors |
| OBS-02 | P1 | Error tracking (Sentry or equivalent) in all 4 apps with release, environment, and user ID (no personal data); source maps / dSYMs uploaded in CI | SDK setup |
| OBS-03 | P1 | Metrics: request rate/latency/error per route, DB pool usage per tenant, queue/outbox lag, webhook processing lag, FCM failure rate, socket connections | Prometheus/OpenTelemetry or APM |
| OBS-04 | P1 | DB: slow-query log (> 200 ms) in staging and prod; weekly index review | MySQL config + dashboard |
| OBS-05 | P1 | Billing: every `BillingEvent` visible per tenant in admin; alert on unprocessed > 10 min, verification failures, `duplicateBilling` | Admin view + alerts |
| OBS-06 | P1 | Capacity: nightly `auditCapacity` for all tenants → alert on any drift or empty ACTIVE org | Cron + alert |
| OBS-07 | P1 | Audit trails: admin log, approval log, ledger — immutable, queryable | — |
| OBS-08 | P2 | Client performance: Firebase Performance / web-vitals reporting | SDK |
| OBS-09 | P1 | Alerts have runbooks (what it means, first checks, rollback) in `docs/runbooks/` | Docs |


---

### 12.13 Verification results (Prompt 0)

**Read-only audit, 2026-09-26, Claude Code (Opus 5.5).** Every §12 issue checked against the code at these commits:
`gymsera_be` e237dc9 · `gyms_era` 809344b · `gymsera_cms` 8e18096 · `gymsera_web` 5b66fea.
Paths are relative to each repo (`be/` = `gymsera_be`, `app/` = `gyms_era`, `cms/` = `gymsera_cms`, `web/` = `gymsera_web`).

**Result values:** `CONFIRMED` (defect exists; file:line) · `PARTIAL` (some of the protection exists, the rest is missing; counted as CONFIRMED in totals) · `NOT REPRODUCED` (code already correct; file:line) · `NEEDS RUNTIME CHECK` (can't be decided from code alone; reason given).
Severity is the §12 severity unless the note says it was raised.

**Summary (164 §12 issues + new findings):**

| Result | Count | Notes |
|---|---|---|
| CONFIRMED | 98 | |
| PARTIAL (counted as confirmed) | 40 | |
| NOT REPRODUCED | 6 | AUTH-03, SEC-16, FLOW-13 fully; BILL-14, CAP-04, SEC-14 are split results (the named risk is absent, a related gap is confirmed) |
| NEEDS RUNTIME CHECK | 12 | CAP-08, FLOW-05, UX-06, UX-10, RT-03, RT-07, RT-09, PERF-01, PERF-02, PERF-11, GLB-06, OBS-04 (plus the Apple half of BILL-03, counted as CONFIRMED) |
| Decision rows (§14) | 4 | BILL-16, BILL-17, FLOW-11, GLB-07 |
| DEFERRED (R-13/R-14) | 4 | UX-03, UX-05, UX-16, UX-25 |
| **NEW** | **17** | 9 × P0 (NEW-01…08, NEW-15), 8 × P1 (NEW-09…14, NEW-16, NEW-BOOST) |

**Top risks, in the order Phase 1 should take them:** account takeover through social sign-in (NEW-02, NEW-03); unauthenticated maintenance/debug endpoints (NEW-01, NEW-04, NEW-05); free entitlement paths (NEW-15, NEW-06, NEW-07, BILL-04/08 unpaid states treated as ACTIVE, BILL-01 cross-account restore); cross-tenant access (SEC-02, NEW-08/SEC-01, RT-04); legacy RBAC still granting access (RBAC-07, AUTH-08).

#### 12.13.1 BILL

| ID | Result | Evidence | Notes |
|---|---|---|---|
| BILL-01 | CONFIRMED (worse than described) | `be/src/services/apple-billing.service.js:186-252`, `be/src/services/google-play-billing.service.js:133-184`, `be/src/services/stripe-billing.service.js:252-305`; client `app/lib/features/billing/presentation/providers/billing_provider.dart:249-262` | Lookup is by `externalOriginalTransactionId` only, never by tenant. `values.tenantId` is the **caller's** tenant and `existing.update(values)` writes it, so tenant B restoring tenant A's transaction **moves the row to B** (A silently loses its plan, no reconcile on A). No `appAccountToken`/`obfuscatedExternalAccountId` is sent (`PurchaseParam` has no `applicationUserName`) or checked. `external_original_transaction_id` is indexed, not unique (`be/src/models/platform/TenantSubscription.model.js:144`). |
| BILL-02 | PARTIAL | Apple `apple-billing.service.js:182,217` (`revocationDate` → `CANCELLED`); Google `google-play-billing.service.js:93-105` (no revoked/voided handling); Stripe `stripe-billing.service.js:393-442` (no `charge.refunded` / `charge.dispute.created`) | No `REVOKED` state (`TenantSubscription.model.js:99`). Apple refund is noticed only if the webhook carries it. Removing the ACTIVE row does **not** drop entitlement to 0: `resolveMaxBranches` falls back to `tenant.selectedPackageId` or `1` (`be/src/services/subscription-quota.service.js:46-50`). No Voided Purchases sweep. |
| BILL-03 | CONFIRMED (Android, Stripe); NEEDS RUNTIME CHECK (Apple) | Android `app/lib/features/billing/presentation/providers/billing_provider.dart:369-376` uses `ReplacementMode.withTimeProration` for upgrades **and** downgrades; Stripe `stripe-billing.service.js:176-180` `proration_behavior: 'create_prorations'` (immediate); server applies `plan.branchCount` of the verified product immediately (`apple-billing.service.js:197-202`) | Apple: a downgrade's signed transaction normally keeps the current product until renewal, so the immediate-apply risk depends on what Apple returns — verify in sandbox. No `pendingChange`, no "choose branches to keep". |
| BILL-04 | CONFIRMED | `TenantSubscription.model.js:98-102`; Google `google-play-billing.service.js:93-105` maps `ON_HOLD`, `PAUSED`, `PENDING` (and any unknown state) to **ACTIVE** via `default`; Stripe `stripe-billing.service.js:212-217` maps `past_due`, `incomplete`, `paused` to **ACTIVE** | Raised to **P0** in effect: an unpaid/on-hold subscription keeps full entitlement. Google `CANCELED` (auto-renew off, still paid to period end) maps to `CANCELLED`, which removes entitlement early. |
| BILL-05 | CONFIRMED | `apple-billing.service.js:195,214-216`; `google-play-billing.service.js:139,154-156`; `stripe-billing.service.js:258,277-279` | `amount` only written when `planChanged`; always the catalog price, never the provider's charged amount; no currency from the provider. |
| BILL-06 | PARTIAL | `be/src/controllers/billing.controller.js:132-139`; `google-play-billing.service.js:262-273` | Server-side acknowledge exists but is fire-and-forget after the response, not retried, and errors are only logged. RTDN path (`handleRtdnNotification`, `:282-300`) never acknowledges. If the app dies before `/sync`, nothing acknowledges and Play auto-refunds after 3 days. |
| BILL-07 | CONFIRMED | no `purchase-intent` route in `be/src/routes/billing.routes.js`; `subscription-migration.service.js:115-206` repairs afterwards | Only a Stripe-on-Stripe guard exists (`stripe-billing.service.js:117-120`). |
| BILL-08 | CONFIRMED (raised to P0) | server `google-play-billing.service.js:102-103` (`SUBSCRIPTION_STATE_PENDING` → ACTIVE, `paymentStatus: 'PAID'` at `:159`); client `billing_provider.dart:521-525` (pending shows the generic "purchasing" spinner) | A pending (not yet paid) Play purchase grants the plan immediately if the app syncs it. |
| BILL-09 | PARTIAL | `be/src/services/subscription-migration.service.js:285-298` | Resurrection is refused and a `statusNote` is written, but there is no `duplicateBilling` flag, no host banner, no admin flag, no email — only a server `console.warn`. |
| BILL-10 | CONFIRMED | Legacy sales still live: `be/src/controllers/host.controller.js:841-913` (host self-serve upgrade), `be/src/services/admin.service.js:675-782` (admin assign), `be/src/services/tenant-provisioning.service.js:510-545` (approval auto-subscription) — all create `platformPackageId` rows with no `billingPlanId`/`branchCount` | See also NEW-06 (the host upgrade grants any package for free). |
| BILL-11 | CONFIRMED | `be/src/models/platform/BillingPlan.model.js:49-51` (one `currency` column, default `PKR`) | Apps already prefer the store's localized price (`billing_provider.dart:209-214`). |
| BILL-12 | CONFIRMED | `be/src/controllers/billing.controller.js:102-109` (Apple: always 200, even on a transient DB error — the event is lost); no `BillingEvent` table (grep); `apple-billing.service.js:345-351` and `google-play-billing.service.js:293-298` drop notifications for unknown transactions; Apple uses the payload, not a refetch | No inbox, no dedupe beyond `CapacityEvent` keys, no sweep, no ordering protection. Google does refetch (`:289`). |
| BILL-13 | CONFIRMED | `be/src/services/tenant-provisioning.service.js:510-545` | Approval creates an **ACTIVE** MANUAL row with `paymentStatus: 'PENDING'` for a full package cycle (up to a year); nothing expires it early when unpaid. Not indefinite: the expiry cron suspends at `endDate` (`be/src/jobs/subscription-expiry.cron.js:145-170`). |
| BILL-14 | NOT REPRODUCED (entitlement); CONFIRMED (UX) | Entitlement only from the verified webhook: `stripe-billing.service.js:386-445`. Web: `web/src/app/(dashboard)/gymsera-billing/page.tsx` — see §12.13.9 UX-02 | The query param can't grant anything. Whether the page *shows* success on `?checkout=success` is a UX item. Web card payments are OFF by R-7 anyway. |
| BILL-15 | CONFIRMED | `BillingPlan.model.js:55-75` (`iosSyncStatus`/`androidSyncStatus` are admin-set flags); no verifier job in `be/src/jobs/` | P2. |
| BILL-16 | — (decision) | §14 R-1 | Decided: keep IAP. |
| BILL-17 | — (decision) | §14 R-7 | Decided: web card OFF. No `WEB_CARD_PAYMENTS_ENABLED` flag exists yet (grep) — Stripe checkout routes are live (`be/src/routes/billing.routes.js:153-222`); the flag must be added. |
| BILL-18 | CONFIRMED (R-15) | `app/lib/features/host/presentation/screens/boost_listing_screen.dart` (fake "Pay & Activate" success) | Logged as NEW-BOOST below. |

#### 12.13.2 CAP

| ID | Result | Evidence | Notes |
|---|---|---|---|
| CAP-01 | CONFIRMED | `be/src/services/subscription-quota.service.js:271-278` (over-quota only sets `overQuotaCount`); no `billingLock` on `be/src/models/tenant/Branch.model.js` | Over-quota blocks new branches/restores only (`be/src/services/gym.service.js:473-481`, `:1039-1046`); existing branches keep selling. Also: a lapsed tenant falls back to `maxBranches = selectedPackage.maxBranches` or `1` (`subscription-quota.service.js:46-50`), never 0. |
| CAP-02 | CONFIRMED | `be/src/services/gym.service.js:44-57` (3 retries, then `console.error` and give up), used at `:904-947` after the tenant commit at `:889` | Only `auditCapacity` notices; no outbox. |
| CAP-03 | CONFIRMED | Four branch creators outside `createBranch`: admin `be/src/services/admin.service.js:1180-1264` (own copy of the capacity check, **no Tenant row lock**, so it races with host `createBranch` at `gym.service.js:445-451`); `be/src/services/membership-plan.service.js:201-211` (a **GET** `listForHost` creates an ACTIVE branch with no capacity check when the tenant has no plans and no branches); provisioning `be/src/services/tenant-provisioning.service.js:302-323` (re-approval flips an existing branch back to `ACTIVE` with no capacity event); new-org `be/src/controllers/host.controller.js:396-640` (own capacity copy, shares `_createBranchRecord`). Plus an unauthenticated mass `Branch.update` at `be/src/routes/discovery.routes.js:580-617` (NEW-01). | `moveBranch` (`gym.service.js:578-646`) and `deleteOrganization` (`:1127-1248`) run without a transaction or lock. |
| CAP-04 | NOT REPRODUCED (bypass); CONFIRMED (missing concept) | Admin status change delegates to `deleteBranch`/`restoreBranch`: `be/src/services/admin.service.js:576-591`, `:1283-1294` | No direct `status` write. But there is no separate `adminSuspended` state: an admin "disable" deletes the branch (credits capacity, cancels memberships). No audit row. |
| CAP-05 | CONFIRMED | New org is `PENDING` with an ACTIVE branch built immediately (`be/src/controllers/host.controller.js:542`, `:619`); reject only sets the listing to `REJECTED` (`be/src/services/admin.service.js:370-375`) | The branch stays ACTIVE and keeps consuming capacity; `getUsedCapacity` still counts the REJECTED listing's `reservedSlots` (it only excludes INACTIVE, `subscription-quota.service.js:102`). |
| CAP-06 | CONFIRMED | `be/src/services/gym.service.js:1027-1029` | Restore into an INACTIVE org returns 409 ("move it instead") instead of reactivating the org; the org's preserved `reservedSlots` become inert (`subscription-quota.service.js:98-102`). |
| CAP-07 | PARTIAL | Guard exists for delete and move (`gym.service.js:427-443`, `:388-419`) | Missing: `auditCapacity` does not report ACTIVE orgs with zero branches (`subscription-quota.service.js:309-386`); `moveBranch`/`deleteOrganization` accept an INACTIVE target org (`gym.service.js:595`, `:1140`); the expiry cron sets **all** the tenant's listings INACTIVE (`be/src/jobs/subscription-expiry.cron.js:165-168`), which also makes their `reservedSlots` inert and nothing reactivates them on renewal/reactivation (`admin.service.js:481-506`). |
| CAP-08 | NEEDS RUNTIME CHECK | Host `createBranch` locks the Tenant row (`gym.service.js:445-451`); delete/restore lock the branch row (`:817`, `:1010`) | Code looks serialised for host paths; admin create (above) does not take the Tenant lock. Needs the parallel test. |

#### 12.13.3 FLOW

| ID | Result | Evidence | Notes |
|---|---|---|---|
| FLOW-01 | PARTIAL | `be/src/services/tenant.service.js:36-60` (one tenant per user, resumable via `GET /tenants/me`); no DRAFT purge job in `be/src/jobs/` | No step idempotency keys; abandoned DRAFTs and KYC files are never purged (R-16 wants 30 days). |
| FLOW-02 | CONFIRMED | `be/src/services/admin.service.js:317-339` → `be/src/services/tenant-provisioning.service.js` (whole flow inline) | No `provisioningState`; `APPROVED` is re-approvable (`admin.service.js:317`) so a double-click runs provisioning twice concurrently; Tenant set ACTIVE (`tenant-provisioning.service.js:499-503`) **before** the subscription step, whose failure is swallowed (`:541-543`). Fallback to `root`/empty password when admin credentials fail (`:67-81`). |
| FLOW-03 | PARTIAL | Double entitlement is prevented: approval skips auto-create if **any** subscription row exists (`tenant-provisioning.service.js:510-515`) | But: the card path (`web/src/app/gym-owner/register/page.tsx:355-372`) charges **before** review (contradicts R-4) and never calls `finalizeApplication`, so the tenant stays `DRAFT`, which `approveTenant` refuses (`admin.service.js:317`) — a paying applicant can get stuck. Card must be hidden anyway (R-7). |
| FLOW-04 | CONFIRMED | Rejected tenant cannot edit its application (`be/src/services/tenant.service.js:71`) and cannot register again (`:38-39`) | No re-application path, no KYC retention/deletion, no refund hook. |
| FLOW-05 | NEEDS RUNTIME CHECK | All four hypotheses fail on the code: no HTTP cache interceptor (`app/lib/core/network/dio_client.dart:27-35`); one `ProviderContainer` (`app/lib/main.dart:30-39`); the screen `ref.watch`es the provider (`app/lib/features/host/presentation/screens/listings_overview_screen.dart:36`) and does not filter by status (`:109-111`); the API returns PENDING orgs (`be/src/controllers/host.controller.js:356-359`); both create paths invalidate `hostListingsProvider` (`app/lib/features/host_onboarding/presentation/providers/host_onboarding_providers.dart:911`, `app/lib/features/host/presentation/screens/new_organization_quick_form_screen.dart:96`) | Needs the debug-log run described in §12 FLOW-05. One untested lead: `getListings` uses `req.user.tenantId` from the token (`host.controller.js:346-349`) — a stale token after onboarding returns `[]`. |
| FLOW-06 | CONFIRMED | Expiry in server UTC, not branch timezone (`be/src/jobs/subscription-expiry.cron.js:35-46`); renew extends from the old `endDate`, not `max(now, end)` (`be/src/services/subscription.service.js:414-415`); freeze never extends `endDate` and nothing unfreezes (`:340-366`; cron only expires ACTIVE) | See NEW-07: a member can renew their own membership to ACTIVE without paying. |
| FLOW-07 | PARTIAL | Dedupe by e-mail only (`be/src/services/gym.service.js:1451-1460`) | No phone normalisation/matching; enrolment silently creates a **verified** platform account for any e-mail typed by staff. |
| FLOW-08 | PARTIAL | Server recomputes price (`be/src/services/subscription.service.js:236-239`) and the membership stays PENDING until staff verify payment (`:194-206`) | No gateway, no webhook, no idempotency key (two taps → the 409 guard at `:180-186` only). Member plan **upgrade applies the new plan immediately** before payment (`:742-746`). Floats for money (`parseFloat`). |
| FLOW-09 | CONFIRMED | `be/src/services/attendance.service.js:34-45` | QR is a static token that changes only on renew; the scanner also accepts the raw **subscription id or user id** as a QR value. Only a 5-minute duplicate window (`:61-81`). |
| FLOW-10 | PARTIAL | `be/src/services/discovery.service.js:907-937` | Requires *any* subscription row (a never-paid PENDING or CANCELLED one counts); reviews are auto-`APPROVED` (no moderation); editing a moderator-REJECTED review flips it back to APPROVED (`:916-924`); `review` is an undeclared variable (implicit global) at `:927`. The listing-level route passes the body as `branchId` (`be/src/controllers/discovery.controller.js:144`), so it always fails. No rate limit. |
| FLOW-11 | — (decision) | §14 R-5 | Manual review stays. |
| FLOW-12 | CONFIRMED | `be/src/routes/staff-invites.routes.js:95-106` | Invite = the `GymStaff` row id, not a single-use token; no expiry; if `staff.userId` is null anyone with the id can accept; acceptance writes the **global** `users.role = 'BRANCH_MANAGER'` (feeds SEC-02); lookup loops over every tenant DB (`:30-44`). The `/team/invites` path is separate (see RBAC). |
| FLOW-13 | NOT REPRODUCED | No trainer-booking feature exists (grep for `booking`/`slotStart` finds only a permission constant) | Re-open if bookings are built. |

#### 12.13.4 PAY

| ID | Result | Evidence | Notes |
|---|---|---|---|
| PAY-01 | PARTIAL | `be/src/services/payment.service.js:90-96` (optional key, check-then-insert); unique index `be/src/database/TenantDbManager.js:131` | Key is optional, not required. Two concurrent requests with the same key both pass the `findOne` and the second hits the unique index → 500, not a replay. Payment + membership activation are not one transaction (`payment.service.js:101-155`). |
| PAY-02 | CONFIRMED | `be/src/models/tenant/Payment.model.js:40-42` `DECIMAL(10,2)` with JS `parseFloat`/`Number` arithmetic (`be/src/services/subscription.service.js:236-239`, `:736-740`); `TenantSubscription.amount DECIMAL(10,2)` | DECIMAL storage is acceptable per §6.3, but all arithmetic is float. Currency hard-coded `'PKR'` in several creators. |
| PAY-03 | CONFIRMED | There is no ledger-entry table: the ledger is computed from `payments` rows, which are updated in place (`payment.service.js:265`, `:429`, `:450`, `:550-563`, `:577`) | Verifying/rejecting an old payment changes the history of a past business day. Adjustments are a separate append-only table (`be/src/services/ledger.service.js:274-314`). |
| PAY-04 | PARTIAL | Business date in branch timezone (`ledger.service.js:36-64`); close is race-safe and one-shot (`:316-366`) | Step 2.7: Payment `business_date` is set once from collection time and made strictly immutable via model hooks (`Payment.model.js`). `verifyPayment`, `markPrinted`, `uploadPaymentProof`, and `markPaymentFailed` never shift `business_date`. Updates attempting to mutate `business_date` are rejected. Migration 006 enforces `business_date DATE NOT NULL` conditionally. Step 2.8: Single authority `getPaymentCollectionTime` in `ledger.service.js` unifies fallback rule (`collected_at` -> `created_at` for CASH; `paid_at` for ONLINE/BANK_TRANSFER) across model hooks, Migration 004, and Query B. Step 2.9: Added maintenance repair script (`src/scripts/repair-payment-business-dates.js`) with preview-by-default (read-only transaction), `--apply --confirm` safety guard, CLOSED ledger day protection ("needs manual adjustment"), tenant-level transactions, and audit logging to `audit_logs` with before/after state via `allowBusinessDateRepair` hook bypass. Step 2.11: Refined `getPaymentCollectionTime` to select EARLIER of created_at and paid_at for CASH without collected_at (normal rows keep created_at; imported rows with import-time created_at use paid_at); non-cash pending payments finalize provisional business_date automatically on first completion via payment service with `fromPaymentServiceTransition: true`; ordinary updates remain immutable. Note: `addAdjustment` refusal on CLOSED day remains for Phase 1. |
| PAY-05 | CONFIRMED | Three copies of a random `INV-YYYYMMDD-<6 hex>` generator: `payment.service.js:10`, `gym.service.js:9`, `subscription.service.js:48` | Not sequential, not gapless, collisions possible, not per branch. |
| PAY-06 | PARTIAL | `staffCollectedBy`/`createdBy` recorded (`Payment.model.js:78`, `payment.service.js:547-563`) | No shift concept; daily close shows totals, not cash per collector vs expected. |
| PAY-07 | CONFIRMED (not built) | `REFUNDED` exists only as a constant (`be/src/constants/payment-status.js:6`); no refund service or route (grep) | Refunds can't be recorded at all. |
| PAY-08 | CONFIRMED (not built) | No gateway/webhook for member payments; `markPaymentFailed` (`payment.service.js:568-600`) has no route caller from a verified gateway | A `TEST` payment method auto-completes and activates memberships when the `X-Test-Payment-Key` header matches (`be/src/routes/payments.routes.js:67-81`, `payment.service.js:98`) — a test backdoor that is live wherever `PAYMENT_TEST_KEY` is set. |
| PAY-09 | PARTIAL | `app/lib/core/services/printer_service.dart` (no "DUPLICATE" marker, no raster rendering for Urdu/Arabic) | `printed_at` is tracked server-side (`TenantDbManager.js:133-138`). |
| PAY-10 | CONFIRMED (not built; fake UI) | No payout code in `be/src` (grep); mobile "Request payout" shows a hard-coded "Rs42,300 submitted" success without any API call (`app/lib/features/host/presentation/screens/request_payout_screen.dart:42-61`, `:391`); bank accounts are a local `StateProvider` (`app/lib/features/host/presentation/providers/host_profile_provider.dart:61`) | See NEW-09. |
| PAY-11 | CONFIRMED | `be/src/services/reports.service.js:81`, `:193`, `:240`, `:288` bucket by `paidAt`/`createdAt` with server-local dates | Not built from business dates in branch timezone; no pre-aggregates. |
| PAY-12 | PARTIAL | Reason required + audit row (`ledger.service.js:274-314`); guarded by `can('ledger.verify')` (`be/src/routes/ledger.routes.js:123-127`) | No approval tier for adjustments. |

#### 12.13.5 AUTH and RBAC

| ID | Result | Evidence | Notes |
|---|---|---|---|
| AUTH-01 | PARTIAL | `be/src/services/auth.service.js:642-672` rotates on use | Refresh tokens are JWTs stored **in plain text** (`be/src/models/platform/RefreshToken.model.js:16`); reusing a revoked token just returns 401 — no reuse detection, no session-family revoke. |
| AUTH-02 | CONFIRMED | No session list/revoke and **no logout endpoint** in `be/src/routes/auth.routes.js` (grep "logout" finds nothing) | Only password reset revokes all refresh tokens (`auth.service.js:744`). |
| AUTH-03 | NOT REPRODUCED | Mobile single-flight `Completer` (`app/lib/core/network/error_interceptor.dart:13-80`); CMS/web `isRefreshing` + subscriber queue (`cms/src/lib/api/client.ts:21-71`, `web/src/lib/api/client.ts:21-71`) | Web/CMS never reject queued subscribers when the refresh fails (they hang); minor. |
| AUTH-04 | CONFIRMED | 6-digit codes, 10-minute expiry (`be/src/utils/otp.utils.js:7-20`) but stored in plain text and matched by DB equality (`auth.service.js:32-40`); no attempt counter (grep `attempt` in `Otp.model.js`/`auth.service.js` finds nothing); auth limiter is 1000 requests / 15 min per IP (`be/app.js:156-173`) | Brute force of a 6-digit code is feasible; no per-identifier limit or lockout. |
| AUTH-05 | PARTIAL | One backend verifier with an `aud` allow-list, used by mobile, web and CMS (`auth.service.js:324-386`; `web/src/lib/api/auth.ts:51`; CMS uses `/auth/social/google/staff`) | But the verifier has an unsigned-token fallback (NEW-03) and links accounts by e-mail. |
| AUTH-06 | CONFIRMED (**P0**) | `auth.service.js:518-560` | Apple identity token is only `jwt.decode`d — **signature never verified**, `aud` computed but not enforced (`:536`, `:539`), `appleId` and e-mail may come from the client (`:548-549`) and an existing account is linked by e-mail (`:567-580`). Anyone can sign in as any user. Same flaw in re-auth (`:831-844`). See NEW-02. |
| AUTH-07 | CONFIRMED | `be/src/services/me.service.js:439-447` | "Request deletion" only sets `users.status = INACTIVE`. No tenant deletion, no store-subscription preflight, no re-auth, no undo window, no data deletion, no Apple token revoke, no device-token cleanup. |
| AUTH-08 | PARTIAL (P0 in effect) | `can()` resolves grants from the DB per request with version-keyed cache (`be/src/services/access.service.js:176-200`) | Legacy `authorize()` routes use the **JWT role**, and `applyLegacyRoleShim` returns early when the user has no live assignment (`be/src/middleware/tenantContext.js:67`), so a revoked team member whose `users.role` was set to `BRANCH_MANAGER` keeps access to every `/gyms/*` route (`be/src/routes/gyms.routes.js:13`) until they leave the tenant context. |
| AUTH-09 | CONFIRMED | `be/src/services/admin.service.js:14-34` | Links an existing account by e-mail and upgrades its role to `GYM_HOST`, or creates a **verified** account with a random password; no invitation, no audit. `team.service.js:245-266` does the same for team invites. |
| AUTH-10 | PARTIAL | Reset code is single-use, 10 minutes, and revokes refresh tokens (`auth.service.js:718-747`) | Code stored in plain text, no attempt limit (see AUTH-04). |
| RBAC-01 | PARTIAL | Grantor cap enforced (`access.service.js:367-386`); preset tiers are not written by overrides | The save is a full overwrite (`PUT /team/:id/permissions` → `be/src/services/team.service.js:428-470` deletes all overrides and re-inserts), not `changes[]`; a client that omits a row silently removes it. |
| RBAC-02 | CONFIRMED | Backend role name "Support" (`be/src/constants/roles.js:116-118`); mobile shows "Cleaner" (`app/lib/features/host/presentation/screens/team_access_screen.dart:16`, `:209`) | No shared `roleLabels` table; the CMS has no team screen yet. P2. |
| RBAC-03 | CONFIRMED | `be/tests/*.test.js` are hand-written scenarios against a **live** server (`be/tests/helpers.js:1-12`) | No generated endpoint × persona matrix. |
| RBAC-04 | PARTIAL | Approver re-checked at decision time, race-safe claim, command re-validated (`be/src/services/approval.service.js:161-240`) | Requester's current access is not re-checked; command execution is not in a transaction with the claim — a command that half-succeeds and then throws is reset to PENDING (`:241-250`) and can execute again. |
| RBAC-05 | PARTIAL | Level rule on invite and update (`access.service.js:338-360`; `team.service.js:208`, `:360`) | There is no acceptance step: `/team/invites` creates an **ACTIVE** assignment immediately (`team.service.js:286-300`), so "re-check at acceptance" can't exist. |
| RBAC-06 | CONFIRMED | Admin routes guarded only by `authorize('PLATFORM_ADMIN')` (`be/src/routes/admin.routes.js`) | No sub-roles; `be/src/middleware/auditLog.js` exists but see SEC-12. |
| RBAC-07 | CONFIRMED (**P0**) | Legacy access sources still live: `GymStaff.designation === 'admin'` grants payments/expenses access (`be/src/controllers/payments.controller.js:35-45`, `be/src/controllers/expenses.controller.js:97`); legacy staff CRUD `/gyms/staff` → `createStaffUser` (`be/src/services/gym.service.js:1707-1760`, sets global `users.role = 'BRANCH_MANAGER'`); `/staff-invites/*` (`be/src/routes/staff-invites.routes.js:95-106`); CMS `/gym/staff` page | The legacy shim maps **any** live assignment to `BRANCH_MANAGER` (`tenantContext.js:69-75`), so a Cleaner passes every `authorize('GYM_HOST','BRANCH_MANAGER')` route — e.g. `PATCH /gyms/profile` (change the gym's payment details) and `PATCH /gyms/branches/:id` for any branch. |
| RBAC-08 | CONFIRMED | `team.service.js:428-470` | No `expectedVersion`; last write wins (the code comment claims PUT prevents this; it does not). |
| RBAC-09 | CONFIRMED | `deleteBranch` terminates `GymStaff` only (`gym.service.js:860-865`); `RoleAssignmentBranch` links survive | After `restoreBranch` the old branch-scoped assignments grant access again automatically. |

#### 12.13.6 SEC

| ID | Result | Evidence | Notes |
|---|---|---|---|
| SEC-01 | CONFIRMED (**cross-tenant**) | `be/src/services/subscription.service.js:124-140` | Any user whose platform `users.role` is GYM_HOST/BRANCH_MANAGER/FRONT_DESK can look up **any** subscription id across **all** tenants and freeze, cancel, renew, change or upgrade it (`/subscriptions/:id/*`, `/member/subscriptions/:id/upgrade`). See NEW-08. Payments by id are branch-checked (`be/src/controllers/payments.controller.js:109-120`). |
| SEC-02 | CONFIRMED (**P0**) | `be/src/middleware/tenantContext.js:95-96` accepts `X-Tenant-Id` / `?tenantId` / body `tenantId` without checking the user belongs to that tenant | Exploit: a user whose `users.role` was set to `BRANCH_MANAGER` by the legacy staff flows (`be/src/routes/staff-invites.routes.js:105`, `be/src/services/gym.service.js:1754-1760`) has no `tenantId` in the token, sends another gym's id, and passes `authorize('GYM_HOST','BRANCH_MANAGER')` on all `/gyms/*` routes of that gym (members list/enrol, branch edit, profile + payment details). `can()` routes are safe (grants come from the target tenant's DB). |
| SEC-03 | PARTIAL | Apple: x5c chain to pinned root + ES256 verify (`be/src/services/apple-billing.service.js:59-103`); Stripe: `constructEvent` on the raw body (`be/src/services/stripe-billing.service.js:391`) | Google RTDN is authenticated by a static `?token=` in the URL (`be/src/routes/billing.routes.js:111-128`), not the Pub/Sub OIDC token; the token lands in access logs. |
| SEC-04 | CONFIRMED | `be/app.js:132-173` | In-memory store (per process, reset on restart), 10,000 req/15 min per IP for the API, 1,000 for auth; social-login routes are exempt. No Redis store, no per-user or per-identifier limits. |
| SEC-05 | CONFIRMED | Hard-coded maintenance keys in git (`be/src/routes/index.js:90`, `:191`, `:238`, `:288`, `:328`; NEW-05); provisioning falls back to MySQL `root` with an empty password (`be/src/services/tenant-provisioning.service.js:78-81`); a Firebase service account can be written to disk through an API call (`index.js:236-284`) | `.env` is git-ignored and not tracked (checked). No secret scanning in CI (there is no CI). |
| SEC-06 | PARTIAL | Service-level allow-lists exist on the paths checked (`be/src/services/gym.service.js:771-779`, `be/src/services/me.service.js:119-124`, `be/src/services/tenant.service.js:187-193`) | The `validate` middleware never rejects unknown fields (`be/src/middleware/validate.js:10-22`) and many mutating routes have no validator at all (e.g. `POST /gyms/members/enroll`, `be/src/routes/gyms.routes.js:315`). |
| SEC-07 | CONFIRMED | E-mails logged in clear: `be/src/services/auth.service.js:413`, `:556`, `:685`; `console.log('[Audit]', JSON.stringify(entry))` in non-production (`be/src/middleware/auditLog.js:34-37`) | No redaction layer; `morgan('combined')` logs full URLs including the RTDN `?token=`. |
| SEC-08 | PARTIAL | MIME allow-list + 10 MB limit (`be/src/middleware/upload.js:4-31`) | Trusts the client MIME type (no magic-byte check), no re-encode/EXIF strip, no virus scan; falls back to **public local disk** (`be/src/services/storage.service.js:59`, `:76`, served by `be/app.js` `/uploads`). |
| SEC-09 | PARTIAL | Raw card number / expiry / CVV fields exist (`app/lib/features/subscriptions/presentation/screens/add_card_screen.dart:190-310`) but "Add card" only shows "coming soon" and sends nothing (`:364-371`) | A hard-coded fake saved card "Visa ···4242" is shown to every user (`app/lib/features/me/presentation/providers/me_providers.dart:149-163`). No PCI exposure today; remove the fields and the fake card. |
| SEC-10 | CONFIRMED | KYC documents are client-supplied URLs saved as-is (`be/src/services/tenant.service.js:94`) and uploaded through the same public image pipeline | No encryption, no private bucket, no access log, no retention. |
| SEC-11 | CONFIRMED | Same as FLOW-09 (`be/src/services/attendance.service.js:34-45`) | |
| SEC-12 | CONFIRMED | `be/src/middleware/auditLog.js:30-44` writes `AuditLog` to the platform DB, but no `AuditLog` model is registered in `be/src/models/platform/index.js` (grep: 0 hits), so every production write fails and is swallowed | Admin actions (approve/reject/suspend/assign/revoke) have no audit rows. Tenant-DB `audit.service.js` exists for team/ledger/approvals only. |
| SEC-13 | CONFIRMED | The gym's public payment details (`Tenant.paymentDetailsJson`, shown to members at `be/src/services/discovery.service.js:1132-1136`) are changed by `PATCH /gyms/profile` (`be/src/services/gym.service.js:185-190`) | Reachable by **any** team role through the legacy shim (RBAC-07); no re-auth, no owner notification, no cooling period. Payouts themselves don't exist (PAY-10). |
| SEC-14 | NOT REPRODUCED (sinks); CONFIRMED (CSP) | No `dangerouslySetInnerHTML` in `web/src` or `cms/src` (grep) | No CSP on either Next.js app (`web/next.config.mjs`, `cms/next.config.mjs` define no headers). |
| SEC-15 | CONFIRMED | Access and refresh tokens in `localStorage` (`web/src/lib/api/client.ts:13`, `:53-68`; same in `cms/src/lib/api/client.ts`) | No CSP to compensate (SEC-14). |
| SEC-16 | NOT REPRODUCED | Raw SQL found only with server constants (`be/src/services/ledger.service.js:214-215`, `be/src/database/platform.js`); no user input in `order`/`literal` (grep) | Keep the check in the SAST step. |
| SEC-17 | CONFIRMED | Admin tenant/member views return full e-mail and phone (`be/src/services/admin.service.js:98`, `:124`, `:612`) | No masking, no reveal audit. P2. |
| SEC-18 | PARTIAL | API uses `helmet` (`be/app.js:47-60`, CSP relaxed with `unsafe-inline` for Swagger) | Neither Next.js app sets HSTS/frame-ancestors/Referrer-Policy/nosniff. |

#### 12.13.7 REL and API

| ID | Result | Evidence | Notes |
|---|---|---|---|
| REL-01 | CONFIRMED | No idempotency middleware in `be/src/middleware/`; only `POST /payments` takes an optional key (`be/src/services/payment.service.js:90-96`) | Branch create/delete/restore, org create, billing sync, enrol, check-in, approvals: none take a key. |
| REL-02 | PARTIAL | Shared button has `isLoading` → disabled (`app/lib/core/widgets/gymsera_primary_button.dart:8-23`) | Not audited per control; needs the widget-test sweep. |
| REL-03 | CONFIRMED | `node-cron` in every process (`be/server.js:72-76`) **and** Vercel cron (`be/vercel.json` → `be/src/routes/cron.routes.js`) run `runExpiryCheck`; no lock | iisnode can run several workers → several runs per day. |
| REL-04 | CONFIRMED | `_reconcileCapacityForAllTenants` opens a connection for every ACTIVE subscription with no tenant-status filter (`be/src/jobs/subscription-expiry.cron.js:208-222`); the expiry pass **suspends the tenant and hides all its listings** (`:153-168`) | The §9.6 `getConnection` mutation is gone, but `getConnection` still runs `ALTER TABLE`/`UPDATE` backfills on first connect (`be/src/database/TenantDbManager.js:48-195`) — see §9.6 regression row in §13. |
| REL-05 | PARTIAL | `server.close` + 10 s force exit (`be/server.js:97-113`) | No drain of Bull queue/socket; `uncaughtException`/`unhandledRejection` are swallowed and the process keeps running (`be/server.js:2-7`). |
| API-01 | CONFIRMED | Success `{success,message,data}` (`be/src/utils/response.utils.js:9-13`); errors vary: `errorHandler`, `validate` (422 with `errors[]`, `be/src/middleware/validate.js:14-20`), `tenantContext` (own JSON), webhooks (`{received}`) | Not the §4.1 envelope; no `requestId`; `code` only on some errors. |
| API-02 | PARTIAL | Mobile dio: 20 s connect / 45 s receive (`app/lib/core/network/dio_client.dart:18-19`); single retry after token refresh only | No retry/backoff policy for GETs; no server request timeout. |
| API-03 | CONFIRMED | No `/me/bootstrap` route (grep); startup reads `/auth/me`, `/me/context`, quota, listings, notifications separately | |
| API-04 | CONFIRMED | Per-request loops over **every** tenant DB: discovery (`be/src/services/discovery.service.js:23`, `:50-110`, `:309`, `:559`, `:645`, `:1106`, `:1153`), review submit (`:884-886`), staff-invite lookup (`be/src/routes/staff-invites.routes.js:30-44`), admin lists (`be/src/services/admin.service.js:95`, `:1335`, `:1407`), `membership-plan.service.js:39`; startup backfill over all tenants (`be/server.js:29-60`) | This is also PERF-06/PERF-08. |
| API-05 | CONFIRMED | `parsePagination` is page/offset (`be/src/utils/response.utils.js:31-36`) | |
| API-06 | PARTIAL | Express's default weak ETag applies to JSON responses (no `app.set('etag', false)` in `be/app.js`) | Clients don't send `If-None-Match`; no `Cache-Control` policy. |
| API-07 | CONFIRMED | List endpoints return full rows (e.g. `listBranches`, `be/src/services/gym.service.js:207-253`) | P2. |
| API-08 | CONFIRMED | Sequential awaits in loops, e.g. `be/src/services/tenant.service.js` admin notifications loop, `be/server.js:33-56` | P2. |

#### 12.13.8 RT

| ID | Result | Evidence | Notes |
|---|---|---|---|
| RT-01 | PARTIAL | Register upserts and moves a token to the new user (`be/src/services/notifications.service.js:87-112`); logout unregisters (`app/lib/features/auth/presentation/providers/auth_provider.dart:149-182`); dead tokens removed (`be/src/services/push.service.js:216-217`, `:259-260`) | No `FirebaseMessaging.deleteToken()` on logout (grep); permission is requested at startup (`app/lib/core/services/notification_service.dart:221`), not in context. |
| RT-02 | PARTIAL | Mobile dedupes by `notificationId` (`app/lib/core/services/notification_service.dart:75`, `:479`, `:551`) | Server payloads not audited for always carrying it. |
| RT-03 | NEEDS RUNTIME CHECK | `GET /notifications/unread-count` exists (`be/src/routes/notifications.routes.js:10`) | Mark-read endpoints don't return the new counts; multi-device sync untested. |
| RT-04 | CONFIRMED (**P0**) | `be/src/socket/index.js:100-104` | Any authenticated user can `join_conversation` with any id and receive every message in it; no participant check. Token also accepted in the query string (`:59`), which gets logged. |
| RT-05 | PARTIAL | `tempId` is echoed back (`be/src/services/inbox.service.js:105`, `:216`, `:332`) | Not stored/unique, so a resend creates a second message. |
| RT-06 | CONFIRMED | Client reconnect exists (`app/lib/core/services/chat_socket_service.dart:194-200`) | No `lastEventId` replay and no refetch contract. P2. |
| RT-07 | NEEDS RUNTIME CHECK | Resolver exists (`app/lib/core/router/notification_route_resolver.dart`) | Tenant/mode switch before navigation not verified. |
| RT-08 | CONFIRMED | No `grants.changed` event (grep) | P2. |
| RT-09 | NEEDS RUNTIME CHECK | Listener cleanup not verifiable without a leak test | P2. |

#### 12.13.9 UX

| ID | Result | Evidence | Notes |
|---|---|---|---|
| UX-01 | CONFIRMED | `web/src/app/onboarding/page.tsx` (435 lines) still live; homepage links to it (`web/src/app/(public)/page.tsx:293`) | |
| UX-02 | CONFIRMED | `web/src/app/(dashboard)/gymsera-billing/page.tsx` sits in the member portal; it toasts "Payment successful — your GymsEra subscription is now active" from the query param alone (`:41-53`, `:225-228`) | The member layout has no role guard (`web/src/app/(dashboard)/layout.tsx:26-35` checks login only). |
| UX-03 | DEFERRED (R-13) | — | |
| UX-04 | CONFIRMED (CMS/web part) | CMS sidebar "Subscriptions" and "Subscription & Billing" (`cms/src/components/layout/sidebar.tsx:72`, `:85`) | Mobile part DEFERRED (R-13). |
| UX-05 | DEFERRED (R-13) | — | |
| UX-06 | NEEDS RUNTIME CHECK | Label not located by grep in the mobile/CMS screens | Check on device. |
| UX-07 | CONFIRMED | `web/src/app/gym-owner/register/page.tsx:1187` ("Our team will contact you for payment once approved") | No consequence or deadline stated; R-17 sets 14 days. |
| UX-08 | PARTIAL | Shimmer/empty widgets exist (`app/lib/core/widgets/loading_shimmer.dart`); e.g. Listings error state is a bare "Failed to load listings" with no retry (`app/lib/features/host/presentation/screens/listings_overview_screen.dart:80-81`) | Needs the per-screen state sweep. |
| UX-09 | CONFIRMED | No ARB/`l10n` setup in `app/` and no next-intl in `web/`/`cms/` (package manifests) | All strings hard-coded. |
| UX-10 | NEEDS RUNTIME CHECK | — | axe / semantics tests needed. |
| UX-11 | CONFIRMED | Separate `/host/notifications` and `/host/inbox` routes (`app/lib/core/router/app_router.dart`) | P2. |
| UX-12 | CONFIRMED (**P0**) | CMS `/gym/staff` uses legacy `/gyms/staff` (`cms/src/app/(dashboard)/gym/staff/page.tsx:49-104` → `cms/src/lib/api/gym.ts:188-198`); `/gym/trainers` separate; no `/gym/team` | Mobile also still ships the old `/host/admins` and `/host/profile/staff` routes (`app_router.dart`; `admin_management_screen.dart`, `staff_management_screen.dart`). |
| UX-13 | CONFIRMED | No Approvals / Ledger / Payouts / quota banner in the CMS sidebar (`cms/src/components/layout/sidebar.tsx:57-97`) | |
| UX-14 | CONFIRMED | CMS profile reads the tenant's first `Gym` row (`be/src/services/gym.service.js:165-166` → `_getOrCreateGym`); no org switcher | |
| UX-15 | CONFIRMED | Bank details hard-coded (`web/src/app/gym-owner/register/page.tsx:87`, "Meezan Bank") | |
| UX-16 | DEFERRED (R-13) | — | |
| UX-17 | CONFIRMED | `cms/src/app/(dashboard)/admin/tenants/[id]/page.tsx` is 1,365 lines | |
| UX-18 | CONFIRMED | CMS dashboard uses `/reports/dashboard` + admin stats (`cms/src/app/(dashboard)/dashboard/page.tsx:35-76`); mobile Today uses `/host/today-summary` (`app/lib/core/constants/api_constants.dart:133`) | Different endpoints and cards. |
| UX-19 | CONFIRMED | CMS create/edit/delete through `/gyms/branches` with a generic error toast (`cms/src/app/(dashboard)/gym/branches/page.tsx:154-188`); no restore, no 403 upsell, no `last_branch_in_organization` confirm | Server-side re-auth for delete is **optional**: skipped when no password/idToken is sent (`be/src/controllers/gyms.controller.js:70-100`), and the CMS sends none. |
| UX-20 | CONFIRMED | No new-organization flow in the CMS (sidebar/pages) | |
| UX-21 | CONFIRMED | CMS profile edits logo/cover/gallery/info only (`cms/src/app/(dashboard)/gym/profile/page.tsx:47-108`) | |
| UX-22 | CONFIRMED | No staff-requests page in the CMS; no web invite-accept page | |
| UX-23 | CONFIRMED | No notification bell/feed in the CMS header (`cms/src/components/layout/header.tsx`) although `cms/src/lib/api/notifications.ts` exists | Inbox out of scope (R-18). |
| UX-24 | PARTIAL | Both clients call the same `/tenants/register → gym-profile → select-package → finalize` steps (`app/lib/core/constants/api_constants.dart:107-112`, `web/src/lib/api/tenants.ts:50-83`) | Different step order/fields; web has extra logo/cover steps and the legacy `/onboarding`. |
| UX-25 | DEFERRED (R-14) | — | |

#### 12.13.10 PERF, GLB, OBS

| ID | Result | Evidence | Notes |
|---|---|---|---|
| PERF-01 | NEEDS RUNTIME CHECK | No `/me/bootstrap` (API-03) | Measure cold start and call count on a device. |
| PERF-02 | NEEDS RUNTIME CHECK | — | DevTools rebuild counts. |
| PERF-03 | CONFIRMED | No `memCacheWidth`/`memCacheHeight` anywhere in `app/lib` (grep: 0); uploads stored as originals, no variants/blurhash (`be/src/services/storage.service.js`) | |
| PERF-04 | PARTIAL | Offset pagination only (API-05); a paginated notifier exists (`app/lib/core/utils/paginated_notifier.dart`) | |
| PERF-05 | CONFIRMED | Public pages are client components with no ISR (`web/src/app/(public)/gyms/page.tsx:1`, `web/src/app/(public)/gyms/[id]/page.tsx:1` are `'use client'`; no `revalidate`/`generateStaticParams` in `web/src/app`) | |
| PERF-06 | CONFIRMED (**availability risk**) | Discovery opens a connection to **every** ACTIVE tenant DB per request (`be/src/services/discovery.service.js:50-110` and the other loops listed in API-04) | Grows linearly with tenants; with PERF-07 it will exhaust MySQL connections. |
| PERF-07 | CONFIRMED | `pool: { max: 5 }` per tenant in an unbounded `Map`, no eviction (`be/src/database/TenantDbManager.js:17-45`) | R-8: caps + LRU now. |
| PERF-08 | CONFIRMED | Admin lists loop over tenant DBs (`be/src/services/admin.service.js:95`, `:1335`, `:1407`) | |
| PERF-09 | CONFIRMED | Reports run live aggregate queries on the primary (`be/src/services/reports.service.js`) | P2. |
| PERF-10 | CONFIRMED | Admin tenant detail: one 1,365-line page with 12 `useQuery` calls (`cms/src/app/(dashboard)/admin/tenants/[id]/page.tsx`) | P2. |
| PERF-11 | NEEDS RUNTIME CHECK | — | `leak_tracker` in widget tests. |
| GLB-01 | PARTIAL | `branches.timezone` exists (default `Asia/Karachi`, `be/src/database/TenantDbManager.js:95-97`) and the ledger uses it (`be/src/services/ledger.service.js:36-64`) | Membership dates (`be/src/services/gym.service.js:16-27`), expiry cron (`be/src/jobs/subscription-expiry.cron.js:35`) and reports (PAY-11) use server/UTC dates. |
| GLB-02 | CONFIRMED | `'PKR'` hard-coded in payment creators (`be/src/services/subscription.service.js:251`, `:761`; `be/src/services/payment.service.js:112` defaults to PKR); "Rs" strings in the app (e.g. `request_payout_screen.dart:391`) | |
| GLB-03 | CONFIRMED | Same as UX-09 | |
| GLB-04 | CONFIRMED | No phone library in `app/pubspec.yaml` or `web/package.json` (grep) | |
| GLB-05 | CONFIRMED | 0 uses of `EdgeInsetsDirectional`, 253 uses of `EdgeInsets.only/fromLTRB` in `app/lib` | P2. |
| GLB-06 | NEEDS RUNTIME CHECK | Validators not exhaustively reviewed | |
| GLB-07 | — (decision) | §14 R-7 | |
| GLB-08 | PARTIAL | Mobile timeouts 20 s / 45 s (`app/lib/core/network/dio_client.dart:18-19`); shimmer skeletons exist | No payload budgets, no throttled-network tests, no retry policy (API-02). |
| GLB-09 | CONFIRMED | No data-export endpoint (grep); deletion is AUTH-07 | |
| OBS-01 | CONFIRMED | `morgan` + `console.*` only (`be/app.js:121-123`); no request id | |
| OBS-02 | CONFIRMED | No Sentry/Crashlytics in any of the 4 manifests (grep: 0) | |
| OBS-03 | CONFIRMED | No metrics library (grep: 0) | |
| OBS-04 | NEEDS RUNTIME CHECK | MySQL server config is outside the repos | |
| OBS-05 | CONFIRMED | No `BillingEvent` (BILL-12) | |
| OBS-06 | PARTIAL | Nightly `auditCapacity` runs but only `console.warn`s (`be/src/jobs/subscription-expiry.cron.js:255-265`); no alert; empty ACTIVE orgs not checked (CAP-07) | |
| OBS-07 | PARTIAL | Tenant-DB audit for team/ledger/approvals exists (`be/src/services/audit.service.js`); platform admin audit is broken (SEC-12) | |
| OBS-08 | CONFIRMED | No client performance SDK (grep) | P2. |
| OBS-09 | CONFIRMED | No `docs/runbooks/` in any repo | |

#### 12.13.11 New defects not in §12 (NEW-xx)

| ID | Sev | Defect | Evidence | Suggested fix (for the phase prompt, not done here) |
|---|---|---|---|---|
| NEW-01 | **P0** | Unauthenticated `GET /api/v1/discovery/debug-activate-branches` opens every tenant DB and mass-updates `travelerVisibilityStatus` on every ACTIVE branch | `be/src/routes/discovery.routes.js:580-617` (also root script `be/activate_branches.js`) | Delete the route. |
| NEW-02 | **P0** | Apple sign-in and Apple re-auth accept an **unsigned** identity token; `aud` not enforced; `appleId`/e-mail can come from the request body; existing accounts are linked by e-mail → account takeover of any user, including platform admins | `be/src/services/auth.service.js:518-580`, `:831-844` | Verify the JWS against Apple's JWKS (`https://appleid.apple.com/auth/keys`), enforce `iss`/`aud`/`exp`, use only `sub` and the token's own e-mail. (AUTH-06) |
| NEW-03 | **P0** | Google sign-in falls back to an **unsigned** `jwt.decode` when the verifier's error text contains "network"/"certificates"/"timed out"; part of that text (the JWT header in "No pem found for envelope …") is attacker-controlled | `be/src/services/auth.service.js:350-378` | Remove the fallback; fail closed. |
| NEW-04 | **P0** | Unauthenticated maintenance endpoints: `/debug-sync-db` (`sequelize.sync({alter:true})` on the platform DB and every tenant DB), `/debug-cleanup-indexes` (drops indexes and foreign keys on every tenant DB), `/system/fcm-status` (leaks user e-mails and token previews), `/system/socket-status` | `be/src/routes/index.js:44-86`, `:132-187`, `:342-470` | Delete them (or move behind admin auth + feature flag in non-prod only). |
| NEW-05 | **P0** | Remote-operation endpoints protected only by keys **committed in git** (`gymsera-fix-socket-2026`, `gymsera-fcm-test-2026`): `run-pull` (git pull + restart), `run-install` (npm install), `configure-fcm` (writes a service-account file), `recycle` (`process.exit`), `fcm-test` (push to any user/token) | `be/src/routes/index.js:88-340` | Delete; rotate anything the keys protected; deploy through CI only. |
| NEW-06 | **P0** | `POST /host/subscription/upgrade` lets any host (no IAP plan) self-assign **any** `PlatformPackage` as `ACTIVE` + `paymentStatus: 'PAID'` with no payment; the CMS "Request a Manual Plan" button calls it | `be/src/controllers/host.controller.js:841-913`; `cms/src/lib/api/host-billing.ts:47-49` | Turn it into a real request (PENDING, admin-verified), on `BillingPlan` (BILL-10). |
| NEW-07 | **P0** | A member can renew their own membership: `POST /subscriptions/:id/renew` sets `ACTIVE`, a new `endDate` and a new QR with **no payment** | `be/src/services/subscription.service.js:386-445`; route `be/src/routes/subscriptions.routes.js:144` (authenticate only) | Renew creates a PENDING payment + pending period; only staff verification activates it. |
| NEW-08 | **P0** | Cross-tenant membership IDOR: callers whose platform role is GYM_HOST/BRANCH_MANAGER/FRONT_DESK resolve **any** subscription id in **any** tenant and can freeze/cancel/renew/change/upgrade it | `be/src/services/subscription.service.js:124-140` | Staff actions must go through `tenantContext` + `can()` on the caller's own tenant; member routes filter by `userId` only. (SEC-01) |
| NEW-15 | **P0** | `GET /host/subscription/current` **creates** a 30-day `ACTIVE`, `PAID` subscription whenever the tenant has no ACTIVE row — after expiry, refund, cancellation or admin revoke. The app calls it automatically (My plan, after restore), so any lapsed tenant gets a free month, repeatedly | `be/src/controllers/host.controller.js:798-839` (create at `:813-823`) | A GET must never write; return "no active plan". |
| NEW-16 | P1 | The single purchase-stream listener is **not** created at startup: `billingProvider` is only read by the My Subscription and Plan Picker screens, so a transaction redelivered at launch (app killed after the store charged) is not synced until the host opens a billing screen — with BILL-06 this risks Play auto-refunds | `app/lib/features/billing/presentation/providers/billing_provider.dart:659`; readers only in `app/lib/features/billing/presentation/screens/my_subscription_screen.dart` and `branch_plan_picker_screen.dart` (grep); not in `app/lib/main.dart` | Instantiate the notifier after first frame at startup (§5.1, §10.2). |
| NEW-09 | P1 | Mobile "Payouts" / "Request payout" is a fake flow: hard-coded "Rs42,300 submitted" success, no API; bank accounts are local state | `app/lib/features/host/presentation/screens/request_payout_screen.dart:42-61`, `:391`; `app/lib/features/host/presentation/providers/host_profile_provider.dart:61` | Replace with "Coming soon" (same treatment as NEW-BOOST) until PAY-10 is built. |
| NEW-10 | **P0** | `TenantDbManager.getConnection` ran DDL (CREATE/ALTER TABLE) and DML (UPDATE backfills on payments, branches, gyms) on cold connection pool cache misses; dev mode ran `sync({alter:true})`. Contradicts §6.5, caused §9.6 regression, and moved payments between business days due to UTC date truncation | `be/src/database/TenantDbManager.js:48-221` | Fixed: removed all writes from getConnection; created versioned tenant migration runner (`src/database/tenant-migration-runner.js`). |
| NEW-11 | P1 | `method: 'TEST'` payments auto-complete and activate memberships whenever `X-Test-Payment-Key` matches `PAYMENT_TEST_KEY` (the variable is set in the backend `.env`) | `be/src/routes/payments.routes.js:67-81`; `be/src/services/payment.service.js:98` | Disable outside test environments. |
| NEW-12 | P1 | Expiry cron suspends the **tenant** and sets **all** its listings INACTIVE the day after `endDate` — including store subscriptions whose renewal webhook was missed (BILL-12). Nothing reactivates the listings on renewal or reactivation, and INACTIVE listings' `reservedSlots` stop counting | `be/src/jobs/subscription-expiry.cron.js:145-170`; `be/src/services/admin.service.js:481-506` | Handle lapse through entitlement (§7.5.8 `billingLock`), not tenant/listing status. |
| NEW-13 | P1 | Branch delete re-auth is optional: the server only checks a password/idToken **if one is sent** | `be/src/controllers/gyms.controller.js:70-100` | Require re-auth server-side. |
| NEW-14 | P1 | `finalizeApplication` creates an `ACTIVE` MANUAL subscription at **submission**, before review, so the paid period starts before approval (and the approval path then skips creating one) | `be/src/services/tenant.service.js:251-276` | Fold into the BILL-13 GRACE flow. |
| NEW-17 | **P0** | "--dry-run wrote data / Migration 004 overwrote non-null business_date" | `be/src/database/tenant-migration-runner.js:274-316` (dry-run returned target finalVersion and applied array instead of empty; SHOW TABLES check fragile under mixed collation; individual migrations lacked direct dry-run guards; Migration 004 verified to filter strictly to business_date IS NULL) | Wrap dry-run in always-rolled-back transaction; add context.dryRun guards in all migrations 001-007; fix runner return values (applied: [], finalVersion: initialVersion); use direct robust schema query; update CLI reporting. Marked DONE: verified with regression tests. |
| NEW-18 | P2 | Plan creation at tenant approval can fail silently: step 10 of `processTenantProvisioning` (runs at approval) wraps the `TenantSubscription.create` in a try/catch that only `console.warn`s, so an approved tenant can end up ACTIVE with no plan row and nobody is told. Before R-21 the `GET /host/subscription/current` fallback hid this by creating one later; now the tenant simply has no plan (found while fixing NEW-15, 2026-09-28) | `be/src/services/tenant-provisioning.service.js:517-552` (swallowed at `:549-551`) | **Partly fixed in Prompt 1B (BILL-13, FLOW-03):** the plan decided at approval for pay-later and for a tenant with a provider-backed row (provisioning step 1b, `subscription-migration.service.js#planForApproval`) runs before the tenant is ACTIVE and is never swallowed — a failure fails the approval, which stays re-approvable. **Still open:** step 10 (bank transfer / legacy package row when submission created none) still warns and continues. Fold into BILL-10 (manual sales on the catalog). |
| NEW-18 (origin/main) | P2 | Plan creation at tenant approval can fail silently: step 10 of `processTenantProvisioning` (runs at approval) wraps the `TenantSubscription.create` in a try/catch that only `console.warn`s, so an approved tenant can end up ACTIVE with no plan row and nobody is told. Before R-21 the `GET /host/subscription/current` fallback hid this by creating one later; now the tenant simply has no plan (found while fixing NEW-15, 2026-09-28) | `be/src/services/tenant-provisioning.service.js:517-552` (swallowed at `:549-551`) | Not fixed. Fold into BILL-13 / FLOW-03 (§7.5.10, §7.5.11): approval creates the first row inside the provisioning transaction, or fails the approval / alerts admin (OBS) — never warn-and-continue. |
| NEW-19 | P1 | **Not built:** mobile "choose branches to keep" screen for a downgrade. The backend endpoints exist (BILL-03); the plan picker never calls them, so a host downgrading below their active branches cannot pick which branches stay, and CAP-01 will fall back to "most recently created first" | Endpoints `be/src/routes/billing.routes.js:76` (`GET /billing/downgrade-preview`), `:102` (`PUT /billing/downgrade-choice`); no caller in `app/lib/features/billing/` | Mobile: before a downgrade purchase, call the preview; if `mustChooseBranches`, show the list and save the choice, then start the store downgrade. Port to CMS/web after. |
| NEW-20 | P1 | **Not built:** CMS admin "Verify payment" button for pay-later tenants. The backend action exists (BILL-13); without the button an admin can only call the API by hand, so pay-later tenants lapse after 14 days even when they paid | `be/src/routes/admin.routes.js:256` (`POST /admin/tenants/:id/subscriptions/:subId/verify-payment`); no caller in `cms/src` | CMS admin → tenant → subscriptions: show "Verify payment" on a MANUAL row in `GRACE` (optional bank reference field). |
| NEW-21 | P1 | **Not built:** GRACE / pay-later countdown banners in mobile, CMS and web. The API returns `paymentIssue` (`manageUrl` for store/Stripe GRACE; `payBy` + `daysLeft` for pay-later) but no client shows it, so a host doesn't know a failed payment or the pay-later deadline is coming | `be/src/controllers/host.controller.js:819`; no client reads `paymentIssue` | One banner component per client on My Subscription / billing pages (mobile first): "Payment failed — update it in {store}" with the link, or "Pay by {date} — {n} days left". |
| NEW-22 | P2 | Admin "assign package" on a pay-later tenant returns `409 iap_subscription_active` ("store-verified (IAP) subscription") — misleading: the pay-later GRACE row has `branchCount` set, which this guard reads as "IAP" | `be/src/services/admin.service.js:721-726` | Use `platform !== 'MANUAL'` for the IAP guard and give pay-later its own message ("verify the payment or let the grace end first"). Fold into BILL-10. |
| NEW-23 | P2 | A lost Google "payment completed" notification for a pending purchase (BILL-08) is not picked up until the app syncs the purchase again: a pending purchase writes no row, and the daily sweep only refreshes rows that exist | `be/src/services/google-play-billing.service.js:274`; sweep filter `be/src/services/billing-event.service.js:185` | Record pending purchase tokens (e.g. in `billing_events`) and let the daily sweep re-fetch them until they complete or are cancelled. |
| NEW-24 | P2 | The daily job ends plans one day late when the server clock runs east of UTC (Pakistan, UTC+5): "today" is local midnight printed as a UTC date, i.e. yesterday, and `endDate < today` is compared with that. On Vercel (UTC clock) there is no shift, but dates are still UTC dates, not branch-timezone dates. Linked to **GLB-01** | `be/src/jobs/subscription-expiry.cron.js:111-112` | Compute business dates in one timezone rule (GLB-01) and use it for platform plan expiry too. |
| NEW-25 | P1 (blocked by R-7) | **Not built:** Stripe downgrade timing and saving the card at signup. `changeSubscriptionPlan` applies every Stripe plan change immediately with prorations, so a Stripe downgrade removes capacity at once (BILL-03's Stripe part); signup checkout is `mode: 'subscription'` (charges now) instead of R-4's setup mode (save the card, charge at approval) | `be/src/services/stripe-billing.service.js:174`, `:129` | When Stripe goes live: downgrade through a subscription schedule at period end + `pendingChange`; signup Checkout in `setup` mode and create the subscription in `planForApproval`. |
| NEW-26 | **P1** (DONE) | Suspended tenants can continue using the application: `tenantContext` middleware queries `status: ['ACTIVE', 'SUSPENDED']` and resolves tenant DB connection without any status checks or restrictions; Redis caches the connection string for 1 hour (`tenant:${tenantId}:connStr`), bypassing DB lookup completely on subsequent calls; `updateMyTenant` has no status check; billing webhooks re-activate/modify subscriptions for suspended tenants; nightly cron can process suspended tenants if already loaded in `TenantDbManager` pool. Git history shows commit `bece4b4` introduced `['ACTIVE', 'SUSPENDED']` with an auto-restore `tenant.update({ status: 'ACTIVE' })` which was removed during refactoring, leaving the full bypass intact. Contradicts spec REL-04 | `be/src/middleware/tenantContext.js:134-152`, `be/src/services/tenant.service.js:180-197`, `be/src/services/subscription-migration.service.js:86,400`, `be/src/jobs/subscription-expiry.cron.js:339` | In `tenantContext`: require `status === 'ACTIVE'` only (returning standard 404 `Tenant not found or not active`); immediate cache invalidation (`safeRedisDel`) and pool release on suspension; add ACTIVE status check in `updateMyTenant`; record billing webhooks on `TenantSubscription` without granting entitlement or reconciling capacity (decision R-23); skip non-ACTIVE tenants in cron jobs. Marked DONE. |
| NEW-27 | P2 | The released mobile app retries a restore purchase on every launch and shows a generic error when the server answers 409 "belongs to another account" (`billing_provider.dart:646-655`) | `app/lib/features/billing/presentation/providers/billing_provider.dart:646-655` | Catch 409 `subscription_owned_by_other_account` in restore flow, finish transaction in StoreKit/Play store queue, and present clear message explaining purchase belongs to another account. |
| NEW-28 | **P2** (DONE) | The Bull "notifications" queue (`src/jobs/queues.js:36`) relied on Redis, opening 33 Redis sockets that were never closed in test setups. In production (where no Redis is running), Bull was silently dropping jobs for 3 event types (`PAYMENT_FAILED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_EXPIRING_SOON`) while every other notification in the codebase directly called `notificationsService.createNotification` | `be/src/jobs/queues.js:36`, `be/src/jobs/notifications.processor.js`, `be/src/services/payment.service.js:649`, `be/src/services/subscription.service.js:448`, `be/src/jobs/subscription-expiry.cron.js:91` | **Option B implemented:** completely removed Bull/Redis notifications queue dependency. Replaced with direct calls to `notificationsService.createNotification` (writes to MySQL, WebSocket broadcast, FCM push) and `emailService` inline at the point of each event. Removed `queues.js`, `notifications.processor.js`, and their startup registration in `server.js`. |
| NEW-29 | **P0** | Unauthenticated `GET /api/v1/debug-cleanup-indexes` drops indexes and foreign keys on every active tenant database | `be/src/routes/index.js:324-408` | Delete the route; schema and index changes belong exclusively in versioned migration runners. |
| NEW-30 | **P1** | Unauthenticated `GET /api/v1/discovery/seed-conversations` seeds test Conversation and Message rows into platform database | `be/src/routes/discovery.routes.js:52-175` | Delete the route completely; test seeding belongs in offline seeders/tests. |
| NEW-31 | **P0** | Unauthenticated `GET /api/v1/discovery/debug-activate-branches` opens every tenant DB and mass-updates `travelerVisibilityStatus` on every ACTIVE branch (same as NEW-01) | `be/src/routes/discovery.routes.js:580-618` | Delete the route completely. Resolved together with NEW-01. |
| NEW-32 | P1 | **Not built:** mobile, CMS and web screens for the lock countdown, "branch locked" banner and unlock explanation. The backend CAP-01 billing-lock fields, countdown endpoint and member check-in grace exist; no client screens or banners currently display the warning or lock state | `be/src/services/branch-billing-lock.service.js`, `be/src/controllers/host.controller.js` (`billingCountdown`) | Add banner on host dashboard/branches list showing countdown before lock ("X days left to upgrade or choose branches"), "Branch Locked" badge on locked branches with explanation, and auto-unlock confirmation when upgraded. |
| NEW-33 | P1 | Mobile host payout screens show hard-coded fixture data instead of the PAY-10 backend (Prompt 1E): a fake payout history (`gyms_era/lib/features/host/presentation/providers/analytics_provider.dart:30-70`, "Bank Transfer ···4291") and a fake bank account "HBL Bank ···9821" (`gyms_era/lib/features/host/presentation/screens/request_payout_screen.dart:21-27`). Found during SEC-09 (Prompt 1F); not a card/PCI issue, so not fixed there. **Now tracked in §12.4 as P1 (NEW-33)** | code read | Wire the payout screens to the PAY-10 endpoints (ledger-derived balance, payout requests, the account from `paymentDetailsJson`), with loading/empty/error states (§2.5). Phase 3 parity work unless the owner moves it earlier |
| NEW-34 | P2 (DONE in Prompt 1I, see §13) | **Rejecting a tenant while a FLOW-02 provisioning run is in progress leaves a partial tenant database behind (found in Prompt 1G, 2026-10-01).** The run stops safely and never activates the tenant, but whatever it had already created stays: the `gymsera_<code>` database (from step 1), its tables, and — if the run had passed step 3/4 — the tenant's GymListing row (still `ACTIVE`) and its gym/branch rows. Not visible to travelers (discovery only reads listings of ACTIVE tenants: `be/src/services/discovery.service.js:23-24`, `:365`, `:568-569`), no entitlement, no money; it is leftover data and disk. The same leftovers exist for a tenant rejected after a provisioning that failed earlier. No automated cleanup exists; removing a database is a manual owner decision. Related to FLOW-02 (§12.3), FLOW-04 (rejection path) and AUTH-07 / R-16 (deletion and retention) | `be/src/services/admin.service.js:499` (`rejectableStatuses` includes APPROVED, with no check for a provisioning run in progress), `:504-510` (sets REJECTED only), `:512-513` (clears the Redis connection-string cache and the pooled connection; nothing looks at `provisioningState` / `provisioningLockToken`, and no database, listing or lease is cleaned up). On the provisioning side the stop is deliberate: every write requires the lease **and** status APPROVED (`be/src/services/tenant-provisioning.service.js:203-208`), and a run that loses it exits without touching anything (`:811`). The read-only script `be/gymsera-flow02-provisioning-check.js` lists these as `ORPHAN_DATABASE` (a `gymsera_*` database whose tenant is not APPROVED/ACTIVE/SUSPENDED) | Decide with AUTH-07 (Prompt 1I), which already owns "ask before any step that drops a database automatically". Options: (a) keep it manual — run the check script periodically and drop by hand; (b) `rejectTenant` answers 409 while a live lease is held (reject after the run stops), and marks the tenant's listing `INACTIVE`; (c) a retention sweep that drops the database of a tenant REJECTED for longer than the R-16 window. Never an automatic DROP without an owner decision recorded in §14 |
| NEW-35 | **P1** (DONE, see §13) | **Re-authentication is skipped for accounts with no password (found in Prompt 1I, 2026-10-02).** A Google/Apple-only account has no `passwordHash`; both password checks only compare `if (user && user.passwordHash)`, so such an account passes by sending ANY `password` string. Affects the payout bank-detail change (SEC-13) and branch deletion. Branch deletion also appears to require no credential at all when `password` is absent (`if (password)` only verifies a value that was sent) — re-check before relying on it. The new AUTH-07 re-auth (`auth.service.js#assertReauth`) does not have this flaw | `be/src/controllers/gyms.controller.js:37-47` (payout details), `:121-131` (delete branch) | Fix in its own prompt: route both through `authService.assertReauth` (it already requires a real hash match or a verified provider token), with a test per route for a social-only account sending a made-up password. Not fixed in 1I (one issue per commit; separate guard) |
| NEW-36 | P2 (DONE: runs in the daily `runExpiryCheck`, test `new-36-deletion-sweep-in-daily-cron.test.js`) | **The 30-day deletion sweep was not scheduled (found in Prompt 1I).** `run-account-deletion-sweep.js` is run by hand like the KYC sweep (R-28: dry-run first, then apply). Until it is run, a deletion past its 30 days stays `PENDING_DELETION` (the account stays disabled, nothing is erased). For store compliance the owner should run it regularly or add an authenticated `/cron/...` entry (`CRON_SECRET`, like `/cron/subscription-expiry` in `vercel.json`) once the first dry runs look right | — | Owner decision: manual cadence vs. cron. The read-only `gymsera-auth07-deletion-check.js` reports `DELETION_DUE` |
| NEW-37 | P2 | **A short residual after a deletion request (found in Prompt 1I).** Access tokens are not checked against the database, so a token issued BEFORE the request stays valid until it expires (`JWT_EXPIRES_IN`, default 15 min) on routes that are not tenant-scoped (tenant routes stop at once through the tenant status). Sockets use their own check (RT-04) and were not changed. Closing it needs the AUTH-08 style per-request version check | `be/src/middleware/authenticate.js` | Accepted for now; fold into AUTH-08 (Prompt 2A) |
| NEW-38 | **P2** (DONE, see §13) | **Organization / Listing deletion requires no re-authentication (found in NEW-35 audit, 2026-10-02).** While branch deletion and account deletion enforce strict re-authentication via `authService.assertReauth` (current password or fresh Apple/Google token), `DELETE /host/listings/:id` deletes an entire gym organization (and can cascade-delete branches via `strategy: 'deleteBranches'`) with only a valid session token and no re-auth check | `be/src/controllers/host.controller.js:717-733` (`deleteListing`) | Enforce `authService.assertReauth(req.user.sub, { password, provider, idToken })` in `host.controller.js#deleteListing` (and update client confirmation dialogs in mobile/CMS accordingly) |


**Other observations (lower severity, recorded for later prompts):**
- The listing-level review route passes the body as `branchId` (`be/src/controllers/discovery.controller.js:144`) — always fails.
- `rejectTenant` accepts an `ACTIVE` tenant and leaves its subscriptions untouched (`be/src/services/admin.service.js:398-409`).
- `server.js` runs a one-off payments backfill over every tenant DB at every boot (`be/server.js:29-60`) — RESOLVED in Step 2.6: removed mutating boot loop and replaced with read-only `checkTenantSchemaVersions` startup check.

---

## 13. Implemented fixes (log — the agent fills this in)

**Nothing is implemented at the time this document was written.** For every issue the agent touches, add one row. An issue is `DONE` only when its regression test exists and passes in CI.

> §13 is the permanent record of finished work. The in-progress state (what the current agent is doing right now, and the exact next step) lives in `AGENT_HANDOFF.md` next to this file.

| Issue | Status (`DONE` / `NOT REPRODUCED` / `DEFERRED` / `IN PROGRESS`) | Root cause (file:line) | Pattern reused | Fix summary | Test file(s) | PR/commit | Verified in staging? |
|---|---|---|---|---|---|---|---|
| NEW-10 | DONE | `be/src/database/TenantDbManager.js:48-221` (getConnection ran DDL and DML on cache miss) | Versioned tenant migration runner (spec §6.5) | Removed all writes from getConnection; created versioned tenant migration runner (`src/database/tenant-migration-runner.js`) and CLI runner (`src/scripts/run-tenant-migrations.js`) | `gymsera_be/tests/regression/get-connection-side-effects.test.js`, `gymsera_be/tests/integration/tenant-migration-runner.test.js` | d7d4179 | pending |
| STEP-2.6 | DONE | `tenant-provisioning.service.js:506` (tenants activated without migrations); `Payment.model.js` (payments created/updated without branch-timezone `business_date`); `tenant-migration-runner.js:004` (fixed +05:00); `005` (string interpolation of IDs) | `ledger.service.js` (`computeBusinessDate`), Sequelize model lifecycle hooks, parameterized queries | Auto-migrate new tenants before ACTIVE; read-only startup schema check; enforce write-time business_date with branch timezone; parameterized migrations 004/005; mobile CI smoke test | `gymsera_be/tests/integration/payment-business-date.test.js`, `gymsera_be/tests/integration/tenant-provisioning-migrations.test.js`, `gyms_era/test/widget_test.dart` | fb3cd2a | pending |
| STEP-2.7 | DONE | `Payment.model.js` (used paidAt/now on update instead of collection time; allowed business_date modification); `payment.service.js:276` (passed paidAt at verify); raw SQL / bulk updates | `ledger.service.js` (`computeBusinessDate`, `stampBusinessDate`), Sequelize lifecycle hooks (`beforeCreate`, `beforeBulkCreate`, `beforeUpdate`, `beforeBulkUpdate`), conditional tenant migration | Payment business_date set once from collection time and immutable; rejects updates changing business_date; stamps legacy NULL rows from original collection time; routes bulk updates with individualHooks; deleted unused backfill-payments.js; Migration 006 enforces NOT NULL conditionally on clean tenants; updated Query B to collection time | `gymsera_be/tests/integration/payment-business-date.test.js` | 6a981ca | pending |
| STEP-2.8 | DONE | Discrepancies in fallback order when collected_at is empty: `Payment.model.js:184-194` (paid_at before created_at), `tenant-migration-runner.js:93` (paid_at before created_at), and Query B (created_at before paid_at) | Unified single authority pattern in `ledger.service.js` (`getPaymentCollectionTime`) | Replaced diverging fallback logic with `getPaymentCollectionTime` (`collected_at` -> `created_at` for CASH; `paid_at` for ONLINE/BANK_TRANSFER). Reused across Payment model hooks, `payment.service.js` (`recordPayment`, `verifyPayment`), Migration 004, and Query B | `gymsera_be/tests/integration/payment-business-date.test.js` | 92b72e6 | pending |
| STEP-2.9 | DONE | Production audit found 7 payments with business_date differing from canonical collection rule | Reused `getPaymentCollectionTime`, `computeBusinessDate`, tenant connection pattern from `tenant-migration-runner.js`, and `AuditLog` model | Created maintenance repair script (`src/scripts/repair-payment-business-dates.js`) with preview-by-default, `--apply --confirm` safety guard, closed ledger day protection (needs manual adjustment), audit logging, and `allowBusinessDateRepair` hook bypass | `gymsera_be/tests/integration/repair-payment-business-dates.test.js` | 1126343 | Ran repair-payment-business-dates.js on all 7 production tenants: repaired 7 payments, audited with zero mismatches, verified 2026-09-26 |
| STEP-2.11 | DONE | Production preview showed 6 CASH rows had seed/import created_at overriding earlier real payment paid_at | Refined `getPaymentCollectionTime` in `ledger.service.js` and model hook in `Payment.model.js` | CASH uses EARLIER of created_at and paid_at (normal rows use created_at; imported rows use paid_at); non-cash uses paid_at if set otherwise created_at; pending non-cash payments finalize provisional business_date once on first transition to COMPLETED via payment service | `gymsera_be/tests/integration/payment-business-date.test.js`, `gymsera_be/tests/integration/repair-payment-business-dates.test.js` | c5a4880 | pending |
| STEP-2.10 | DONE | Production MySQL 5.7 tenant databases have mixed collations (`payments.branch_id` `utf8mb4_general_ci` vs `branches.id` `utf8mb4_unicode_ci`), causing `ER_CANT_AGGREGATE_2COLLATIONS` ("Illegal mix of collations") on SQL join in Migration 004; `reactivateTenant` activated tenants without migrations; runner lacked per-tenant error isolation and dry-run | JavaScript in-memory join pattern from `repair-payment-business-dates.js`, versioned migration runner (`tenant-migration-runner.js`), `TenantDbManager` | Backend CI and Docker switched to MySQL 5.7; fixed Migration 004 to match branch timezone in JS instead of cross-table SQL join; added Migration 007 to align all tenant table/column collations dynamically to `utf8mb4_unicode_ci`; added `--dry-run` flag to runner and resilient per-tenant error handling; added migration execution in `reactivateTenant` before status becomes ACTIVE; Step 2.10b verified full codebase raw SQL audit and confirmed Migration 007 fixes payments and ledger_days joins to branches | `gymsera_be/tests/integration/mixed-collation-migration.test.js`, `gymsera_be/tests/integration/reactivate-tenant-migration.test.js` | 85526bd | yes, 2026-09-26 |
| NEW-17 | DONE | `be/src/database/tenant-migration-runner.js:274-316` (dry-run returned target finalVersion and applied list; SHOW TABLES check fragile; individual migrations lacked direct dry-run guards) | Transaction rollback wrapper, per-migration defense-in-depth guards, robust table inspection, and strict IS NULL backfill isolation | Added transaction rollback wrapper to dry-run path; added context.dryRun guards to migrations 001-007; fixed dry-run return values (applied: [], finalVersion: initialVersion, wouldRun: [...]); replaced fragile SHOW TABLES check with direct schema query; updated CLI runner reporting; audited and verified Migration 004 strictly filters to business_date IS NULL | `gymsera_be/tests/integration/tenant-migration-dry-run-safety.test.js` | pending | yes, verified locally on MySQL 5.7 |
| BILL-12 | DONE | `be/src/controllers/billing.controller.js:102-109` (Apple webhook answered 200 even when nothing was stored — event lost on a DB error); no inbox/dedupe table (grep); `apple-billing.service.js:332-353` applied the notification payload instead of re-fetching; `apple-billing.service.js:345-351`, `google-play-billing.service.js:292-298` dropped unknown transactions silently; Stripe `customer.subscription.deleted` had a second write path (`stripe-billing.service.js:426-429`); the apply block was copy-pasted in all three providers | Existing sync functions, `requestProviderChange`, `reconcileRenewalStatus`, `reconcileCapacity`, `CapacityEvent.idempotencyKey`; tenant migration runner (`runTenantMigrations`, now given a migration list) for the platform DB | New `billing_events` inbox (UNIQUE provider + providerEventId) via platform migration p001 (`src/database/platform-migrations.js`, CLI `run-platform-migrations.js --dry-run`). Webhooks: verify sender → record → process; 500 only if the event can't be recorded. Processor re-fetches truth (Apple subscription-status API, Play `subscriptionsv2.get`, Stripe `subscriptions.retrieve`) through `syncFromApple` / `syncFromGoogle` / `syncFromStripe` — the same entry points `/billing/{ios,android}/sync` use — ending in ONE apply function `subscription-migration.service.js#applyVerifiedSubscription`. Failed events retried by a 1-minute sweep (server.js) and the daily cron, which also re-fetches every live store row. Processed inline before the 200 (not after) because the API also runs on Vercel serverless | `gymsera_be/tests/integration/billing-webhook-inbox.test.js`, `gymsera_be/tests/integration/platform-migration-runner.test.js` | be 84d250f (branch `phase-1/prompt-1a-billing-core`) | no — needs a sandbox notification from each store |
| BILL-02 | DONE | No `REVOKED` state (`be/src/models/platform/TenantSubscription.model.js:99`); Apple refund mapped to `CANCELLED` with no capacity change (`apple-billing.service.js:217`, reconcile only for ACTIVE at `:291`); Google `SUBSCRIPTION_REVOKED`/voided and Stripe `charge.refunded`/`charge.dispute.created` not handled (`google-play-billing.service.js:93-105`, `stripe-billing.service.js:393-442`); `resolveMaxBranches` fell back to `tenant.selectedPackageId` / 1 when no ACTIVE row (`subscription-quota.service.js:46-50`), so a refund handed the registration package back for free | `reconcileCapacity` (unchanged), `resolveMaxBranches`, `getActiveSubscription`, the BILL-12 inbox + `applyVerifiedSubscription`, `CapacityEvent.idempotencyKey` | `REVOKED` status (platform migration p002; the boot-time status MODIFY in `platform.js#connect` removed so a reboot can't narrow the ENUM). Apple `revocationDate` → REVOKED; Google RTDN type 12, `voidedPurchaseNotification`, and the Voided Purchases API (daily sweep, via the inbox) → REVOKED; Stripe full refund / dispute (charge re-fetched; partial refunds ignored) → REVOKED. `applyVerifiedSubscription`: ACTIVE→REVOKED runs `reconcileCapacity` against the tenant's remaining entitlement (unbuilt slots trimmed); a REVOKED row only becomes ACTIVE again for a newer paid period. `resolveMaxBranches` returns 0 after a revoke instead of the legacy fallback. Branch locking itself is CAP-01 (Prompt 1C); host notification not added | `gymsera_be/tests/integration/billing-refund-revoke.test.js`, `gymsera_be/tests/integration/platform-migration-runner.test.js` | be 542ef53 (branch `phase-1/prompt-1a-billing-core`) | no — needs a sandbox refund on each store |
| BILL-06 | DONE | `be/src/controllers/billing.controller.js:132-139` (acknowledge fire-and-forget after the response, with the **client-supplied** productId, never retried); `google-play-billing.service.js:262-273` swallowed every error; RTDN path (`:282-300`) never acknowledged — if the app died before `/sync`, nothing acknowledged and Play auto-refunded after 3 days | BILL-12 `syncFromGoogle` (the shared verified sync path) and the `billing_events` inbox + sweep for retries | Acknowledge moved into `syncFromGoogle`, after the verified apply, for `/sync` and RTDNs alike: only when Play reports `ACKNOWLEDGEMENT_STATE_PENDING` and the purchase is active/in grace (never a pending/unpaid one), with the productId Google reported. `acknowledgePurchaseIfNeeded` now throws on anything but "already acknowledged". A failed ack never fails `/sync` (the app completes only after a 200): it is recorded as inbox event `ack:<token>` and retried by the sweep until Play accepts it. Client `completePurchase` stays as a backup | `gymsera_be/tests/integration/billing-android-ack.test.js` | be 1a7300f (branch `phase-1/prompt-1a-billing-core`) | no — needs a Play sandbox purchase with the app killed before `/sync` |
| BILL-01 | DONE (transfer endpoint deferred) | Lookup by `externalOriginalTransactionId` only and `existing.update(values)` wrote the **caller's** `tenantId` (`be/src/services/apple-billing.service.js:186-252`, `google-play-billing.service.js:133-184`, `stripe-billing.service.js:252-305`) — tenant B restoring A's purchase moved the row to B; no binding token sent (`app/lib/features/billing/presentation/providers/billing_provider.dart:259-273`) or checked; index not unique (`TenantSubscription.model.js:144`) | BILL-12 `applyVerifiedSubscription` (the one apply path), `_pendingProductId`/`_verifyAndComplete` on mobile, the typed-409 pattern of `gyms_repository.dart#_mapLastBranchConflict` | Server: a row's tenant owns it — any other tenant's `/sync` gets `409 subscription_owned_by_other_account` and nothing changes; `tenantId` is never rewritten on an existing row. Before a row exists, the store-echoed token decides (Apple `appAccountToken`, Google `obfuscatedExternalAccountId`, Stripe `metadata.tenantId` set server-side). Webhooks/sweep resolve an unknown transaction's owner from that token (only if the tenant exists) instead of dropping it. UNIQUE(platform, external_original_transaction_id) via platform migration p003 (skipped and reported if duplicates exist); a simultaneous race retries once and loses with 409. Mobile: `applicationUserName` = tenant id on every purchase and plan change (`billingAccountTokenProvider`); on that 409 the purchase is completed in the store queue and a clear message shown. The explicit "Move my plan to this account" transfer endpoint (§7.5.2) is NOT built | `gymsera_be/tests/integration/billing-binding.test.js`, `gymsera_be/tests/integration/platform-migration-runner.test.js`, `gyms_era/test/regression/store_purchase_binding_test.dart` | be 7a53c72, app b4dfb59 (branch `phase-1/prompt-1a-billing-core`) | no — needs two sandbox accounts on one device |
| BILL-14 | DONE (entitlement part was already NOT REPRODUCED) | Entitlement was already webhook-only (`be/src/services/stripe-billing.service.js:386-445`, §12.13). UX defect: `web/src/app/(dashboard)/gymsera-billing/page.tsx:41-53`, `:225-228` toasted "Payment successful — your GymsEra subscription is now active" and showed "Payment confirmed." from `?checkout=success` alone; `web/src/app/gym-owner/register/page.tsx:367` sent no session id to verify | BILL-12 `stripeApi` seam and the webhook-created `TenantSubscription` row as the only proof of entitlement; react-query polling | New read-only `GET /billing/stripe/session/:id`: re-fetches the Checkout Session from Stripe, 404 unless it belongs to the caller's tenant, returns `confirmed` (paid per Stripe) and `entitled` (the webhook's ACTIVE row exists). Web return page: success only when `entitled`; "Confirming payment…" / "activating your plan…" while polling; "not completed" when Stripe says unpaid; `?checkout=success` alone shows nothing. Register success_url now carries `session_id={CHECKOUT_SESSION_ID}`. The redirect to the canonical host billing page is UX-02 (not done here). Web card payments stay OFF per R-7 | `gymsera_be/tests/integration/billing-stripe-return.test.js`, `gymsera_web/tests/components/gymsera-billing-return.test.tsx` | be 2fff789, web f5fa208 (branch `phase-1/prompt-1a-billing-core`) | no — needs a Stripe test-mode checkout |
| TEST-FLAKE-1A (intermittent full-suite failure reported after Prompt 1A) | RESOLVED (mechanism not proven) | Symptom: in ~3 of 14 full `npm test` runs one test failed that always passed on its own, a different test each time (`harness.test.js`; BILL-14 session check got 400; BILL-06 RTDN ack not called). Believed cause: real outbound network calls during tests — `tests/integration/tenant-provisioning-migrations.test.js` sent a real approval e-mail through `src/services/email.service.js` → `mail.gymsera.com:587` (and one test run hit the real Google Play API before provider credentials were blanked). A real SMTP send takes a variable, sometimes long, time and its connection/timers are not awaited by the test that started it; with `--runInBand` all files share one process, so the unfinished call keeps running into the NEXT test file — during its setup (tables truncated/recreated) or its first requests — and whichever file happens to be running when it lands is the one disturbed. That explains why a different test failed each time and why every failing test passed alone | Network jail `tests/harness/no-network.js` (jest `setupFiles`) blocking connections and all DNS resolution except localhost; fake mail sender `tests/harness/mail-fake.js` via the new `email.service.js#mailTransport` seam (same pattern as billing's `appleApi`/`playApi`/`stripeApi`) | Evidence: with outbound e-mail blocked, 10/10 consecutive full runs passed (95/95, 20/20 suites), then 5/5 more (96/96, 20/20) after the DNS gap was closed and the provisioning test switched to the fake sender, with zero real e-mails and zero blocked attempts in those runs. We did not capture the failing interaction itself, so this is RESOLVED on consistent removal of the symptom, not a proven root cause — reopen if it recurs | `gymsera_be/tests/regression/no-outbound-network.test.js`, `gymsera_be/tests/integration/tenant-provisioning-migrations.test.js` | be bed0855 (network block) + DNS/mail-fake commit on `phase-1/prompt-1a-billing-core` | n/a (test infrastructure) |
| SEC-SMTP-FALLBACK | DONE (password rotation is an owner action) | `be/src/config/smtp.config.js:9-15` (commit 7d5ba61, 2026-08-31, pushed to origin/main): when SMTP settings were empty — or pointed at zoho/mailtrap — the config silently switched to a hard-coded `noreply@gymsera.com` account with its password in source | Fail-fast config pattern; test network jail + `mail-fake.js` | No built-in host/account/password: settings come only from `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` (+ optional `SMTP_PORT`/`SMTP_SECURE`/`SMTP_FROM`). `assertSmtpConfigured()` runs first in `server.js` bootstrap and at load in `api/index.js` (Vercel): a missing setting stops startup with `SMTP is not configured: missing …`. Test harness sets fixed fake SMTP values so tests behave the same locally and in CI. **Owner:** change the mailbox password (it is in git history on GitHub) and set all three variables in every deployed environment BEFORE deploying — the server will not start without them. Same-pattern findings elsewhere, not changed here: DB passwords fall back to dev literals (`database.config.js:7,16,18`, `tenant-provisioning.service.js:50-51` also tries MySQL `root` with an empty password, SEC-05); tracked root scripts carry literal fallbacks for `TENANT_CONN_ENCRYPTION_KEY` (`query-requests.js:32`) and `JWT_SECRET` (`test-socket-verify.js:13`); maintenance keys hard-coded in `src/routes/index.js` (NEW-05) | `gymsera_be/tests/regression/smtp-no-fallback.test.js` (4 fail on the old code) | see git log on `phase-1/prompt-1a-billing-core` | no — needs the owner's deploy with real SMTP env |
| SEC-DB-FALLBACK | DONE | `be/src/config/database.config.js:7,16,18`: when `PLATFORM_DB_PASS` / `TENANT_DB_ADMIN_PASS` / `TENANT_DB_PASS` were unset, the config silently used built-in passwords (the local Docker development ones) | Fail-fast pattern from SEC-SMTP-FALLBACK (`assertSmtpConfigured`) | No built-in passwords. `assertDatabaseConfigured()` runs at startup in `server.js` and `api/index.js`: an unset variable stops startup with `Database is not configured: missing …`. An explicitly empty value is still accepted (local/CI MySQL with no root password). Usernames/hosts keep their non-secret defaults. Provisioning's own `root`/empty-password guess (SEC-05) and the seed script `provision-seeded-tenants.js` are not changed here. **Owner:** confirm all three variables are set in every deployed environment before deploying — the server will not start without them | `gymsera_be/tests/regression/db-password-no-fallback.test.js` (4 fail on the old code) | see git log on `phase-1/prompt-1a-billing-core` | no — needs the owner's deploy |
| CI-DB-ENV | DONE (verified by local CI simulation, not yet on GitHub Actions) | `be/.github/workflows/ci.yml:31-37` set only `MYSQL_*` and `JWT_SECRET`: the app's `PLATFORM_DB_USER/PASS` fell back to the built-in `gymsera` user/password (fails against the `mysql:5.7` service, which only has root with an empty password), and `TENANT_CONN_ENCRYPTION_KEY` / `JWT_REFRESH_SECRET` were missing — backend CI could not pass | SEC-DB-FALLBACK (explicit values, no defaults); GitHub `$GITHUB_ENV` | Workflow sets `PLATFORM_DB_HOST/PORT/USER/PASS` and `TENANT_DB_HOST/PORT/ADMIN_USER/ADMIN_PASS/USER/PASS` explicitly (root, empty password — matching the service's `MYSQL_ALLOW_EMPTY_PASSWORD=yes`) and generates throwaway `TENANT_CONN_ENCRYPTION_KEY` / `JWT_REFRESH_SECRET` per run (`openssl rand`, never committed). `smtp-no-fallback.test.js` made environment-independent (it relied on a local `.env` for SMTP host/user). Evidence: clean checkout (no `.env`) + fresh `mysql:5.7` with `MYSQL_ALLOW_EMPTY_PASSWORD=yes` + only the workflow's env → 105/105; the old workflow env on the same setup → 79/105 failed (`Access denied for user 'gymsera'` ×168, encryption key missing). Note: the workflow's branch filter (`phase/**`) does not match `phase-1/…` branches | `gymsera_be/.github/workflows/ci.yml`, `gymsera_be/tests/regression/smtp-no-fallback.test.js` | see git log on `phase-1/prompt-1a-billing-core` | pending first GitHub Actions run |
| SEC-SECRET-SCAN (2026-09-28) | OPEN — report only, owner decisions needed | Full-history scan of all four repos (every committed file version; rules for private keys, service-account JSON, connection strings with passwords, Stripe `sk_/rk_/whsec_`, Google `GOCSPX-`/API keys/FCM server keys, AWS, GitHub, Slack, SendGrid, JWTs, high-entropy values assigned to secret-like names). None found: private keys, service-account files, Stripe/Apple/Google server secrets, cloud tokens. Found: (1) `be/src/seeders/seed.js:306-340` creates 4 `PLATFORM_ADMIN` accounts on `@gymsera.com` with passwords in the repo (also in `SEEDER_GUIDE.md`) — critical if the live database was ever seeded; (2) `TENANT_CONN_ENCRYPTION_KEY` fallback literal (sequential `0123…` pattern, same as the local `.env`) in tracked root scripts `debug-branch-scratch.js:14`, `debug-orgs.js:13`, `query-requests.js:32` (and formerly `src/backfill-payments.js`) — only harmful if production uses that key; (3) `JWT_SECRET` fallback literal in `test-socket-verify.js:12-13` — not the local value; harmful only if it is production's; (4) `query-requests.js:51` MySQL URL `root@localhost` with the Docker dev password — local only; (5) `src/scripts/provision-seeded-tenants.js:24` `TENANT_DB_PASS` dev-default fallback; (6) the removed SMTP password stays in git history (SEC-SMTP-FALLBACK). Public by design (not secrets): Firebase/Maps client API keys in the mobile app (`google-services.json`, `GoogleService-Info.plist`, `firebase_options.dart`, `AndroidManifest.xml`, `AppDelegate.swift`) — should be restricted to the app in Google Cloud. Test/seed fixture passwords in `tests/` are fake. Out of scope here: NEW-05, SEC-05 | — | — | — | — |
| NEW-15 | DONE (made fully read-only by R-21, row below) | `be/src/controllers/host.controller.js:802-805` looked only for an **ACTIVE** row; when there was none (`:807`) it created a 30-day `ACTIVE`/`PAID` row from `tenant.selectedPackageId` (`:813-823`). Nothing told a brand-new tenant apart from one whose plan had ended, so right after a BILL-02 refund (row REVOKED, `resolveMaxBranches` = 0) the app's next "My plan" load granted the registration package again — and again after every CANCELLED/EXPIRED/REVOKED. The onboarding paths already used the correct test ("no subscription row at all"): `be/src/services/tenant.service.js:251-252`, `be/src/services/tenant-provisioning.service.js:518-523` | The onboarding paths' "no row at all" check; the BILL-02 `REVOKED` state and refund path (webhook → refetch → `applyVerifiedSubscription`) drive the test; the response stays the existing 404 "No active subscription found" that mobile (`my_subscription_screen.dart:123-127`), CMS and web already handle | The endpoint auto-creates only when the tenant has **no subscription row of any status**; any history (REVOKED, CANCELLED, EXPIRED, …) → 404, no write. No client change needed. Whether the endpoint should write at all is owner question R-21 | `gymsera_be/tests/integration/subscription-current-no-free-plan.test.js` (refund → 404, no row, `maxBranches` stays 0, repeated calls; CANCELLED/EXPIRED/REVOKED-only history → 404; zero-history tenant still gets its registration plan once; no package → 404; ACTIVE plan returned unchanged) | be 6f3506f (branch `phase-1/prompt-1a-billing-core`) | no |
| NEW-15 / R-21 | DONE | After 6f3506f the endpoint still created a plan for a tenant with zero history (`be/src/controllers/host.controller.js:816-837` at 6f3506f). Owner decision R-21: the endpoint is read-only | The existing ACTIVE lookup and the existing 404 "No active subscription found" (already handled by mobile, CMS, web); query-spy pattern from `tests/regression/get-connection-side-effects.test.js` | Removed the create branch entirely: the endpoint only reads the ACTIVE row, else 404. The first plan comes only from onboarding (submission / approval — see NEW-18 for the silent-failure gap there) | `gymsera_be/tests/integration/subscription-current-no-free-plan.test.js` — every call runs under a write spy (no INSERT/UPDATE/DELETE/DDL); new cases: no history + selected package → 404, zero rows; no history + no package → 404, zero rows. Proven red against 6f3506f (spy caught `INSERT INTO tenant_subscriptions`) | be 5d984de (branch `phase-1/prompt-1a-billing-core`) | no |
| BILL-04 | DONE | No GRACE/ON_HOLD/PAUSED state (`be/src/models/platform/TenantSubscription.model.js:101`); Google mapped `IN_GRACE_PERIOD`, `ON_HOLD`, `PAUSED`, `PENDING` and every unknown state to `ACTIVE` via `default`, and `CANCELED` (auto-renew off, still paid) to `CANCELLED`, which ended entitlement early (`google-play-billing.service.js:89-101`); Stripe mapped `past_due`, `incomplete`, `paused` and anything unknown to `ACTIVE` (`stripe-billing.service.js:210-215`); Apple ignored the subscription status (billing retry / grace) entirely (`apple-billing.service.js:189`, `:216-221` dropped `status` and `signedRenewalInfo`); a first-seen non-active purchase was always created `ACTIVE` by `requestProviderChange` (`subscription-migration.service.js:97-99`) | `getActiveSubscription` → `resolveMaxBranches` (the one capacity read), `reconcileCapacity` (unchanged logic), `applyVerifiedSubscription` + the BILL-02 "entitlement ended" block, `reconcileRenewalStatus`, the `billing_events` inbox and daily store sweep, platform migration runner (p002 pattern) | Platform migration **p004** adds `GRACE`, `ON_HOLD`, `PAUSED` (appended; skipped and listed if the column holds unknown values). `ENTITLING_STATUSES = [ACTIVE, GRACE]` in `subscription-quota.service.js` is used by `getActiveSubscription`, `reconcileCapacity`'s overQuota write, `requestProviderChange`, `reconcileRenewalStatus`, the daily capacity pass and the Stripe lookups — so the one-ACTIVE-row invariant now means one *entitling* row. `ON_HOLD`/`PAUSED` join `REVOKED` in `ENDED_STATUSES`: entitlement 0 (never the legacy fallback) and capacity reconciled in the same transaction. Mappings: Google GRACE/ON_HOLD/PAUSED, CANCELED → ACTIVE (autoRenew=false) until expiry then EXPIRED, unknown → error (inbox retries/alerts); Apple status 1/2/3/4/5 → ACTIVE/EXPIRED/ON_HOLD/GRACE/REVOKED plus `autoRenewStatus`; Stripe past_due → GRACE, unpaid → ON_HOLD, paused → PAUSED, incomplete → nothing written. First-seen non-entitling purchases are recorded as they are. The store sweep also refetches GRACE/ON_HOLD/PAUSED rows. `GET /host/subscription/current` returns the GRACE row with `paymentIssue` = the provider's own manage page (Apple / Google Play fixed URLs; Stripe → our `POST /billing/stripe/portal-session`) | `gymsera_be/tests/integration/billing-lifecycle-states.test.js` (15 cases, red before the fix), `gymsera_be/tests/integration/platform-migrations-1b.test.js` (p004 dry-run zero writes, conflicting-data skip, apply + re-run), `platform-migration-runner.test.js` (list no longer hard-coded) | be f5543f2 (branch `phase-1/prompt-1b-billing-lifecycle`) | no |
| BILL-05 | DONE | `be/src/services/subscription-migration.service.js:390-397` (at f5543f2) deleted `amount` on every sync unless the plan changed, and every provider filled `amount` from the **catalog** (`apple-billing.service.js:185`, `google-play-billing.service.js:142`, `stripe-billing.service.js:266`) — the provider's charged price (Apple `price`/`currency`, Play `recurringPrice`, Stripe `price.unit_amount`) was never read; no `currency` column (`TenantSubscription.model.js`) | `applyVerifiedSubscription` (the one write path) and each provider's existing values builder; catalog stays read-only for subscribers (`billing-plan-catalog.service.js#updatePlan` untouched); platform migration runner | Providers now pass `chargedAmount`/`chargedCurrency` from their verified response (Apple milliunits ÷ 1000; Play `units + nanos`; Stripe minor units, zero-decimal currencies handled). `applyVerifiedSubscription` writes them as `amount`/`currency` on every sync, renewals included. Only when the provider reports no price does the catalog price + catalog currency stand in, and then only for a new row or a plan change — a catalog edit can never reach a subscriber. Platform migration **p005** adds `currency CHAR(3) NULL` (existing rows stay NULL = catalog PKR; skipped and reported if a hand-made `currency` column of another type exists) | `gymsera_be/tests/integration/billing-subscriber-price.test.js` (Apple increase + catalog edit, Apple storefront currency, Play recurring price, Stripe price migration, no-price renewal; 5/5 red before the fix), `platform-migrations-1b.test.js` (p005 dry-run, conflict, apply + re-run) | be e7d61f5 (branch `phase-1/prompt-1b-billing-lifecycle`) | no — Play's `recurringPrice` is the price for the next renewals; confirm on a sandbox price change that it matches the charged order |
| BILL-03 | DONE (backend + Android mode); the branch **lock** is CAP-01 (Prompt 1C); Stripe downgrade timing not changed (web card OFF, R-7) | Android bought every change with `ReplacementMode.withTimeProration` (`app/lib/features/billing/presentation/providers/billing_provider.dart:382-389` at b4dfb59) — a downgrade applied immediately; server had no notion of an upcoming plan: Apple `renewalInfo.autoRenewProductId` was never read (`apple-billing.service.js:209-226` dropped `signedRenewalInfo`), Google `deferredItemReplacement` ignored, and a not-yet-started replacement token would have superseded the current plan at once (`subscription-migration.service.js#requestProviderChange`); no `pendingChange`, no "choose branches to keep" (§12.13.1) | `applyVerifiedSubscription` (one write path; plan in effect = what the provider reports now), `reconcileCapacity` (trims reserved slots first, records overQuotaCount — unchanged), `requestProviderChange` store-confirmed replacement (`linkedPurchaseToken`), the BILL-04 Apple status/renewal-info read, `audit.service.record`, platform migration runner | Platform migration **p006** adds `pending_change JSON NULL`. Providers report `upcomingChange` (Apple: `autoRenewProductId` ≠ current product and auto-renew on; Google: `deferredItemReplacement.productId`); `applyVerifiedSubscription` keeps it as `pendingChange {billingPlanId, branchCount, productId, effectiveAt, keepBranchIds, confirmedByProvider, appliedAt}` and never changes `branchCount` before the provider does; a store-cancelled downgrade clears it; when the provider switches plans the change is marked `appliedAt` and its keep-list stays (carried to the replacement row for Google). A Google replacement whose `startTime` is in the future is recorded on the current row, not applied. New owner-only API: `GET /billing/downgrade-preview?billingPlanId=` (branches, reserved slots, `mustChooseBranches`, `keepCount`) and `PUT /billing/downgrade-choice {billingPlanId, keepBranchIds}` (exactly `newBranchCount` of the tenant's ACTIVE branches when they don't fit; audited as `billing.downgrade_choice`; 409 if the store has a different change scheduled). **Hook for CAP-01:** `subscription-quota.service.js#getBranchesToKeep(tenantId)`. Mobile: `replacementModeForChange` — downgrade `deferred`, upgrade `withTimeProration`; picker passes the current branch count | `gymsera_be/tests/integration/billing-downgrade.test.js` (Apple 6→3: stays 6 until renewal, then 3, slot trimmed, overQuotaCount 2, all 5 branches still ACTIVE, keep-list via hook; store cancel clears; choice after confirmation; validation ×6 incl. owner-only; Google deferred + future replacement + carry-over — 10/10 red before), `platform-migrations-1b.test.js` (p006), `gyms_era/test/regression/android_plan_change_mode_test.dart` | be 900506e (branch `phase-1/prompt-1b-billing-lifecycle`), app b8909df (branch `phase-1/prompt-1b-billing-lifecycle`) | no — **needs sandbox**: Apple downgrade transaction/renewal-info timing; whether Play issues the DEFERRED replacement token before or at renewal and what `startTime` it carries |
| BILL-13 | DONE | Submission already created an **ACTIVE** MANUAL row for the whole package cycle for every method, pay-later included (`be/src/services/tenant.service.js:251-275` at main; `paymentStatus: 'PENDING'`), so approval (`tenant-provisioning.service.js:517-551`) found a row and did nothing; provisioning's reserved-slot step (`:350-352`) then handed out the package's extra branches; with no row at all `resolveMaxBranches` fell back to the registration package (`subscription-quota.service.js:52-55`) — test run before the fix: pay-later tenant ACTIVE until 2027-09-28 (a yearly package). Nothing ended an unpaid plan early | `applyVerifiedSubscription` (one write path — MANUAL rows keyed `pay-later:<tenantId>`), BILL-04 `GRACE` + `paymentIssueFor`, the existing daily sweep `subscription-expiry.cron.js#_processPlatformSubscriptions` (no new cron), `audit.service.record`, the NEW-15 "no fallback once a plan existed" rule | `PAY_LATER_GRACE_DAYS` (default 14, R-17 = R-22) is defined once in `src/config/billing.config.js` (+ `.env.example`). PAY_LATER gets no plan at submission. Approval (provisioning step 1b — before the slot step and before the tenant is ACTIVE, and **not swallowed**, so a failure keeps the tenant re-approvable: NEW-18 fixed for this path) creates one MANUAL row in `GRACE`, `branchCount=1`, `endDate = approval + PAY_LATER_GRACE_DAYS`, `paymentStatus PENDING`; `GET /host/subscription/current` shows `paymentIssue {provider: MANUAL, payBy, daysLeft}` (the countdown). New `POST /admin/tenants/:id/subscriptions/:subId/verify-payment {bankTransferRef}` (PLATFORM_ADMIN): GRACE → ACTIVE, PAID, one month from today, audited as `billing.pay_later_verified` in the tenant's trail; anything else → 409. The daily sweep ends an unpaid grace → `EXPIRED` (then the existing lapsed-plan handling: tenant suspended, listing hidden, e-mail). `EXPIRED` now joins the no-fallback states → 0 branches, never the package. Bank transfer unchanged | `gymsera_be/tests/integration/billing-pay-later.test.js` (real approval; submit → no row; approval → 1 GRACE row, +14 days, no extra slots, countdown; env 5 → +5; +16 days unpaid → EXPIRED, 0 branches; verify → ACTIVE/PAID/audited, survives the sweep; verify refuses non-admin / non-GRACE; retried start keeps one row; bank transfer unchanged — 6/7 red before) | be fc76f8b (branch `phase-1/prompt-1b-billing-lifecycle`) | no |
| FLOW-03 | DONE (backend). R-4 setup-mode card (save now, charge at approval) **not built** — web card is OFF (R-7) | §12.13.3 found double entitlement already prevented by "any row exists" (`tenant-provisioning.service.js:519-523` at main). Still reproduced (test red before the fix): (1) approval never looked at a provider-backed row — a pay-later applicant whose registration card was declined (Stripe `unpaid` → ON_HOLD) got a free GRACE plan on top (2 rows); an existing card row was never re-verified at approval; (2) a card subscription completing **after** approval superseded the MANUAL plan through the store branch of `requestProviderChange` (`subscription-migration.service.js:191-204` at main): `PENDING_CANCEL` with the note "cancel the undefined subscription yourself" (`storeLabel` has no MANUAL) | `requestProviderChange` (one-entitling-row rule), the provider sync entry points (dispatcher lifted out of `billing-event.service.js#reconcileStoreSubscriptions` as `refreshStoreSubscription`, used by the sweep and approval), BILL-13 `startPayLaterGrace` | Provisioning step 1b calls `planForApproval(tenant)` before anything is created: a provider-backed row (IOS/ANDROID/STRIPE) is re-verified through its provider's sync and **nothing else is created**; otherwise pay-later gets its GRACE plan and other methods keep the existing path. A superseded MANUAL row becomes `CANCELLED` — "Replaced by a new Stripe subscription on … — no action needed." NEW-18 partly fixed (see §12.13.11) | `gymsera_be/tests/integration/flow-03-one-entitlement.test.js` (card at registration → approval re-verifies it, 1 row; declined card → no pay-later plan on top; card after approval → one entitling row, MANUAL CANCELLED with a clear note — 3/3 red before) | be 6142e65 (branch `phase-1/prompt-1b-billing-lifecycle`) | no |
| BILL-08 | DONE | Server: `SUBSCRIPTION_STATE_PENDING` fell into `default: return 'ACTIVE'` with `paymentStatus: 'PAID'` (`be/src/services/google-play-billing.service.js:98-99`, `:146` at main) — an unpaid Play purchase granted the plan as soon as the app synced it (BILL-04 already stopped the grant by refusing unknown states; the app still got a 5xx instead of a clear answer). App: `PurchaseStatus.pending` showed the "purchasing" spinner indefinitely (`app/lib/features/billing/presentation/providers/billing_provider.dart:535-539` at b4dfb59); nothing distinguished "not paid yet" from failure | `syncFromGoogle` (the one entry point for `/sync` and RTDNs), the `billing_events` inbox, BILL-06 acknowledge rules (ack only ACTIVE/GRACE), the typed-exception pattern of BILL-01 (`SubscriptionOwnedByOtherAccountException`), `_pendingProductId` matching | Server: `SUBSCRIPTION_STATE_PENDING` / `PENDING_PURCHASE_CANCELED` → nothing written, granted or acknowledged; `POST /billing/android/sync` answers **202** `{state: PAYMENT_PENDING}` (or 200 `PAYMENT_CANCELLED`); the inbox records such an RTDN as IGNORED. Google's later `SUBSCRIPTION_PURCHASED` re-fetches the now-paid purchase and applies it through the existing webhook path (plan + server acknowledge). App: new `BillingPurchaseStatus.pending` for the store's pending event and the server's 202 (`PaymentPendingException`): "Payment pending — we'll unlock your branches when Google Play confirms the payment", no success, no replay, not finished in the store queue, buy button disabled | `gymsera_be/tests/integration/billing-android-pending.test.js` (202 + no row + no ack; completion via RTDN → ACTIVE + ack; cancelled → nothing; pending upgrade leaves the current plan — 4/4 red with the server change removed), `gyms_era/test/regression/billing_pending_purchase_test.dart` | be 07043f3 (branch `phase-1/prompt-1b-billing-lifecycle`), app 520a49b | no — needs a Play sandbox "slow test card" purchase to confirm the RTDN sequence. Gap: if Google's completion RTDN is lost there is no row for the daily sweep to refresh; the app re-syncs it when Play redelivers the purchase |
| TEST-FLAKE-1B (intermittent full-suite failure, 1A + 1B) | DONE — cause proven (supersedes the "mechanism not proven" note on TEST-FLAKE-1A) | supertest 7.3 starts a bare Express app with `app.listen(0)` on **every address (::)** and then calls **127.0.0.1** (`node_modules/supertest/lib/test.js:90`, `:105`). On macOS the OS may give that listen a port another program already holds on 127.0.0.1 only (this machine: IDE language servers, Electron, GitHub Desktop, Dart… 20 loopback listeners in 49152–65535); both binds succeed and the request reaches the other program. Evidence: 15 baseline runs → runs 3 and 4 failed in different tests (BILL-06 `/android/sync` got **403** with no `[Audit]` line for it — the app never saw the request; BILL-03 got **"socket hang up"**); a detectOpenHandles run failed a third test (BILL-04 resumed RTDN not applied — the webhook's response is not checked). Port stress on this machine: 3 of 5000 `listen(0)` ports were ports held on 127.0.0.1 by other programs; a controlled repro (`tests/regression/test-server-loopback.test.js`) shows 127.0.0.1 answered by the other program. Not a billing defect | The network jail pattern (`setupFiles`), the existing `teardownTestDatabases` in every file's `afterAll` | `tests/harness/test-server.js#startTestServer`: the app listening on 127.0.0.1 (async bind; supertest then uses that address as is) — the 12 test files and `personas.js` that called `request(app)` now start it in `beforeAll` (call sites unchanged); `teardownTestDatabases` stops it. `tests/harness/loopback-listen.js` (setupFiles) refuses a random-port every-address listen in tests with a message naming the fix, so a bare `request(app)` fails at once instead of rarely. No timeout raised, no retry | `gymsera_be/tests/regression/test-server-loopback.test.js` (mechanism repro; guard; test server on 127.0.0.1 never takes a port held there, supertest reaches our app) | be e9feaf7 (branch `phase-1/prompt-1b-billing-lifecycle`); after the fix 10 consecutive full runs 168/168 (before: 15 runs, 2 failed) | n/a (test infrastructure). Separate, not the cause: at suite end 33 Redis sockets (Bull queues, `src/jobs/queues.js:36`, 3 clients per queue, never closed, against the developer's local Redis) and 3 MySQL sockets stay open, so Jest needs `--forceExit`; `src/models/platform/index.js:46` runs `DeviceToken.sync()` un-awaited at require time |
| NEW-04 | DONE | `be/src/routes/index.js:342-383` (unauthenticated `/debug-sync-db` ran `platformSeq.sync({alter:true})` and decrypted all tenant DBs to run `tenantSeq.sync({alter:true})`); `fetch_sync.js:1` called this route | Standard 404 route handling; schema changes come exclusively via versioned migration runners (`tenant-migration-runner.js`, `platform-migrations.js`). Query write-spy pattern from `tests/regression/get-connection-side-effects.test.js` | Removed `/debug-sync-db` completely from `src/routes/index.js`; deleted legacy `fetch_sync.js`. Route returns 404 on GET and POST with zero database writes. Other unauthenticated routes in the same file and mounted files are audited and listed in hotfix report (d) | `gymsera_be/tests/regression/debug-sync-db-removed.test.js` | be 0cc58d8 | no |
| NEW-05 | DONE | `be/src/routes/index.js:326-340` (`/system/recycle` terminated worker process via `process.exit(0)` behind a hard-coded key committed in git) | Standard 404 route handling; process recycling and deployments belong in CI/CD and server orchestration, not unauthenticated/key-in-code HTTP routes. Query write-spy pattern from `tests/regression/get-connection-side-effects.test.js` | Removed `/system/recycle` completely from `src/routes/index.js`. Route returns 404 on GET and POST with zero database writes. The committed key must never be reused for anything, and any other key found in the same route file is listed in part (d) | `gymsera_be/tests/regression/system-recycle-removed.test.js` | be 271ca62 | no |
| NEW-29 | DONE | `be/src/routes/index.js:324-408` (unauthenticated `/debug-cleanup-indexes` dropped foreign keys and indexes on every tenant DB) | Standard 404 route handling; schema and index changes come exclusively via versioned migration runners (`tenant-migration-runner.js`, `platform-migrations.js`). Query write-spy pattern from `tests/regression/debug-sync-db-removed.test.js` | Removed `/debug-cleanup-indexes` completely from `src/routes/index.js`. Route returns 404 on GET and POST with zero database writes | `gymsera_be/tests/regression/debug-cleanup-indexes-removed.test.js` | be 0ae5cdf | no |
| NEW-30 | DONE | `be/src/routes/discovery.routes.js:52-175` (unauthenticated `/discovery/seed-conversations` seeded dummy conversations and messages into platform DB) | Standard 404 route handling; seeding test data belongs in test fixtures and offline seeders, not open API endpoints. Query write-spy pattern from `tests/regression/debug-sync-db-removed.test.js` | Removed `/discovery/seed-conversations` completely from `src/routes/discovery.routes.js`. Route returns 404 on GET and POST with zero database writes | `gymsera_be/tests/regression/seed-conversations-removed.test.js` | be 58237df | no |
| NEW-31 | DONE (resolves NEW-01) | `be/src/routes/discovery.routes.js:580-618` (unauthenticated `/discovery/debug-activate-branches` updated `travelerVisibilityStatus` across all tenant DBs) | Standard 404 route handling; branch status updates belong inside authenticated host/admin workflows, not open API endpoints. Query write-spy pattern from `tests/regression/debug-sync-db-removed.test.js` | Removed `/discovery/debug-activate-branches` completely from `src/routes/discovery.routes.js`. Route returns 404 on GET and POST with zero database writes | `gymsera_be/tests/regression/debug-activate-branches-removed.test.js` | be 158f50a | no |
| CAP-01 | DONE | `be/src/services/subscription-quota.service.js:271-278` (over-quota only incremented `overQuotaCount`, never enforced on real branches; branches kept selling); no `billing_locked_at` on `Branch` | Tenant migration runner (010), platform migration runner (p007), `CapacityEvent` (`BRANCH_BILLING_LOCKED`/`BRANCH_BILLING_UNLOCKED`), `OVERQUOTA_GRACE_DAYS` (7), `MEMBER_CHECKIN_GRACE_DAYS` (7), `getBranchesToKeep(tenantId)`, daily sweep `subscription-expiry.cron.js` | Added `billing_locked_at` / `billing_lock_reason` columns to `branches` (migration 010); widened `capacity_events.action` (migration p007); created `branch-billing-lock.service.js` with `applyBranchBillingLocks` and `reconcileTenantBillingLocks`; created `checkBranchBillingLock` middleware to guard plan creation, member enrollments, payments/sales, and staff additions; allowed existing member check-ins for 7 days then blocked; daily cron enforces lock after 7-day grace and auto-unlocks on upgrade/delete | `gymsera_be/tests/regression/cap-01-branch-billing-lock.test.js` | be a023dad | no |
| CAP-02 | DONE | `be/src/services/gym.service.js:930-975` (`deleteBranch` committed tenant DB first, then attempted platform DB credit; crash/network split dropped slot credit permanently) | Transactional outbox pattern, `CapacityEvent.idempotencyKey` replay safety, daily sweep `subscription-expiry.cron.js` | Added `capacity_outbox` table in tenant DB (migration 009); wrote outbox entry inside the tenant DB transaction in `deleteBranch`; created `capacity-outbox.service.js` to process entries atomically; added sweep in daily job `subscription-expiry.cron.js` | `gymsera_be/tests/regression/cap-02-capacity-outbox.test.js` | be 03493c5 | no |
| CAP-03 | DONE | `be/src/controllers/host.controller.js:588-608` (direct `Branch.create` inside `createListing`), `be/src/controllers/admin.controller.js:296-324` (`createAdminTenantBranch` called `Branch.create` directly, bypassing capacity quota), `Branch.update({status})` paths | `gymService.createBranch`, `gymService.deleteBranch`, `gymService.restoreBranch` as single lifecycle authority doors | Routed all branch creation through `gymService.createBranch` (`createAdminTenantBranch` and `createListing`); guarded direct status updates; added AST/source-scan regression test ensuring no direct `Branch.create` or `Branch.update({status})` appears outside `gym.service.js` | `gymsera_be/tests/regression/cap-03-branch-lifecycle-source-scan.test.js` | be 0d81080 | no |
| CAP-04 | DONE | `be/src/controllers/admin.controller.js:332-358` (`disableAdminTenantBranch` wrote `status: 'INACTIVE'` directly, conflating administrative policy suspension with lifecycle deletion, reducing active capacity and granting unearned quota) | Tenant migration runner (008), audit logging, public discovery filtering | Added `admin_suspended`, `admin_suspended_at`, `admin_suspended_reason` to `branches` (migration 008); admin suspension leaves capacity and `status: 'ACTIVE'` unchanged while hiding branch from discovery and traveler search; admin delete calls `deleteBranch`; writes audit row | `gymsera_be/tests/regression/cap-04-admin-disable-branch.test.js` | be 9444ca2 | no |
| CAP-05 | DONE | `be/src/services/admin.service.js:462-475` (`rejectTenant` marked tenant REJECTED without releasing reserved slots or deactivating branches via lifecycle door); `subscription-quota.service.js:134` included REJECTED listings in capacity sum | `deleteBranch` with `confirmOrganizationDeletion: true`, `subscriptionQuotaService.reconcileCapacity`, host notification | In `rejectTenant`, call `deleteBranch` on the listing's branches with `confirmOrganizationDeletion: true`, mark listing REJECTED, notify host, and exclude REJECTED listings from capacity usage in `getUsedCapacity` | `gymsera_be/tests/regression/cap-05-reject-pending-org-capacity.test.js` | be 262846e | no |
| CAP-06 | DONE | `be/src/services/gym.service.js:1060-1070` (`restoreBranch` restored branch into an auto-deactivated organization without reactivating the organization, leaving orphan active branch or requiring fresh capacity instead of consuming preserved slot) | `gymService.restoreBranch` lifecycle door, `GymListing.update`, `CapacityEvent` | In `restoreBranch`, if listing `status === 'INACTIVE'`, reactivates listing (`status: 'ACTIVE'`, `branchId: branch.id`) in the same flow and consumes that organization's preserved `reservedSlots` first (no fresh capacity used) | `gymsera_be/tests/regression/cap-06-restore-auto-deactivated-org.test.js` | be a85db2d | no |
| CAP-07 | DONE | `be/src/services/subscription-quota.service.js:403-435` (`auditCapacity` audited capacity drift and over-quota but did not check or report ACTIVE organizations with 0 ACTIVE branches) | `auditCapacity`, `_guardLastBranchInOrganization` | Extended `auditCapacity` to detect and report ACTIVE organizations with zero ACTIVE branches (`emptyActiveOrgs`, `hasEmptyActiveOrgs`, `ok: false`); added randomized property-based test running create/delete/move/restore/lock/unlock sequences verifying invariant `activeBranches + Σ reservedSlots <= maxBranches` and organization never empty at every step | `gymsera_be/tests/regression/cap-07-organization-never-empty.test.js` | be 5463307 | no |
| CAP-08 | DONE | `be/src/services/gym.service.js:520` (`createBranch` awaited `_notifyBranchLimitReached` inside platform transaction without transaction binding, causing connection pool exhaustion and deadlock when parallel requests exceeded capacity) | Row-level locking `lock: true` on `Tenant` and `Branch`, asynchronous non-blocking notification dispatch | Dispatched `_notifyBranchLimitReached` asynchronously so failed transactions rollback immediately; verified 20 concurrent branch creations with room for 3 (exactly 3 succeed, 17 fail 403), parallel delete + restore on same branch, and parallel new-organization creation competing for one donor slot | `gymsera_be/tests/regression/cap-08-capacity-concurrency.test.js` | be 2dcaec8 | no |
| BUILD-PROD-DEPS (web + CMS) | DONE | Both Next.js apps: `tsconfig.json` had `"include": ["**/*.ts", …]` with only `node_modules` excluded, so `next build` type-checked test-only files (`playwright.config.ts`, `vitest.config.ts`, `e2e/`, `tests/`) and failed wherever `@playwright/test`/`vitest` were absent; and the build-time tools (`typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `tailwindcss`, `postcss`, `autoprefixer`) were `devDependencies`, so a prod-only install (`npm ci --omit=dev`) could not build at all (CMS repro on a clean copy of main: `Cannot find module 'autoprefixer'`, and every `@/` import unresolved because Next reads tsconfig `paths` through `typescript`) | Same fix in both repos; lockfile versions unchanged (only the `dev` flags move) | `tsconfig.json` `exclude` adds `playwright.config.ts`, `vitest.config.ts`, `e2e`, `tests`, `test-results`, `playwright-report` (vitest/playwright still load their own files, so tests are unaffected); the seven build-time packages above moved to `dependencies`. **Rule for any repo:** everything `npm run build` needs (compiler, type packages, CSS/PostCSS toolchain) belongs in `dependencies`; test runners and their configs must stay out of the build's type-check. Check with `npm ci --omit=dev && npm run build` on a clean checkout, and delete any devDependency npm pulls in anyway (`next` drags `@playwright/test` in as a peer) before building. Tests and CI unchanged (CI still runs a full `npm ci`) | — (build check: clean `npm ci --omit=dev` + `npm run build` passes in both repos with no devDependencies present; CMS vitest passes) | web 12c9914, cms a99547e | n/a (build) — the next production deploy of each app is the real check |
| NEW-26 | DONE | `be/src/middleware/tenantContext.js:134` (`where: { id: tenantId, status: ['ACTIVE', 'SUSPENDED'] }`), `be/src/services/tenant.service.js:181` (no status check in `updateMyTenant`), `be/src/services/subscription-migration.service.js:93,477` (unconditional capacity reconciliation during webhooks), `be/src/jobs/subscription-expiry.cron.js:172,228,370` (missing status checks and Redis invalidation on auto-suspension) | Strict `status === 'ACTIVE'` enforcement in tenantContext (same 404 shape), immediate Redis cache invalidation (`safeRedisDel`) and pool release on suspension, ACTIVE status check in `updateMyTenant`, skipping capacity reconciliation on suspended tenants in billing webhooks (decision R-23), skipping non-ACTIVE tenants in cron capacity reconciliation and DB pool sweeps | Restored `status: 'ACTIVE'` requirement in `tenantContext.js` (returns 404 `{ success: false, message: 'Tenant not found or not active' }`); verified admin console routes (`/admin/*`) do not pass through `tenantContext` and continue to work via `_getTenantDb`; added `status !== TenantStatus.ACTIVE` check in `updateMyTenant`; updated `subscription-migration.service.js` to record subscription updates on `TenantSubscription` without granting entitlement or reconciling capacity for suspended tenants; updated `subscription-expiry.cron.js` to skip non-ACTIVE tenants and invalidate cache / release pool on auto-suspend; added source-scan and integration regression tests | `gymsera_be/tests/regression/new-26-suspended-tenant-blocking.test.js` | be ee571f5 | no |
| NEW-28 / OPTION-B | DONE | `be/src/jobs/queues.js:36`, `be/src/services/payment.service.js:649`, `be/src/services/subscription.service.js:448`, `be/src/jobs/subscription-expiry.cron.js:91` (Bull notifications queue silently dropped jobs in production without Redis and leaked sockets during tests) | Direct in-app/push/email notification dispatch via `notificationsService.createNotification` and `emailService` (matching all other notifications across the codebase) | Replaced Bull queue.add() with direct `notificationsService.createNotification` (MySQL write, WebSocket broadcast, FCM push) and `emailService` calls; removed unused `_enqueueNotification` helper in `subscription.service.js`; removed `queues.js`, `notifications.processor.js`, and queue startup in `server.js` | `gymsera_be/tests/regression/direct-member-notifications.test.js` | be 65d70f8 | no |
| RBAC-07 | DONE | `be/src/controllers/me.controller.js:28-66` (`_legacyGymStaffScan` looped across all tenant DBs checking `GymStaff`), `payments.controller.js:106` (`GymStaff.designation === 'admin'` bypass), `expenses.controller.js:77,152` (`GymStaff` bypass), `staff-actions.routes.js:52-78`, `staff-invites.routes.js:79` (mutated platform `users.role = 'BRANCH_MANAGER'`), `gym.service.js:1145,1248` (bypassed `RoleAssignment` creation/revocation) | `RoleAssignment` + `team.service.js` single authority (§8.3), `resolveGrant()` / `hasBranchAccess`, source code AST scan guard | Removed `_legacyGymStaffScan` in `me.controller.js` so staff status is sourced solely from `RoleAssignment`; removed `GymStaff` access bypasses in `payments.controller.js` and `expenses.controller.js`; updated `staff-actions.routes.js` to require active `RoleAssignment` for branch; routed legacy staff invites/creates/removes to `teamService` (`acceptStaffInvite`, `inviteMember`, `revokeUserAccess`, `revokeBranchAssignments`) leaving user role as `MEMBER`; cascaded branch deletion to branch-scoped `RoleAssignment`s (RBAC-09); enforced `GymStaff` is HR/profile metadata only. **Residual data:** before this fix the legacy flow had written `users.role = BRANCH_MANAGER` (existing MEMBERs upgraded; staff invited by e-mail created with it). Read-only check `gymsera-rbac07-elevated-roles-check.js` lists every user whose role is not MEMBER/GYM_HOST/PLATFORM_ADMIN with tenant ownership, `user_org_index`, and `role_assignments` + `gym_staff` in every tenant DB (by user id or e-mail), verdict OWNS_TENANT / STAFF_ACCESS_CURRENT / LIKELY_BUG_ORPHAN / NO_TRACE. Correction script `gymsera-rbac07-reset-orphan-roles.js` (PREVIEW default, `--apply --confirm`): only the hard-coded ids, each re-verified live with the same verdict code, one transaction with locking reads, `role` BRANCH_MANAGER → MEMBER only, one `platform_audit_logs` row each (`rbac07_role_correction`, before/after role, reason), read-only post-check. Needs `platform_audit_logs` (platform migration p010) | `gymsera_be/tests/regression/rbac-07-unify-staff-access.test.js`, `gymsera_be/tests/regression/rbac-07-reset-orphan-roles.test.js` | be d296268 (fix), be a89d1bc (check + correction scripts) | Production data correction run 2026-09-30 (PKT; owner): check found 6 accounts with the legacy elevated role — 6 LIKELY_BUG_ORPHAN, 0 STAFF_ACCESS_CURRENT, 0 OWNS_TENANT, 0 NO_TRACE; all 6 corrected BRANCH_MANAGER → MEMBER, one `platform_audit_logs` row each; post-apply check confirmed all 6; no user's active access affected. Code fix itself not separately verified in staging |
| AUTH-01 | DONE | `be/src/models/platform/RefreshToken.model.js:16` (refresh tokens stored in plaintext; no `family_id` column); `be/src/services/auth.service.js:81` (used signed JWT instead of opaque string); `be/src/services/auth.service.js:652-663` (ignored revoked tokens without reuse detection or session family revocation) | Session family rotation & reuse detection (RFC 6819 §5.2.2.3, OAuth 2.0 BCP), SHA-256 token hashing at rest, platform migration p008 | Replaced JWT refresh tokens with 80-hex opaque cryptographically random tokens stored as SHA-256 hashes at rest in `refresh_tokens`; added `family_id` column and index (migration p008); rotated tokens on every refresh within same `family_id`; on reuse attempt of revoked token, immediately revokes entire session family so all tokens in family (including legitimate rotated tokens) are dead (401) | `gymsera_be/tests/regression/auth-01-refresh-token-rotation.test.js` | be 4adc58d | no |
| AUTH-04 | DONE | `be/src/models/platform/Otp.model.js:21` (code stored in plaintext `VARCHAR(6)` without attempts tracking); `be/src/services/auth.service.js:61,859` (raw code SQL matching; no brute-force lockout; no resend cooldown; no per-identifier rate limit) | Constant-time hash verification (`crypto.timingSafeEqual`), SHA-256 salted at-rest hashing, max 5 failed attempts lockout, 60s cooldown, 10/hour per-identifier rate limit, platform migration p009 | Widened `otps.code` to `VARCHAR(64)` and added `attempts` / `max_attempts` columns (migration p009); salted SHA-256 code hashing; constant-time verification; locks out code after 5 failed attempts (`is_used = true`); enforced 60-second cooldown (`_assertOtpCooldown`) and 10 codes/hr rate limit (`_assertIdentifierRateLimit`); zero raw OTP logging in source | `gymsera_be/tests/regression/auth-04-otp-security.test.js` | be 621dc93 | no |
| AUTH-09 | DONE | `be/src/services/admin.service.js:14-57` (admin "add tenant" flow auto-created verified accounts with random passwords or auto-linked/mutated existing `MEMBER` users to `GYM_HOST` with zero proof of email ownership or consent) | Email-verified invitation token flow (`TenantInvitation`), salted SHA-256 token hashing, `PlatformAuditLog` (`platform_audit_logs`), platform migration p010 | Replaced automatic account creation / linking with `TenantInvitation` email invitation flow; admin creating a tenant sends an invitation link with 7-day token; recipient proves email ownership by accepting invitation via `/auth/tenant-invitations/accept` (setting password for new user, confirming password for existing user) before tenant is created or role upgraded; audit logging on `admin.tenant_invited` and `tenant_invitation.accepted` | `gymsera_be/tests/regression/auth-09-admin-tenant-invitation.test.js` | be 476c3c6 | no |
| SEC-02 | DONE | `be/src/middleware/tenantContext.js:95` (`explicit = req.headers['x-tenant-id'] || req.query.tenantId || req.body?.tenantId;` accepted client body/query input to select tenant; allowed accessing unauthorized tenants via X-Tenant-Id or body; leaked existence via 403 on existing vs 404 on non-existing) | Spec §8.2 authorization pipeline (`ctx.tenantId ∈ user's tenants`), `UserOrgIndex` + `Tenant.ownerUserId` membership validation, leak-proof 404 response | Removed `req.body.tenantId` and `req.query.tenantId` from tenant selection; stripped `req.body.tenantId` from payload; enforced that `X-Tenant-Id` header is only valid if caller belongs to tenant (or is PLATFORM_ADMIN on active tenant); rejected forged body `tenantId` or header `X-Tenant-Id` for unauthorized tenant with 404 (zero existence leakage); synchronized `req.user.tenantId = tenantId`; updated `resolveDefaultTenantForUser` to include owned gyms | `gymsera_be/tests/regression/sec-02-tenant-identity-source.test.js` | be 78f346e | no |
| SEC-01 | DONE | `be/src/services/subscription.service.js:124-140` (`_resolveBySubscriptionId` allowed any staff user to look up any subscription id across all tenants and perform operations); `payments.controller.js:53,109-120` (returned 403 when user lacked branch access, leaking existence of payment ID across branches); `gyms.controller.js:255` (returned 403 on branch access failure); `users.controller.js:63-228` (did not check if target user belonged to tenant or assigned branch) | `accessService.resolve` / `hasBranchAccess` (shared in `src/utils/branchAccess.utils.js`), leak-proof 404 responses (spec §8.2), `UserGymMembership` tenant verification | Centralized branch scoping in `hasBranchAccess`; replaced 403 existence-leaking responses with 404 across payment, subscription, branch, and user operations; restricted member subscriptions strictly to caller's `userId`; restricted user details/mutations/searches to users with records in caller's tenant and assigned branch(es) | `gymsera_be/tests/regression/sec-01-no-idor-matrix.test.js` | 4de6020 | no |
| RBAC-03 | DONE | `be/tests/*.test.js` were hand-written scenarios against a live server (`be/tests/helpers.js`) with no systematic endpoint × persona matrix test or committed PERMISSIONS.md documentation derived from code | Code-derived permission catalogue (`src/constants/permissions.js`, `src/constants/roles.js`), `PersonaManager` test harness (`tests/harness/personas.js`), approvable actions engine | Created `src/scripts/generate-permissions-doc.js` to auto-generate `docs/PERMISSIONS.md` directly from the code catalogue; created comprehensive integration suite testing all mutating route groups across all §8.4 personas (Owner, OrgAdmin, Manager, FrontDesk, Trainer, Cleaner, Member, OtherTenantOwner, Anonymous), verifying 200/202 for authorized and 401/403/404 for unauthorized personas | `gymsera_be/tests/integration/rbac-03-permission-matrix.test.js` | 963863f | no |
| REL-01 | DONE | `be/src/middleware/` (no general-purpose idempotency middleware existed; only `POST /payments` accepted an optional key in service `payment.service.js:90-96`) | `CapacityEvent.idempotencyKey` pattern (§1.3), `billing_events` provider event inbox (§7.5), SHA-256 request payload fingerprinting, platform migration runner (`p011`), tenant migration runner (`011`) | Built `src/middleware/idempotency.js` supporting required and optional modes, response replay (caching status, headers, body in tenant or platform `idempotency_records` table with 24h TTL), in-flight concurrent request locking (`409 concurrent_request_in_flight`), payload fingerprint mismatch detection (`422 idempotency_key_payload_mismatch`); added platform migration p011 and tenant migration 011 with dry-run and conflict tests | `gymsera_be/tests/integration/rel-01-idempotency-middleware.test.js`, `gymsera_be/tests/integration/platform-migrations-1e.test.js` | be 5f24c8b | no |
| PAY-01 | DONE | `be/src/controllers/payments.controller.js:29-87` (payment creation did not enforce `Idempotency-Key`; `payment.service.js:89-130` created payment and subscription without an explicit database transaction; `hasBranchAccess` was not enforced on member payment creation) | `idempotency({ required: true })` middleware (REL-01), `branchAccess.utils.js#hasBranchAccess`, atomic Sequelize transaction wrapper | Enforced `idempotency({ required: true })` on `POST /payments`; wrapped payment creation, auto-verification, subscription linkage, and capacity sync in an explicit tenant database transaction; enforced `hasBranchAccess` verifying caller is authorized for the target branch; verified concurrent submission of identical key replays cached response with zero duplicate payments | `gymsera_be/tests/regression/pay-01-payment-idempotency.test.js` | be a5f26da | no |
| PAY-02 | DONE | `be/src/services/payment.service.js:63,222`, `be/src/services/subscription.service.js:410`, `be/src/services/ledger.service.js:150` (used JavaScript IEEE-754 floating point arithmetic for currency calculations, prone to `0.1 + 0.2 = 0.30000000000000004` float drift) | Integer minor units financial arithmetic (`src/utils/money.utils.js`), `Accounting.js` fixed-point decimal patterns | Implemented comprehensive integer minor units math module (`toMinorUnits`, `fromMinorUnits`, `addMinor`, `subMinor`, `mulMinor`, `divMinor`, `sumMinor`, `compareMinor`, `toMajorUnitsNumber`); converted payment calculations, subscription plan price validations, and ledger aggregations to minor units before any arithmetic; verified with a 10,000-sample property test proving zero rounding or precision drift | `gymsera_be/tests/regression/pay-02-money-math.test.js` | be 80054e4 | no |
| PAY-03 | DONE | `be/src/models/tenant/LedgerAdjustment.model.js:56-62` (lacked hook guards preventing update/destroy; allowed mutations of financial adjustments); `be/src/models/tenant/Payment.model.js:180-250` (allowed updating amount, currency, and business_date of completed payments) | Sequelize lifecycle hooks (`beforeUpdate`, `beforeBulkUpdate`, `beforeDestroy`, `beforeBulkDestroy`), immutable audit trail invariant (§6.3) | Added lifecycle hooks to `LedgerAdjustment` model throwing `ledger_adjustment_immutable` on any update or destroy operation; added lifecycle hooks to `Payment` model throwing `payment_immutable` when attempting to mutate financial fields (`amount`, `currency`, `businessDate`, `paidAt`) or delete a `COMPLETED` payment; verified errors reject modifications across single and bulk operations | `gymsera_be/tests/regression/pay-03-append-only-ledger.test.js` | be 1337e97 | no |
| PAY-04 | DONE | `be/src/services/payment.service.js:105-125` (accepted payments with retroactive or current dates even if that business date was already `CLOSED` in `ledger_days`); `be/src/controllers/ledger.controller.js:77-100` (`closeDay` was not idempotent and allowed closing already closed days or missed days out of sequence) | Spec §6.3 ledger close model, `ledger.service.js#getPaymentCollectionTime`, `computeBusinessDate`, 409 Conflict rejection pattern | Enforced that `recordPayment` and `verifyPayment` check `ledger_days` for the payment's business date and reject with `409 ledger_day_closed` if the day is closed; updated `closeDay` to be idempotent (replays existing snapshot if already closed on that day) and snapshot expected and verified totals atomically | `gymsera_be/tests/regression/pay-04-daily-close.test.js` | be 6f4af91 | no |
| PAY-07 | DONE | `be/src/services/payment.service.js:150-195` (refunds were not integrated with the approvable commands engine; allowed refunding more than the original payment amount; did not create reversing `LedgerAdjustment` entries or cancel associated member subscriptions) | Approvable actions engine (`src/services/commands/`, spec §8.3), `LedgerAdjustment` `type: 'REVERSAL'`, minor units subtraction (`subMinor`) | Registered approvable command `'payments.refund'` with permission `payments.refund` in catalogue; calculated remaining refundable amount using integer minor units; created append-only `LedgerAdjustment` (`type: 'REVERSAL'`) linked to the closed or current ledger day; cancelled associated active `MemberSubscription` upon 100% full refund; allowed Owner DIRECT tier and Manager REQUEST tier with notification dispatch | `gymsera_be/tests/regression/pay-07-refunds.test.js` | be 88a236b | no |
| PAY-10 | DONE | `be/src/routes/host.routes.js` (no payout endpoints existed; no `payouts` table in tenant database; payout balance was not derivable from the ledger) | Dynamic balance derivation from ledger (`payments - reversals - expenses - payouts`), tenant migration runner (`012`), approvable commands engine (`payouts.request`), integer minor units math | Added tenant migration 012 creating `payouts` table; registered `Payout` model; created `payout.service.js` calculating dynamic available payout balance across branch payments, reversals, expenses, and pending/approved/completed payouts; created approvable command `'payouts.request'` with idempotency enforcement; exposed `GET /host/payouts/balance`, `GET /host/payouts`, and `POST /host/payouts` | `gymsera_be/tests/regression/pay-10-payouts.test.js`, `gymsera_be/tests/integration/platform-migrations-1e.test.js` | be bbceb49 | no |
| SEC-13 | DONE | `be/src/controllers/gyms.controller.js:175-210`, `be/src/services/gym.service.js:180-205` (`PATCH /gyms/profile` updated `paymentDetailsJson` without password/OAuth re-authentication, without owner security alerts, and without a cooling period blocking immediate payouts) | Platform migration runner (`p012`), password / Firebase idToken re-authentication, `notificationsService` + `emailService` alert pattern, 24-hour security cooling period | Added platform migration p012 adding `payment_details_updated_at` to `tenants`; required `payouts.bank.manage` permission and mandatory password/OAuth re-authentication when updating `paymentDetailsJson`; dispatched security alert notifications (in-app, push, and email) to the gym owner; blocked payout requests within 24 hours of bank detail changes with `422 cooling_period_active` | `gymsera_be/tests/regression/sec-13-payout-cooling-and-reauth.test.js`, `gymsera_be/tests/integration/platform-migrations-1e.test.js` | be ba64174 | no |
| SEC-03 | DONE (Google part; Apple and Stripe were already correct and are now covered by tests) | `be/src/routes/billing.routes.js:147-164` (at f83de34): Google RTDN was authenticated by a static `?token=` query parameter compared with `GOOGLE_PLAY_RTDN_TOKEN`, not by the Pub/Sub push OIDC token; the secret sat in the URL and in access logs. Apple JWS x5c + ES256 (`apple-billing.service.js`) and Stripe `constructEvent` on the raw body (`stripe-billing.service.js:322-326`) already rejected tampered payloads | The provider-call seam pattern (`playApi`/`appleApi`/`stripeApi`, now also `rtdnAuth`), `google-auth-library` (already a dependency), the BILL-12 inbox (unchanged) | Decision R-26 (OIDC only). New `google-play-billing.service.js#verifyRtdnPush`: requires `Authorization: Bearer <token>`, verifies the Google signature against Google's signing certs (via `rtdnAuth.getSigningCerts`), issuer, expiry, audience = `GOOGLE_PLAY_RTDN_AUDIENCE`, `email` = `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT` with `email_verified`. Unconfigured server fails closed (401). The library's errors contain the token, so they are never returned or logged. `?token=` / `GOOGLE_PLAY_RTDN_TOKEN` removed (`.env.example`, `docs/STAGING_TEST_PLAN.md` updated). Existing RTDN tests now send a token signed by a local test key through the real verifier | `gymsera_be/tests/regression/sec-03-webhook-authenticity.test.js` (16 tests: valid, no header, legacy `?token=`, foreign key, payload changed after signing, wrong audience / service account / unverified email / issuer, expired, unconfigured, no token echo; Apple tampered JWS; Stripe real `constructEvent`: valid, body changed, wrong secret); updated `tests/integration/billing-{android-ack,android-pending,lifecycle-states,refund-revoke,webhook-inbox}.test.js`; `tests/harness/billing-fakes.js#rtdnAuthHeader` | be 884713b, branch `phase-1/prompt-1f-security-provisioning` | no: **deploy step**: turn on authentication on the Pub/Sub push subscription and set both env values before this backend goes live |
| SEC-07 | DONE | No redaction layer anywhere (at f83de34). E-mails logged in clear: `be/src/services/auth.service.js:557,590,617,633,700,723,750,759,856,885`, `email.service.js:36,42,45`, `me.service.js:455`, `jobs/subscription-expiry.cron.js:161,163,216`; audit entries printed raw (`middleware/auditLog.js:34`); `morgan('combined')` (`app.js:122`) printed full URLs including query secrets (e.g. the old RTDN `?token=`) | No logger existed (everything is `console.*` + morgan), so no second logging system was added: one redaction module wraps the existing `console` and morgan's own `url`/`referrer` tokens; `sink` seam for tests (same pattern as `mailTransport`/`playApi`) | New `be/src/utils/log-redaction.js`, installed first thing in `app.js` (every entry point, `server.js` and `api/index.js`, loads `app.js` before anything else logs). Removes by key: authorization, cookies, API keys, passwords, OTPs, access/refresh/id/FCM/purchase tokens, signed payloads, receipts, card number/CVV/expiry, IBAN/account numbers, CNIC/national ID/passport, connection strings. Removes by pattern inside any string (including JSON text and error stacks): Bearer/Basic values, JWT/JWS, secret query params, CNIC, IBAN, Luhn-valid card numbers. E-mails and phone numbers become `<email:hash12>` / `<phone:hash12>` (SHA-256, lowercase) so lines stay correlatable. Never throws; circular-safe; input objects are not modified. The ~50 existing log call sites were left as they are (no drive-by edits); all are covered by the wrapper | `gymsera_be/tests/regression/sec-07-log-redaction.test.js` (18 tests: every rule, identifiers left readable, objects/errors/circular, installed on the global console by `app.js`, a real request (unknown-email password reset) prints only the hash, direct console calls redacted, morgan lines redacted) | be d50216b, branch `phase-1/prompt-1f-security-provisioning` | no: §16 "log redaction verified on production-like traffic" is still open. Standalone CLI scripts in `src/scripts` / repo root do not load `app.js` and are not redacted (operator tools, not service logs) |
| RT-04 | DONE | `be/src/socket/index.js:100-104` (at f83de34): `join_conversation` joined any conversation id with no participant check, so any signed-in user could receive every message of any conversation; `:128-133` a GYM_HOST/PLATFORM_ADMIN token without `tenantId` replied to any conversation by borrowing the conversation's own tenant; `mark_read` with no tenant had no filter (`inbox.service.js:129-130`); typing events went into any room name; the tenant room was joined from the token's `tenantId` without re-checking membership; the token was also accepted in the query string (`:58`), which ends up in access logs | `inbox.service.js` scoping (`replyToInquiry`/`markInquiryRead` by tenant, `replyAsUser`/`markTravelerRead` by user, unchanged) and `tenantContext.userBelongsToTenant` (the SEC-02 membership check) | One `authorizeConversation(user, id)` in the gateway: allowed as HOST only when the token's role is GYM_HOST, its tenant owns the conversation and `userBelongsToTenant` still says yes; as USER only when `conversation.userId` is the caller; otherwise "not found". Used by `join_conversation` (new optional ack `{success}`; a denied join is ignored), `send_message` (tenant always the conversation's, never borrowed), `mark_read`. Typing only into rooms the socket actually joined. Tenant room joined only after `userBelongsToTenant`. Query-string token removed (mobile uses `setAuth`, `chat_socket_service.dart:102`; CMS and web don't use sockets). Behaviour change: a PLATFORM_ADMIN token no longer acts as a host over the socket (no client used that) | `gymsera_be/tests/regression/rt-04-socket-room-authorization.test.js` (13 tests over a real Socket.IO server + `socket.io-client` on 127.0.0.1: own traveler / owning host join and receive; other member, other tenant's host, and a host token naming a tenant it doesn't belong to are denied and receive nothing; tenant-less host and admin cannot send; stranger cannot send, type into or mark read; both sides can still send; tenant room re-checked; query token rejected). Red on the old gateway: 10/13 fail | be 2bddcae, branch `phase-1/prompt-1f-security-provisioning` | no: needs a two-device chat check on staging. Past exposure can't be measured: joins were never logged |
| SEC-09 | DONE | `app/lib/features/subscriptions/presentation/screens/add_card_screen.dart:190-310` (at gyms_era f426afb): raw card number / expiry / CVV `TextFormField`s (the "Add card" button only showed "coming soon" and sent nothing, so no card data ever left the device); `app/lib/features/me/presentation/providers/me_providers.dart:149-171`: a hard-coded fake saved card "Visa ···4242" shown to every user in Profile → Payment Methods (`profile_screen.dart:297-349`); "Add new card" entry points on checkout (`payment_screen.dart:299-352`) and in the sheet; checkout copy "We do not store your CVV number" | Nothing to reuse: members pay gyms by bank transfer / wallet (the existing checkout options). A real card flow must later use the gateway's SDK / hosted fields (R-7: no card provider is live) | Deleted `AddCardScreen` and the `/home/checkout/add-card` route; removed both "Add card" buttons, the unused `savedCardProvider`, and `paymentMethodsProvider` with its fake card (and its session-cache reset). Payment Methods now shows `PaymentMethodsSheet`: "No saved payment methods. You pay each gym by bank transfer or mobile wallet at checkout." Checkout copy now says GymsEra never asks for card details. Out of scope, left as is: the Boost screen's fake "Visa ending in 4242" (R-15 / NEW-BOOST, fake "Pay & Activate", replace with "Coming soon" in hardening) and fake payout / bank fixtures (new NEW-33) | `gyms_era/test/regression/sec_09_no_card_collection_test.dart` (source scan of `lib/`: no CVV / card-number fields, no add-card route or screen, no saved-card fixture or provider; widget test of the sheet) | gyms_era 4ca8277 (branch `phase-1/prompt-1f-security`) | no: check Profile → Payment Methods and checkout on a device |
| R-25 (provisioning DB credential fallback; found while verifying FLOW-02) | DONE | `be/src/services/tenant-provisioning.service.js` (at f83de34): `getTenantDbConfig` (`:34-47`) defaulted the admin user to `PLATFORM_DB_USER` / `'root'` and the passwords to `PLATFORM_DB_PASS` / `''`; `createSafeAdminConnection` (`:61-107`) tried TENANT_DB_ADMIN_*, then the platform credentials, then `root` with an empty password; step 5 (`:196-224`), when the tenant app user was refused, switched to the admin credentials and **stored them encrypted as the tenant's permanent connection string** (that tenant then ran as a server admin) | SEC-DB-FALLBACK approach (credentials only from the environment, clear error, explicit empty password allowed); existing admin-approval failure path (502, tenant stays re-approvable) | Decision R-25. Provisioning reads only `TENANT_DB_ADMIN_USER` / `TENANT_DB_ADMIN_PASS` / `TENANT_DB_USER` / `TENANT_DB_PASS` (missing → `TENANT_DB_NOT_CONFIGURED` naming the variables; an empty user is rejected, an empty password is allowed). The admin login retries only the host spelling (localhost ↔ 127.0.0.1, same server). A refused app user stops provisioning with a clear error; admin credentials are never used for or stored on a tenant. Error messages name users and error codes, never passwords. **Read-only check** `gymsera-r25-tenant-db-credentials-check.js` lists tenants whose stored connection string uses the admin, platform or `root` user (verdicts OK_APP_USER / ADMIN_USER / PLATFORM_USER / ROOT / OTHER_USER / UNDECRYPTABLE / NOT_PROVISIONED; READ ONLY transaction, no passwords printed). The seed script `src/scripts/provision-seeded-tenants.js` had the same kind of fallback; fixed later with owner approval, see row "R-25 (seed script)" | `gymsera_be/tests/regression/r-25-provisioning-no-credential-fallback.test.js` (12 tests: each missing variable, empty user vs empty password, platform creds never used, a refused admin login retries only the configured user, approval with a wrong admin password → no DB and tenant not ACTIVE, a refused app user → no admin retry and nothing stored, a correct run stores the app user; check-script classification and a child-process run against the test platform DB that changes nothing). Red on the old service: 9/12 fail | be d9520b8, branch `phase-1/prompt-1f-security-provisioning` | no. **Deploy:** `TENANT_DB_ADMIN_USER` must now be set explicitly (it used to default to `root`). Owner: run the check script on the live DB before deploying |
| UX-12 | PLANNED (not built, per the Prompt 1F instruction) | `cms/src/components/layout/sidebar.tsx:71,76` (separate Staff and Trainers entries); `cms/src/app/(dashboard)/gym/staff/page.tsx` → `cms/src/lib/api/gym.ts:127-198` calls the legacy `/gyms/branches/:id/staff` and `/gyms/staff` endpoints (`be/src/routes/gyms.routes.js:241,331,367,386`); no `/gym/team` page | Mobile Team & Access (`gyms_era/lib/features/host/presentation/screens/team_access_screen.dart`, `permission_editor_screen.dart`, `add_team_member_screen.dart`, `approvals_inbox_screen.dart`; `providers/team_provider.dart`; `data/repositories/team_repository.dart`) and the backend `/team` + `/approvals` routes it uses | See "UX-12 implementation plan" below this table | — (plan only) | — | — |
| R-25 (seed script) | DONE | `be/src/scripts/provision-seeded-tenants.js:18-25` (at c887dee): its own `getTenantDbConfig` fell back to admin user `root`, an empty admin password, app user `gymsera_tenant` and the built-in app password `'tenant_pass'` (also listed in SEC-SECRET-SCAN item 5); config was read only after connecting to the platform DB, and `main()` ran on `require` | The R-25 `getTenantDbConfig` in `tenant-provisioning.service.js` (reused, not copied) | Owner approved 2026-09-30. The script imports the provisioning service's `getTenantDbConfig` (only `TENANT_DB_ADMIN_USER/PASS`, `TENANT_DB_USER/PASS`; missing → `TENANT_DB_NOT_CONFIGURED`), checks it first in `main()` before any connection, prints the clear message on that error, and runs `main()` only when executed directly. `SEEDER_GUIDE.md` already sets all four variables, no change needed | `gymsera_be/tests/regression/r-25-seed-script-no-credential-fallback.test.js` (6 tests: same function as the service and no fallback literals in the source; each missing variable throws; the real script in a child process (empty cwd, network jail) exits 1 with the message and never connects). Red on the old script: 6/6 fail | be 6cfdcab, branch `phase-1/prompt-1f-security-provisioning` | n/a (operator script) |
| SEC-06 | OPEN (PARTIAL): no mass-assignment hole found on the paths checked, but unknown fields are still accepted. Not covered by SEC-01 (that fixed by-ID scope/IDOR, not request-body validation); SEC-02 only stopped body `tenantId` from selecting the tenant | `be/src/middleware/validate.js:10-22` still only runs the express-validator chains a route lists and never rejects unknown keys; only ~24 of 176 `POST`/`PUT`/`PATCH` routes use `validate()` at all (single-line grep; e.g. `POST /gyms/members/enroll`, `gyms.routes.js:315`, has none). Mass assignment itself: no create/update receives `req.body` (or a spread of it) directly; the sinks checked build explicit allow-lists (`expenses.controller.js:471-484`, `host.controller.js:675-689`, `me.service`, `gym.service`, `tenant.service`) or read named fields (`gym.service#enrollMember`, `payment.service#recordPayment` behind the `{...req.body}` spreads at `host.controller.js:1410` and `payments.controller.js:48`). Probe (2026-09-30, local test DB, not committed): `PATCH /me/profile` with extra `role: PLATFORM_ADMIN`, `status`, `tenantId`, `isVerified`, `passwordHash` → **200**, only `fullName` changed, the rest ignored | — (verification only) | Not fixed (verification only, as asked). Suggested fix for its prompt: make `validate()` reject keys not declared by the route's chains (express-validator `checkExact`), then add schemas route by route, starting with routes that write money, roles, status or tenant data. Keep the service allow-lists (defence in depth) | — (a test goes with the fix: extra `status` / `tenantId` / `role` → 400, per §12.6) | — | — |
| NEW-03 | DONE | `be/src/services/auth.service.js:494-523` (at 93587ab, added in 60b0c83): when `googleClient.verifyIdToken` threw and the error text contained "timed out" / "certificates" / "ECONNREFUSED" / "ETIMEDOUT" / "ENOTFOUND" / "network", the token was `jwt.decode`d (**no signature check**) and accepted if iss/aud/exp/sub/email looked right. Reachable by anyone: the library echoes the token header in its "No pem found for envelope …" error, so a `kid` containing "network" triggers it; a failed or slow cert fetch did too. Result: sign in (or pass re-auth) as any Google user, including via the CMS staff route. Also `email_verified: "false"` (string) passed the check (`:526`) | `google-auth-library` `OAuth2Client#verifyIdToken` (already the primary path; kept), `createError` + `errorHandler` 401 shape (same as every auth failure), SEC-07 redaction for the log line | Fallback removed. Any verifier failure, including an unreachable or slow (4 s) Google cert endpoint, is `401 Invalid Google ID token`; the timer is cleared. `sub` required; `email_verified` must be `true` or `"true"`. Only the first line of the verifier's error is logged. Applies to `googleLogin` (app/web and CMS staff) and `verifyReauthCredential` (they share `_verifyGoogleIdToken`) | `gymsera_be/tests/regression/new-03-google-token-verification.test.js` (19 tests; Google's certs replaced by a local test key via `OAuth2Client#getFederatedSignonCertsAsync`, no network). Forged: unsigned token with certs unreachable, header `kid` carrying "network…", attacker key, `alg: none`, payload swapped after signing, cert fetch hangs, wrong audience / expired / non-Google issuer / unverified e-mail (bool and string), CMS staff route, re-auth → all 401, no account created or linked. Genuine: new user, returning user, e-mail account linked, `email_verified: "true"`, iOS client ID, re-auth same account ok / other account 401. **Red on the old code: the 6 attack tests fail (4 × 200 signed in, staff route verified the token and only stopped at the role check, re-auth accepted); all 6 genuine tests pass on old and new code** | be 30eb602, branch `phase-1/new-02-03-social-token-verification` | no: needs a real Google sign-in on staging. **Deploy risk:** the server must reach `https://www.googleapis.com/oauth2/v1/certs`; if production blocks it (the removed fallback's comment suggests it once might have), every Google sign-in now gets 401 instead of being let in unverified |
| NEW-02 | DONE | `be/src/services/auth.service.js` (at 93587ab): `appleLogin` `jwt.decode`d the identity token with **no signature check** (`:668`); the audience was computed but **never enforced**, only iss/exp (`:675-686`); the Apple user id was `userIdentifier || decoded.sub`, i.e. **taken from the request body** first (`:691`); the e-mail used to **link an existing account** could come from the body (`:692`, used at `:710-722`) and Apple's `email_verified` was ignored. `verifyReauthCredential` for APPLE also only `jwt.decode`d (`:993`), no audience. Result: anyone could sign in as any Apple user (or any e-mail account, by linking) and pass re-auth for sensitive actions | `jsonwebtoken` `jwt.verify` with pinned algorithm (the AUTH-01 access-token pattern, `src/utils/jwt.utils.js`), Node `crypto.createPublicKey` for Apple's JWK keys (no new dependency), `createError` + `errorHandler` 401 shape, SEC-07 redaction for log lines | New `_verifyAppleIdentityToken` (shared by sign-in and re-auth): keys from Apple's JWKS (`https://appleid.apple.com/auth/keys`, 5 s timeout, cached 24 h; an unknown `kid` refetches at most once a minute); `jwt.verify` RS256 only, issuer `https://appleid.apple.com`, audience = the existing list (`com.inovettatech.gymsera`, `APPLE_BUNDLE_ID`, `APPLE_CLIENT_ID`), expiry, `sub` required. Any failure (including Apple's keys unreachable) → 401. Apple user id and e-mail come **only** from the verified token; body `userIdentifier` / `email` are ignored (`fullName` stays display-only); a token e-mail Apple marks unverified → 401. Re-auth also requires the verified `sub` to match | `gymsera_be/tests/regression/new-02-apple-token-verification.test.js` (19 tests; Apple's JWKS served from a local test key pair by stubbing `fetch`, no network). Forged/misuse: unsigned, attacker key, `alg: none`, payload swapped, unpublished kid, wrong audience, expired, non-Apple issuer, keys unreachable, body `userIdentifier` override, body e-mail linking, unverified token e-mail, forged re-auth → all refused, victim untouched. Genuine: first sign-in exactly as the app sends it (identityToken, userIdentifier = sub, email, fullName), returning user whose token has no e-mail, e-mail account linked (bool and `"true"`), keys cached (one fetch for two sign-ins), key rotation (one refetch), re-auth same account ok / other account 401. **Red on the old code: 11 attack tests fail (8 × 200 signed in, one directly as the victim via `userIdentifier`; forged re-auth accepted); the 4 genuine-flow tests pass on old and new code** | be 35bad3e, branch `phase-1/new-02-03-social-token-verification` | no: needs a real Sign in with Apple on an iOS build against staging. **Deploy:** the server must now reach `https://appleid.apple.com/auth/keys` (it made no outbound call for Apple sign-in before) |
| FLOW-02 | DONE (backend + CMS). Mobile admin approve not changed (see notes) | Verified again at 7e2b246 (after 1A–1F, NEW-02/03). Already improved: `planForApproval` runs first and throws (1A/1B), ACTIVE is set after migrations (`be/src/services/tenant-provisioning.service.js:536`), R-25 removed the credential fallback. Still open: no recorded step or lock — `approvableStatuses` includes APPROVED (`be/src/services/admin.service.js:372`) and `processTenantProvisioning` ran inline with no lock (`:388`), so two approvals both ran (proven: the second failed with a DDL race `Duplicate key name 'branches_gym_id'` → the admin saw 502 although the tenant became ACTIVE); find-then-create with no lock for listing/gym/branch (`tenant-provisioning.service.js:226,273,308`); a failed GymListing insert was swallowed (`:257-260`) → proven: tenant ACTIVE with no listing and a branch linked to none; the legacy plan step ran after ACTIVE and swallowed errors (`:577-579`) → proven: tenant ACTIVE with 0 plan rows; slot attribution swallowed (`:403-405`); no Idempotency-Key on the route (`be/src/routes/admin.routes.js:108`); no resume/sweep | Platform migration runner (p013, same pattern as p005/p006/p012; dry-run + conflict + re-run tests); REL-01 `idempotency.js` middleware and `idempotency_records` as is (optional key, like PAY-01 but not required so the mobile admin keeps working); the existing daily sweep `subscription-expiry.cron.js#runExpiryCheck` (also the Vercel cron) — no new job system; `recordCapacityEvent` idempotency key; natural-key find-or-create already in the steps; `log-redaction.js#redactString` for the stored error; the seam pattern (`mailTransport`/`playApi`) for failure injection | p013 adds `tenants.provisioning_state` / `provisioning_lock_token` / `provisioning_locked_until` / `provisioning_error` (all NULL, no backfill; all-or-nothing: a conflicting column skips the whole migration). Provisioning is six recorded steps `DB_CREATED → MODELS_SYNCED → LISTING_CREATED → BRANCH_CREATED → SUBSCRIPTION_LINKED → ACTIVE` (approve first records `REQUESTED`, only if nothing is recorded). A run takes a 10-minute lease on the Tenant row by a conditional UPDATE (only on an APPROVED tenant with no live lease), renews it at every step, and every write checks the token + APPROVED, so a run whose lease was taken over, or a tenant rejected meanwhile, stops without activating. A second approve while a run holds the lease changes nothing and returns `provisioning.inProgress` (HTTP 202 with the step). A failure releases the lease, keeps the last finished step and stores the (redacted, ≤500 chars) error; Resume = approve again, continues from there. The listing and plan steps no longer swallow errors; plan (`planForApproval` + legacy package plan) and slot attribution moved into step 5 (still before ACTIVE and before slots are read); slot event + `reservedSlots` in one platform transaction. Activation is the step-6 write itself (status ACTIVE + dbName + connection string + lease cleared); e-mail/notification once, after it. A resumed run settles the DB host the same way step 1 does, then logs in once as the app user (R-25 unchanged). The daily cron resumes up to 5 stalled runs (state recorded, lease free); tenants APPROVED before 1G (no state) are left for the admin. `GET /admin/tenants/:id` returns `tenant.provisioning {state, step, totalSteps, inProgress, lockedUntil, lastError, canResume}`; the lock token never leaves the server (`Tenant#toJSON`). Route takes an optional `Idempotency-Key`. CMS tenant page: panel "Provisioning… (step n/6)" / "stopped at step n/6" with last error and **Resume**, polls every 10 s while in progress, one Idempotency-Key per click. **Read-only check** `gymsera-flow02-provisioning-check.js` (READ ONLY transactions; works before and after p013; needs explicit `CHK_USER`/`CHK_PASSWORD`): STUCK_APPROVED_NO_DB / STUCK_APPROVED_PARTIAL / ACTIVE_NO_CONNECTION / ACTIVE_NO_LISTING / ACTIVE_NO_PLAN / DUPLICATE_GYM / BRANCH_WITHOUT_LISTING / DUPLICATE_LISTING_AT_APPROVAL / UNREACHABLE_TENANT_DB / ORPHAN_DATABASE. **Verdict definitions corrected 2026-10-01** (the first run on the live DB reported DUPLICATE_GYM=10 and DUPLICATE_LISTING_AT_APPROVAL=4, false positives): the first version flagged any tenant DB with more than one `gyms` row and any tenant whose two oldest listings were created within 5 minutes. Both are normal: adding an organization creates its own GymListing **and** its own Gym row (`be/src/controllers/host.controller.js:534`, `:598-613`), and seed data inserts a tenant's listings in the same second (`be/src/seeders/seed.js:1023-1027`). Now **DUPLICATE_GYM** = two or more gyms share one `gym_listing_id`, or there are at least two gyms and more gyms than the tenant has listings; **DUPLICATE_LISTING_AT_APPROVAL** = two listings of one tenant with the same title (trimmed, case-insensitive) created within 5 minutes of each other, any pair, not only the two oldest. Titles are compared, never printed; the output line also shows `gymsSharingListing` | `gymsera_be/tests/regression/flow-02-resumable-provisioning.test.js` (20: crash after each of the 6 steps' work before it is recorded → Resume → exactly one DB, listing, gym, branch, membership plan, subscription row and capacity event, reservedSlots 1; failure before a step + admin summary step 3/6 without the token; real failures inside steps (branch, listing, plan insert); approval e-mail once; two approvals at once → one runs, one in-progress; live lease → nothing done; expired lease → taken over; lease taken over mid-run → stops, not ACTIVE; HTTP Idempotency-Key replay; HTTP 202 + GET summary; sweep resumes a stalled run and leaves a pre-1G APPROVED tenant alone; cron calls the sweep; resume into a half-made general_ci database → finished, collations joinable, schema at target). Added 2026-10-01 (21st test): provisioning and a resumed provisioning with a tenant app user that has **no server-wide privileges** (USAGE only; before this the app user was `ALL ON *.*` locally and root in CI) — both finish, the user can read only its own tenant database, not the platform database or another tenant's. Red on 7e2b246: 19/19 (the API did not exist); the three proven defects above were shown with a probe on the old code before the fix. `tests/integration/platform-migrations-1g.test.js` (6: target 13, dry-run writes nothing, conflicting type / NOT NULL → skipped + not recorded + unchanged, apply keeps rows + no backfill + re-run no-op, hand-added matching columns). `tests/regression/flow-02-provisioning-check-script.test.js` (8: classification including the multi-organization and seed-data patterns, real run in a child process changes nothing and does not list a legitimate 3-organization tenant, no default DB user/password; the corrected cases fail on the first version of the script). `gymsera_cms/tests/components/provisioning-status.test.tsx` (5), `gymsera_cms/tests/api/admin-approve.test.ts` (1) | be d326909, cms 355b29f; branch `phase-1/prompt-1g-resumable-provisioning` in both repos. Backend 3× 77/77 suites 516/516; CMS 3× 8/8, Playwright 1/1 | no. **Deploy order:** apply p013 (`run-platform-migrations.js --dry-run`, then without) BEFORE this backend goes live and before `run-tenant-migrations.js --dry-run` (every Tenant query, including tenant discovery, reads the new columns). Owner: run `gymsera-flow02-provisioning-check.js` on the live DB first |
| SEC-10 | DONE | `be/src/services/tenant.service.js:94` (accepted arbitrary client-supplied URLs without verification); `storage.service.js` (files placed in public storage / R2 or public disk without access control or encryption at rest); no access logging for document retrieval; no retention policy enforcement (`kycDocumentsJson` retained indefinitely after rejection/deletion) | Decision R-27, R-16 retention policy (90 days), `PlatformAuditLog` (`action: KYC_DOCUMENT_ACCESSED`, `KYC_DOCUMENT_UPLOADED`, `KYC_DOCUMENT_DELETED`, `KYC_DOCUMENTS_PURGED`), log redaction (`src/utils/log-redaction.js`), magic-byte inspection (`file-type` / buffer checks), non-public private storage (`R2_KYC_BUCKET` with SSE-AES256 or non-public `storage/private/kyc/`), read-only check script (`gymsera-sec10-kyc-check.js`) with `SET SESSION TRANSACTION READ ONLY` | Created `kyc-storage.service.js` with magic byte validation and SSE-AES256 encryption at rest; added authenticated streaming endpoint `GET /tenants/:id/kyc-documents/:documentId/stream` requiring `view_tenants` or tenant ownership; records every admin view in `PlatformAuditLog` as `KYC_DOCUMENT_ACCESSED`; CMS admin viewer provides audited preview with visual watermark overlay; Web and Mobile clients support secure KYC upload; created retention sweep `kyc-retention.sweep.js` / CLI runner purging files and clearing `kycDocumentsJson` 90 days after rejection/deletion; created read-only audit script `gymsera-sec10-kyc-check.js` | `gymsera_be/tests/integration/sec-10-kyc-protection.test.js` (9 tests), `gymsera_cms/tests/api/kyc-documents.test.ts` (10 tests), `gymsera_web/tests/api/tenants-kyc.test.ts` (1 test), `gyms_era/test/regression/kyc_documents_upload_test.dart` (3 tests) | be a7969cb, cms ce48011, web 558938c, app 287d81a | no |
| AUTH-07 | DONE (backend, mobile, web privacy copy, CMS display). **Not live until** the owner runs migrations p014–p016 and schedules the sweep (see notes) | Verified again at 608d849 (after 1A–1H), still open: `be/src/services/me.service.js:449-456` only did `user.update({ status: 'INACTIVE' })` and logged; no re-auth (`be/src/controllers/me.controller.js:207-214` took no credential), no tenant handling, no store-subscription check, no undo, no data removal, no Apple revoke, device tokens kept. Worse, `be/src/services/auth.service.js:552` / `:583` / `:759` / `:797` (Google/Apple sign-in) set `status = ACTIVE` on every sign-in, so the "deletion" undid itself; password login answered "suspended" (`:443`). Mobile `settings_screen.dart` posted with no credentials and promised "contacted within 7 days"; the web privacy page (`privacy/page.tsx:191`) promised everything is purged | Platform migration runner + `_widenEnumColumn` / `_addNullableColumn` (p014–p016, like p004–p013); SEC-13 re-auth (`auth.service.js#verifyReauthCredential`, `gyms.controller.js:30-60`); the existing tenant status gate (`tenantContext.js` serves only ACTIVE, `discovery.service.js:23-24` lists only ACTIVE tenants) instead of a second blocking mechanism; `stripe-billing.service.js#cancelAtPeriodEnd`; `PlatformAuditLog`; `notifications.service.js#createNotification`; the KYC retention sweep shape (`kyc-retention.sweep.js` + CLI `--dry-run`); `TenantDbManager.release` + `safeRedisDel` (as `rejectTenant`); the Apple credential pattern (`APPLE_IAP_*` env + key path) and R-25 "fail loudly / never a fallback"; mobile `appleAuthServiceProvider.reauthenticate()` / `googleAuthServiceProvider.reauthenticate()` (delete-branch dialog); the typed-409 mapping of `gyms_repository.dart#_mapLastBranchConflict` | Owner decisions R-28 (and R-16). **Request:** `POST /me/request-deletion` needs a password or a fresh Google/Apple token; `GET /me/deletion-preflight` (a live Apple/Google subscription → 409 `store_subscription_active` with the store link; Stripe is cancelled at period end); the user and every tenant they own go to `PENDING_DELETION` for 30 days (tenant `statusBeforeDeletion` remembered); sessions revoked, device tokens deleted, members notified; idempotent (window not extended). A `dp` token claim limits a pending session to profile / preflight / `POST /me/cancel-deletion` (undo restores user and tenants exactly, refused after the window). Sign-in no longer flips PENDING_DELETION/DELETED to ACTIVE. **Day 30 sweep:** `node src/scripts/run-account-deletion-sweep.js [--dry-run]` anonymizes the user in place, scrubs member health data / notes / payment proof images / contact and bank details, cancels a deleted tenant's memberships, revokes staff, marks the tenant `DELETED`, retries a failed Stripe cancel; one failing account is retried next run. **Kept (R-16):** payments, invoices, ledger, tenant subscriptions, platform invoices, audit logs; **the tenant database is never dropped.** Sign in with Apple token revoke built behind `APPLE_SIGNIN_*` config (skipped and recorded when unset; a failing Apple is retried). The KYC 90-day sweep now counts deleted tenants from `deletedAt`. Mobile: delete flow with preflight, re-confirmation, undo date and a restore gate; web privacy copy rewritten; CMS shows the two statuses | `gymsera_be/tests/integration/platform-migrations-1i.test.js` (10), `tests/regression/auth-07-account-deletion-request.test.js` (28), `auth-07-account-deletion-finalize.test.js` (19, incl. mixed-collation tenant DB and "financial records unchanged"), `auth-07-apple-signin-revoke.test.js` (11), `auth-07-deletion-check-script.test.js` (8); `gymsera_cms/tests/components/deletion-status-badge.test.tsx` (2); `gymsera_web/tests/components/privacy-account-deletion.test.tsx` (3); `gyms_era/test/regression/auth_07_account_deletion_test.dart` (10) | be f2c6598 (p014/p015), 6f3ab27 (request/undo), 3043e1d (sweep), 0ca2b99 (Apple, p016), 462e561 (p016 skips a database with no users table; found by the full suite), 3c75de1 (check script); cms b0ae3f8; web 4b83fbe; app 7705380 | no (full backend suite 3x: 84/84 suites, 625/625 tests each; Flutter 3x 29/29; CMS vitest 3x 12/12 + Playwright 1/1; web vitest 3x 10/10 + Playwright 1/1) |
| NEW-34 | DONE (option (b) + report-only, per R-28 point 6) | `be/src/services/admin.service.js:499` (`rejectableStatuses` includes APPROVED with no check for a live provisioning lease), `:504-510` (set REJECTED only; the tenant's ACTIVE `GymListing` stayed ACTIVE); nothing removed the leftover database | `provisioningSummary(tenant).inProgress` (the FLOW-02 lease check) reused as the guard; `GymListing` status `INACTIVE`; `tenant-provisioning.service.js#getTenantDbConfig` / `createSafeAdminConnection` (R-25) for the manual script; the read-only `gymsera-flow02-provisioning-check.js` stays the finder (`ORPHAN_DATABASE`); `PlatformAuditLog` | `rejectTenant` answers 409 `provisioning_in_progress` while a live lease is held, and marks the tenant's ACTIVE listings INACTIVE (PENDING/REJECTED ones untouched). Orphan databases are only reported; `src/scripts/drop-orphan-tenant-database.js <db> [--apply --confirm <db>]` (dry run by default) drops ONE database and refuses: non-`gymsera_*` or the platform DB, no tenant row, live/under-review tenants, the undo window, a live lease, REJECTED < 90 days, REJECTED with payment/invoice/ledger rows, DELETED < 6 years. Nothing automatic: a test proves `DROP DATABASE` appears in exactly one source file | `gymsera_be/tests/regression/new-34-reject-during-provisioning-and-orphan-databases.test.js` (22) | be 27ed2a5 | no |
| NEW-35 | DONE | `be/src/controllers/gyms.controller.js:37-47` (payout details), `:121-131` (delete branch): both password checks only compared `if (user && user.passwordHash)`, so a Google/Apple-only account passed by sending ANY `password` string; branch deletion also required no credential when `password` was absent (`{}`) | Prompt 1I deletion re-auth pattern (`authService.assertReauth` in `src/services/auth.service.js`) and `verifyReauthCredential` | Replaced ad-hoc password/provider checks in `updateProfile` (bank payout details) and `deleteBranch` with unified `authService.assertReauth(userId, credential)`. Updated `assertReauth` to support `reauthProvider`/`reauthIdToken` as well as `provider`/`idToken`. Social-only accounts cannot pass with any password string; missing credentials throw 401 `reauth_required`; invalid passwords throw 401 `invalid_credentials`; valid fresh Google/Apple tokens or correct local passwords pass | `gymsera_be/tests/regression/new-35-reauth-social-account.test.js` (14) | be 2b4ad6e | no (full backend suite 3x: 86/86 suites, 642/642 tests each) |
| NEW-38 | DONE | `be/src/controllers/host.controller.js:717-733` (`deleteListing`): deleted whole gym organization (and could cascade-delete branches via `strategy: 'deleteBranches'`) with only a session token and no re-auth check | `authService.assertReauth` (Prompt 1I / NEW-35) | Enforced `authService.assertReauth(userId, { password, provider: provider || reauthProvider, idToken: idToken || reauthIdToken })` in `deleteListing`. Exempts freshly created empty orgs (< 5 min old, caller-owned, 0 branches ACTIVE or INACTIVE, no cascade flag) so aborted branch-move rollbacks succeed without credentials. In mobile (`gyms_era`), updated `deleteListing` repo and `showDeleteOrganizationConfirmDialog`, made `new_organization_quick_form_screen.dart` rollback promptless with honest failure message; verified `gymsera_cms` has no organization deletion action | `gymsera_be/tests/regression/new-38-delete-listing-reauth.test.js` (15), `gyms_era/test/regression/delete_organization_dialog_test.dart` (1), `gyms_era/test/regression/new_org_rollback_test.dart` (2) | be 376acf8, app 55037b9 | no (full backend suite 3x: 87/87 suites, 657/657 tests each; Flutter 31/31; CMS 20/20 + build ok) |
| API-01 | DONE (backend, mobile, web, CMS) | Divergent error shapes (`{success:false, message}`, `{message}`, `{error}`), lack of consistent request tracing header `X-Request-Id` across requests, and lack of canonical localized error copy catalog (§4.1, §4.2) | Standard envelope helper (`src/utils/response.utils.js`), `requestId` middleware, error copy catalog table (`src/constants/error-copy.js`), client interceptor decoders | Implemented canonical response envelope `{ success, data, meta: { timestamp, requestId, path } }` and error envelope `{ success: false, error: { code, message, details, requestId } }`; backward compatibility preserved for legacy shapes when no version header/code is specified; auto-generates/echoes `X-Request-Id`; exposed canonical error copy catalog endpoint `GET /api/v1/meta/error-copy`; added Dio client interceptors (`DioClient`) on Flutter and client error resolvers on CMS and Web | `gymsera_be/tests/integration/api-01-response-envelope.test.js` | be bfaf8fb, app 406e690, cms 3dcf23a, web 41b167c | no |
| API-02 | DONE (backend + mobile) | Inconsistent server request timeouts leading to stuck sockets, client network retry storms without backoff or idempotency safety (§4.1). Review fix: slow mobile upload routes (KYC, payment proofs, images, posters, gallery) risked 408 cut-off, and retried requests during background processing could duplicate writes | Express timeout middleware (`src/middleware/timeout.js`), Dio client retry interceptor with exponential backoff on retryable status codes (408, 429, 500, 502, 503, 504) and idempotent HTTP methods | Added 15-second server timeout middleware; upload routes given 120s limit (`isUploadRoute`); provisioning exempt; idempotency middleware preserves IN_PROGRESS record on 408 timeout so client retries receive 409 request_in_progress without duplicate execution; completed handler resolves the record; added Dio client `RetryInterceptor` with exponential backoff and jitter | `gymsera_be/tests/integration/api-01-response-envelope.test.js`, `gymsera_be/tests/regression/rel-timeout-upload-and-idempotency.test.js`, `gyms_era/test/widget_test.dart` | be bfaf8fb, dc394e4; app 406e690 | no |
| REL-02 | DONE (mobile) | Mutating button controls permitted rapid repeated taps during network transit, risking double-submission on mobile (`gymsera_primary_button.dart`) | Throttle/debounce timer pattern, widget busy state management | Implemented built-in debounce timer (default 500ms) on `GymseraPrimaryButton` that disables tap interactions while an action is executing or during rapid re-tap intervals | `gyms_era/test/regression/rel_02_primary_button_debounce_test.dart` | app 406e690 | no |
| REL-03 | DONE (backend) | Scheduled background jobs and sweeps (billing event sweep, subscription expiry cron) executed concurrently across multiple server instances without distributed synchronization | Redis distributed locking (`SET NX PX`) with automatic dedicated MySQL advisory locking fallback (`GET_LOCK`/`RELEASE_LOCK`) (`src/utils/distributed-lock.js`) | Wrapped `cron:subscription-expiry` and `cron:billing-events` sweeps inside `withDistributedLock`; concurrent executions gracefully yield with clean skip logging. Note: `GET_LOCK` uses timeout 0 (non-blocking) so failed locks never block threads or exhaust pools. MySQL `GET_LOCK` fallback has no TTL: a hung (not crashed) cron job keeps the lock until the connection drops or IIS recycles the process. Hotfix: raw mysql2 connection queries require Promise callback wrapping, and Sequelize connectionManager.releaseConnection is synchronous (void); fixed invalid .catch() call and callback query invocation so MySQL lock fallback acquires and releases cleanly without Redis | `gymsera_be/tests/regression/rel-03-04-05-cron-and-shutdown.test.js`, `gymsera_be/tests/regression/rel-03-mysql-distributed-lock.test.js` | be dd52c24, 979dc9c | no |
| REL-04 | DONE (backend) | Nightly billing subscription expiry cron opened database connections and attempted status reconciliation on SUSPENDED and non-ACTIVE tenants, and could mutate tenant status | Tenant status guard (`tenant.status === 'ACTIVE'`), subscription expiration without tenant suspension | Expiry cron skips non-ACTIVE and SUSPENDED tenants; subscription expiry transitions `TenantSubscription` status to `EXPIRED` without mutating tenant status or attempting to decrypt invalid connection strings | `gymsera_be/tests/regression/rel-03-04-05-cron-and-shutdown.test.js` | be dd52c24 | no |
| REL-05 | DONE (backend) | Server process exit lacked graceful socket draining, termination signal handling, and clean database/Redis pool destruction on container restart. Review fix: unhandledRejection previously called shutdown, crashing the entire server on transient errors | Unix signal traps (`SIGTERM`, `SIGINT`), HTTP server `close`, Socket.IO disconnect, Redis/MySQL pool release | Implemented graceful shutdown orchestration in `server.js` and `src/socket/index.js` with 15s in-flight request draining and resource cleanup on SIGTERM/SIGINT. `unhandledRejection` logs to console.error without terminating the process | `gymsera_be/tests/regression/rel-03-04-05-cron-and-shutdown.test.js`, `gymsera_be/tests/regression/rel-unhandled-rejection-and-shutdown.test.js` | be dd52c24, 158b3ed | no |
| BILL-07 | DONE (backend) | No cross-provider purchase intent validation endpoint existed before a host initiated a store purchase, allowing double subscriptions across Apple, Google Play, and Stripe | Pre-purchase intent validation pattern, `billingAccountTokenProvider` check | Added `POST /api/v1/billing/purchase-intent` validating whether caller's tenant already holds an active or grace subscription on another provider; returns `409 cross_provider_blocked` with provider guidance | `gymsera_be/tests/regression/bill-07-09-intent-and-duplicate.test.js` | be 495c827 | no |
| BILL-09 | DONE (backend) | When a superseded store subscription renewed at the store, server warned in console logs but lacked database tracking, host banner notification, and admin visibility | Platform migration runner (`p017`), subscription model attribute, host subscription current endpoint | Added platform migration `p017_tenant_subscriptions_duplicate_billing` adding `duplicate_billing tinyint(1) NULL`; set `duplicateBilling: true` on superseded renewal; exposed warning banner in `GET /api/v1/host/subscription/current`. **Deploy prerequisite:** run `p017` before deploying code to avoid `Unknown column 'duplicate_billing'` on `TenantSubscription` queries | `gymsera_be/tests/regression/bill-07-09-intent-and-duplicate.test.js`, `gymsera_be/tests/integration/platform-migrations-2a.test.js` | be 495c827 | no |
| AUTH-02 | DONE (backend) | No device session management endpoints existed; users could not inspect active logins or revoke other sessions upon password change | `RefreshToken` family metadata, user audit logging, session revocation service | Implemented `POST /api/v1/auth/logout`, `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:sessionId`, and `DELETE /api/v1/auth/sessions` (revoke other sessions) | `gymsera_be/tests/regression/auth-02-08-sessions-and-revocation.test.js` | be bedc13f | no |
| AUTH-03 | DONE (CMS + Web) | In Next.js API client token refresh interceptor (`src/lib/api/client.ts`), failed refresh unhandled promise rejections leaked in subscriber queue | Subscriber queue drain with error rejection pattern | Fixed `onTokenRefreshFailed(err)` to iterate through and reject all queued promises in `refreshSubscribers` before clearing queue and redirecting to login | `gymsera_cms/tests/components/button.test.tsx`, `gymsera_web/tests/components/button.test.tsx` | cms 3dcf23a, web 41b167c | no |
| AUTH-08 | DONE (backend) | Token permission version (`ver` claim) was not checked on authenticated API requests, allowing revoked tokens to continue accessing resources until JWT expiry. Review fix: missing Redis caused 1 DB query per request | Token version validation hook in `src/middleware/authenticate.js`, in-process bounded cache (`user-auth-cache.js`), Redis cached version lookup (`user:auth:<id>`) | Added `ver` claim verification against cached/database `user.permissionVersion`; token with stale version rejected with `403 forbidden`. Added 30s TTL bounded LRU/FIFO in-process cache (5,000 max entries) preventing DB queries when Redis is absent; cleared immediately in same process on permission bump or user deletion/status change (0s delay in-process, ≤30s worst-case across processes) | `gymsera_be/tests/regression/auth-02-08-sessions-and-revocation.test.js`, `gymsera_be/tests/regression/auth-permission-version-cache.test.js` | be bedc13f, 7b21589 | no |
| NEW-37 | DONE (backend) | Immediate token invalidation upon account deletion request (`POST /me/request-deletion`) was bypassable on tenant routes | Permission version increment (`accessService.bumpUserPermissionVersion`), `dp` deletion-pending token claim | On `requestDeletion` and `cancelDeletion`, user permission version is bumped immediately revoking all issued access tokens; new tokens require `dp: true` and are restricted to allowed deletion endpoints | `gymsera_be/tests/regression/auth-02-08-sessions-and-revocation.test.js` | be bedc13f | no |
| SEC-12 | DONE (backend) | `src/middleware/auditLog.js:30-44` wrote `AuditLog` to platform DB, but no `AuditLog` model was registered in `src/models/platform/index.js`, causing production mutating requests to fail with `Cannot read properties of undefined (reading 'create')` and swallow writes | Platform AuditLog model (`src/models/platform/AuditLog.model.js`), platform models index registration, platform migration runner (`p018_create_audit_logs`) | Registered `AuditLog` model mapping to table `audit_logs` on Platform DB with `userId`, `tenantId`, `method`, `path`, `statusCode`, `ipAddress`, `userAgent`, `durationMs`, `createdAt`. Replaced boot-time table creation with versioned platform migration `p018_create_audit_logs` (with dry-run and conflict-skip checks). Updated `auditLog` middleware to persist in production (and test via `AUDIT_LOG_PERSIST=true`), export `_write`, and set `res._auditPromise`. Added new-26 Redis resilience so test passes with `DISABLE_REDIS=true` | `gymsera_be/tests/regression/sec-12-audit-log-persistence.test.js`, `gymsera_be/tests/integration/platform-migrations-p018.test.js`, `gymsera_be/tests/regression/new-26-suspended-tenant-blocking.test.js` | be 83e8cff | no |
| RBAC-09 | DONE (backend) | `be/src/services/gym.service.js:860-865` (`deleteBranch` terminated `GymStaff` only; `RoleAssignmentBranch` junctions and branch-scoped `RoleAssignment`s survived, so restoring or re-assigning preserved obsolete branch grants). Check script `gymsera-rbac09-stale-branch-assignments-check.js:101,171,193,275` failed with `Unknown column 'name' in 'field list'` (used `name` instead of `business_name` on `tenants` and `role_assignment_id` instead of `assignment_id` on `role_assignment_branches`) | `teamService.revokeBranchAssignments` with transaction, `accessService.bumpUserPermissionVersion`, `UserOrgIndex` sync. Check script: query real column names `business_name` and `rab.assignment_id` | In `gym.service.js:deleteBranch`, invoked `teamService.revokeBranchAssignments(tenantDb, branchId, { transaction })` inside the branch deletion transaction; revokes branch-scoped `RoleAssignment`s (`status: 'REVOKED'`), deletes branch junctions (`RoleAssignmentBranch`), bumps `permissionVersion`, and syncs `UserOrgIndex` so deleted branch grants cannot leak after branch deletion. In `gymsera-rbac09-stale-branch-assignments-check.js`, fixed `tenants` query to select `business_name` and `rab` join to use `assignment_id` | `gymsera_be/tests/regression/rbac-09-branch-deletion-cascade.test.js`, `gymsera_be/tests/regression/rbac-09-stale-branch-assignments-check-script.test.js` | be 43851fa, (check fix) | no |
| RBAC-05 | DONE (backend) | `be/src/services/team.service.js:208,627-640`, `be/src/services/gym.service.js:1387-1410` (strictly-below level rule bypassable via `assignStaff` using synthesized `ownerGrants`; staff invite lacked acceptance-time level re-check) | `accessService.canAssignRole` (strictly-below level rule), `accessService.resolve` for real actor grants | Enforced that `gym.service.js:assignStaff` resolves real actor grants via `accessService.resolve` instead of synthesizing `ownerGrants` with level 100; enforced `canAssignRole` in `team.service.js:acceptStaffInvite` at acceptance time so demoted inviter cannot grant elevated role | `gymsera_be/tests/regression/rbac-05-level-rule.test.js` | be 4dfa4c4 | no |
| RBAC-08 | DONE (backend) | `be/src/services/team.service.js:358-470` (`updateAssignment` and `setOverrides` lacked concurrency control / `expectedVersion`, allowing concurrent writes to overwrite permissions silently) | Optimistic concurrency control via `version` column, tenant migration runner (`013_add_role_assignment_version`), 409 Conflict with `code: 'grants_changed'` | Added tenant migration `013_add_role_assignment_version` adding `version INT NOT NULL DEFAULT 1` to `role_assignments` table (safely skipping if table does not exist); updated `RoleAssignment` model; added optimistic concurrency checks with `expectedVersion` in `team.service.js:updateAssignment` and `team.service.js:setOverrides` (increments `version`, returns 409 `grants_changed` on mismatch, backward compatible when `expectedVersion` is omitted); returned `version` in serialized assignments; exposed in `team.controller.js` | `gymsera_be/tests/integration/tenant-migrations-013.test.js`, `gymsera_be/tests/regression/rbac-08-concurrency-version.test.js` | be 5233633 | no |
| RBAC-04 | DONE (backend) | `be/src/services/approval.service.js:161-240` (approval decision did not re-check that requester account still exists, is not suspended/deleted, and is still an active team member; lacked `approvalId` idempotency on execution) | `User` and `Tenant` platform status checks, `RoleAssignment` active membership verification, command execution idempotency via `execCtx.approvalId` | In `approval.service.js:decide`, added re-verification for `APPROVE` decisions ensuring requester `User` exists and is `ACTIVE` (returns 422 if suspended/deleted) and requester holds an `ACTIVE` `RoleAssignment` in tenantDb unless requester is tenant owner; passed `approvalId: request.id` and `idempotencyKey` in `execCtx` for idempotent execution | `gymsera_be/tests/regression/rbac-04-approval-rechecks.test.js` | be 4370db4 | no |
| PAY-08a | DONE (backend) | `be/src/routes/payments.routes.js:103-114` (TEST payment guard allowed `method: 'TEST'` to bypass real payments whenever `PAYMENT_TEST_KEY` matched, even in production); `be/src/services/payment.service.js:128-130,166-169` (`data.method === 'TEST'` auto-completed payments and set `gatewayName: 'TEST_GATEWAY'` unconditionally) | Environment-based execution guard (`NODE_ENV === 'production'`), fail-closed 403 Forbidden | In `payments.routes.js`, rejected `method: 'TEST'` with `403` "TEST payment method is not allowed in production" whenever `NODE_ENV === 'production'`, regardless of `PAYMENT_TEST_KEY`. In `payment.service.js`, restricted `isTest` to `data.method === 'TEST' && process.env.NODE_ENV !== 'production'`, preventing auto-completion, status manipulation, and `TEST_GATEWAY` assignment in production. Added comments to `.env.example` and Swagger docs; verified `.env.example` contains no real-looking keys | `gymsera_be/tests/regression/pay-08a-test-payment-method.test.js` | 1a5060c | no |

**Regression tests for already-fixed defects (mobile doc §9).** Add these if missing:

| Defect | Regression test | Status | Test file(s) | Result / Notes |
|---|---|---|---|---|
| §9.1 `updateBranch` status bypass | `PATCH` branch with `status` → 400 `branch_status_immutable_here`; same value → 200 | DONE | `gymsera_be/tests/regression/branch-status-bypass.test.js` | PASS (400 on status change, 200 on identical) |
| §9.2 purchase-stream matching | Stale transaction for another product does not show success UI | DONE | `gyms_era/test/regression/purchase_stream_matching_test.dart` | PASS (stale transaction ignores foreground success UI; matching flips to success) |
| §9.3 new-org attempt-first | Quota says "none" but a donor slot exists → create succeeds without the upsell | DONE | `gyms_era/test/regression/new_org_attempt_first_test.dart` | PASS (0 remaining branches still attempts create; succeeds without upsell) |
| §9.4 renewal resurrection | Renewal of a superseded row → stays superseded | DONE | `gymsera_be/tests/regression/renewal-resurrection.test.js` | PASS (`reconcileRenewalStatus` refuses to resurrect superseded row to ACTIVE when another ACTIVE exists) |
| §9.5 tenant-wide quota provider | Invalidating once updates every org tab | DONE | `gyms_era/test/regression/tenant_quota_provider_test.dart` | PASS (invalidating `hostBranchQuotaProvider` causes `hostBranchQuotaProviderFamily(orgId)` to re-evaluate) |
| §9.6 `getConnection` side effects | `getConnection` on a cold cache performs zero writes (query spy) | DONE | `gymsera_be/tests/regression/get-connection-side-effects.test.js` | PASS (Zero writes: UPDATE, INSERT, DELETE, ALTER, CREATE, DROP on getConnection) |
| §9.7 tenant list rows | Tenant with 3 ACTIVE orgs → 1 row | DONE | `gymsera_be/tests/regression/tenant-list-rows.test.js` | PASS (Tenant with 3 ACTIVE organizations produces exactly 1 row in `listTenants`) |
| §9.8 delete-button enablement | Typing a password enables the button | DONE | `gyms_era/test/regression/delete_branch_dialog_test.dart` | PASS (Typing password in `_DeleteBranchDialog` triggers setState and enables Delete button) |


#### UX-12 implementation plan (PLANNED, Prompt 1F, 2026-09-30)

Goal (§8.3.7): the CMS `/gym/team` page is the mobile Team & Access screen on a wide layout. It uses the same endpoints, copy and states, so the same person shows the same effective permissions in both. Nothing new on the backend: the `/team` routes and the permission model already exist (RBAC-03 / RBAC-07).

1. **API layer (CMS).** Add `cms/src/lib/api/team.ts` with exactly the calls the mobile repository makes (`gyms_era/.../team_repository.dart`): `GET /team/meta/roles`, `GET /team/meta/permissions`, `GET /team`, `GET /team/:assignmentId`, `POST /team/invites`, `PATCH /team/:assignmentId` (role/scope), `PUT /team/:assignmentId/permissions` (overrides), `DELETE /team/:assignmentId` (revoke), plus `/approvals`, `/approvals/mine`, `/approvals/:id/approve|reject|cancel`. Always send `X-Tenant-Id` (SEC-02 selector). Note: §8.3.3 describes `PATCH /team/:id/grants { changes, expectedVersion }`; the code and mobile use `PUT /team/:assignmentId/permissions`. Follow the code and mobile, and fix §8.3.3 wording when this is built.
2. **Query keys and invalidation (§5.2 / §5.3).** `['team', tenantId]`, `['team', tenantId, assignmentId]`, `['team-meta', tenantId]`, `['approvals', tenantId, tab]`. Invite, role change, permission save and revoke invalidate `team` and the member; approve/reject invalidate `approvals` and the badge.
3. **Page `/gym/team`.** Left: a member table with the mobile role filter chips and live counts, hiding roles with nobody in them (§8.3.2), plus search. Right: a side sheet for the selected member with (a) role and scope, (b) the 3-choice editor Off / Needs approval / Direct, with preset-only tiers (VIEW / APPROVE / FULL) shown as read-only labels such as "Can approve · from Manager role", which saving never changes (RBAC-01), (c) the before/after diff confirmation before saving, (d) "Revoke access" (keeps the record) and "Restore access" (new assignment). Use the mobile role labels and the error-copy table (§4.2). On `409` (someone else saved first), reload the sheet and say so (RBAC-08).
4. **Invite.** Port `add_team_member_screen.dart` as a dialog: phone or email, role (only roles strictly below the inviter's level; the server re-checks), scope (organization or branches). Show the pending-invite state as mobile does.
5. **Approvals.** A `/gym/approvals` page (or a tab on the team page, whichever the mobile drawer placement maps to) with *Waiting on you* / *Your requests*, the server badge count, approve / reject / cancel.
6. **Navigation.** Replace the sidebar "Staff" entry with "Team & access". "Trainers" stays as the bookable-profile screen (R-14) but links a trainer to a team member instead of creating access. Guard the page with `team.view` from the grants the CMS already loads; hide the actions the user lacks (`team.invite`, `team.role.assign`, `team.permission.override`), while the server stays the authority.
7. **Retire the old path (§0.5).** Remove `/gym/staff` and its `gym.ts` staff calls from the CMS. In the backend, answer `410 Gone` on `/gyms/branches/:id/staff` (POST/DELETE) and `/gyms/staff` (POST/DELETE) one release after the CMS ships, unless the mobile app still calls them (check `gyms_era` first; §3.3 notes the old `/host/admins` and `/host/profile/staff` routes still exist in the app router).
8. **Tests.** Vitest component tests for the sheet (preset labels read-only, diff shows only changed rows, 409 reload) and the chips (counts, empty roles hidden). A Playwright flow: invite → edit a permission → revoke. The §8.3.7 acceptance check as an API-level test: for one person, `GET /team/:id` gives the same effective tiers the app shows.
9. **Size and order.** About 1 prompt of CMS work (Phase 3, with RBAC-01/02/04/05/06/08/09). Backend changes are limited to the step 7 retirement. Screen states (loading / empty / error / forbidden) follow §2.5.

---

## 14. Remaining risks and open decisions

> **Decisions recorded 2026-09-26.** The owner delegated these to the architect (Claude Code) and they are now **final for agents**. Agents apply them and do **not** stop to ask about them again. The owner may override any row at any time by editing it.

| # | Risk / decision | Owner | **DECIDED** |
|---|---|---|---|
| R-1 | IAP vs web-first sales channel per region (BILL-16) | Product | **Keep IAP in the apps.** The web sells nothing by card for now (see R-7). |
| R-2 | Member-grace length when a branch locks (CAP-01, §7.5.8) | Product | **DECIDED 2026-09-28: 7 days.** A gym's own members can still check in for 7 days after the branch locks. Config value `MEMBER_CHECKIN_GRACE_DAYS=7`. The owner approved the spec default. |
| R-3 | Over-quota grace before locking | Product | **DECIDED 2026-09-28: 7 days, shown to the host as a countdown banner.** Config value `OVERQUOTA_GRACE_DAYS=7`. The owner approved the spec default. |
| R-4 | Card at registration: setup mode vs charge + refund on rejection (FLOW-03) | Product + Finance | **DECIDED 2026-09-28: Setup mode: save the card and charge only when the application is approved** (not charge immediately and refund on rejection). No charge before approval, so nothing to refund. The owner approved the spec default. Web card payments are still OFF (R-7), so this takes effect only once they are turned on. |
| R-5 | Auto-approve additional organizations (FLOW-11) | Product + Trust | **Manual review stays.** |
| R-6 | Legacy `PlatformPackage` subscribers' migration timing (BILL-10) | Finance | **At their next renewal.** |
| R-7 | Stripe availability for the legal entity's country; merchant-of-record alternative (BILL-17) | Founder/Finance | **Stripe is not available for Pakistan-based companies** (the code is PKR / `Asia/Karachi` / CNIC / JazzCash). **Web card payments stay OFF.** Web signup offers bank transfer and pay-later only; plans are bought in the app (App Store / Play). Keep the Stripe code behind a feature flag `WEB_CARD_PAYMENTS_ENABLED=false`; don't delete it. A later web provider (a merchant of record such as Paddle, or a local gateway) plugs in behind the same catalog and provider abstraction. The owner confirms the entity's country. |
| R-8 | `TenantDbManager` at thousands of tenants: pool-per-server redesign (PERF-07) | Engineering | **Caps + LRU now**; revisit at 500 active tenants. |
| R-9 | Play upgrade/downgrade eligibility not verified on a production Play Console (documented open item) | Engineering | **Must pass the staging checklist before launch** (owner tests on a real device). |
| R-10 | Offline check-in queue (§11.4) | Product | **Not built; online only.** |
| R-11 | Data residency requirements in some countries (e.g. EU customers) | Legal | **Single region**; documented in the privacy policy. |
| R-12 | Everything in this document derives from docs and screen maps; the code may differ | Agent | Verify-first rule (§0.1). |
| R-13 | Mobile navigation refinements proposed in §2.3.1 and on the UI canvas (drawer → More hub, label renames, front-desk shell) | Owner | **Keep mobile as it is.** UX-03, UX-05, UX-16 and the mobile part of UX-04 are `DEFERRED (R-13)`. |
| R-14 | Web-only features with no mobile equivalent (CMS Trainers, web Account statement) and mobile-only traveler features on the web (checkout, wishlist) | Owner | **Keep as they are; no new work.** UX-25 is `DEFERRED (R-14)`. |
| R-15 | **Boost** (BILL-18). Code check: `gyms_era/lib/features/host/presentation/screens/boost_listing_screen.dart` shows Rs 1,500 / 4,500 / 8,000 tiers, and "Pay & Activate Boost" shows a success dialog **without charging anything**; the backend has no Boost code. | Product | **Boost is a paid product, but it is not built.** In hardening: replace the fake "Pay & Activate" with a disabled **"Coming soon"** state (a fake success screen is a store-review and trust risk). Building it later is a new feature: an IAP product in the one catalog, the same `/sync` + webhook pipeline (BILL-18 fix). Log it as NEW-BOOST in §12.13. |
| R-16 | Retention periods for account/tenant deletion (AUTH-07, FLOW-01, SEC-10) | Legal | **30-day undo window** after a deletion request. **Financial records** (payments, invoices, ledger, platform invoices) kept **6 years, anonymized** (Pakistan tax record rule; owner confirms with the accountant). **KYC files** deleted 90 days after rejection or tenant deletion. **Abandoned DRAFT applications** purged after 30 days. **Application logs** kept 90 days. |
| R-17 | Web-registration payment choices while R-7 is OFF | Product | Options shown: **Bank transfer** and **Pay later**. Pay-later grace (BILL-13, §7.5.11) = **14 days**, config value `PAY_LATER_GRACE_DAYS=14`. |
| R-18 | CMS Inbox (UX-23) | Product | **Out of scope.** Build the notifications bell + feed only. |
| R-19 | Database environment (owner statement, 2026-09-26) | Owner | The "production" database holds **test data only**, so agents may connect to it to investigate and to apply migrations. **Automated test suites still run only against a local/Docker MySQL**, because the harness creates and drops databases and would break the live apps the owner tests on. Real store/Stripe keys stay out of the code: sandbox only. |
| R-20 | Upgrade production MySQL 5.7 → 8.0/8.4 (5.7 is end-of-life; requested in Step 2.10 under R-15) | Infrastructure / Engineering | **Four-step upgrade plan**: 1. **Full backup**: Complete `mysqldump` (`--single-transaction --quick --routines --triggers --events`) of platform DB and all tenant databases. 2. **Restore test**: Restore into a staging / local MySQL 8.0/8.4 instance, run `mysqlcheck --check-upgrade`, verify collation compatibility (`utf8mb4_unicode_ci`), run full backend integration test suite. 3. **Maintenance window**: Announce scheduled downtime, stop API services (`docker compose down` / service pause) to guarantee zero in-flight writes, perform fresh final snapshot. 4. **Switchover & Verification**: Execute MySQL engine upgrade/container replacement, run startup schema verification check, run `run-tenant-migrations.js --dry-run` then execute, run smoke tests across endpoints, restart API services, verify monitoring. |
| R-21 | Should `GET /host/subscription/current` create a plan at all? (raised by NEW-15, 2026-09-28) | Owner | **DECIDED 2026-09-28: `GET /host/subscription/current` is read-only. It never creates a plan. The owner approved this.** The first plan comes only from onboarding (submission / approval, later the BILL-13 pay-later GRACE row). Implemented in §13 row NEW-15 / R-21. |
| R-22 | Pay-later grace period: days a host has to pay after approval before branches become non-entitling (BILL-13, §7.5.11; same value as R-17) | Owner | **DECIDED 2026-09-28: 14 days.** Config value `PAY_LATER_GRACE_DAYS=14`.<br>owner confirmed: yes (2026-09-29)<br>R-22 and R-17 are the same value, held in one setting (`PAY_LATER_GRACE_DAYS`). There is no second copy. |
| R-23 | Renewal webhooks for suspended tenants (NEW-26, Point 3) | Owner | **DECIDED 2026-09-29: Record what the provider reports on TenantSubscription for audit and billing history, but do not grant entitlement or unlock any branches/capacity while the tenant is SUSPENDED.** The webhook records the provider's transaction, dates, and amounts in `tenant_subscriptions` and logs the event, but skips capacity reconciliation, leaves branch locks intact, and does not alter the tenant's SUSPENDED status. |
| R-24 | Prompt 1F scope (raised 2026-09-30: the prompt was much bigger than described) | Owner | **DECIDED 2026-09-30: split.** Prompt 1F does SEC-03, SEC-07, SEC-09, RT-04 and the UX-12 plan. FLOW-02, SEC-10 and AUTH-07 each become their own prompt (1G, 1H, 1I in the playbook) and are verified again before work starts. |
| R-25 | Hard-coded DB credential fallback in tenant provisioning (`tenant-provisioning.service.js`: platform credentials, then `root` with an empty password) | Owner | **DECIDED 2026-09-30: remove it and fail loudly.** Provisioning uses only `TENANT_DB_ADMIN_USER` / `TENANT_DB_ADMIN_PASS` and stops with a clear error when they are missing or rejected (same approach as SEC-DB-FALLBACK). Done in Prompt 1F as its own commit, separate from FLOW-02. **Extended 2026-09-30 (owner approved):** the seed script `src/scripts/provision-seeded-tenants.js` follows the same rule (see §13 "R-25 (seed script)"). |
| R-26 | Google RTDN authentication cutover (SEC-03) | Owner | **DECIDED 2026-09-30: OIDC only.** The static `?token=` check is removed. RTDN is accepted only with a valid Google-signed OIDC token for the configured audience and service account. Deploy note: update the Pub/Sub push subscription (authentication on, same audience and service account) **before** this backend goes live. Otherwise RTDNs get 401 and Pub/Sub retries them for up to 7 days, and the daily sync keeps running. |
| R-27 | Private KYC storage and document protection (SEC-10) | Owner | **DECIDED 2026-10-01:** (1) Dedicated private bucket name `R2_KYC_BUCKET` reusing primary R2 credentials with S3 Server-Side Encryption (`AES256`). When R2 is not configured or in local dev/testing (`STORAGE_DRIVER=local`), fall back to a non-public local directory `storage/private/kyc/` outside public web roots (`public/uploads`). (2) Access to KYC documents is strictly gated by authenticated API endpoints (only the owning host and authorized platform admins) generating short-lived signed URLs (or authenticated streaming proxy if local storage). Every access is recorded in `PlatformAuditLog` (`action: KYC_DOCUMENT_ACCESSED`). (3) Admin views in CMS display an un-copyable visual watermark overlay (viewing admin email, IP/timestamp, "CONFIDENTIAL - AUDITED ACCESS"). (4) 90-day retention cron sweep automatically deletes KYC files from storage 90 days after tenant rejection or deletion, clearing `kycDocumentsJson` and logging `KYC_DOCUMENTS_PURGED` to `PlatformAuditLog`. (5) Full-stack implementation across backend, CMS admin viewer, web onboarding upload, and mobile host onboarding KYC upload. |
| R-28 | Account and tenant deletion (AUTH-07, Prompt 1I) and orphan databases (NEW-34) | Owner | **DECIDED 2026-10-02 (owner answered through the question tool):** (1) **Timeline.** A confirmed request (after re-authentication) takes effect at once: the user and every tenant they own go to `PENDING_DELETION` (all tenant/member access stops through the existing tenant status gate, the listing leaves discovery, sessions and device tokens are removed, members are notified). The **30-day undo window** (R-16) applies to host accounts **and** member-only accounts. At day 30 a sweep finishes the deletion (dry-run first, then apply). (2) **Financial records:** payments, invoices, ledger, platform invoices and tenant subscriptions are **kept 6 years, anonymized in place**. They only ever pointed at people by user id, so scrubbing the `users` row and the free-text fields anonymizes them. **The tenant database is NOT dropped and no automatic DROP exists.** A deleted tenant keeps its database, flagged `DELETED`; dropping it after year 6 is a manual owner step. (3) **Members of a deleted tenant:** told at request time; their active memberships are cancelled at day 30 (no automatic refunds); their own platform accounts are untouched; their receipts/history stay readable with the gym's business name kept; staff access is blocked at once by the tenant status and the assignments are revoked at day 30. (4) **Preflight:** a live Apple or Google subscription **blocks** deletion (409 with the store link, because only the user can cancel it); Stripe subscriptions are cancelled automatically at period end. Re-auth = current password, or a fresh Google/Apple token for social accounts (same check as SEC-13). (5) **Apple Sign-In revoke:** built behind configuration, no secrets in code (R-25 pattern). With no Apple key configured, deletion still completes and records `skipped`. The owner supplies the key later. (6) **NEW-34:** `rejectTenant` answers 409 while a live provisioning lease is held and marks the tenant's listing `INACTIVE`. Orphan databases are **reported only** (read-only listing); dropping one is a manual, explicit, per-database script run (`--drop <tenantCode> --confirm <dbName>`), never automatic. (7) **Scope:** backend, mobile delete-account flow and web privacy copy; the CMS only displays the new statuses. |

**Rejected alternative (recorded so it isn't reopened by accident):** replacing `reservedSlots` with purely derived capacity (`available = entitled − activeBranches`). This would remove the slot-donor mechanism and ledger drift, but the capacity architecture is **locked**. All capacity defects are fixed inside the locked model (CAP-01…08). Revisit only if CAP-07 or OBS-06 shows recurring drift that the outbox cannot eliminate.

---

## 15. Testing matrix

**Tooling:**
- Backend: Jest + Supertest, plus a real MySQL via Testcontainers (platform DB + 2 tenant DBs).
- Flutter: `flutter_test` (unit/widget), golden tests, `integration_test`, `patrol` for native dialogs.
- Web: Vitest/Jest + React Testing Library; Playwright for E2E; axe for accessibility; Lighthouse CI.
- Billing: StoreKit Testing in Xcode + App Store sandbox; Google Play license testers and test cards; Stripe test mode + **test clocks**.

| Layer | What | Must cover | Gate |
|---|---|---|---|
| **Unit (backend)** | Services with fakes | Capacity math, state machines (subscription, membership, approval), money arithmetic, tier/level rules, error mapping | ≥ 90% line coverage on `services/billing`, `services/capacity`, `services/payments`, `approval.service.js` |
| **Integration (backend + real MySQL)** | Services + both DBs | Transactions, outbox, idempotency middleware, `reconcileCapacity`, `auditCapacity`, provisioning resume | Every P0 issue has ≥ 1 test |
| **API contract** | Every route | Envelope, error codes, validation (unknown fields rejected), pagination, ETag | Generated from the route list; 100% of routes |
| **Cross-client parity** | Same flow driven from the mobile integration test and the CMS/web E2E | Same endpoint, same request shape, same resulting data; the same person's effective permissions identical in app and CMS | Every ✅ row in §3.3 has one parity test |
| **Permission matrix** | Every mutating route × persona (Owner, Org admin, Manager, Front desk, Trainer, Cleaner, Member, Other-tenant owner, Admin sub-roles, Anonymous) | Allowed → 2xx, not allowed → 403/404, cross-tenant → 404 | 100% of mutating routes; fails CI on any unexpected 2xx |
| **Database** | Migrations | Up/down on an empty DB and on a prod-like snapshot; tenant migration runner resume; index presence | Runs on every PR touching models |
| **Concurrency** | Parallel requests | 20× `createBranch` at capacity; delete+restore race; donor-slot race; 50× invoice numbering; double refund; double approve; double webhook | Deterministic assertions |
| **Idempotency** | Replays | Same key → same response; different body → 422; in-flight → 409; app restart with persisted key | All mutations in the REL-01 list |
| **Billing** | Fixtures per provider notification type + sandbox runs | Purchase, restore (same/other tenant), renewal, price increase, upgrade, deferred downgrade, cancel, grace, hold, pause, expiry, refund/revoke, cross-provider, duplicate billing, out-of-order events, pending purchase, server-side ack | Fixture suite in CI; the sandbox checklist is manual per release |
| **Capacity property test** | Random operation sequences | Invariant holds; no empty ACTIVE org; ledger replay equals the stored slots | 1,000 random sequences per CI run |
| **Flutter unit/widget** | Notifiers + screens | §2.5 states for each screen; busy states; PermissionGate per persona; billing notifier (pending, stale transaction, success match); provider invalidation matrix §5.3 | Every screen with data has state tests |
| **Flutter golden** | Key screens | Light/dark, 200% text, `ar` RTL, 320-px width | Goldens reviewed on change |
| **Flutter integration** | On emulator/simulator | Login → bootstrap → create branch → 403 → upsell (fake store) → replay; create org → Listings visible (FLOW-05); logout clears everything | Nightly |
| **Web component** | CMS/web | States, forms, `PermissionGate`, org switcher | PR |
| **E2E (Playwright)** | Web flows | Host registration (bank / later / card with Stripe test mode); admin approve (with a provisioning-failure injection); host CMS enroll + record payment + close day; member portal views only own data | Nightly + pre-release |
| **Realtime** | Socket server + client | Auth on connect, room authorization, token refresh, reconnect replay, no duplicate delivery, listener cleanup | PR |
| **Notifications** | FCM (emulated) + device tests | Register, refresh, logout removal, tap routing with context switch, foreground banner | Pre-release on real devices |
| **Failure recovery** | Fault injection | Kill between tenant commit and platform effect; webhook processor crash; provisioning crash; client timeout mid-payment | Each recovery path in §11.3 |
| **Performance** | k6 / Lighthouse CI / Flutter traces | §10.1 budgets; 1,000-tenant pool soak; discovery 200 RPS | Pre-release; budgets fail CI when exceeded |
| **Security** | SAST, dependency audit, secret scan, DAST (OWASP ZAP) on staging, manual IDOR review | SEC-* | No high/critical findings open at release |
| **Accessibility** | axe (web), Flutter semantics tests, manual screen reader pass (TalkBack/VoiceOver) | §2.11 | No critical violations |
| **Redis independence** | Full backend test suite with `DISABLE_REDIS=true` | All tests pass with Redis disabled; distributed lock MySQL fallbacks and in-process auth caching operate cleanly without Redis | 100% test pass rate with Redis off |

---

## 16. Production deployment checklist

### Infrastructure
- [ ] Separate staging and production: databases, buckets, keys, store apps (Apple/Google test tracks), Stripe accounts.
- [ ] MySQL: automated backups for the platform DB **and every tenant DB**, with point-in-time recovery; a **restore drill** performed and timed.
- [ ] `max_connections` sized for the pool caps (PERF-07); a read replica for reports.
- [ ] Redis (rate limits, caches, Socket.IO adapter, job locks).
- [ ] Object storage + CDN with image variants; private bucket for KYC.
- [ ] TLS everywhere; HSTS; security headers (SEC-18).
- [ ] Secrets in a secret manager / KMS; the key for `connectionStringEncrypted` has a documented rotation procedure.

### Backend
- [ ] All migrations applied; the tenant migration runner reports 100% of tenants at the target `schemaVersion`.
- [ ] Cron and sweeps running with distributed locks (REL-03): billing reconciliation, voided purchases, outbox, BillingEvent retry, capacity audit, membership expiry, ledger reminders, DRAFT purge.
- [ ] Webhook endpoints registered and signature-verified:
  - [ ] Apple App Store Server Notifications V2 (production + sandbox URLs)
  - [ ] Google RTDN Pub/Sub push
  - [ ] Stripe
- [ ] Rate limits on.
- [ ] Graceful shutdown configured (REL-05).
- [ ] `GET /health` (liveness) and `/ready` (DB, Redis) wired to the load balancer.

### Billing
- [ ] `BillingPlan` tiers mapped to live iOS product IDs, Android product + base plan IDs, and Stripe price IDs per currency; the verifier (BILL-15) shows no mismatch.
- [ ] Subscription groups (Apple) and base plans (Google) ordered so that upgrade/downgrade semantics are correct.
- [ ] Sandbox checklist passed on real devices for every flow in §7.5 (including R-9).
- [ ] Refund policy page matches the actual behaviour.

### Before launch: real store sandbox test
These cannot be proven with the fakes in the test suite (Prompt 1B). Each needs a real sandbox purchase on a
device, and the result recorded in §13:
- [ ] **Apple downgrade timing:** an in-group downgrade keeps the current product until renewal; the server shows it
  only as `pendingChange` (from `renewalInfo.autoRenewProductId`) and switches `branchCount` at the renewal (BILL-03).
- [ ] **Google deferred replacement token timing:** with `ReplacementMode.deferred`, when Play issues the new purchase
  token (at purchase or at renewal), what `startTime` it carries, and that the old plan stays until the switch (BILL-03).
- [ ] **Play `recurringPrice` vs the charged amount:** after a sandbox price change, the stored `amount`/`currency` match
  the order Google actually charged (BILL-05).
- [ ] **Google pending → completed sequence:** a "slow test card" purchase shows "Payment pending", grants nothing, and
  the plan appears only after Google's completion notification (BILL-08).

### Clients
- [ ] Flutter release builds with obfuscation + symbol upload; `minAppVersion` enforcement in bootstrap (force-update screen).
- [ ] Universal Links / App Links verified (`apple-app-site-association`, `assetlinks.json`).
- [ ] Push: APNs key uploaded to FCM; Android notification channels defined.
- [ ] Web: ISR revalidation tags wired; Lighthouse CI budgets green; CSP enforced (report-only first, then enforce).
- [ ] Store listings: privacy nutrition labels / Data Safety form match the actual data use; account-deletion path is discoverable (AUTH-07).

### Observability and operations
- [ ] Dashboards: API, DB, pools, billing, capacity, realtime, FCM.
- [ ] Alerts with runbooks (OBS-09); on-call rota defined.
- [ ] Error tracking receiving events from all 4 apps with release tags.
- [ ] Log redaction verified on production-like traffic (SEC-07).

### Release process
- [ ] **Deploy prerequisite (BILL-09 / p017):** Execute platform migration `p017_tenant_subscriptions_duplicate_billing` (`node src/scripts/run-platform-migrations.js`) on the database BEFORE deploying code. `TenantSubscription.model.js` declares `duplicate_billing`; without the column, queries against `TenantSubscription` will fail with `Unknown column 'duplicate_billing' in 'field list'`.
- [ ] **Distributed lock safety (REL-03):** MySQL `GET_LOCK(key, 0)` fallback in `src/utils/distributed-lock.js` operates with timeout 0 (non-blocking). When Redis is unavailable, concurrent background jobs fail fast instead of blocking MySQL connection pool threads indefinitely. Note: MySQL `GET_LOCK` fallback has no TTL: a hung (not crashed) cron job keeps the lock until the connection drops or IIS recycles the process.
- [ ] Feature flags for risky changes (CAP-01 locking, BILL-10 catalog freeze, BILL-03 deferred downgrade), so they can be turned off without a deploy.
- [ ] Staged rollout: Play staged %, App Store phased release; web canary.
- [ ] Rollback plan per system: previous container image, previous app build still compatible with the API (API changes are additive only).
- [ ] Data migrations reversible (expand/contract).

### Before adding real data
Both items are deferred (recorded 2026-09-28): production holds test data only (R-19), and the owner plans a
full database wipe before real customers go live. Do them at that point, not before.
- [ ] Check whether the seeded platform-admin accounts (`src/seeders/seed.js`) exist in the production database.
  If they do, delete them or change their passwords before any real gym signs up.
- [ ] Confirm the `noreply@gymsera.com` mailbox password has been changed (it was committed to git history on
  2026-08-31), and that git history is eventually cleaned or repo access is reviewed.

---

## 17. Final production-readiness criteria

GymsEra is production-ready **only when every item below is true and backed by evidence**: a test run link, a staging verification record, or a dashboard. Reading the code is not evidence.

1. **Zero open P0 issues** in §12. Each has status `DONE` (with a test) or `NOT REPRODUCED` (with file/line proof) in §13.
2. **All P1 issues** are `DONE` or explicitly `DEFERRED` with an owner and date in §14.
3. **Permission matrix suite** is green: no mutating endpoint returns 2xx for a persona that shouldn't have access, and there is no cross-tenant access.
4. **Billing sandbox checklist** passed on real iOS and Android devices and in Stripe test mode, for every flow in §7.5, within the last 14 days before release.
5. **Capacity:**
   - The property test is green.
   - `auditCapacity` across all staging tenants shows **zero drift** and **zero empty ACTIVE organizations**.
   - The concurrency tests are green.
6. **Money:**
   - Idempotency, ledger immutability, daily close, refund, and invoice-sequence tests are green.
   - Staging reconciliation (sum of payments = sum of ledger per day per branch) is exact.
7. **Recovery:** every §11.3 scenario was fault-injected in staging and recovered without manual database edits.
8. **Performance budgets** (§10.1) met on the reference device/network and in load tests.
9. **Security:**
   - No high or critical findings open from SAST, dependency audit, secret scan, and DAST.
   - Webhook signature tests green.
   - Log redaction verified.
10. **Global:**
    - The app works in at least one RTL locale and one non-PKR currency end to end.
    - Timezone tests pass across a DST boundary.
11. **Accessibility:** no critical axe violations; a screen reader pass completed on the host core flow (login → Today → check-in → record payment).
12. **Operations:**
    - Dashboards and alerts are live.
    - The restore drill was completed.
    - Runbooks exist for billing, capacity drift, provisioning failure, and webhook backlog.

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| Tenant | One host account: one owner, one GymsEra entitlement |
| Organization | A brand a tenant runs (`GymListing`); free, never empty |
| Branch | A physical location; consumes capacity |
| `maxBranches` | Branches the current entitlement covers |
| `reservedSlots` | Paid but unbuilt capacity parked on an organization |
| Entitlement | What the tenant may use right now, from the one ACTIVE/GRACE `TenantSubscription` row |
| `billingLock` | Branch restricted because the plan no longer covers it; not a lifecycle status |
| Membership | A member's purchase of a branch's membership plan (`MemberSubscription`) |
| Tier | Permission level per module: NONE/VIEW/REQUEST/APPROVE/DIRECT/FULL |
| Outbox | Tenant-DB table that makes platform-DB side effects durable |
| BillingEvent | Inbox row per provider webhook/notification |

## Appendix B — Agent quick-start

0. Read `AGENT_HANDOFF.md` (next to this file). If a task is in progress, continue it from its "Next action" instead of starting something new.
1. Read §0 (especially §0.5: mobile is the reference), §3.3 (parity matrix), §8.3 (Team & Access), then §12.1–§12.2 (the P0 money issues).
2. For each P0: locate the code → confirm or refute → write the failing test → fix using the listed reuse → test green → log it in §13.
3. After Phase 1, re-run the whole §15 suite and update §14.
4. Never mark §17 criteria as met without a linked test run or staging record.

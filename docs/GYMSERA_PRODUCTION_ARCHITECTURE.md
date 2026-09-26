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
| PAY-04 | PARTIAL | Business date in branch timezone (`ledger.service.js:36-64`); close is race-safe and one-shot (`:316-366`) | Step 2.7: Payment `business_date` is set once from collection time and made strictly immutable via model hooks (`Payment.model.js`). `verifyPayment`, `markPrinted`, `uploadPaymentProof`, and `markPaymentFailed` never shift `business_date`. Updates attempting to mutate `business_date` are rejected. Migration 006 enforces `business_date DATE NOT NULL` conditionally. Note: `addAdjustment` refusal on CLOSED day remains for Phase 1. |
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
| _example_ CAP-02 | DONE | `branch.service.js:212` platform credit after tenant commit | `CapacityEvent.idempotencyKey` | Tenant `Outbox` row in step-5 transaction + processor | `capacity.outbox.test.js` | #123 | yes, 2026-10-02 |

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


---

## 14. Remaining risks and open decisions

> **Decisions recorded 2026-09-26.** The owner delegated these to the architect (Claude Code) and they are now **final for agents**. Agents apply them and do **not** stop to ask about them again. The owner may override any row at any time by editing it.

| # | Risk / decision | Owner | **DECIDED** |
|---|---|---|---|
| R-1 | IAP vs web-first sales channel per region (BILL-16) | Product | **Keep IAP in the apps.** The web sells nothing by card for now (see R-7). |
| R-2 | Member-grace length when a branch locks (CAP-01, §7.5.8) | Product | **7 days**, config value `MEMBER_CHECKIN_GRACE_DAYS=7`. |
| R-3 | Over-quota grace before locking | Product | **7 days, with a countdown banner**, config value `OVERQUOTA_GRACE_DAYS=7`. |
| R-4 | Card at registration: setup mode vs charge + refund on rejection (FLOW-03) | Product + Finance | **Setup mode: save the card and charge only on approval.** No charge before approval, so nothing to refund. Applies only once a web card provider is live (R-7). |
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
- [ ] Feature flags for risky changes (CAP-01 locking, BILL-10 catalog freeze, BILL-03 deferred downgrade), so they can be turned off without a deploy.
- [ ] Staged rollout: Play staged %, App Store phased release; web canary.
- [ ] Rollback plan per system: previous container image, previous app build still compatible with the API (API changes are additive only).
- [ ] Data migrations reversible (expand/contract).

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

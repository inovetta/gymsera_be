# GymsEra Platform Architecture — Backend, CMS, and Website

**Companion to `gyms_era/docs/MOBILE_APP_ARCHITECTURE.md`.** That document covers the
mobile app's navigation and the billing/capacity system in full detail — this one
covers the three systems around it: the shared backend API (`gymsera_be`), the
admin/host web portal (`gymsera_cms`), and the public website (`gymsera_web`). Read
the mobile doc first for the capacity/subscription model; it isn't repeated here.

**Audience:** a technical reader — a senior engineer or another AI coding agent —
who needs the real, current design.

---

## 1. The four systems, one sentence each

| System | What it is | Who uses it |
|---|---|---|
| **`gyms_era`** | Flutter mobile app | Gym hosts (day-to-day operations, billing) |
| **`gymsera_be`** | Node/Express API | Every other system talks to this; nothing talks to a database directly |
| **`gymsera_cms`** | Next.js admin/host web portal | Platform Admins **and** Gym Hosts/Branch Managers (same app, different nav) |
| **`gymsera_web`** | Next.js public website | Anonymous visitors, prospective hosts signing up, and gym **members** managing their own membership |

One backend, one set of business rules, four different doors into it. **No system
ever re-implements a decision the backend already makes** — a screen shows what the
API returns and calls what the API exposes; it does not independently decide
capacity, permissions, or pricing.

---

## 2. `gymsera_be` — the backend

### 2.1 Two databases, on purpose

```
Platform DB (one database, shared)
  Tenant, User, GymListing, TenantSubscription, BillingPlan,
  CapacityEvent, PlatformPackage, PlatformInvoice, City, Area, ...

Tenant DB (one MySQL database PER TENANT — gymsera_{tenantCode})
  Branch, Gym, MembershipPlan, MemberSubscription, GymStaff,
  Payment, Invoice, LedgerDay, RoleAssignment, ApprovalRequest, ...
```

**Why:** a tenant's operational data (members, payments, attendance) never touches
any other tenant's database, at the infrastructure level — not just an application
filter. Cross-tenant data leakage is architecturally impossible, not just
guarded-against. The cost: almost every service that needs both platform-level facts
(subscription, capacity) and tenant-level facts (real branches, real members) has to
explicitly connect to both, which is why `tenantDb` shows up as an explicit parameter
through so much of the codebase rather than being ambient.

`TenantDbManager` is the connection pool for the tenant-DB side — one live
connection per tenant, cached in-memory for the life of the process, created lazily
on first `getConnection(tenantId, encryptedConnStr)` call. (This pool's own
first-connection migration step was the source of a serious, now-fixed bug — see the
mobile doc's §9.6.)

### 2.2 Two authorization layers

**Layer 1 — coarse role**, `authorize('GYM_HOST', 'BRANCH_MANAGER')`: a JWT claim
(`PLATFORM_ADMIN` / `GYM_HOST` / `BRANCH_MANAGER` / `TRAINER` / `MEMBER`), checked by
route. Simple, and most routes only need this.

**Layer 2 — fine-grained permission catalogue**, `can('members.create', {branch: ...})`:
for anything that needs to answer *"can this specific person do this specific thing
to this specific branch, and if not directly, should it become an approval
request?"* Built on:

- **`RoleAssignment`** — an org- or branch-scoped role a person holds, independent of
  their coarse `UserRole`. A traveler hired as a trainer doesn't lose their MEMBER
  account; they just also hold a `TRAINER` `RoleAssignment` on one branch.
- **Role levels** (`OWNER` 100 → `ORG_ADMIN` 80 → `MANAGER` 60 → `BR_ADMIN` 40 →
  `DESK`/`TRAINER` 20 → `SUPPORT` 5) — a person may only assign a role *strictly
  below* their own level, enforced server-side, never just hidden in the UI.
- **The permission catalogue** (`constants/permissions.js`) — modules `dashboard`,
  `members`, `checkins`, `announcements`, `schedule`, `expenses`, `subscriptions`,
  `payments`, `invoices`, `plans`, `governance`, `ledger`. Each role × module cell is
  a tier: `NONE` / `VIEW` / `REQUEST` / `APPROVE` / `DIRECT` / `FULL`.
- **The approval engine** (`approval.service.js`) — one generalized
  request/decide/execute pipeline. A controller calls
  `approvalService.perform(ctx, 'members.create', payload)` and never writes the
  approval logic itself; the engine decides from the caller's grants alone whether
  to execute immediately or queue an `ApprovalRequest` for someone with `APPROVE`
  tier to decide on. The same shape — front-desk collects a cash payment, host
  verifies, membership activates — covers member creation, expenses, refunds,
  discounts, and invoice voids identically.

**This is the "Team & Access" feature** in the CMS/app — a host inviting a Branch
Manager, a Front Desk person, a Trainer, each with a real, enforced, server-side
ceiling on what they can do and what needs sign-off first.

### 2.3 Route domains

```
/auth              Login, OTP, Google/Apple social login, refresh, password reset
/tenants            Host onboarding: register → verify → business → gym profile →
                    package → payment → finalize (mirrors gymsera_web's own
                    onboarding wizard, which calls these same endpoints)
/admin              Everything Platform Admin does — see §2.5
/admin/billing-plans  The branch-count catalog CRUD (Super Admin only)
/billing            Store-verified purchase sync (iOS/Android/Stripe), webhooks,
                    the public plan catalog (GET /billing/plans)
/gyms               Legacy/general gym & branch CRUD
/discovery          Public gym search/browse (feeds gymsera_web's /gyms pages)
/host               THE host-facing surface — branches, organizations, branch
                    quota, subscription, staff, everything gyms_era's Host Mode
                    and gymsera_cms's "Gym Management" section call
/membership-plans   What a branch sells to its own members
/subscriptions      Member subscriptions (a gym's customers, not the host's own)
/member             The member/traveler-facing API (gymsera_web's (dashboard) group)
/me                 "Who am I" — profile, current role context
/notifications      Push + in-app notification feed
/payments /invoices /attendance /trainers /reports
                    Day-to-day branch operations
/team               RoleAssignment CRUD — invite/remove staff, assign roles
/approvals          The approval-request queue — list, approve, reject
/ledger             Daily cash reconciliation
/staff-invites /staff  Staff invite acceptance flow
```

### 2.4 Tenant lifecycle & provisioning

```
DRAFT → PENDING_REVIEW → UNDER_REVIEW → APPROVED → ACTIVE
                                    ↘ REJECTED
                          ACTIVE → SUSPENDED → ACTIVE (reactivateTenant, explicit)
```

`approveTenant` runs `tenant-provisioning.service.js` **synchronously, inline in the
request** (deliberately no background job — works identically on a traditional
always-on server or serverless):

1. Connect to the tenant MySQL server (with multi-host/credential fallback).
2. `CREATE DATABASE gymsera_{tenantCode}`, configure privileges.
3. Build + encrypt the connection string, sync the tenant's Sequelize models into it.
4. Create the `GymListing` (cross-DB link back to platform) and the initial `Gym` +
   `Branch` in the new tenant DB.
5. `Tenant.status = 'ACTIVE'`, `connectionStringEncrypted` set.
6. Auto-create the tenant's first `TenantSubscription` from whatever package/plan
   was selected during onboarding.
7. Email + push notification to the owner.

From this point on, every `/host/*` call opens this tenant's own database via
`TenantDbManager`.

### 2.5 What a Platform Admin does (backend surface)

Everything under `/admin`:

- **Tenant review** — approve/reject applications, suspend/reactivate accounts,
  delete a tenant (only while still pending/rejected — never an active one with real
  data).
- **Additional-organization review** — a *second+* organization under an already-
  active tenant independently goes through `PENDING → ACTIVE/REJECTED`, the same
  review shape as a first-time tenant, via the exact same approve/reject endpoints
  (resolved by a compound `tenantId:listingId` id).
- **Tenant capacity audit** — `GET /admin/tenants/:id/capacity-audit`, the read-only
  integrity check (mobile doc §4.4/§8).
- **Branch management on a tenant's behalf** — create/edit/disable a branch,
  toggle Travelers-feed visibility (an admin-only on/off switch, **not** a request
  queue — despite reading like one in the CMS UI before a recent fix added an
  explicit caption saying so).
- **The `BillingPlan` catalog** — the one central branch-count price table every
  platform reads. Editing a price here never touches a live provider price object or
  an existing subscriber's locked-in price (mobile doc §5.5) — it flips that
  provider's sync status to `PENDING`, and a separate, explicit "sync" action is
  what actually pushes it live (fully automatic for Stripe; admin-attested for
  iOS/Android, since neither store exposes a safe price-write API).
- **The legacy `PlatformPackage` catalog** — flat-tier manual/bank-transfer plans,
  kept deliberately separate from the branch-count catalog.
- **Cities/Areas, Reviews moderation, platform-wide Analytics.**
- **Manually assign/revoke a subscription** on a tenant's behalf (the same
  `409 iap_subscription_active` guard as the host's own self-serve manual-plan
  endpoint protects this from corrupting a real store-verified entitlement).

---

## 3. `gymsera_cms` — the admin/host web portal

**One Next.js app, one login, two completely different experiences based on role** —
there is no separate "admin site."

```dart
login → staffRoles.includes(role)?
          GYM_HOST / BRANCH_MANAGER / PLATFORM_ADMIN  → land here (gymsera_cms)
          MEMBER / TRAINER                            → gymsera_web's own portal
```

### 3.1 Sidebar — what each role actually sees

```
Overview
  Dashboard                          ← everyone

Gym Management  (GYM_HOST / BRANCH_MANAGER only, and only once tenant is ACTIVE)
  Gym Profile, Branches, Plans, Members, Staff, Subscriptions,
  Attendance, Payments, Invoices, Trainers, Reports

Settings  (GYM_HOST / BRANCH_MANAGER only)
  Business Profile
  Subscription & Billing             ← the host's OWN GymsEra plan (see §3.3)

Platform Admin  (PLATFORM_ADMIN only)
  Tenants, Reviews, Cities, Packages, Billing Plans, Analytics
```

Section visibility is a real, enforced gate in `sidebar.tsx`
(`section.adminOnly && !isPlatformAdmin → hidden`), not just styling — and every
route it links to is independently protected server-side by the same
`authorize`/`can` middleware as §2.2, so hiding a nav item is a UX convenience, never
the actual security boundary.

### 3.2 What a Gym Host does here

This is the **web equivalent of the mobile app's Gyms tab** — same branches, same
members, same subscriptions, same backend endpoints (`/host/*`). A host genuinely
can run their gym entirely from a laptop if they prefer it to the phone. The one
place mobile and web diverge is **buying/changing their own GymsEra subscription**:
web has no App Store/Play Store to transact through.

### 3.3 The host's own Subscription & Billing page

Reads the **exact same real entitlement** the mobile app's `/host/subscription/mine`
shows (`GET /host/subscription/current`, `GET /host/branch-quota`) — not a
web-specific view of it. For a host on a real, store-verified (iOS/Android)
subscription: read-only, with an explicit note that changing it happens in the
mobile app, since the web has no way to transact with Apple/Google. For a host with
**no** real subscription yet, or already on the legacy manual plan: a "Request a
Manual Plan" section — bank-transfer instructions plus the legacy `PlatformPackage`
tiers — wired to the same `409`-guarded endpoint as §2.5, so it can never silently
clobber a real IAP entitlement. The real branch-count catalog is always shown too,
as reference pricing (self-serve purchase itself only happens in the app, until
Stripe checkout on the website goes live — see the mobile doc's §10).

### 3.4 What a Platform Admin does here

The **operator's console** for everything in §2.5, plus:

- **Tenant detail page** — one real tenant, its owner, its organizations (each with
  real branch counts — not a separate look-alike tenant row per organization; that
  was itself a fixed bug, mobile doc §9.7), its full subscription history with all
  three prices (mobile doc §5.5) side by side, its Capacity tab (real vs. ledger,
  drift, over-quota — mobile doc §4.4), Invoices, and its Branches (grouped by
  organization).
- **Billing Plans page** — edit the branch-count catalog, trigger Stripe sync, mark
  iOS/Android as manually synced after updating those consoles by hand.
- **Packages page** — the legacy flat-tier catalog.

---

## 4. `gymsera_web` — the public website

Three distinct audiences share this one app:

### 4.1 Anonymous visitor

`/`, `/gyms`, `/gyms/[id]`, `/for-gym-owners`, `/contact`, `/privacy`, `/terms`,
`/refund-policy` — marketing + public gym discovery/search (backed by
`/discovery/*`).

### 4.2 Prospective host — `/gym-owner/register`

A 7-step wizard, **live production signup flow** (confirmed by direct read — a
near-duplicate exists at `/onboarding` but is not the linked one):

```
Account → Verify (OTP) → Business → Gym Profile → Package → Payment → Done
```

Calls the exact same `/tenants/*` endpoints as §2.3/§2.4 — this is not a separate
onboarding implementation from the backend's own tenant-provisioning flow, just its
web front door. "Package" is the legacy manual-tier catalog today (bank transfer /
pay-later); becoming the same central branch-count catalog + Stripe Checkout is the
planned, not-yet-live next step (mobile doc §10).

### 4.3 Gym member — `(dashboard)` route group

**Not a host surface at all** — this is a gym **member's** own self-service portal:
`My Subscriptions`, `Payments`, `Account Statement`, `Profile`. Someone who joined a
gym as a customer, signed in with `MEMBER`/`TRAINER` role, and lands *here* after
login rather than in `gymsera_cms` — the exact opposite branch of the
`staffRoles.includes(role)` check in §3's login flow.

**Google Sign-In** exists on this app's own login page (`/auth/login`), using Google
Identity Services directly (not the shared backend's mobile-only flow) — posts to
the same `POST /auth/social/google` every platform uses, so an account created via
the app, the website, or Google Sign-In on either is the same one account either way.

---

## 5. End-to-end: one host, one branch, from nothing to operating

Tying §2–4 together as a single trace, since this is the flow that exercises every
system at once:

```
1. gymsera_web: /gym-owner/register — 7-step wizard
       → gymsera_be: /tenants/register, /tenants/:id/verify-otp,
                      /tenants/:id/submit-gym-profile,
                      /tenants/:id/select-package,
                      /tenants/:id/finalize-application
       → Tenant row created, status DRAFT → PENDING_REVIEW

2. gymsera_cms: Platform Admin opens Tenants, reviews, approves
       → gymsera_be: POST /admin/tenants/:id/approve
       → tenant-provisioning.service.js runs synchronously (§2.4):
         new tenant database created, first Branch + Gym provisioned,
         first TenantSubscription auto-created from the selected package
       → Tenant status → ACTIVE
       → Owner gets an email + push notification

3. Host opens gyms_era (or gymsera_cms) for the first time
       → Signs in — same account, same JWT, same /auth endpoints either way
       → Lands on their one organization, one branch, already built

4. Host wants a SECOND organization
       → gyms_era: Listings tab → "Add New" → build-new-branch wizard
         (or gymsera_cms: same thing, web-side)
       → gymsera_be: POST /host/organizations
       → New GymListing, status PENDING — genuinely needs its own admin
         review (§2.5), same shape as step 2 but for an organization, not
         a whole tenant

5. Host wants to grow from 1 branch to 4
       → gyms_era: BranchPlanPickerScreen (the ONE purchase screen — mobile
         doc §6) → real Play Billing / StoreKit purchase
       → gymsera_be: /billing/android/sync (or /ios/sync) verifies directly
         with the store, updates TenantSubscription.branchCount, reconciles
         capacity (mobile doc §4)
       → gymsera_cms's Capacity tab and gyms_era's /host/subscription/mine
         both now reflect the new plan — same read, two doors
```

---

## 6. What is *not* built yet (as of this document)

- **Stripe checkout on the website** — service code exists
  (`stripe-billing.service.js`), no live keys configured, `/gym-owner/register`'s
  Package step still shows the legacy catalog rather than the real branch-count one.
- **A self-serve web purchase path for the branch-count catalog** — today, buying or
  changing a *real* subscription only happens in the mobile app; the web can only
  show it (§3.3) or fall back to the legacy manual plan.
- See `gyms_era/docs/MOBILE_APP_ARCHITECTURE.md` §10 for the mobile-side open items
  (Play Console upgrade/downgrade not yet confirmed live, one unresolved stale-cache
  report).

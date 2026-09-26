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
| D-1 | `PLATFORM_ARCHITECTURE.md` says the web wizard's Package step shows the **legacy** catalog and Stripe checkout is **not live**. The Public Site Map says the Package step **reads `BillingPlan`** and `card` → **Stripe Checkout** → `/gymsera-billing?checkout=success`. | Read `gymsera_web/src/app/gym-owner/register/page.tsx`, then update both docs to match the code. |
| D-2 | The Mobile Screen Map says Team & Access uses **3 tiers** (Off / Needs approval / Direct). The backend has **6** (`NONE/VIEW/REQUEST/APPROVE/DIRECT/FULL`). | **Resolved (v2): mobile is correct.** The editor edits 3 tiers per person; VIEW/APPROVE/FULL come from the role preset. See §8.3 and RBAC-01. |
| D-3 | The mobile map shows a **Cleaner** role. The backend role levels have no Cleaner. | **Resolved (v2): "Cleaner" is the mobile label.** Confirm which backend level it maps to (probably `SUPPORT`). Every client uses the mobile label table. See RBAC-02. |
| D-4 | The mobile app merged Admin + Staff management into Team & Access. The CMS still has separate **Staff** and **Trainers** screens. | **Resolved (v2): the CMS ports mobile Team & Access.** See UX-12 and RBAC-07. |


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

## 13. Implemented fixes (log — the agent fills this in)

**Nothing is implemented at the time this document was written.** For every issue the agent touches, add one row. An issue is `DONE` only when its regression test exists and passes in CI.

> §13 is the permanent record of finished work. The in-progress state (what the current agent is doing right now, and the exact next step) lives in `AGENT_HANDOFF.md` next to this file.

| Issue | Status (`DONE` / `NOT REPRODUCED` / `DEFERRED` / `IN PROGRESS`) | Root cause (file:line) | Pattern reused | Fix summary | Test file(s) | PR/commit | Verified in staging? |
|---|---|---|---|---|---|---|---|
| _example_ CAP-02 | DONE | `branch.service.js:212` platform credit after tenant commit | `CapacityEvent.idempotencyKey` | Tenant `Outbox` row in step-5 transaction + processor | `capacity.outbox.test.js` | #123 | yes, 2026-10-02 |

**Regression tests for already-fixed defects (mobile doc §9).** Add these if missing:

| Defect | Regression test |
|---|---|
| §9.1 `updateBranch` status bypass | `PATCH` branch with `status` → 400 `branch_status_immutable_here`; same value → 200 |
| §9.2 purchase-stream matching | Stale transaction for another product does not show success UI |
| §9.3 new-org attempt-first | Quota says "none" but a donor slot exists → create succeeds without the upsell |
| §9.4 renewal resurrection | Renewal of a superseded row → stays superseded |
| §9.5 tenant-wide quota provider | Invalidating once updates every org tab |
| §9.6 `getConnection` side effects | `getConnection` on a cold cache performs zero UPDATEs (query spy) |
| §9.7 tenant list rows | Tenant with 3 ACTIVE orgs → 1 row |
| §9.8 delete-button enablement | Typing a password enables the button |

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

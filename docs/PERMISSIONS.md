# GymsEra — Permission Catalogue & Persona Matrix

> **AUTOMATICALLY GENERATED — DO NOT EDIT DIRECTLY**
> Source of truth: `src/constants/permissions.js` and `src/constants/roles.js`.
> Generated on: 2026-09-29

This document describes the unified Role-Based Access Control (RBAC) model implemented in GymsEra, specifying exactly what each staff persona, gym member, and platform admin can do across all functional modules.

---

## 1. Roles & Hierarchy

Staff roles are assigned per organization or per branch via `RoleAssignment`. Privilege escalation is strictly prevented by role levels: a user may only invite or assign roles strictly below their own level.

| Role Key | Display Name | Level | Default Scope | Assignable | Charter |
|---|---|---|---|---|---|
| `OWNER` | **Owner / Host** | 100 | `ORG` | No (Host creation) | Created the organization. Implicit full access. Sole holder of billing, payouts, bank details, ownership transfer and org deletion. Cannot be removed. |
| `ORG_ADMIN` | **Gym Admin** | 80 | `ORG` | Yes | Full operations across every branch. No payouts, no bank details, no owner removal, no org deletion. |
| `MANAGER` | **Branch Manager** | 60 | `BRANCH` | Yes | Full operations on assigned branches, including financial approvals and end-of-shift cash reconciliation. May invite roles below level 60. |
| `BR_ADMIN` | **Branch Admin** | 40 | `BRANCH` | Yes | Day-to-day operations on assigned branches, minus financial approval and team invites. |
| `DESK` | **Front Desk / Staff** | 20 | `BRANCH` | Yes | Check-ins, member onboarding by request, records payments into the collection box. No approvals, no money out. |
| `TRAINER` | **Trainer** | 20 | `BRANCH` | Yes | Own classes and assigned members, with progress notes. Zero financial access. |
| `SUPPORT` | **Support / Cleaner** | 5 | `BRANCH` | Yes | Schedule visibility and facility tasks only. No member contact details, ever. |

### Non-Staff Personas
- **MEMBER**: Gym member or traveler. Has zero staff access to tenant operations; operates exclusively on their own profile, QR check-ins, personal subscriptions, and invoices.
- **PLATFORM_ADMIN**: System administrator across the platform. Holds superuser access to platform-level tenant management and diagnostic routes; accesses tenant DBs strictly through audited platform-admin doors without bypasses.
- **ANONYMOUS**: Unauthenticated public caller. Access limited to public discovery, health checks, and auth endpoints.

---

## 2. Permission Tiers

Every permission follows a 3-choice or 5-tier evaluation model:

| Tier Code | Tier Name | Meaning | API Behavior |
|---|---|---|---|
| `F` | **FULL** | Full administrative control | Direct mutation + viewing + sub-configuration |
| `D` | **DIRECT** | Direct action execution | Mutation executes immediately; holds `.direct` twin |
| `A` | **APPROVE** | Decision maker | Can approve or reject requests in inbox |
| `R` | **REQUEST** | Gated / Approvable action | Mutation writes `approval_request` for manager review |
| `V` | **VIEW** | Read-only | Can query and view records within scope |
| `x` | **NONE** | No access | Endpoint returns 403 Forbidden; UI element hidden |

---

## 3. Persona Matrix by Module

### 3.1 Module: Dashboard (`dashboard`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View dashboard** | `dashboard.view` | Full | Full | Full | Full | View | View | View | No |
| **See revenue figures** | `dashboard.revenue.view` | Full | Full | Full | View | — | — | — | No |
| **Roll-up across branches** | `dashboard.multibranch.view` | Full | Full | — | — | — | — | — | No |

### 3.2 Module: Members (`members`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View members** | `members.view` | Full | Full | Full | Full | View | View | — | No |
| **See contact details** | `members.pii.view` | Full | Full | Full | Full | View | — | — | No |
| **Add member** | `members.create` | Direct | Direct | Direct | Direct | Request | — | — | Yes |
| **Edit member** | `members.update` | Direct | Direct | Direct | Direct | Request | — | — | Yes |
| **Delete member** | `members.delete` | Direct | Direct | Request | Request | — | — | — | Yes |
| **Freeze membership** | `members.freeze` | Direct | Direct | Direct | Request | Request | — | — | Yes |
| **Transfer between branches** | `members.transfer` | Direct | Direct | Request | — | — | — | — | Yes |
| **Write progress notes** | `members.notes.write` | Full | Full | Full | Full | — | Direct | — | No |
| **Export member list** | `members.export` | Full | Full | View | — | — | — | — | No |

### 3.3 Module: Check-ins (`checkins`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View check-ins** | `checkins.view` | Full | Full | Full | Full | View | View | — | No |
| **Scan member QR** | `checkins.qr.scan` | Full | Full | Full | Full | Direct | Direct | — | No |
| **Manual check-in** | `checkins.manual.create` | Direct | Direct | Direct | Direct | Request | — | — | Yes |
| **Backdate a check-in** | `checkins.backdate` | Direct | Direct | Request | — | — | — | — | Yes |
| **Delete a check-in** | `checkins.delete` | Direct | Direct | Request | — | — | — | — | Yes |

### 3.4 Module: Announcements (`announcements`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View announcements** | `announcements.view` | Full | Full | Full | Full | View | View | View | No |
| **Draft an announcement** | `announcements.create` | Direct | Direct | Direct | Direct | Request | Request | — | Yes |
| **Publish to members** | `announcements.publish` | Direct | Direct | Direct | Direct | — | — | — | No |
| **Broadcast to all branches** | `announcements.broadcast.all_branches` | Direct | Direct | — | — | — | — | — | No |
| **Delete an announcement** | `announcements.delete` | Direct | Direct | Direct | — | — | — | — | No |

### 3.5 Module: Schedule (`schedule`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View class schedule** | `schedule.view` | Full | Full | Full | Full | View | View | View | No |
| **Create a class** | `schedule.class.create` | Direct | Direct | Direct | Direct | Request | Direct | — | Yes |
| **Edit a class** | `schedule.class.update` | Direct | Direct | Direct | Direct | Request | Direct | — | Yes |
| **Cancel a class** | `schedule.class.cancel` | Direct | Direct | Direct | Request | Request | Request | — | Yes |
| **Assign a trainer** | `schedule.trainer.assign` | Direct | Direct | Direct | — | — | — | — | No |
| **Force-add to a full class** | `schedule.booking.override` | Direct | Direct | Direct | Direct | — | — | — | No |

### 3.6 Module: Expenses (`expenses`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View expenses** | `expenses.view` | Full | Full | Full | View | View | — | View | No |
| **Record an expense** | `expenses.create` | Direct | Direct | Direct | Request | Request | — | Request | Yes |
| **Approve expenses** | `expenses.approve` | Approve | Approve | Approve | — | — | — | — | No |
| **Manage expense categories** | `expenses.category.manage` | Full | Full | Direct | — | — | — | — | No |
| **Delete an expense** | `expenses.delete` | Direct | Direct | Request | — | — | — | — | Yes |

### 3.7 Module: Subscriptions (`subscriptions`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View subscriptions** | `subscriptions.view` | Full | Full | Full | Full | View | — | — | No |
| **Assign a plan** | `subscriptions.create` | Direct | Direct | Direct | Direct | Request | — | — | Yes |
| **Extend / add free days** | `subscriptions.extend` | Direct | Direct | Direct | Request | Request | — | — | Yes |
| **Pause a subscription** | `subscriptions.pause` | Direct | Direct | Direct | Direct | Request | — | — | Yes |
| **Cancel a subscription** | `subscriptions.cancel` | Direct | Direct | Direct | Request | Request | — | — | Yes |
| **Apply a discount** | `subscriptions.discount.apply` | Direct | Direct | Direct | Request | Request | — | — | Yes |
| **Change plan** | `subscriptions.plan.change` | Direct | Direct | Direct | Direct | Request | — | — | Yes |

### 3.8 Module: Payments (`payments`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View payments** | `payments.view` | Full | Full | Full | View | View | — | — | No |
| **Record a payment** | `payments.record` | Direct | Direct | Direct | Direct | Request | — | — | Yes |
| **Verify a payment** | `payments.verify` | Approve | Approve | Approve | — | — | — | — | No |
| **Issue a refund** | `payments.refund` | Direct | Direct | Request | — | — | — | — | Yes |
| **View the collection box** | `payments.collection_box.view` | Full | Full | Full | View | View | — | — | No |
| **Reconcile cash handover** | `payments.collection_box.reconcile` | Direct | Direct | Direct | — | — | — | — | No |

### 3.9 Module: Invoices (`invoices`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View invoices** | `invoices.view` | Full | Full | Full | Full | View | — | — | No |
| **Generate an invoice** | `invoices.generate` | Direct | Direct | Direct | Direct | — | — | — | No |
| **Send an invoice** | `invoices.send` | Direct | Direct | Direct | Direct | Direct | — | — | No |
| **Void an invoice** | `invoices.void` | Direct | Request | Request | — | — | — | — | Yes |
| **Download an invoice** | `invoices.download` | Full | Full | Full | Full | View | — | — | No |

### 3.10 Module: Membership plans (`plans`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View plans** | `plans.view` | Full | Full | View | View | View | — | — | No |
| **Create a plan** | `plans.create` | Direct | Direct | Request | — | — | — | — | Yes |
| **Edit a plan** | `plans.update` | Direct | Direct | Request | — | — | — | — | Yes |
| **Change plan pricing** | `plans.price.update` | Direct | Direct | — | — | — | — | — | Yes |
| **Archive a plan** | `plans.archive` | Direct | Direct | Request | — | — | — | — | Yes |

### 3.11 Module: Team & governance (`governance`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View the team** | `team.view` | Full | Full | Full | View | — | — | — | No |
| **Invite team members** | `team.invite` | Direct | Direct | Direct | — | — | — | — | No |
| **Change someone's role** | `team.role.assign` | Direct | Direct | Direct | — | — | — | — | No |
| **Fine-tune individual permissions** | `team.permission.override` | Direct | Direct | — | — | — | — | — | No |
| **Manage custom roles** | `roles.manage` | Direct | Direct | — | — | — | — | — | No |
| **See the approval inbox** | `approvals.view` | Full | Full | Full | — | — | — | — | No |
| **Approve or reject requests** | `approvals.decide` | Approve | Approve | Approve | — | — | — | — | No |
| **Approve your own requests** | `approvals.self_approve` | Direct | — | — | — | — | — | — | No |
| **Create a branch** | `branch.create` | Direct | — | — | — | — | — | — | No |
| **Edit branch settings** | `branch.settings` | Direct | Direct | Direct | — | — | — | — | No |
| **Manage the public listing** | `listing.manage` | Direct | Direct | — | — | — | — | — | No |
| **View the audit log** | `audit.view` | Full | Full | View | — | — | — | — | No |
| **View payouts** | `payouts.view` | Full | — | — | — | — | — | — | No |
| **Manage bank details** | `payouts.bank.manage` | Direct | — | — | — | — | — | — | No |
| **Manage the GymsEra subscription** | `billing.manage` | Direct | — | — | — | — | — | — | No |

### 3.12 Module: Collection ledger (`ledger`)

| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **View Today's Ledger** | `ledger.today.view` | Full | Full | Full | Full | View | — | — | No |
| **Verify / reconcile ledger** | `ledger.verify` | Approve | Approve | Approve | — | — | — | — | No |
| **Close Today's Ledger** | `ledger.close` | Direct | Direct | Request | — | — | — | — | Yes |
| **View Weekly Ledger** | `ledger.weekly.view` | Full | Full | Full | — | — | — | — | No |
| **View Monthly Ledger** | `ledger.monthly.view` | Full | Full | Full | — | — | — | — | No |

---

## 4. Endpoint Protection Architecture

Endpoints enforce permissions using two complementary mechanisms:

1. **Direct Route Middleware (`can(permissionKey, opts)`):**
   Resolves effective grants for `(tenantId, userId, branchId)` against active `RoleAssignment`s.
   - `can('ledger.today.view')`
   - `can('team.invite', { orgWide: true })`
   - `can.any(['approvals.view', 'approvals.decide'])`

2. **Unified Approvable Actions Door (`POST /api/v1/actions/:actionKey`):**
   Evaluates `req.grants.tierFor(actionKey)`:
   - If `DIRECT`: runs action command immediately via `actions.controller`.
   - If `REQUEST`: creates an `approval_request` row in tenant DB.
   - If `OFF`: returns 403 Forbidden.

3. **IDOR & Cross-Tenant Defense-in-Depth:**
   - Out-of-scope resources (by `:id`) return 404 Not Found (never 403) to prevent existence leakage.
   - Branch-scoped users (Manager, Desk, Trainer, Cleaner) cannot read or mutate data outside their assigned branch(es).
   - Non-platform admins cannot read or mutate resources across different tenant boundaries.

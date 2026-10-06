# PAY-08 (non-gateway part) — Online / member pending payments

Prompt 2B group 4, item B. No Stripe or other gateway was integrated. PAY-08a (TEST method in production) was done
earlier (1a5060c).

| Field | Value |
|---|---|
| Status | DONE (backend, non-gateway part). Gateway webhook as source of truth stays open until a member gateway exists. |
| Verified on | main 285417b (+ NEW-39, FLOW-08, NEW-40 on this branch) |

## Verification, requirement by requirement

| Requirement | State at main | Proof |
|---|---|---|
| Pending online/member payments expire | **OPEN** — no deadline, no job, no EXPIRED status (`src/constants/payment-status.js:1-7`; nothing in `src/jobs/`) | `tests/regression/pay-08-pending-payment-expiry.test.js` tests 1, 3–7 fail on the pre-fix source (`expireStalePendingPayments is not a function`, `expiresAt` NaN) |
| A client callback / return page can never mark a payment PAID | **ALREADY FIXED** — no member route can complete a payment: `POST /payments` needs `payments.record` branch access (`src/routes/payments.routes.js:70-95`); completion needs the direct grant (`src/controllers/payments.controller.js:31`); verify needs `payments.verify` (`:110`, `:127-142`); `/me/payment-request` and proof uploads only touch PENDING rows (`src/services/me.service.js`, `src/services/payment.service.js` `uploadPaymentProof`). There is no gateway callback route; `markPaymentFailed` (`payment.service.js:788`) has no route. | test 8 (4 cases) passes before and after — kept as a guard |
| No method auto-completes except cash by a collector and the approved paths | **ALREADY FIXED** after PAY-08a — see the table below | test 9 passes before and after — kept as a guard |
| Webhook replay → one state change | NOT APPLICABLE yet — no member gateway. When one is added, reuse the 1A `billing_events` inbox (`src/services/billing-event.service.js`); not built here. | — |

### Every way a member payment becomes COMPLETED (after this change)

| Path | Where | Who |
|---|---|---|
| Record with the direct grant | `src/services/payment.service.js:203` (`autoComplete = isDirect \|\| isTest`), `:247` | Owner or a role holding `payments.record` DIRECT (§8.3) |
| TEST method | `payment.service.js:202` | Never in production (PAY-08a); elsewhere needs `X-Test-Payment-Key` (`payments.routes.js:103-117`) |
| Verify | `payment.service.js:423` (`verifyPayment`) via `POST /payments/:id/verify` or `/action` `verify` | `payments.verify` on the payment's branch |
| Walk-in enrollment by the host | `src/services/gym.service.js:1670`, `:1760` | Host (`GYM_HOST`), or an approval executed through the approval engine (`commands/member.commands.js`) |
| Partial refund keeps COMPLETED | `src/services/commands/payment.commands.js:180` | Approval engine (PAY-07) |

Cash taken by a collector goes PENDING → STAFF_COLLECTED (`verifyOrRejectPayment` `collect`) and still needs verify.

## Fix (the open part)

- `PaymentStatus.EXPIRED` and `payments.expires_at` (tenant migration **018**). `payments.status` exists in two shapes:
  the model's ENUM (values in any order) and `VARCHAR(50)` on older tenants (the mixed-collation fixture,
  `tests/harness/test-db.js:362`). An ENUM that has all five known values gets `EXPIRED` appended, keeping its order,
  nullability and default (appending is metadata-only on MySQL 5.7); a VARCHAR is left alone (it already holds
  `EXPIRED`); anything else → skipped and not recorded. Then a nullable DATETIME `expires_at` + index
  `(status, expires_at)`.
- Every payment a **member** starts gets a deadline: checkout (`subscribe`), member upgrade, member renewal (NEW-40),
  re-submitted first payment (`/me/payment-request`). `MEMBER_PAYMENT_PENDING_TTL_HOURS`, default 168 (7 days = the
  invoice due date). Staff-recorded payments (cash in the collect box) get no deadline and never expire.
- `payment.service#expireStalePendingPayments` (batched, conditional `UPDATE … WHERE status='PENDING'` so a payment
  verified at the same moment stays verified):
  - payment → EXPIRED; its ISSUED invoice (same subscription, same amount, newest) → CANCELLED;
  - first checkout: the never-started membership → CANCELLED (+ `user_gym_memberships`), so the member can subscribe again;
  - upgrade/renewal: nothing else — the old plan continues (FLOW-08);
  - a payment with an uploaded proof is skipped (the member says they paid; the host verifies or rejects it).
- Run from the existing daily job (`src/jobs/subscription-expiry.cron.js` `_processTenant`), which already holds the
  REL-03 lock with the MySQL `GET_LOCK` fallback — works with no Redis (rule 10). **Only when
  `MEMBER_PAYMENT_EXPIRY_ENABLED=true`** (see client impact).
- An EXPIRED payment cannot be verified (409) or take a proof (400) — existing status checks.
- `GET /payments?status=EXPIRED` accepted by the validator.

Existing pattern reused: daily cron + distributed lock (REL-03), tenant migration runner, `money.utils`, conditional
UPDATE as in the provisioning lease. No second scheduler, no new table.

## Tests

- `tests/regression/pay-08-pending-payment-expiry.test.js` — 12 tests; 7 fail on the pre-fix source, all pass after.
- `tests/integration/tenant-migrations-018.test.js` (6 tests) — dry-run writes nothing; an ENUM lacking a known value →
  skipped, not recorded; an ENUM in another order → `EXPIRED` appended, order/NOT NULL/default kept; a VARCHAR status →
  left as is, `expires_at` added; `expires_at` with another type → skipped; apply + re-run.
- The first version of 018 skipped VARCHAR tenants; the full suite caught it
  (`tests/integration/reactivate-tenant-migration.test.js` stopped at version 17).

## Client impact (why the sweep is behind a flag)

| Client | What it does with an `EXPIRED` payment | Breaks? |
|---|---|---|
| Mobile (released) | `Payment.fromJson` uses `$enumDecode` (`gyms_era/lib/features/payments/data/models/payment_model.g.dart:22`) against `enum PaymentStatus { pending, staffCollected, completed, failed, refunded }` (`lib/core/constants/app_enums.dart:25`). The host's subscription detail parses every payment of the subscription (`lib/features/host/presentation/providers/host_subscriptions_provider.dart:112-118`); `payments_repository.dart:111,150,169` parse single payments. | **Yes** — once a payment is EXPIRED, that host screen fails to load. Hence `MEMBER_PAYMENT_EXPIRY_ENABLED` stays `false` until a mobile release adds `expired` (with `unknownEnumValue`). |
| Mobile workspace list | `team_payments_workspace_screen.dart:91-97` switch has a default | No |
| CMS | `gymsera_cms/src/app/(dashboard)/gym/payments/page.tsx:49-56` badge falls back to the raw status | No (shows "EXPIRED"); type `src/types/index.ts:5` lacks it (compile-time only) |
| Web | shows member payments via `/me/payments` (`gymsera_web/src/lib/api/me.ts:101`) | Not verified at runtime; status is a string there |

No request shape changed. Responses gain `expiresAt` on payments.

## Deploy order

1. `node src/scripts/run-tenant-migrations.js --dry-run` → `017_add_payment_pending_change`, `018_add_payment_expiry`.
2. `node src/scripts/run-tenant-migrations.js` (017 before 018; both additive).
3. Deploy the backend with `MEMBER_PAYMENT_EXPIRY_ENABLED` unset/false. Deadlines are stamped on new member payments from now on.
4. Ship the mobile release that understands `EXPIRED` (client work, not done here); CMS type update optional.
5. Set `MEMBER_PAYMENT_EXPIRY_ENABLED=true`. The next 01:00 run expires overdue new-style payments.

## Existing data

Rows created before this change have `expires_at = NULL` and are never expired automatically. The read-only
`src/scripts/gymsera-prompt-2b-group4-check.js` lists member-started PENDING payments older than the TTL
(`stalePendingMemberPayments`) for the owner to decide (expire by hand, or leave).

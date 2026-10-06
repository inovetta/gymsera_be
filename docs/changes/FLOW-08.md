# FLOW-08 (non-gateway part) — Member checkout and plan upgrade

Prompt 2B group 4, item A. No gateway, no Stripe. Gateway parts of FLOW-08 (hosted page, verified webhook,
confirmation polling) stay open.

| Field | Value |
|---|---|
| Status | DONE (backend, non-gateway part) |
| Verified on | main 285417b |

## What was open (proven)

| # | Defect | Where (pre-fix) | Proof |
|---|---|---|---|
| 1 | A member upgrade switched to the new plan **before** any payment; the payment stayed PENDING | `src/services/subscription.service.js:890-898` (`sub.update({ membershipPlanId })`, `index.update({ planName })`) | test 1 & 4 red: plan was Premium right after the request and stayed Premium after the host rejected the payment |
| 2 | The member's payment request stored the **client's** amount over the server-priced payment | `src/services/me.service.js:299-306` (`payment.update({ method, amount })`), `:309-321` (create with client `amount`); validator `.toFloat()` (`src/validators/me.validator.js:47-49`) | test 7 & 8 red: stored `1` and `5` instead of `1000.05` |
| 3 | A payment request for an active membership with nothing due created a free-floating PENDING payment | `src/services/me.service.js:308-321` | test 9 red: 201 |
| 4 | Walk-in enrollment summed prices with `parseFloat` | `src/services/gym.service.js:1747-1750` | test 10 red: `0.30000000000000004` |
| 5 | An unpaid (PENDING) membership could be upgraded | `upgradeSubscription` had no status check | test 6 red: 200 |

Already fine (not changed): `subscribe` prices on the server in minor units (`subscription.service.js:216-221` at main); the
membership stays PENDING until a verified payment (`:176-190`).

## What the old plan does meanwhile

Nothing changes until the upgrade payment is verified: the member keeps the old plan, its end date, visits and QR.
- Payment verified (`verifyPayment`) → the subscription switches to the new plan (end date unchanged; the price paid is
  the difference) and `user_gym_memberships.plan_name` follows.
- Payment rejected, or expired (PAY-08) → nothing happens; the old plan continues.
- The membership ends (CANCELLED/EXPIRED) before verification → the plan is not switched; the money stays recorded on
  the payment for the host to refund through PAY-07.
- Only one payment may await verification per membership: a second upgrade request → 409.
- A host approving a **staff** upgrade request (`POST /host/action-requests/:id/approve`), and an approved (or
  DIRECT-tier) `subscriptions.plan.change` with `isUpgrade` through the approval engine
  (`src/services/commands/subscription.commands.js`), are the "host approves it" path and apply at once, as before
  (test 5b).

## Root cause → pattern reused → fix

- `payments.pending_change_json` (tenant migration **017**, additive, nullable TEXT, same style as
  `ledger_days.closed_collectors_json`) records what a payment unlocks: `{"type":"UPGRADE","planId":…}`.
  `verifyPayment` (the only verified server-side path, PAY-08) applies it via `subscription.service#applyUpgrade`.
- Money: `money.utils` (PAY-02) — `subtractMoney` for the difference, `toMinorUnits/fromMinorUnits` in enrollment;
  first-payment pricing extracted from `subscribe` into `priceFirstPayment` and reused by the payment request.
- `POST /me/payment-request`: the stored amount is always the server's; a client `amount` is accepted (released apps
  send it) and ignored. A new payment is created only for a membership still waiting for its first payment.
- Upgrade requires an ACTIVE or FROZEN membership and no payment already awaiting verification.

## Tests

- `tests/regression/flow-08-member-checkout-and-upgrade.test.js` — 11 tests; on the pre-fix source 8 fail
  (1, 4, 5, 6, 7, 8, 9, 10; 5b fails against the first version of this fix, which forgot the approval engine), after the fix all pass.
- `tests/integration/tenant-migrations-017.test.js` — dry-run writes nothing; conflicting column type → skipped and
  not recorded; apply + re-run.

## Client impact

| Endpoint | Released app / CMS / web send | Breaks? |
|---|---|---|
| `POST /member/subscriptions/:id/upgrade` | Mobile host screen `gyms_era/lib/features/host/presentation/screens/upgrade_package_screen.dart:75` (`subscriptions_repository.dart:174-185`) with the **host's** token. Already returns 404 today (looks up the subscription by the caller's id) — unchanged, recorded as a finding. CMS/web: no caller. | No (response gains `applied`, `newPlanId`) |
| `POST /me/payment-request` | Mobile `checkout_provider.dart:179-184` sends `{subscriptionId, method, amount}`; `amount` includes a client-only promo (`GYMSERA10`, `checkout_provider.dart:129-135`). Web `gymsera_web/src/lib/api/me.ts:105-106` (`/me/payments`). | No — still 201; the stored amount is the server's, so a promo the app shows is not honoured (it never was a server promo) |
| `POST /host/action-requests/:id/approve` (upgrade) | Mobile staff screen `upgrade_package_screen.dart:51-61` | No |

Mobile wording to fix later (client work, not done): the host upgrade dialog says "Upgrade Successful!"
(`upgrade_package_screen.dart:113-127`); it should say the upgrade starts once the payment is verified.

## Deploy order

1. `node src/scripts/run-tenant-migrations.js --dry-run` → expect `017_add_payment_pending_change` listed per tenant.
2. `node src/scripts/run-tenant-migrations.js` (adds a nullable column; no data change).
3. Deploy the backend. Without 017 every `payments` query fails ("Unknown column"), so 017 must run first.
4. Clients: nothing required.

## Existing data

Upgrades applied before payment on older servers: payments with notes `Upgrade to …` still PENDING / FAILED while the
subscription is already on the new plan. Listed read-only by `src/scripts/gymsera-prompt-2b-group4-check.js`
(`upgradeAppliedBeforePayment`). Reverting them is an owner decision.

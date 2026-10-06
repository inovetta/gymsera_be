# NEW-39 — Verifying a member payment never activated the membership (P0)

Found while verifying FLOW-08 (Prompt 2B group 4). Not in the spec issue list.

| Field | Value |
|---|---|
| Status | DONE (backend) |
| Severity | P0 (money taken, entitlement never granted) |
| Root cause | `src/services/payment.service.js` `verifyPayment`: the PAY-02 change (80054e4) renamed `finalAmount` to `finalAmountMinor` but left two uses of the old name (`:391` invoice update, `:473` host notification). Every verify of a payment with a `referenceEntityId` set the payment COMPLETED, then threw `ReferenceError: finalAmount is not defined` before marking the invoice PAID and before `_activateSubscription`. The caller got a 500; the member stayed PENDING. |
| Why no test caught it | The only verify-with-invoice test is `tests/verify-payment-invoice.test.js`, which is outside `jest.config.js` `testMatch` (only `tests/integration` and `tests/regression` run). `tests/integration/payment-business-date.test.js` Path 3 verifies a payment with no `referenceEntityId`. |
| Pattern reused | `money.utils#fromMinorUnits` (PAY-02) |
| Fix | Define `finalAmount = fromMinorUnits(finalAmountMinor)` once and use it for the payment, the invoice total and the notification. |
| Regression test | `tests/regression/new-39-verify-payment-activates.test.js` (member subscribe → host verify → subscription ACTIVE, invoice PAID with the exact total, `user_gym_memberships` ACTIVE; waived joining fee → invoice total = verified amount) |

## Failing-first

On the pre-fix source both tests fail with `ReferenceError: finalAmount is not defined`; after the fix both pass.

## Existing data

Any member payment verified on a server running 80054e4 or later is `COMPLETED` while its subscription is still
`PENDING` and its invoice still `ISSUED`. `src/scripts/gymsera-prompt-2b-group4-check.js` (read-only) lists them
(`completedPaymentPendingSubscription`). Repairing them is an owner decision (activate, or refund) — not done here.

## Deploy

Code only, no migration. No client change: the request and response shapes of `POST /payments/:id/verify` and
`POST /payments/:id/action` are unchanged (they now return 200 instead of 500).

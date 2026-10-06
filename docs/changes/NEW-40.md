# NEW-40 — Member self-renew extended the membership with no payment (P0)

Found while verifying FLOW-08 (Prompt 2B group 4). Fixed with the owner's approval (asked 2026-10-06: "Fix in FLOW-08",
separate commit).

| Field | Value |
|---|---|
| Status | DONE (backend) |
| Severity | P0 (free entitlement) |
| Root cause | `src/services/subscription.service.js` `renew` (main 285417b `:415-529`): `POST /subscriptions/:id/renew` with the member's own token set the subscription ACTIVE, moved the end date by one period and issued a new QR, and created **no payment**. It even renewed a PENDING membership whose first payment was never made. The website's Renew button calls it (`gymsera_web/src/lib/api/subscriptions.ts:37-39`, `src/app/(dashboard)/subscriptions/page.tsx:54-60`). |
| Pattern reused | FLOW-08's `payments.pending_change_json` (tenant migration 017) + `verifyPayment` as the only place a change applies; `money.utils`; `getNextInvoiceNumber` (PAY-05); FLOW-06 date rule moved unchanged into `applyRenewal`. |
| Fix | Member path: refuse a never-paid (PENDING) membership (409) and a membership that already has a payment awaiting verification (409); otherwise create a PENDING payment for one period at the server price plus an ISSUED invoice, with `{"type":"RENEW","planId":…}`. `verifyPayment` calls `applyRenewal` (FLOW-06 dates computed at verification time; a member-chosen start date is ignored). The host approving a staff renewal request (`POST /host/action-requests/:id/approve`) and an approved (or DIRECT-tier) `subscriptions.create` command through the approval engine (`src/services/commands/subscription.commands.js`) pass `approvedByHost` and apply at once, as before. Reject or expiry (PAY-08) → nothing is extended. |
| Existing tests updated (not weakened) | `tests/regression/flow-06-subscription-dates.test.js` (2 renewal tests) and `tests/regression/direct-member-notifications.test.js` (Path 2) called the member `renew()` and expected an instant extension / notification — exactly the defect. They now renew as the member, verify the payment as the owner, then run the same date and notification assertions; the notification lookup filters on the title "Subscription Renewed" because verify also notifies the member. |
| Regression test | `tests/regression/new-40-member-renew-requires-payment.test.js` (8 tests; 6 fail on the pre-fix source; test 8 covers the approval engine) |

## Client impact

| Endpoint | Who sends what today | Breaks? |
|---|---|---|
| `POST /subscriptions/:id/renew` | Web member "Renew" (`gymsera_web/src/lib/api/subscriptions.ts:38`, no body). Response still `{ subscription, qrCode }` plus `payment`, `invoice`, `applied: false`. | No error. The web toast still says "Subscription renewed!" (`subscriptions/page.tsx:57`) while the membership now shows a pending payment — web copy to fix (client work, not done). A renew of a never-paid membership now gets 409 → "Failed to renew". |
| same | Mobile host screen `gyms_era/lib/features/host/presentation/screens/renew_subscription_screen.dart:127` with the **host's** token → already 404 today (subscription looked up by the caller's id); unchanged, recorded as a finding. | No change |
| `POST /host/action-requests/:id/approve` (renew) | Mobile staff renew request (`renew_subscription_screen.dart:97-110`) | No |

## Deploy

Needs tenant migration 017 (FLOW-08) first. No other migration.

## Existing data

Free renewals already granted cannot be told apart reliably from paid ones (no payment was ever linked). The read-only
check script lists ACTIVE memberships whose current period has no COMPLETED payment on or after its start date
(`activeWithoutPaymentForPeriod`) as candidates for the owner to review. Nothing is changed automatically.

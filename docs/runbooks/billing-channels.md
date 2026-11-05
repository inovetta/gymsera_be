# Runbook: one host plan, three channels (Apple, Google Play, bank transfer)

Phase 7 P9c item E, 2026-11-05. Decisions: R-1 (IAP in the apps), R-7 (no web card), R-82 (lapsed
plan), R-87 (Sandbox), R-93 (one Apple ID on two hosts), **R-95** (bank transfer in the CMS).

## 1. The rule that holds everything together

Every host plan, whatever the channel, is written by **one function**:
`subscription-migration.service.js#applyVerifiedSubscription`.

| Channel | Who calls it | When |
|---|---|---|
| Apple | `apple-billing.service.js` (app `/billing/ios/sync`, App Store notifications) | after Apple verified the transaction |
| Google Play | `google-play-billing.service.js` (app `/billing/android/sync`, RTDN) | after Google verified the purchase token |
| Bank transfer | `plan-payment.service.js#approve` (CMS admin "Plan payments") | after a platform admin checked the money |
| Pay later | `startPayLaterGrace` / `verifyPayLaterPayment` | at approval / when the admin confirms the transfer |

When the purchase is new (an id the server has not seen), `requestProviderChange` locks the tenant,
finds the current ACTIVE / GRACE row and **supersedes it in the same transaction**. So a tenant
never has two entitling rows. A renewal of a row that was superseded is never turned back into
ACTIVE (`reconcileRenewalStatus`); it is marked `duplicate_billing` instead.

Before any money moves, the server can refuse a second channel **while the current plan is a store
plan that renews** (`autoRenew` true): `POST /billing/purchase-intent` (for the app) and
`GET` / `POST /host/plan-payments` (the CMS). A cancelled (auto-renew off) or ended store plan does
not block. **The CMS uses its check; the app does not call purchase-intent yet (NEW-225)**, so a
cross-store purchase in the app is not stopped before payment (rows 4 to 4b).

## 2. The matrix

"Test" names the file that proves the row (backend `tests/`).

| # | Case | What the host sees | What the server does | Two entitlements / double billing? | Test |
|---|---|---|---|---|---|
| 1 | iOS → iOS upgrade | the new plan at once (Apple charges the prorated difference) | same `originalTransactionId`: the same row gets the new plan and branch count | no: one row | `p9c-channel-matrix` "IOS → IOS upgrade" |
| 2 | iOS → iOS downgrade | the plan picker asks which branches to keep; the current plan stays until the renewal date | Apple reports the next product; `pendingChange` with the keep-list; applied at renewal | no | `integration/billing-downgrade` (Apple) |
| 3 | Android → Android upgrade | the new plan at once | Google issues a new token with `linkedPurchaseToken` = the old one; the old row is CANCELLED "no action needed" | no | `p9c-channel-matrix` "ANDROID → ANDROID upgrade" |
| 4 | iOS then Android (and Android then iOS) | **today: nothing stops it.** "Change plan" opens the store's plan picker on whichever phone the host uses (`my_subscription_screen.dart:506`); the app never calls purchase-intent (NEW-225) | `purchase-intent` would answer `blocked`, `active_subscription_other_provider`, with the old store's link | not prevented in the app (NEW-225) | `bill-07-09-intent-and-duplicate` (server answer), `p9c-channel-matrix` |
| 4a | … so the second purchase arrives | the new store's plan is current. **No notice yet** that the old store plan still renews: `GET /host/subscription/current` returns only the entitling row (NEW-225) | the new row is the one entitlement; the old row PENDING_CANCEL with the note "cancel the Apple subscription yourself" (visible to support, not to the host) | one entitlement; the old store bills again at its renewal → 4b | `p9c-channel-matrix` |
| 4b | … and the old store renews it | app: "You may be billed twice — An older subscription through App Store is still billing. Cancel it there so you are not charged twice." with "Open subscriptions" (`billing_notice.dart:108`); the CMS billing page shows the same notice (`billing-notices.ts:99`); from `duplicateBilling`, `duplicateBillingPlatform`, `duplicateBillingManageUrl` on `GET /host/subscription/current` | the renewal is recorded on the old row, which **stays superseded**; `duplicate_billing = 1`; alert `billing_duplicate_billing` | **yes, real double billing at the stores**, shown to the host and to support (section 3) | `p9c-channel-matrix`, `bill-07-09-intent-and-duplicate` |
| 5 | iOS (or Android) then bank transfer | while the store plan renews: the CMS shows "Your plan is billed by Apple and renews automatically. Change or cancel it in the GymsEra app; bank transfer opens once that plan is cancelled or has ended." and no form | `GET /host/plan-payments` `blocked: store_plan_active`; `POST` 409; an admin approval 409 too | prevented | `p9c-plan-payment` (Apple and Google separately) |
| 5a | … store plan cancelled (auto-renew off) or ended (EXPIRED, REVOKED) | the form at once | the approval supersedes the store row: CANCELLED "Auto-renew was already off at Apple — no action needed"; the bank period starts at the end of the paid store period (no paid day lost) | no | `p9c-plan-payment` |
| 6 | bank transfer then iOS / Android | the app sells normally (no block: a bank plan does not renew by itself) | the store row is the entitlement; the bank row CANCELLED "Replaced by a new Apple subscription … no action needed" | no; **the unused paid bank days are not refunded or carried over** (NEW-224) | `p9c-channel-matrix` |
| 7 | bank transfer then bank transfer (renewal) | the form again (one pending at a time) | the new period starts at the end of the running **paid** plan | no | `p9c-channel-matrix`, `p9c-plan-payment` |
| 8 | expired, then renewed by Apple / Google / bank | first the lapse view (R-82): "Plan ended", branches stay open for 7 days, then locked; after renewal the plan is current again | no entitling row → the new one is created fresh; capacity reconciled; branch billing locks lifted | no | `p9c-channel-matrix` (all three) |
| 9 | pay later (14-day grace) then bank transfer | the form | approval supersedes the GRACE row; **not extended** from its end (unpaid days are not carried) | no | `p9c-plan-payment` |

Not covered by an automated test, needs a device: a real Apple / Google sandbox purchase in each
direction (R-9), and NEW-210 / R-93 (one Apple ID on two host accounts).

## 3. When `duplicate_billing` is set (support note)

1. The host sees it on the CMS billing page and in the app; the alert `billing_duplicate_billing`
   fires (`billing-events.md#billing_duplicate_billing`).
2. Read-only check (platform DB):
   `SELECT id, platform, status, auto_renew, end_date, status_note FROM tenant_subscriptions WHERE tenant_id = '<tenant id>' ORDER BY created_at;`
   The row with `duplicate_billing = 1` is the one still billing.
3. Tell the host to cancel that subscription in the store (link in the notice). GymsEra cannot cancel
   an Apple or Google subscription server-side. A refund of the extra charge is requested by the
   host from Apple / Google (Apple: reportaproblem.apple.com; Google: Play order history).
4. Nothing to change in the database: the next store notification (cancel / expire) closes the row
   and clears the notice.

## 4. Bank transfer plan payments (R-95), for platform admins

CMS → Admin → **Plan payments** → "To check".
1. Open the receipt (every opening is audited: `PLAN_PAYMENT_PROOF_ACCESSED`).
2. Check the money is in the GymsEra account (amount and currency are the catalog's, fixed when the
   host sent it).
3. **Approve and activate**: the plan starts at once; its end is one month or one year after the
   end of the running paid plan, or after today. Refused (409) if the host has meanwhile bought a
   renewing store plan.
4. **Reject** with a reason the host sees; the host can send a new payment.

## 5. Payment proofs from travellers (item A)

Since P9c a proof is stored in the private store and opened only through `GET /payments/:id/proof`
(staff with `payments.view` on that branch, platform admins). Proofs sent **before** this deploy were
never stored (the old code saved only a path). They show "Proof not saved — ask the member to upload
it again". To list them, read-only, per tenant database (take the name from
`SELECT tenant_code, db_name FROM tenants WHERE db_name IS NOT NULL;`, never infer it, R-79):
`SELECT id, branch_id, user_id, amount, created_at FROM <db_name>.payments WHERE status = 'PENDING' AND proof_url LIKE '%/payment-proofs/%' AND proof_url NOT LIKE 'private:%';`

## 6. "Branches built 3 of 1" with a plan named "Subscription"

The host's entitling row is a legacy package row (`platform_package_id` set, `branch_count` NULL),
created by web signup with bank transfer (`tenant.service.js:330`) or the admin "assign package"
form, typically the seeded "Starter" (Rs 4,999, 1 branch). The CMS now names it "Starter (legacy
package)". The tenant has more ACTIVE branches than the package allows, so it is over quota: after
the 7-day over-quota grace (R-3) the extra branches lock. Read-only check:
`SELECT s.id, s.status, s.payment_status, s.amount, p.name, p.max_branches FROM tenant_subscriptions s JOIN platform_packages p ON p.id = s.platform_package_id WHERE s.tenant_id = '<tenant id>' AND s.status IN ('ACTIVE','GRACE');`
The fix for the host is a real plan: buy it in the app, or pay by bank transfer in the CMS (R-95);
either supersedes the legacy row. Converting legacy rows in bulk is a data decision (R-6).

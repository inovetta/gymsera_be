# GymsEra Unified Billing — Staging Verification Test Plan

**Audience:** whoever executes staging verification (QA engineer / developer with staging access).
**Purpose:** real-provider execution of every scenario the code-level audit could not verify. Nothing in this
document may be marked PASS from code inspection alone — every row needs a real purchase, a real webhook
delivery, or a real database query run against staging.

**Format for every scenario:** `Scenario → Steps → Expected → Actual → Evidence → PASS/FAIL`. Fill in *Actual*,
*Evidence*, and *PASS/FAIL* as you go — everything else is pre-filled so execution doesn't require re-deriving
what to do. If a scenario fails, stop, find the root cause, fix it, re-test that scenario, then re-run the
regression scenarios listed in §7 before continuing.

**Do not modify** `reconcileCapacity`, `subscription-quota.service.js`, `CapacityEvent`, or the branch
lifecycle/capacity architecture to make a test pass — if a failure traces back to that code, stop and report it
instead of patching it.

---

## 0. Prerequisites — must be done before any test below can run

- [ ] Backend deployed to staging with every variable in §7 of the readiness report set (`APPLE_IAP_*`,
      `GOOGLE_PLAY_*`, `STRIPE_*`).
- [ ] **Google Play**: service account linked in Play Console (View financial data + Manage orders and
      subscriptions); 10 subscription products (`branches_1`…`branches_10`), each with monthly + annual base
      plans; **upgrade/downgrade eligibility enabled between each tier's base plans** (Monetize → Subscriptions
      → base plan → eligibility) — without this, every Android→Android scenario below will fail at the Play
      Billing sheet itself, not in GymsEra's code; real product/base-plan IDs written into `billing_plans` via
      the CMS Billing Plans page (replacing the `PLACEHOLDER_*` values `platform.js` seeded); Pub/Sub topic +
      push subscription at `POST /billing/webhooks/google?token=<GOOGLE_PLAY_RTDN_TOKEN>`; a License Tester
      account added; app uploaded to at least Internal Testing (a local debug build cannot complete a Play
      Billing purchase at all).
- [ ] **Stripe**: test-mode account; 10 Products/Prices created via the CMS Billing Plans page's "Sync Stripe
      Price" action per tier (requires `STRIPE_SECRET_KEY` set first); webhook endpoint registered at
      `POST /billing/webhooks/stripe` for `checkout.session.completed`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.payment_failed`, with its signing secret set as
      `STRIPE_WEBHOOK_SECRET`. If available, install the Stripe CLI (`stripe listen --forward-to
      <staging-url>/api/v1/billing/webhooks/stripe`) — makes the retry/idempotency scenarios far easier to
      trigger on demand instead of waiting for Stripe's own retry schedule.
- [ ] **Apple**: existing production config — nothing new required, this is a regression pass on an
      already-shipped, already-verified integration.
- [ ] Shell access to the staging server (or a tunnel to its platform DB) to run the evidence scripts below.
- [ ] One test tenant ID, noted here for the whole run: `TENANT_ID = ____________________`
- [ ] Confirm the two evidence scripts exist and run cleanly against staging before starting:
      `node src/scripts/check-tenant-entitlement.js <TENANT_ID>` and
      `node src/scripts/check-recent-capacity-events.js <TENANT_ID>`.

---

## 1. Evidence collection reference (reused in every scenario below)

**Primary evidence command** — run after every single scenario, paste its relevant output into the *Evidence*
column:

```
node src/scripts/check-tenant-entitlement.js <TENANT_ID>
```

This dumps: every `TenantSubscription` row (all statuses, not just ACTIVE) with platform/amount/cycle/external
IDs/statusNote, a flag if more than one row is `ACTIVE` (the single invariant every scenario below must never
violate), every `GymListing.reservedSlots`, and the last 15 `capacity_events` rows.

**Server log prefixes to tail concurrently** (`tail -f` the staging process output, or your log aggregator,
filtered to these):

```
[Apple Billing]       [Apple Webhook]
[Google Play Billing] [Google RTDN Webhook]
[Stripe Billing]      [Stripe Webhook]
[Android Sync]
```

**Manually re-sending a webhook payload** (for retry/idempotency scenarios) — capture the exact JSON body from
your webhook provider's own delivery log (Stripe Dashboard → Developers → Webhooks → an event's "Resend", or
Google Cloud Console → Pub/Sub → the subscription's message history) and re-POST it:

```
curl -X POST https://<staging-host>/api/v1/billing/webhooks/stripe \
  -H "Content-Type: application/json" -H "Stripe-Signature: <captured>" \
  --data-binary @captured-event.json

curl -X POST "https://<staging-host>/api/v1/billing/webhooks/google?token=<GOOGLE_PLAY_RTDN_TOKEN>" \
  -H "Content-Type: application/json" --data-binary @captured-rtdn.json
```

(Prefer the provider's own real retry — Stripe Dashboard's "Resend" button, or Pub/Sub's own redelivery after a
temporary 500 — over a hand-crafted curl replay wherever possible, since that's what actually happens in
production. Use curl only when you need to force a specific replay on demand.)

---

## 2. Google Play

### 2.1 First purchase
**Steps:** On the Internal Testing build, as a License Tester, open the branch plan picker (first-time host,
no existing subscription), select a tier, complete the Play Billing purchase sheet.
**Expected:** Purchase completes; app calls `POST /billing/android/sync`; a new `TenantSubscription` row is
created with `platform=ANDROID`, `status=ACTIVE`, correct `branchCount`/`amount`/`billingCycle`; a
`CapacityEvent` is recorded if this attributed new reservedSlots.
**Actual:** _____
**Evidence:** `check-tenant-entitlement.js` output + `[Android Sync]` log line + `[Google Play Billing]` log line.
**PASS/FAIL:** _____

### 2.2 Restore
**Steps:** Reinstall the app (or clear its data) on the same Google account with the purchase from 2.1 still
active. Trigger "Restore Purchases" in the app.
**Expected:** `restorePurchases()` redelivers the purchase; syncs idempotently — the *same* `TenantSubscription`
row is updated (same `id`), not duplicated.
**Actual:** _____
**Evidence:** entitlement dump before vs. after — same row `id`, `updated_at` refreshed.
**PASS/FAIL:** _____

### 2.3 Renewal
**Steps:** Either wait for a real renewal, or use a Play Billing test subscription with an accelerated renewal
cycle if configured. Confirm the RTDN `SUBSCRIPTION_RENEWED` notification arrives.
**Expected:** `[Google RTDN Webhook]` log shows the notification processed; `endDate` on the row advances;
`status` stays `ACTIVE`; no new `TenantSubscription` row created (same `externalOriginalTransactionId`); no
new `CapacityEvent` (a same-tier renewal doesn't change `branchCount`).
**Actual:** _____
**Evidence:** entitlement dump `end_date` before/after + RTDN log line.
**PASS/FAIL:** _____

### 2.4 Cancellation
**Steps:** Cancel the subscription from the Play Store app (Subscriptions → Cancel).
**Expected:** RTDN `SUBSCRIPTION_CANCELED` arrives; row stays `ACTIVE` with `autoRenew=false` until period end
(per the documented "expiry cron is the real deactivation point" rule) — confirm this matches, don't expect
immediate `CANCELLED`.
**Actual:** _____
**Evidence:** entitlement dump `auto_renew` flips to `0`, status still `ACTIVE` immediately after.
**PASS/FAIL:** _____

### 2.5 RTDN delivery
**Steps:** Trigger any RTDN-firing action above (renewal or cancellation) and confirm the push actually
arrives at the endpoint — check Pub/Sub delivery metrics in Google Cloud Console for the subscription.
**Expected:** 200 response logged; zero undelivered/dead-lettered messages for this test.
**Actual:** _____
**Evidence:** Pub/Sub delivery metrics screenshot + `[Google RTDN Webhook] ... received: true` log line.
**PASS/FAIL:** _____

### 2.6 RTDN retry / idempotency
**Steps:** Manually re-POST a captured RTDN payload for an already-processed notification (see §1).
**Expected:** Processed again without error, but no duplicate `TenantSubscription` row and no duplicate
`CapacityEvent` (same `idempotency_key` already present → `applied:false` internally, no double-apply).
**Actual:** _____
**Evidence:** `capacity_events` row count for the relevant `idempotency_key` — must stay exactly 1 after the replay.
**PASS/FAIL:** _____

### 2.7 Android → Android upgrade
**Steps:** As the host from 2.1, open the plan picker in its upgrade context (existing subscriber, higher
tier), select a higher branch count, same billing cycle, complete the purchase.
**Expected:** The **native Play Billing replacement sheet** appears (not a fresh "buy" sheet) — this alone
confirms `ChangeSubscriptionParam` wired correctly. After completion: new `TenantSubscription` row `ACTIVE`
with the new tier; old row's terminal state per §2.15 below; exactly one `ACTIVE` row total; `CapacityEvent`
reflects the upgrade.
**Actual:** _____
**Evidence:** entitlement dump (both rows) + screenshot of the replacement sheet.
**PASS/FAIL:** _____

### 2.8 Android → Android downgrade
**Steps:** Same as 2.7, but to a lower tier.
**Expected:** Same mechanism as 2.7; if the host currently has more real branches than the new tier allows,
`overQuotaCount` reflects it (confirm this via `reconcileCapacity`'s existing, unmodified trim logic — do not
expect real branches to be touched).
**Actual:** _____
**Evidence:** entitlement dump — `over_quota_count` and `reservedSlots` before/after.
**PASS/FAIL:** _____

### 2.9 Monthly → monthly
**Steps:** Upgrade/downgrade tier while staying on the monthly base plan.
**Expected:** New row's `billing_cycle = MONTHLY`; `amount` matches the new tier's monthly catalog price at
time of change.
**Actual:** _____
**Evidence:** entitlement dump.
**PASS/FAIL:** _____

### 2.10 Annual → annual
**Steps:** Same, staying on the annual base plan.
**Expected:** New row's `billing_cycle = YEARLY`; `amount` matches the new tier's annual price.
**Actual:** _____
**Evidence:** entitlement dump.
**PASS/FAIL:** _____

### 2.11 Monthly → annual
**Steps:** Change tier and billing cycle in the same action.
**Expected:** Succeeds via the same replacement mechanism (Play Billing supports a base-plan change as part of
a subscription update); new row reflects `YEARLY`.
**Actual:** _____
**Evidence:** entitlement dump.
**PASS/FAIL:** _____

### 2.12 Annual → monthly
**Steps:** Reverse of 2.11.
**Expected:** Same as above, `MONTHLY` on the new row.
**Actual:** _____
**Evidence:** entitlement dump.
**PASS/FAIL:** _____

### 2.13 Kill/restart app during replacement
**Steps:** Start an Android→Android change (2.7-style). After Google's purchase sheet confirms the purchase but
*before* the app finishes syncing to the backend, force-kill the app. Relaunch it.
**Expected:** On relaunch, the pending purchase redelivers via the normal purchase stream and completes the
sync automatically — no manual restore should be necessary, though performing one should also be harmless if
needed.
**Actual:** _____
**Evidence:** entitlement dump shows the change fully applied after relaunch, without further user action beyond opening the app.
**PASS/FAIL:** _____

### 2.14 Double-tap / change-plan concurrency
**Steps:** Rapidly tap "change plan" / submit twice in quick succession (or trigger two near-simultaneous
change requests if testable).
**Expected:** Play Billing itself should reject/ignore the second concurrent attempt, or both attempts resolve
to the same end state — never two different new tiers both applied, never two `ACTIVE` rows.
**Actual:** _____
**Evidence:** entitlement dump — exactly one `ACTIVE` row, one coherent end state.
**PASS/FAIL:** _____

### 2.15 Verify `linkedPurchaseToken`
**Steps:** After any Android→Android change (2.7–2.12), inspect the raw Google Play Developer API response for
the new purchase (`subscriptionsv2.get` — can be re-triggered via `check-tenant-entitlement.js` alongside a
manual API call, or by adding a temporary debug log in `getSubscriptionPurchase`) for a `linkedPurchaseToken`
field, and check what the OLD row's terminal state ended up as.
**Expected:** If `linkedPurchaseToken` is present and matches the old row's `external_original_transaction_id`:
old row is `CANCELLED` with `statusNote` = *"Replaced by an in-app plan change on ... — no action needed."* If
absent: old row falls back to `PENDING_CANCEL` with the "cancel it yourself" guidance — confirm the fallback
path itself still behaves correctly, even if the ideal `linkedPurchaseToken` path isn't observed.
**Actual:** _____
**Evidence:** entitlement dump `status`/`status_note` on the old row + note whether `linkedPurchaseToken` was present.
**PASS/FAIL:** _____

### 2.16 Verify exactly one ACTIVE entitlement
**Steps:** After *every* scenario above, this is already checked by `check-tenant-entitlement.js`'s own
`ACTIVE row count` line — treat any run showing more than 1 as an automatic FAIL of that scenario, and stop
immediately (this is the single most important invariant in the whole system).
**Expected:** Exactly 1, in every single check across this whole section.
**Actual:** _____
**Evidence:** the `ACTIVE row count:` line from every run in this section.
**PASS/FAIL:** _____

### 2.17 Verify exactly one capacity reconciliation / CapacityEvent
**Steps:** For each scenario that should change capacity (2.1, 2.7, 2.8), check `capacity_events` for exactly
one new row with the expected `action` (`SLOT_ATTRIBUTED_UPGRADE` or `SLOT_TRIMMED_DOWNGRADE`) and a unique
`idempotency_key` — never two rows for what should be one logical change.
**Expected:** One row per real change, matching `reconcileCapacity`'s documented behavior.
**Actual:** _____
**Evidence:** `capacity_events` section of the entitlement dump.
**PASS/FAIL:** _____

---

## 3. Stripe

### 3.1 Checkout
**Steps:** From the website's registration wizard (card payment option) or the GymsEra Billing "Change plan"
flow, initiate `POST /billing/stripe/checkout-session` and open the returned URL.
**Expected:** Stripe's real Checkout page loads with the correct tier/price.
**Actual:** _____ **Evidence:** _____ **PASS/FAIL:** _____

### 3.2 Successful payment
**Steps:** Complete Checkout with a Stripe test card (`4242 4242 4242 4242`).
**Expected:** Redirects to the success URL; **the redirect itself grants nothing** — the entitlement only
appears once the webhook lands (verify by checking the entitlement dump immediately after redirect, before the
webhook has necessarily arrived, and again a few seconds later).
**Actual:** _____ **Evidence:** entitlement dump at both points in time. **PASS/FAIL:** _____

### 3.3 Webhook delivery
**Steps:** Confirm `checkout.session.completed` actually reached the endpoint (Stripe Dashboard → Developers →
Webhooks → this endpoint → recent deliveries).
**Expected:** 200 response logged; `TenantSubscription(platform=STRIPE, status=ACTIVE)` created.
**Actual:** _____ **Evidence:** Stripe Dashboard delivery log + entitlement dump. **PASS/FAIL:** _____

### 3.4 Webhook retry / idempotency
**Steps:** Use Stripe Dashboard's "Resend" on the same event (or `stripe events resend <id>` via the CLI).
**Expected:** Processed again without error; same `TenantSubscription` row updated, not duplicated; no new
`CapacityEvent` (same Stripe event ID → same idempotency key → no double-apply).
**Actual:** _____ **Evidence:** row `id` unchanged, `capacity_events` count unchanged. **PASS/FAIL:** _____

### 3.5 Cancellation
**Steps:** Cancel via the restricted Stripe Portal session (GymsEra Billing → "Manage payment method &
invoices" → Cancel), or directly in the Stripe Dashboard for a faster test cycle.
**Expected:** `customer.subscription.deleted` fires; row routes through `syncSubscriptionFromStripeObject` and
becomes `CANCELLED`.
**Actual:** _____ **Evidence:** entitlement dump status transition. **PASS/FAIL:** _____

### 3.6 Same-provider upgrade
**Steps:** As an active Stripe subscriber, use GymsEra Billing's "Change plan" (`POST
/billing/stripe/change-plan`) to move to a higher tier.
**Expected:** The Stripe subscription **ID stays the same** (verify in the Stripe Dashboard); no new Stripe
subscription object created; `customer.subscription.updated` fires; the *same* `TenantSubscription` row updates
in place (direct-update path, never reaching `subscription-migration.service.js`); `CapacityEvent` reflects the
upgrade, keyed by the Stripe **event ID**, not the subscription ID.
**Actual:** _____ **Evidence:** Stripe subscription ID before/after (identical) + entitlement dump (same row
`id`, new `branch_count`/`amount`) + capacity_events. **PASS/FAIL:** _____

### 3.7 Same-provider downgrade
**Steps:** Reverse of 3.6.
**Expected:** Same mechanism; `overQuotaCount` reflects any real-branch overage per the unmodified
`reconcileCapacity` trim logic.
**Actual:** _____ **Evidence:** entitlement dump. **PASS/FAIL:** _____

### 3.8 Stripe portal restrictions
**Steps:** Open a Portal session (`POST /billing/stripe/portal-session`) as an active Stripe subscriber and
inspect the real Stripe-hosted page.
**Expected:** Payment method update, invoice history, and cancellation are available; **"update
subscription" / plan-change is NOT offered anywhere in the Portal UI** — GymsEra's own catalog must remain the
only source of plan choices.
**Actual:** _____ **Evidence:** screenshot of the Portal page. **PASS/FAIL:** _____

### 3.9 Duplicate/concurrent webhook scenarios
**Steps:** Trigger two events for the same subscription close together (e.g. a plan change immediately
followed by a manual "Resend" of the resulting `customer.subscription.updated` event), or use `stripe trigger
customer.subscription.updated` twice back-to-back via the CLI if available.
**Expected:** Exactly one `ACTIVE` row throughout; no duplicate `CapacityEvent`; final state matches the last
real change.
**Actual:** _____ **Evidence:** entitlement dump. **PASS/FAIL:** _____

### 3.10 Capacity reconciliation
**Steps:** Cross-check every Stripe scenario above that should move capacity (3.3, 3.6, 3.7) against
`capacity_events`.
**Expected:** One row per real change, correct `action`/`delta`.
**Actual:** _____ **Evidence:** capacity_events section. **PASS/FAIL:** _____

---

## 4. Apple (regression — already shipped, verify nothing broke this session)

This session changed two things in `apple-billing.service.js`: the amount-preservation fix (renewals no longer
recompute `amount`/`billingCycle` from the current catalog price) and the migration hook (a brand-new Apple
purchase for a tenant already on a different provider now routes through `subscription-migration.service.js`).
Everything else in the Apple flow is untouched.

### 4.1 Regression — existing purchase flow
**Steps:** A fresh Apple sandbox purchase, first-time subscriber.
**Expected:** Identical behavior to the already-verified pre-session flow — `TenantSubscription(platform=IOS)`
created, capacity correct.
**Actual:** _____ **Evidence:** entitlement dump. **PASS/FAIL:** _____

### 4.2 Renewal
**Steps:** Sandbox-accelerated renewal (or real renewal).
**Expected:** **Specifically verify the amount-preservation fix**: edit the tier's catalog price in the CMS
Billing Plans page *before* the renewal fires, then confirm the renewed row's `amount` stays at the
subscriber's *original* locked-in price, not the new catalog price.
**Actual:** _____ **Evidence:** entitlement dump `amount` before/after the catalog edit and renewal. **PASS/FAIL:** _____

### 4.3 Cancellation
**Steps:** Cancel from Settings → Apple ID → Subscriptions.
**Expected:** Same as always — stays `ACTIVE`/`autoRenew=false` until period end.
**Actual:** _____ **Evidence:** entitlement dump. **PASS/FAIL:** _____

### 4.4 Same-provider upgrade/downgrade
**Steps:** Change tier while remaining on Apple.
**Expected:** Same `originalTransactionId`, direct-update path (never reaching the migration service);
`CapacityEvent` reflects the change.
**Actual:** _____ **Evidence:** entitlement dump (same row `id`) + capacity_events. **PASS/FAIL:** _____

### 4.5 Restore
**Steps:** Reinstall, restore purchases.
**Expected:** Unchanged, idempotent.
**Actual:** _____ **Evidence:** entitlement dump. **PASS/FAIL:** _____

### 4.6 Entitlement and capacity remain correct
**Steps:** Cross-check all of 4.1–4.5 for exactly one `ACTIVE` row throughout and correct `capacity_events`.
**Expected:** No regression versus the prior, already-verified Apple behavior.
**Actual:** _____ **Evidence:** entitlement dump. **PASS/FAIL:** _____

---

## 5. Cross-provider migration — all six directions

For **every** direction below, record all eight checks in one pass. Start each direction from a tenant with a
real, active subscription on the "from" provider (use the corresponding purchase/checkout flow above to get
there first).

**The eight checks, for every direction:**
1. Old provider state (terminal status: `SCHEDULED` for a Stripe *old* provider, `PENDING_CANCEL` — or
   `CANCELLED` with "no action needed" for the Android `linkedPurchaseToken` case — for Apple/Google)
2. New provider state (`ACTIVE`, correct platform)
3. Exactly one `ACTIVE` `TenantSubscription` throughout
4. Correct `amount` and `billing_cycle` on the new row
5. No duplicate entitlement (old row never deleted, never left `ACTIVE`)
6. Correct capacity (`reservedSlots`/`overQuotaCount` reflect the new tier)
7. Exactly-once/idempotent `CapacityEvent` for the migration
8. Retry/replay safety — re-deliver the new provider's own webhook/sync for this same purchase and confirm no
   second migration is triggered (the row now exists, so the retry takes the direct-update path, never
   `subscription-migration.service.js` again)

| Direction | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Evidence | PASS/FAIL |
|---|---|---|---|---|---|---|---|---|---|---|
| Apple → Google | | | | | | | | | | |
| Apple → Stripe | | | | | | | | | | |
| Google → Apple | | | | | | | | | | |
| Google → Stripe | | | | | | | | | | |
| Stripe → Apple | | | | | | | | | | |
| Stripe → Google | | | | | | | | | | |

For each row, attach: the entitlement dump immediately after the migration purchase completes, and again after
step 8's replay.

---

## 6. Catalog / pricing

### 6.1 All 10 tiers, both cycles, via the real Super Admin catalog
**Steps:** Open the CMS Billing Plans page, confirm all 10 branch-count tiers are listed with the exact seeded
PKR values (1 branch = 5,000/47,999 … 10 branches = 50,000/300,000 — see `platform.js`'s seed block for the
full table).
**Expected:** All 10 present, correct monthly/annual values, correct `sortOrder`.
**Actual:** _____ **Evidence:** screenshot/export of the CMS table. **PASS/FAIL:** _____

### 6.2 Mobile and web consume the same catalog
**Steps:** Compare `GET /billing/plans?platform=android`, `?platform=ios`, and `?platform=web` responses for
the same tier side by side.
**Expected:** Identical `branchCount`/`monthlyPrice`/`annualPrice`/`currency` across all three — only the
provider-specific product/price ID fields differ.
**Actual:** _____ **Evidence:** three raw API responses. **PASS/FAIL:** _____

### 6.3 No hardcoded prices
**Steps:** Change one tier's price in the CMS. Reload the Flutter app's plan picker, the website's plan card,
and the CMS catalog page.
**Expected:** All three reflect the new price on next load — none of them show a stale, locally-cached number.
**Actual:** _____ **Evidence:** before/after screenshots of all three. **PASS/FAIL:** _____

### 6.4 Existing subscribers retain their stored subscription amount
**Steps:** With an existing ACTIVE subscriber on each provider (Apple/Google/Stripe), change that tier's
catalog price in the CMS. Force a renewal/resync for each subscriber (accelerated sandbox renewal, or a manual
re-sync call).
**Expected:** Each subscriber's `TenantSubscription.amount` stays at their original locked-in price — the
catalog edit must not propagate to any of them. This is the single most important pricing-integrity check in
this whole plan.
**Actual:** _____ **Evidence:** entitlement dump `amount` before/after the catalog edit + renewal, for all three providers. **PASS/FAIL:** _____

### 6.5 Catalog price changes affect only new purchases
**Steps:** After the same catalog edit from 6.4, have a **new** subscriber (any provider) purchase that tier
for the first time.
**Expected:** Their `TenantSubscription.amount` reflects the **new** catalog price (for Stripe, only if
"Sync Stripe Price" was also run — confirm this distinction explicitly, since a catalog price edit alone does
not create a new Stripe Price until that action is taken).
**Actual:** _____ **Evidence:** entitlement dump for the new subscriber. **PASS/FAIL:** _____

### 6.6 Provider mapping/status is correct
**Steps:** In the CMS Billing Plans page, check the iOS/Android/Stripe sync-status badges for each tier after
the actions above.
**Expected:** Stripe shows `SYNCED` after "Sync Stripe Price" is run, `PENDING` immediately after a price edit
before that action; iOS/Android show whatever the admin has manually attested via "Mark as synced" — confirm
these reflect reality, not a stale default.
**Actual:** _____ **Evidence:** CMS screenshot. **PASS/FAIL:** _____

---

## 7. Regression suite

Once staging has a real database, the existing integration suite (`npm test` in `gymsera_be`) becomes runnable
for the first time in this verification process (it requires a live server + DB, which the original sandboxed
audit did not have).

**Steps:** Point the suite's target at the staging API (`API_BASE_URL` or equivalent env var the test client
reads — confirm the exact var name in `tests/` setup), run `npm test`.
**Expected:** All existing tests pass — this is a regression check on everything *outside* billing (auth,
tenants, access, host, etc.) that this session's changes should not have touched at all.
**Actual:** _____ **Evidence:** full `npm test` output. **PASS/FAIL:** _____

Also re-run this after fixing any root cause found anywhere above, per the "fix the root cause, retest, then
regress" rule.

---

## 8. Final report template

Fill this in once every section above is complete — this is the exact structure to hand back:

1. **Passed staging tests** — list every scenario ID (e.g. "2.1, 2.2, 2.3...") that reached PASS.
2. **Failed tests and root causes** — scenario ID, what broke, why (the actual root cause, not just symptoms).
3. **Fixes made during staging** — exact files/functions changed in response to a failure, and which scenario
   was re-tested afterward to confirm the fix.
4. **Database/entitlement evidence** — the key `check-tenant-entitlement.js` outputs that prove correctness
   (attach or summarize; at minimum, one example of an "exactly one ACTIVE row" confirmation per provider and
   per migration direction).
5. **CapacityEvent evidence** — the key rows proving exactly-once reconciliation for at least one upgrade,
   one downgrade, and one migration per provider.
6. **Provider webhook/RTDN evidence** — delivery confirmations from Stripe Dashboard and Google Cloud Pub/Sub
   metrics.
7. **Remaining configuration requirements** — anything from §0 that turned out to still be missing or
   misconfigured.
8. **Remaining known issues** — anything intentionally deferred (e.g. the `linkedPurchaseToken` fallback
   behavior, if Google's real response didn't include it as expected).
9. **Production deployment checklist** — the exact ordered steps to go from staging-verified to live (env var
   swap from test to production keys, real Play Console track promotion, Stripe live-mode switch, etc.).
10. **Final status** — `PRODUCTION READY` only if every scenario in §§2–6 reached PASS with real evidence, and
    §7's regression suite passed. Otherwise `NOT PRODUCTION READY`, with the specific blocking scenarios named.

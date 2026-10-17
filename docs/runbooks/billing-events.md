# Billing event alerts (OBS-05)

Source: `src/services/billing-event.service.js#sweepBillingAlerts`, run every minute with the inbox sweep
(`server.js`) and daily by the expiry cron. Every Apple, Google Play and Stripe notification is stored in
`billing_events` (platform DB) before it is processed, and each event carries the tenant it is about once that is known
(`tenant_id`, p022; rows from before p022 and events no tenant owns have none).

Look at the events in the admin API: `GET /admin/billing-events?tenantId=<id|none>&status=<RECEIVED|PROCESSED|IGNORED|FAILED>&provider=<APPLE|GOOGLE|STRIPE>`.
Rows flagged `"stuck": true` are the ones these alerts are about. The raw provider payload is not returned; it stays in the
`raw_payload` column (platform DB) for the sweep to reprocess.

Alerts carry counts and tenant ids only. `unattributedEventCount` counts events with no tenant (not an error by itself:
a notification can arrive before the app has synced the purchase).

## BILLING_EVENT_UNPROCESSED

**What it means**
`eventCount` events have been `RECEIVED` for more than 10 minutes (`oldestAgeMinutesCount` for the oldest). The minute
sweep (`processPendingEvents`) should have processed them within a minute or two, so the sweep itself is not running or is
failing before it reaches the event. Subscriptions may be stale: a renewal, refund or revoke has not been applied.

**First checks**
1. Is the API process up and is the cron running? Look for `[Cron] billing-events sweep error` in the logs, and for the lock `cron:billing-events` being held (a hung run holds it for up to 2 minutes).
2. `GET /admin/billing-events?status=RECEIVED` and look at `provider` and `tenantName`: one provider only points at that provider's processing path or credentials; all providers point at the sweep or the database.
3. Check the platform database is reachable and not read-only, and that Redis being off is not the cause (the lock falls back to MySQL `GET_LOCK`).
4. If the host runs serverless (Vercel), the minute job does not run there; only the daily cron does. Events then wait up to a day: expected on that hosting, so run the sweep by hand (below).

**Rollback**
Nothing is applied until the sweep runs, so there is nothing to undo. Restart the API process to clear a stuck lock, or run
`node -e "require('dotenv').config(); require('./src/services/billing-event.service').processPendingEvents({limit:500}).then(console.log)"` from the API
folder. If a deploy broke the sweep, roll the deploy back first. The alert repeats at most hourly while events stay stuck.

## BILLING_EVENT_FAILED

**What it means**
`eventCount` events failed at least 5 times (the retry threshold, `ALERT_AFTER_ATTEMPTS`); `maxAttemptsCount` is the highest count.
After 20 attempts the sweep stops retrying a row. A tenant's subscription may be wrong until this is fixed (for example a renewal
or refund that was never applied).

**First checks**
1. `GET /admin/billing-events?status=FAILED`: read `lastError` and `tenantName`. Provider API errors (timeouts, 401) point at credentials or an outage; "signature" or "verify" errors point at keys or certificates (Apple root certs, Google RTDN audience, `STRIPE_WEBHOOK_SECRET`).
2. If all failures share one provider, check that provider's credentials in the environment and its status page.
3. If only one tenant, open its subscription rows (`GET /admin/tenants/<tenantId>/subscriptions`): a mismatch between the store's truth and our row is the thing to fix.
4. Webhooks rejected at the door (bad signature) are answered with an error and not stored, so they never appear here; look for `[Apple Webhook] Rejected unverifiable payload` or `[Stripe Webhook] Rejected unverifiable event` in the logs.

**Rollback**
Fixing the cause is enough for the events to succeed; they are reprocessed from the stored payload. To retry a row now, set its
`attempts` back to `0` and `status` to `RECEIVED` in `billing_events` (platform DB) for that row only; the next minute sweep picks it up.
To close an event that no longer matters, set `status = 'IGNORED'` and put the reason in `last_error`. There is no admin button for
this yet, and an unresolved FAILED row keeps the alert coming hourly. Never delete rows: they are the billing audit trail.

## BILLING_DUPLICATE_BILLING

**What it means**
`tenantCount` tenants have a superseded subscription (for example an old Apple plan after moving to Google) that the provider
still reports as billing (`tenant_subscriptions.duplicate_billing`, BILL-09). The tenant is being charged twice. The host also sees a
banner with a link to cancel the old subscription in the right store.

**First checks**
1. `GET /admin/tenants/<tenantId>/subscriptions`: find the row with the duplicate flag and its `platform`.
2. Confirm in the provider's console (App Store Connect, Play Console, Stripe) that the superseded subscription is still active and renewing.
3. Check the tenant's current plan is the intended one and entitling (the flag is about the old row only).

**Rollback**
Nothing was changed automatically. The tenant (or support, with the tenant's consent) cancels the old subscription in the store it
came from. Do not cancel it from our side without the tenant: it may be the plan they want. For a Stripe duplicate that is clearly a
mistake, cancel it in Stripe and refund per policy, then tell the tenant.

**Known gap: the flag does not clear itself.** Nothing in the code resets `duplicate_billing` once the store stops billing
(`subscription-migration.service.js` only ever sets it), so after the tenant has cancelled, set `duplicate_billing = 0` on that
`tenant_subscriptions` row (platform DB), or this alert and the host's banner keep coming back. Tracked as a follow-up (NEW-89).

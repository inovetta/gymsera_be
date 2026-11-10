# Runbooks (OBS-09)

One file per group of alerts. Every alert code in `src/services/alert.service.js` (`ALERTS`) has a
section here headed with the code, and its notification carries the link. A test
(`tests/regression/obs-06-alert-service.test.js`) fails if a code has no section or a section is
missing **What it means**, **First checks** or **Rollback**.

| Alert code | Runbook |
|---|---|
| (launch day, not an alert) | [launch-wipe.md](launch-wipe.md) |
| `CAPACITY_DRIFT` | [capacity-audit.md](capacity-audit.md#capacity_drift) |
| `CAPACITY_EMPTY_ACTIVE_ORG` | [capacity-audit.md](capacity-audit.md#capacity_empty_active_org) |
| `CAPACITY_AUDIT_FAILED` | [capacity-audit.md](capacity-audit.md#capacity_audit_failed) |
| `BILLING_EVENT_UNPROCESSED` | [billing-events.md](billing-events.md#billing_event_unprocessed) |
| `BILLING_EVENT_FAILED` | [billing-events.md](billing-events.md#billing_event_failed) |
| `BILLING_DUPLICATE_BILLING` | [billing-events.md](billing-events.md#billing_duplicate_billing) |
| `BILLING_PRICE_MISMATCH` | [billing-prices.md](billing-prices.md#billing_price_mismatch) |
| `BILLING_PRICE_CHECK_FAILED` | [billing-prices.md](billing-prices.md#billing_price_check_failed) |
| `TENANT_SCHEMA_BEHIND` | [tenant-schema.md](tenant-schema.md#tenant_schema_behind) |
| `DEVICE_STORAGE_FULL` | [devices.md](devices.md#device_storage_full) |
| `DEVICE_GRANTED_NOT_DESIRED` | [devices.md](devices.md#device_granted_not_desired) |

## Procedures (not tied to an alert code)

| Procedure | Runbook |
|---|---|
| Slow query log and the weekly index review (OBS-04) | [slow-queries.md](slow-queries.md) |
| Burned secrets and rotating `TENANT_CONN_ENCRYPTION_KEY` (SEC-05); the tenant database password and its connection strings (NEW-203, section 3b); the launch rotation list (P10); `BIOMETRIC_DATA_KEY` (section 3c) | [secrets-rotation.md](secrets-rotation.md) |
| Apple: one subscription per group per Apple ID, two host accounts on one Apple ID (NEW-210, accepted) | [billing-events.md](billing-events.md#apple-one-subscription-per-group-per-apple-id-new-210-accepted-limitation) |
| Backend tests on a future day: date bombs, the libfaketime MySQL check (NEW-207) | [test-date-bombs.md](test-date-bombs.md) |
| Redis warnings, running without Redis (R-88) | [redis.md](redis.md) |
| One host plan across Apple, Google Play and bank transfer: the channel matrix, `duplicate_billing` support steps, approving bank-transfer plan payments (R-95), payment proofs sent before P9c, a legacy package plan (P9c) | [billing-channels.md](billing-channels.md) |
| A tenant approved but not ACTIVE: provisioning stopped or stalled (FLOW-02, NEW-34) | [provisioning-failure.md](provisioning-failure.md) |
| Production and staging on one server: separate databases, no copied `.env`, checks after every deploy (NEW-127, NEW-131, NEW-134) | [production-environments.md](production-environments.md) |
| ZKTeco access devices: the sync engine, the four device jobs and their Task Scheduler entries, where to look (Phase 2) | [devices.md](devices.md) |
| ZKTeco Push devices, Phase 0 spike: capture server on a Mac, device tests (a) to (g), restoring the device (spec `ZKTECO_PUSH_DEVICE_SYNC.md` §15) | [zkteco-phase0-checklist.md](zkteco-phase0-checklist.md) |

## How alerts arrive

- An in-app notification (type `PLATFORM_ALERT`, high priority) to every ACTIVE platform admin.
- A Sentry message tagged `alertCode`, only when `SENTRY_DSN` is set. Without it nothing is sent and the SDK is not loaded.
- A log line starting `[Alert] <CODE>`.
- At most **one alert per code per hour**. A condition that persists alerts again an hour later, so "no new alert" does not mean "fixed": check the cause.
- Alerts carry ids and counts only (no names, e-mails or free text). Look the ids up in the platform DB.

## Adding an alert

1. Add the code to `ALERTS` with its runbook link.
2. Add a section here and in the runbook file, using the four-part layout below.
3. Raise it with `alertService.raise(code, { fooCount, fooIds })` (aggregate: one call per run, not per tenant).

Layout of every section: **What it means**, **First checks**, **Rollback**, and (when needed) **Escalate**.

# Runbooks (OBS-09)

One file per group of alerts. Every alert code in `src/services/alert.service.js` (`ALERTS`) has a
section here headed with the code, and its notification carries the link. A test
(`tests/regression/obs-06-alert-service.test.js`) fails if a code has no section or a section is
missing **What it means**, **First checks** or **Rollback**.

| Alert code | Runbook |
|---|---|
| `CAPACITY_DRIFT` | [capacity-audit.md](capacity-audit.md#capacity_drift) |
| `CAPACITY_EMPTY_ACTIVE_ORG` | [capacity-audit.md](capacity-audit.md#capacity_empty_active_org) |
| `CAPACITY_AUDIT_FAILED` | [capacity-audit.md](capacity-audit.md#capacity_audit_failed) |
| `BILLING_EVENT_UNPROCESSED` | [billing-events.md](billing-events.md#billing_event_unprocessed) |
| `BILLING_EVENT_FAILED` | [billing-events.md](billing-events.md#billing_event_failed) |
| `BILLING_DUPLICATE_BILLING` | [billing-events.md](billing-events.md#billing_duplicate_billing) |
| `BILLING_PRICE_MISMATCH` | [billing-prices.md](billing-prices.md#billing_price_mismatch) |
| `BILLING_PRICE_CHECK_FAILED` | [billing-prices.md](billing-prices.md#billing_price_check_failed) |

## Procedures (not tied to an alert code)

| Procedure | Runbook |
|---|---|
| Slow query log and the weekly index review (OBS-04) | [slow-queries.md](slow-queries.md) |
| Burned secrets and rotating `TENANT_CONN_ENCRYPTION_KEY` (SEC-05) | [secrets-rotation.md](secrets-rotation.md) |

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

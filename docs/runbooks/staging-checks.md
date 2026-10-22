# Staging checks (spec §16, §17.4, §17.12)

Script: `scripts/staging/staging-check.js`. It runs only on staging and says so before it does anything.

## Start conditions (all required, otherwise it exits 2 and runs nothing)

- `--env=staging` on the command line **and** `GYMSERA_ENV=staging`.
- `NODE_ENV` is not `production`.
- `STAGING_DB_HOSTS` lists the platform database host; the host is not in `PRODUCTION_DB_HOSTS` and has no "prod" in its name.
- `STRIPE_SECRET_KEY` is not a live key; `APPLE_IAP_ENVIRONMENT` is not `Production`.

## Checks

| Flag | What it does | Changes data? |
|---|---|---|
| `--purchases --google-token <t> --apple-transaction <id>` | Asks Google/Apple about the purchase and passes only if the store calls it a sandbox/test purchase. | No. With `--apply --tenant <id>` it runs the real sync into that staging tenant. |
| `--audit` | `auditCapacity` for every ACTIVE tenant. Fails on drift, errors, or a tenant with no database connection. | No |
| `--reconcile` | Counts billing events stuck in RECEIVED over 10 min or FAILED, and subscriptions still ACTIVE/GRACE more than a day after their end date. | No |
| `--restore-drill` | `mysqldump` of the platform database into `restore_drill_<yyyymmdd_hhmmss>` on the same server, compares row counts per table, drops it. `--keep-drill` keeps it. | Creates and drops only that database |
| `--drop-old-drills` | Drops leftover `restore_drill_*` databases. | Drops only names matching `restore_drill_<8 digits>_<6 digits>` |

No flag runs `--audit`, `--reconcile` (not `--purchases`; it needs a token). The restore drill is explicit.

`mysqldump` and `mysql` must be on `PATH` and new enough to log in to the server (a MySQL 9 client cannot log in to 5.7).
Exit codes: 0 green, 1 a check failed, 2 refused. Output has ids and counts only.

## Release-day use

Run all four once the release candidate is on staging, keep the JSON output with the release notes, and fix any failure before the freeze (2026-11-30).

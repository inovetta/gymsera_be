# Launch-day wipe: removing test data before real customers

Owner: Amir. Script: `src/scripts/reset-platform-data.js` (service `src/services/platform-reset.service.js`).
The database holds TEST data only (R-19), but the wipe is still irreversible. Do the steps in order and tick them.

## What the script does

- **Keeps:** `schema_migrations`, `billing_plans`, `billing_plan_prices`, `platform_packages`, `cities`, `areas`, and the platform admins you name with `--keep-admin`.
- **Empties:** every other platform table (including `billing_offers` and `billing_plan_price_checks`; see "Decide before the day").
- **Tenant databases:** untouched unless you pass `--drop-tenant-databases`; then only the names held in `tenants.db_name` are dropped, one log line each. A tenant with no `db_name` is skipped. The script never works a name out from `tenant_code`.
- **Does not touch:** object storage (R2 images/documents), Redis, Firebase push tokens, Stripe/Apple/Google sandbox data. Steps below cover them.
- Dry run is the default. A real run needs `--confirm --db <name> --host <host>` matching the environment. `--keep-admin a@x.com,b@y.com` is always required.

## Database names: read them, never infer them (R-79)

A tenant database name is **never inferred**: not from the `gymsera_<tenant code>` naming rule, not from this runbook, not from memory. Before any drop (this script, `drop-orphan-tenant-database.js`, or a drop by hand), read the name from the platform `tenants` table for that `tenant_code`, **immediately before the drop**, with this read-only query:

```sql
-- Read-only. On the platform database.
SELECT tenant_code, status, provisioning_state, db_name
FROM tenants
WHERE tenant_code = 'GYM-XXXXXXXX';
```

The same query is in `docs/sql/tenant-db-name-before-drop.sql`. On the API server, which has no mysql client, run it from the app folder with `node src/scripts/run-sql-check.js docs/sql/tenant-db-name-before-drop.sql` after you set the tenant code in its `SET` line.

- Use `db_name` exactly as printed. Do not type it from memory or copy it from a doc.
- **Stop, do not drop** if no row comes back, more than one row comes back, or `db_name` is NULL. NULL means provisioning never recorded a database, and the owner decides by hand.
- The dry run's `plan` line lists each tenant as `tenantCode` and `dbName`. Each pair must match what the query printed.

## Decide before the day

- [ ] Should `billing_offers` and `billing_plan_price_checks` be kept? Default: emptied. Ask for them to be added to the allow-list if wanted.
- [ ] Which platform admins stay (at least two, so one can recover the other).

## Before

- [ ] Release freeze is in effect; no mobile/CMS/web release is rolling out.
- [ ] Take a backup of the platform database and every tenant database named in `tenants.db_name` (`mysqldump`), and store it off the server. Read the names with the R-79 query; never infer them. Check the file sizes are not zero.
- [ ] Restore the platform dump into a scratch database on the staging MySQL and spot-check row counts (this doubles as the restore drill).
- [ ] Stop the API, workers and cron (`/cron/subscription-expiry`) so nothing writes during the wipe.
- [ ] Confirm `PLATFORM_DB_NAME`, `PLATFORM_DB_HOST` in the shell are the target you mean (`echo` them; no secrets).

## Run

1. Dry run, read the plan: `node src/scripts/reset-platform-data.js --keep-admin <emails>`
   - [ ] Every table you expect is `KEEP` or `EMPTY`; the user counts say `keep` = the admins you named.
   - [ ] The tenant database list is exactly the databases you expect to lose.
   - [ ] It includes the test gyms made for production checks: **GYM-16516973** (approved 2026-10-28 for the NEW-127 check). Its database name is the `db_name` the R-79 query prints for `tenant_code = 'GYM-16516973'`. It is not written here on purpose. If the wipe keeps tenant databases, remove that tenant and its database anyway, by the R-79 rule.
   - [ ] For every tenant whose database must go, run the R-79 query now and check that its `db_name` matches the plan's `dbName` for that `tenantCode`. Any difference, a missing row or a NULL `db_name`: stop.
2. Real run:
   `node src/scripts/reset-platform-data.js --keep-admin <emails> --confirm --db <name> --host <host>`
   Add `--drop-tenant-databases` in the same command if the tenant databases must go. The script reads the names from
   `tenants.db_name` in the same run, before it deletes the rows, so the flag cannot be used in a second run. Run the R-79 query
   again just before this command if anything changed since the dry run.
3. Check the last log line says `done`.
4. Keep `logs/reset-<time>.jsonl`; it lists what was removed (no e-mails).

## After

- [ ] Empty the R2 bucket prefixes for test uploads (gym images, documents) by hand.
- [ ] Flush Redis (`FLUSHDB` on the app's database only).
- [ ] Remove test device tokens in Firebase if any were registered.
- [ ] Revoke sandbox keys that must not reach production; confirm production keys (not sandbox) are set for Apple, Google Play, Stripe, per §16.
- [ ] Start the API. Log in as a kept admin. `GET /api/v1/billing/plans` returns the plans; cities and areas load.
- [ ] Run `auditCapacity` (see `capacity-audit.md`): zero findings on an empty platform.
- [ ] Register a fresh test host account in the app, run one sandbox purchase, delete it afterwards by hand.
- [ ] Re-enable cron and workers.

## Rollback

Restore the dumps taken in "Before" into the same database names, the ones the R-79 query printed before the wipe (stop the API first). If only part of the wipe ran, the platform-row delete is one transaction and is rolled back on error; tenant database drops are not, so restore those from the dumps.

## Escalate

If the script prints `REFUSED` it changed nothing; fix the flag it names. If it prints `FAILED` during a tenant database drop, stop, note the last log line, and restore that database from the dump before starting the API.

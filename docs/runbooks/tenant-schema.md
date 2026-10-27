# Tenant database schema (NEW-126, NEW-127)

Every tenant database must be at the tenant schema target (the last migration in
`src/database/tenant-migration-runner.js`). The API checks this read-only at startup and every
15 minutes (`TENANT_SCHEMA_CHECK_CRON`). The check covers ACTIVE, SUSPENDED and PENDING_DELETION
tenants: a suspended tenant goes live again when its subscription is renewed, and a deletion can be
cancelled, and neither path runs migrations.

Check by hand, from the API folder (read-only, exit 1 when anything is wrong; use it as a deploy gate):

    node src/scripts/run-tenant-migrations.js --check

## TENANT_SCHEMA_BEHIND

**What it means**
`behindCount` tenant databases (`tenantIds`, up to 20) are below the target, and `failedCount` could
not be read at all. While this is true, `GET /api/v1/health/tenant-schema` answers 503. Hosts of
those gyms get `database_error` (500) on any screen that reads a column a missing migration adds
(the Gyms tab for 019 `branches.currency`, NEW-124).

**First checks**
1. Run `node src/scripts/run-tenant-migrations.js --check`. Each `BEHIND` line names the tenant
   code, its version, the missing migrations and the command to fix it. The API error log has the
   same lines (`[TenantSchema] BEHIND`).
2. A tenant WITH `schema_migrations`: `node src/scripts/run-tenant-migrations.js --dry-run`, read the
   report, then run it without `--dry-run`.
3. A tenant with **NO schema_migrations table** (made before the runner existed, 2026-09-26; the
   runner refuses it): `node src/scripts/repair-tenant-schema.js --tenant <code>` (dry run: lists
   what is already there and what would run), then
   `node src/scripts/repair-tenant-schema.js --tenant <code> --apply --confirm <code>`.
   If it answers `REFUSED, unexpected schema`, stop: send the output. A conflict or a model column
   that no migration adds (NEW-126) needs a new migration first, not a manual ALTER.
4. `UNCHECKED` lines: the tenant database could not be reached (wrong stored connection, database
   dropped, MySQL down). Fix the connection; the check does not change anything.
5. Re-run step 1 until it prints `OK`. The health route turns 200 at the next scheduled check (or
   recycle the app pool).

**Rollback**
The check changes nothing. The runner's migrations are additive; see the deploy notes of the
migration concerned. The repair records baseline rows in `schema_migrations`; deleting that table
puts the database back to the state the repair started from (the missing migrations it ran stay).

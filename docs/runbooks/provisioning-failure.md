# Provisioning failure (FLOW-02, NEW-34)

Not tied to an alert code: nothing raises an alert when provisioning stops (adding a `PROVISIONING_FAILED` code is a possible follow-up).
You find out from the admin tenant page ("Provisioning… step n/6", with a **Resume** button and the last error) or an `APPROVED` tenant that never turns `ACTIVE`, a host asking why their gym is
not live, or the daily sweep line in the log (`[Cron] Provisioning sweep: N finished, M still failing` /
`[Provisioning sweep] Tenant <id> still not provisioned`).

Source: `src/services/tenant-provisioning.service.js`. Approving a tenant runs six steps in order, each recorded on the tenant row
(`provisioning_state`): `DB_CREATED`, `MODELS_SYNCED`, `LISTING_CREATED`, `BRANCH_CREATED`, `SUBSCRIPTION_LINKED`, `ACTIVE`. A run holds a
lease on the tenant (`provisioning_lock_token`, `provisioning_locked_until`, 10 minutes, renewed at every step). A failure releases the lease,
stores the error in `provisioning_error`, and leaves the tenant `APPROVED` at the last finished step. Every step looks for what it
already created before creating it, so repeating a step is safe.

## What it means

A tenant was approved but has not become ACTIVE. Three situations look the same from outside:
1. **A step failed** (database server unreachable, admin credentials rejected, a model sync error): `provisioning_error` is set, no lease is held.
2. **A run died** (process recycled, timeout): no error, a lease that has expired (or is about to).
3. **A run is still working**: a live lease. The admin screen shows the step; do nothing.

## First checks

1. Read the tenant row in the platform DB: `status`, `provisioning_state`, `provisioning_error`, `provisioning_locked_until`.
   - `provisioning_locked_until` in the future: a run is working. Wait 10 minutes before anything else.
   - `status = 'APPROVED'` and an error: note the message and the step; the cause is usually environmental.
2. Check the environment named by the error:
   - `MySQL admin connection failed for TENANT_DB_ADMIN_USER …`: `TENANT_DB_ADMIN_USER` / `TENANT_DB_ADMIN_PASS` are wrong or the server refuses them. No other credentials are tried (R-25).
   - A connection or timeout error: the database server (`max_connections`, load, restart). Look at the tenant pool metrics (`GET /metrics`, behind `METRICS_KEY`).
   - A model sync or migration error: compare the tenant schema version with `node src/scripts/run-tenant-migrations.js --dry-run`.
3. Run the read-only report: `node gymsera-flow02-provisioning-check.js`. Verdicts that matter here: `STUCK_APPROVED_NO_DB`,
   `STUCK_APPROVED_PARTIAL`, `ACTIVE_NO_LISTING`, `ACTIVE_NO_PLAN`, `DUPLICATE_GYM`, `ORPHAN_DATABASE`.
4. Check that the applicant did not get rejected in between (`status = 'REJECTED'`): a rejection while a lease is held answers 409 and marks the listing INACTIVE (NEW-34).

## Fix

- **Fix the cause first**, then resume. Resuming into the same fault only records the same error again.
- **Resume** = approve again: `POST /admin/tenants/:id/approve` (the admin "Resume" button; send a new `Idempotency-Key`). It continues from the
  last recorded step. `200` means ACTIVE; `202` means another run holds the lease; `502` means a step failed again (read the new error).
- **The sweep** also resumes a stalled tenant once a day (five per run) when its lease has expired and `provisioning_state` is recorded.
  Tenants approved by code older than FLOW-02 have no recorded state: resume those by hand.
- Do not edit `provisioning_state`, the lease columns or `status` in SQL to "unstick" a tenant. If a lease is stuck for more than 10 minutes it expires by itself.

## Rollback

Provisioning only ever adds things for one tenant, so there is nothing to undo for the other tenants. If the application must not go live:
1. Reject it through the admin screen (`POST /admin/tenants/:id/reject`): refused with 409 while a live lease is held, so wait for the lease to expire first.
2. A database left behind is reported as `ORPHAN_DATABASE` by the check script. It is **never dropped automatically** (R-28). Look at the report, then, if
   the verdict allows it, per database: `node src/scripts/drop-orphan-tenant-database.js <dbName>` (dry run), then with `--apply --confirm <dbName>`.
   `<dbName>` is never inferred (R-79). Immediately before the drop, read it from the platform `tenants` table for that `tenant_code`
   (`docs/sql/tenant-db-name-before-drop.sql`, read-only; the query is also in `launch-wipe.md`). No row, or a NULL `db_name`, means stop. The script
   refuses live tenants, tenants in the undo window, REJECTED under 90 days, DELETED under 6 years, databases holding payment, invoice or ledger rows,
   and any name that no `tenants.db_name` holds.

## Escalate

- The same tenant fails after the cause is fixed and `provisioning_error` is not environmental: keep the row as it is (it is the evidence), note the step and error, and open an issue with the tenant id (no names or e-mails).
- Many tenants stall on the same night: suspect a deploy, the database server, or the connection encryption key (`TENANT_CONN_ENCRYPTION_KEY`), not the tenants.
- A tenant that is `ACTIVE` but has no listing or no plan (`ACTIVE_NO_LISTING`, `ACTIVE_NO_PLAN`) was provisioned by pre-FLOW-02 code: report it; it needs a data correction decided by the owner, not a resume.

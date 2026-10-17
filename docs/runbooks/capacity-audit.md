# Capacity audit alerts (OBS-06)

Source: the nightly job `src/jobs/subscription-expiry.cron.js` (`_reconcileCapacityForAllTenants`).
It first reconciles each tenant's capacity (`reconcileCapacity`, self-healing), then runs the read-only
`auditCapacity` (`src/services/subscription-quota.service.js`) on what is left. The audit **never repairs**:
drift means the audit trail and reality disagree, and a human decides which is right.

Per tenant, the detail is also in the log as `CAPACITY AUDIT FAILED tenant <id>` plus one line per drifted listing.
The same audit for one tenant on demand: `GET /admin/tenants/:id/capacity-audit`.

## CAPACITY_DRIFT

**What it means**
At least one tenant failed the capacity audit after reconciliation: a listing's `reservedSlots` disagrees with the
`capacity_events` ledger (`driftedListingCount`), `overQuotaCount` disagrees with the real overage
(`overQuotaMismatchCount`), or `activeBranches + Σ reservedSlots` exceeds the plan (`invariantBrokenCount`).
`tenantIds` lists up to 20 affected tenants; `tenantCount` is the full number.

**First checks**
1. Open `GET /admin/tenants/<tenantId>/capacity-audit` (or read the `[Cron] CAPACITY AUDIT FAILED` lines for that id).
2. Look at that tenant's recent rows in `capacity_events` (platform DB) and `capacity_outbox` (tenant DB). A pending or failed outbox row from a
   branch delete (`gym.service.js#deleteBranch`) is the usual cause: the slot credit was never applied.
3. Check `tenant_subscriptions` for the tenant: status, `branchCount`, `overQuotaCount`, and whether a store webhook
   changed the plan in the last day (`billing_events`, platform DB).
4. If `tenantCount` is large and all started on the same night, suspect a deploy or a failed migration, not data.

**Rollback**
Nothing is changed automatically, so there is nothing to undo. Fix a single tenant by recording the missing
ledger event through the capacity service (never edit `reservedSlots` by hand), then re-run the audit endpoint to
confirm `ok: true`. If a deploy caused it, roll the deploy back first; the next nightly run clears the alert
(alerts repeat at most hourly while the condition persists).

## CAPACITY_EMPTY_ACTIVE_ORG

**What it means**
A tenant has an ACTIVE organization (gym listing) with no ACTIVE branch. The product rule is that an organization is
never empty (CAP-07): deleting the last branch must deactivate the organization. `emptyOrgCount` organizations in
`tenantCount` tenants.

**First checks**
1. In the tenant database, list `branches` for the organization (`gym_listing_id`): were they deleted, or are they INACTIVE or locked?
2. Check the tenant's `audit_logs` (tenant DB) for a branch delete or restore in the last days.
3. Check whether a branch restore failed half way (listing ACTIVE, branch still INACTIVE).

**Rollback**
Either restore a branch through the normal door (`restoreBranch`) if the host still wants the organization, or set the
organization INACTIVE through the same lifecycle door the delete flow uses. Do not edit statuses directly in SQL.

## CAPACITY_AUDIT_FAILED

**What it means**
The nightly audit could not run for `tenantCount` tenants (an error while reconciling or auditing), so those tenants
were **not checked tonight**. This is not a clean result.

**First checks**
1. Search the logs for `[Cron] Capacity audit failed for tenant <id>` or `Capacity reconciliation failed for tenant <id>`; the message says why.
2. Common causes: the tenant database is unreachable or its credentials changed, the tenant pool cap was hit
   (`TenantDbManager` metrics), or a tenant migration is missing (compare the tenant's schema version).
3. If every tenant failed, the platform database or the connection encryption key (`TENANT_CONN_ENCRYPTION_KEY`) is the suspect.

**Rollback**
Nothing was changed by the failed audit. Fix the cause (connection, migration, key), then run the audit for one
tenant with `GET /admin/tenants/<tenantId>/capacity-audit` to confirm it works. The next nightly run re-checks everyone.

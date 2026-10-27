/**
 * Tenant schema health (NEW-126, NEW-127).
 *
 * The startup check used to print one warning per tenant behind and carry on; NEW-123 lost those
 * lines, and GYM-4814C134 stayed live with no schema_migrations for days. Now a tenant that is
 * behind TARGET_SCHEMA_VERSION, or whose database cannot be read, is reported on every channel:
 *
 *   1. one error line per tenant (tenant code, versions, the exact command),
 *   2. the TENANT_SCHEMA_BEHIND platform alert (in-app to every platform admin, Sentry when set;
 *      one per hour, ids and counts only),
 *   3. GET /api/v1/health/tenant-schema answers 503 until it is fixed.
 *
 * `/health` itself stays a liveness check (200): the API runs as one instance, and a monitor or
 * proxy that took it out of rotation for one tenant would take every gym down.
 * Checked at startup and every TENANT_SCHEMA_CHECK_CRON (server.js), read-only.
 */
const { checkTenantSchemaVersions, repairCommand } = require('../database/tenant-migration-runner');

let last = null;
let inFlight = null;

const commandFor = (t) => (t.hasMigrationTable
  ? 'node src/scripts/run-tenant-migrations.js --dry-run, then without --dry-run'
  : `${repairCommand(t.tenantCode)} (dry run), then add --apply --confirm ${t.tenantCode}`);

async function check() {
  const result = await checkTenantSchemaVersions();
  last = { ...result, checkedAt: new Date().toISOString() };

  for (const t of result.behind) {
    console.error(
      `[TenantSchema] BEHIND: tenant ${t.tenantCode} (${t.status}) is at v${t.currentVersion}` +
        `${t.hasMigrationTable ? '' : ' with NO schema_migrations table'}, target v${t.targetVersion}; ` +
        `missing ${t.missingVersions.join(', ')}. Fix: ${commandFor(t)}`
    );
  }
  for (const f of result.failed) {
    console.error(`[TenantSchema] UNCHECKED: tenant ${f.tenantCode || '(list)'}: ${f.error}`);
  }

  if (result.behind.length || result.failed.length) {
    const tenantIds = [...result.behind, ...result.failed].map((t) => t.tenantId).filter(Boolean);
    await require('./alert.service')
      .raise('TENANT_SCHEMA_BEHIND', { behindCount: result.behind.length, failedCount: result.failed.length, tenantIds })
      .catch((err) => console.error(`[TenantSchema] alert not raised: ${err.message}`));
  } else {
    console.log(`[TenantSchema] OK: ${result.checked} tenant database(s) at v${result.targetVersion}`);
  }
  return last;
}

/** Runs the check (one at a time) and reports. Never throws. */
async function runTenantSchemaCheck() {
  if (!inFlight) {
    inFlight = check()
      .catch((err) => {
        console.error(`[TenantSchema] check failed: ${err.message}`);
        last = { checked: 0, behind: [], failed: [{ tenantId: null, tenantCode: null, error: err.message }], checkedAt: new Date().toISOString() };
        return last;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Counts only (served without auth). */
function tenantSchemaHealth() {
  if (!last) return { status: 'unchecked', checkedAt: null };
  const behindCount = last.behind.length;
  const failedCount = last.failed.length;
  return {
    status: behindCount || failedCount ? 'behind' : 'ok',
    checkedAt: last.checkedAt,
    checkedCount: last.checked,
    targetVersion: last.targetVersion,
    behindCount,
    failedCount,
  };
}

const _resetForTests = () => { last = null; inFlight = null; };

module.exports = { runTenantSchemaCheck, tenantSchemaHealth, _resetForTests };

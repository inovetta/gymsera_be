/**
 * The three read-mostly staging checks. Every dependency is passed in so the tests can run them without a store or
 * a real tenant; staging-check.js wires the real ones after the guard has passed.
 */

/** Sandbox purchase verifier: a purchase is accepted only if the store itself says it is a sandbox/test purchase. */
const verifySandboxPurchases = async ({ google = null, apple = null, playApi, appleApi }) => {
  const findings = [];
  if (google) {
    try {
      const p = await playApi.getSubscriptionPurchase(google.purchaseToken);
      const lineItem = (p.lineItems || [])[0] || {};
      const sandbox = Boolean(p.testPurchase);
      findings.push({
        provider: 'GOOGLE',
        ok: sandbox,
        sandbox,
        subscriptionState: p.subscriptionState || null,
        productId: lineItem.productId || null,
        expiryTime: lineItem.expiryTime || null,
        problem: sandbox ? null : 'Google does not mark this as a test purchase; use a licence-tester account',
      });
    } catch (err) {
      findings.push({ provider: 'GOOGLE', ok: false, problem: `lookup failed: ${err.message}` });
    }
  }
  if (apple) {
    try {
      const t = await appleApi.getLatestTransaction(apple.transactionId);
      const sandbox = t.environment === 'Sandbox';
      findings.push({
        provider: 'APPLE',
        ok: sandbox,
        sandbox,
        productId: t.productId || null,
        expiresDate: t.expiresDate ? new Date(t.expiresDate).toISOString() : null,
        problem: sandbox ? null : `Apple says environment is ${t.environment}, not Sandbox`,
      });
    } catch (err) {
      findings.push({ provider: 'APPLE', ok: false, problem: `lookup failed: ${err.message}` });
    }
  }
  if (findings.length === 0) findings.push({ provider: 'NONE', ok: false, problem: 'give --google-token and/or --apple-transaction' });
  return { ok: findings.every((f) => f.ok), findings };
};

/** auditCapacity over every ACTIVE tenant (read-only). */
const auditActiveTenants = async ({ listActiveTenants, getTenantDb, auditCapacity }) => {
  const tenants = await listActiveTenants();
  const failed = [];
  const skipped = [];
  let passed = 0;
  for (const tenant of tenants) {
    try {
      const db = await getTenantDb(tenant);
      if (!db) { skipped.push({ tenantId: tenant.id, reason: 'no tenant database connection' }); continue; }
      const res = await auditCapacity(tenant.id, db);
      if (res.ok) passed += 1;
      else failed.push({ tenantId: tenant.id, error: res.error || null, driftedListings: (res.driftedListings || res.drifted || []).length });
    } catch (err) {
      failed.push({ tenantId: tenant.id, error: err.message });
    }
  }
  return { ok: failed.length === 0 && skipped.length === 0, tenants: tenants.length, passed, failed, skipped };
};

/**
 * Billing reconciliation: what the stores told us versus what we applied.
 *  - billing events still RECEIVED after `stuckMinutes`, or FAILED;
 *  - entitling subscriptions whose end date passed more than `lapseDays` ago (the expiry sweep should have moved them).
 */
const reconcileBilling = async ({ countEvents, countLapsed, now = new Date(), stuckMinutes = 10, lapseDays = 1 }) => {
  const stuckBefore = new Date(now.getTime() - stuckMinutes * 60000);
  const lapsedBefore = new Date(now.getTime() - lapseDays * 86400000);
  const stuck = await countEvents({ status: 'RECEIVED', receivedBefore: stuckBefore });
  const failed = await countEvents({ status: 'FAILED' });
  const lapsed = await countLapsed({ endedBefore: lapsedBefore });
  return { ok: stuck === 0 && failed === 0 && lapsed === 0, stuckEvents: stuck, failedEvents: failed, lapsedStillEntitling: lapsed };
};

module.exports = { verifySandboxPurchases, auditActiveTenants, reconcileBilling };

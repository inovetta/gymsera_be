/**
 * READ-ONLY: why is this branch not live for travellers?
 *
 * Prints every condition of the live-gym rule (R-77, NEW-159; discovery.service.js
 * `_buildAllActiveBranches`) for each branch whose id or name matches, and which ones fail:
 *   tenant status ACTIVE; an entitling subscription (ACTIVE or GRACE; status, platform,
 *   environment); the tenant database; an organization; branch ACTIVE, visible to travellers,
 *   not suspended by an administrator, not paused, not locked for billing (R-83); at least one
 *   ACTIVE public plan for the branch or the whole organization.
 * Also printed, as WARN because discovery does not hide the branch for it: the city (id and name;
 * no city = in no city's list or search).
 *   not suspended by an administrator, not paused; at least one ACTIVE public plan for the
 *   branch or the whole organization.
 * Also printed, as WARN because discovery does not hide the branch for them: the billing lock
 * and the city (id and name; no city = in no city's list or search).
 * Makes no writes. Traveller lists are cached for a short time, so a fix can take a moment to show.
 *
 * Usage: node src/scripts/why-not-live.js --branch <branch id or name>
 */
require('dotenv').config();
const { Op, where, fn, col } = require('sequelize');
const TenantDbManager = require('../database/TenantDbManager');
const { Tenant, TenantSubscription, GymListing, City } = require('../models/platform');
const { ENTITLING_STATUSES } = require('../services/subscription-quota.service');
const { resolveBranchCityId } = require('../services/discovery.service');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseArgs = (argv) => {
  const i = argv.findIndex((a) => a === '--branch' || a.startsWith('--branch='));
  if (i === -1) return { branch: null };
  const value = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1];
  return { branch: value && value.trim() ? value.trim() : null };
};

const _day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'none');
const _sub = (s) => `${s.status} (${s.platform}, environment ${s.environment || 'none'}, ends ${_day(s.endDate)})`;

const _subscriptionCheck = async (tenantId) => {
  const rows = await TenantSubscription.findAll({
    where: { tenantId },
    attributes: ['status', 'platform', 'environment', 'endDate', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });
  const entitling = rows.find((r) => ENTITLING_STATUSES.includes(r.status));
  if (entitling) return { status: 'PASS', detail: _sub(entitling) };
  if (rows.length === 0) return { status: 'FAIL', detail: 'no subscription row' };
  return { status: 'FAIL', detail: `none entitles (${ENTITLING_STATUSES.join(' or ')}); latest: ${_sub(rows[0])}` };
};

const _report = async (tenant, tenantDb, branch) => {
  const { Gym, MembershipPlan } = tenantDb.models;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  add('tenant status', tenant.status === 'ACTIVE' ? 'PASS' : 'FAIL', tenant.status);
  const sub = await _subscriptionCheck(tenant.id);
  add('subscription', sub.status, sub.detail);
  add('tenant database', 'PASS', 'provisioned and reachable');

  const gyms = await Gym.findAll({ attributes: ['id', 'name'] });
  const gym = gyms.find((g) => g.id === branch.gymId) || gyms[0];
  add('organization', gym ? 'PASS' : 'FAIL', gym ? gym.name : 'the tenant has no organization');

  add('branch status', branch.status === 'ACTIVE' ? 'PASS' : 'FAIL', branch.status);
  add(
    'traveller visibility',
    branch.travelerVisibilityStatus === 'active' ? 'PASS' : 'FAIL',
    branch.travelerVisibilityStatus || 'none'
  );
  add('admin suspension', branch.adminSuspended === true ? 'FAIL' : 'PASS', branch.adminSuspended === true ? 'suspended' : 'not suspended');
  add('paused', branch.pausedAt ? 'FAIL' : 'PASS', branch.pausedAt ? `paused by the host on ${_day(branch.pausedAt)}` : 'not paused');

  const plans = await MembershipPlan.count({
    where: { status: 'ACTIVE', isPublic: true, branchId: { [Op.or]: [null, branch.id] } },
  });
  add('public plans', plans > 0 ? 'PASS' : 'FAIL', `${plans} ACTIVE public plan(s) for this branch or the whole organization`);

  add(
    'billing lock',
    branch.billingLockedAt ? 'FAIL' : 'PASS', // R-83: a locked branch is hidden from travellers
    branch.billingLockedAt ? `locked on ${_day(branch.billingLockedAt)} (${branch.billingLockReason || 'no reason'})` : 'not locked'
    branch.billingLockedAt ? 'WARN' : 'PASS',
    branch.billingLockedAt
      ? `locked on ${_day(branch.billingLockedAt)} (${branch.billingLockReason || 'no reason'}): still listed, but new members and payments are refused`
      : 'not locked'
  );

  const listing = branch.gymListingId ? await GymListing.findByPk(branch.gymListingId, { attributes: ['id', 'status', 'cityId'] }) : null;
  const liveListing = listing && listing.status === 'ACTIVE' ? listing : null;
  const cityId = resolveBranchCityId(branch, liveListing, tenant);
  const city = cityId ? await City.findByPk(cityId, { attributes: ['id', 'name'] }) : null;
  add(
    'city',
    city ? 'PASS' : 'WARN',
    city ? `${city.id} ${city.name}` : cityId ? `${cityId} (no such city)` : 'none: the branch is in no city list or search'
  );

  const failing = checks.filter((c) => c.status === 'FAIL').map((c) => c.name);
  return {
    tenant: { id: tenant.id, name: tenant.businessName || tenant.gymName || null },
    branch: { id: branch.id, name: branch.branchName || null, listingId: branch.gymListingId || null, listingStatus: listing?.status || null },
    checks,
    failing,
    live: failing.length === 0,
  };
};

/**
 * @param {string} query - a branch id, or part of a branch name (case ignored).
 * @param {{onSkip?: (tenantId: string, why: string) => void}} [opts]
 * @returns {Promise<object[]>} one report per matching branch, in every tenant.
 */
const whyNotLive = async (query, { onSkip = () => {} } = {}) => {
  const q = String(query || '').trim();
  if (!q) return [];
  const tenants = await Tenant.findAll({
    attributes: ['id', 'status', 'businessName', 'gymName', 'cityId', 'connectionStringEncrypted'],
  });
  const reports = [];
  for (const tenant of tenants) {
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    let tenantDb;
    try {
      tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    } catch (err) {
      onSkip(tenant.id, err.message);
      continue;
    }
    const { Branch } = tenantDb.models;
    const match = UUID.test(q)
      ? { id: q }
      : where(fn('LOWER', col('branch_name')), { [Op.like]: `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%` });
    const branches = await Branch.findAll({ where: match });
    for (const branch of branches) reports.push(await _report(tenant, tenantDb, branch));
  }
  return reports;
};

const formatReport = (r) =>
  [
    `Branch ${r.branch.name || '(no name)'} (${r.branch.id})`,
    `Tenant ${r.tenant.name || '(no name)'} (${r.tenant.id}); listing ${r.branch.listingId || 'none'} ${r.branch.listingStatus || ''}`.trimEnd(),
    ...r.checks.map((c) => `  ${c.status.padEnd(4)}  ${c.name}: ${c.detail}`),
    r.live ? '=> LIVE for travellers' : `=> NOT LIVE. Failing: ${r.failing.join(', ')}`,
  ].join('\n');

if (require.main === module) {
  const { branch } = parseArgs(process.argv.slice(2));
  if (!branch) {
    console.error('Usage: node src/scripts/why-not-live.js --branch <branch id or name>');
    process.exit(1);
  }
  (async () => {
    let code = 0;
    try {
      const reports = await whyNotLive(branch, {
        onSkip: (tenantId, why) => console.warn(`(tenant ${tenantId} skipped: database unreachable: ${why})`),
      });
      if (reports.length === 0) {
        console.log(`No branch matches "${branch}".`);
        code = 2;
      }
      console.log(reports.map(formatReport).join('\n\n'));
    } catch (err) {
      console.error('why-not-live failed:', err.message || err.original?.code || err.name);
      code = 1;
    } finally {
      await TenantDbManager.releaseAll().catch(() => {});
      await require('../database/platform').sequelize.close().catch(() => {});
    }
    process.exit(code);
  })();
}

module.exports = { whyNotLive, formatReport, parseArgs };

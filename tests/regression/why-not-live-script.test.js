/**
 * Read-only diagnosis: why is this branch not live for travellers?
 *
 * `node src/scripts/why-not-live.js --branch <id or name>` prints every condition of the
 * live-gym rule (R-77, NEW-159; discovery.service.js `_buildAllActiveBranches`) for each
 * matching branch, and which ones fail: tenant status, an entitling subscription (status,
 * platform, environment), the tenant database and organization, branch open / visible to
 * travellers / not suspended / not paused / not locked for billing (R-83), a plan travellers can
 * see, plus the city (id and name), which does not hide a branch but matters to the host.
 *
 * Each case also asks discovery itself (`isLiveForTravellers`, fresh), so the script can
 * never disagree with the real rule. Nothing is written: row counts are compared before and after.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const cache = require('../../src/services/discovery-cache.service');
const { isLiveForTravellers } = require('../../src/services/discovery.service');
const { GymListing, City, Tenant, TenantSubscription } = require('../../src/models/platform');
const { whyNotLive, formatReport, parseArgs } = require('../../src/scripts/why-not-live');

describe('why-not-live: every live-gym condition, and which one fails', () => {
  let h; let personas; let tenantId; let branch; let plan; let city;

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    tenantId = personas.owner.tenantId;
    city = await City.create({ name: 'WNL City', isActive: true });
    const listing = await GymListing.findOne({ where: { tenantId } });
    await listing.update({ status: 'ACTIVE', cityId: city.id });
    branch = await h.tenant1.models.Branch.findOne({ where: { gymListingId: listing.id } });
    await branch.update({
      status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false, pausedAt: null,
      billingLockedAt: null, cityId: city.id, branchName: 'Why Not Live Downtown',
    });
    plan = await h.tenant1.models.MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Monthly', price: 2500,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(() => cache._resetForTests());

  const check = (report, name) => report.checks.find((c) => c.name === name);
  const only = async (q = branch.id) => {
    const reports = await whyNotLive(q);
    expect(reports).toHaveLength(1);
    return reports[0];
  };
  const agreesWithDiscovery = async (report) => {
    expect(report.live).toBe(await isLiveForTravellers(branch.id, { fresh: true }));
  };

  test('a live branch: every condition passes, with the subscription environment and the city name', async () => {
    const r = await only();
    expect(r.live).toBe(true);
    expect(r.failing).toEqual([]);
    expect(check(r, 'tenant status').detail).toMatch(/ACTIVE/);
    expect(check(r, 'subscription').detail).toMatch(/ACTIVE/);
    expect(check(r, 'subscription').detail).toMatch(/environment/);
    expect(check(r, 'public plans').detail).toMatch(/^1\b/);
    expect(check(r, 'city').detail).toContain(`${city.id}`);
    expect(check(r, 'city').detail).toContain('WNL City');
    await agreesWithDiscovery(r);

    const text = formatReport(r);
    expect(text).toContain('LIVE');
    expect(text).toContain('Why Not Live Downtown');
  });

  test('finds the branch by name, ignoring case, as well as by id', async () => {
    const r = await only('why not live downtown');
    expect(r.branch.id).toBe(branch.id);
    expect(await whyNotLive('no branch has this name')).toEqual([]);
  });

  test.each([
    ['tenant status', () => Tenant.update({ status: 'SUSPENDED' }, { where: { id: tenantId } }),
      () => Tenant.update({ status: 'ACTIVE' }, { where: { id: tenantId } })],
    ['subscription', () => TenantSubscription.update({ status: 'EXPIRED' }, { where: { tenantId } }),
      () => TenantSubscription.update({ status: 'ACTIVE' }, { where: { tenantId } })],
    ['branch status', () => branch.update({ status: 'INACTIVE' }), () => branch.update({ status: 'ACTIVE' })],
    ['traveller visibility', () => branch.update({ travelerVisibilityStatus: 'pending' }),
      () => branch.update({ travelerVisibilityStatus: 'active' })],
    ['admin suspension', () => branch.update({ adminSuspended: true }), () => branch.update({ adminSuspended: false })],
    ['paused', () => branch.update({ pausedAt: new Date() }), () => branch.update({ pausedAt: null })],
    ['public plans', () => plan.update({ isPublic: false }), () => plan.update({ isPublic: true })],
    ['billing lock', () => branch.update({ billingLockedAt: new Date() }), () => branch.update({ billingLockedAt: null })],
  ])('%s fails alone: named as the failing condition, and discovery agrees', async (name, breakIt, fixIt) => {
    await breakIt();
    try {
      const r = await only();
      expect(r.live).toBe(false);
      expect(r.failing).toEqual([name]);
      expect(formatReport(r)).toMatch(new RegExp(`FAIL\\s+${name}`));
      await agreesWithDiscovery(r);
    } finally {
      await fixIt();
    }
  });

  test('an unknown city is reported but, as in discovery, does not hide the branch', async () => {
    await branch.update({ cityId: 999999 });
    try {
      const r = await only();
      expect(r.live).toBe(true);
      expect(check(r, 'city').status).toBe('WARN');
      expect(check(r, 'city').detail).toMatch(/999999 \(no such city\)/);
      await agreesWithDiscovery(r);
    } finally {
      await branch.update({ cityId: city.id });
    }
  });

  test('read-only: nothing is written', async () => {
    const counts = async () => [
      await TenantSubscription.count(), await Tenant.count(), await GymListing.count(),
      await h.tenant1.models.Branch.count(), await h.tenant1.models.MembershipPlan.count(),
    ];
    const before = await counts();
    const updatedAt = (await h.tenant1.models.Branch.findByPk(branch.id)).updatedAt.getTime();
    await whyNotLive(branch.id);
    await whyNotLive('downtown');
    expect(await counts()).toEqual(before);
    expect((await h.tenant1.models.Branch.findByPk(branch.id)).updatedAt.getTime()).toBe(updatedAt);
  });

  test('arguments: --branch is required', () => {
    expect(parseArgs(['--branch', 'abc'])).toEqual({ branch: 'abc' });
    expect(parseArgs(['--branch=Downtown Gym'])).toEqual({ branch: 'Downtown Gym' });
    expect(parseArgs([])).toEqual({ branch: null });
    const run = spawnSync(process.execPath, [path.join(__dirname, '../../src/scripts/why-not-live.js')], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Usage: node src\/scripts\/why-not-live.js --branch/);
  });
});

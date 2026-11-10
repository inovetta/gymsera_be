/**
 * ZKTeco Phase 2: backup jobs, privacy, the outbox and security (spec §6.3, §8.2, §8.3, §14; D-4).
 *
 * Watchdog: no answer → re-queued with backoff, then failed; expired; device offline → one owner
 * notification per incident, cleared when it is back, and the changes made meanwhile arrive.
 * Audit: DATA COUNT / DATA QUERY in packs; extras removed, hand-added PINs listed as unlinked,
 * missing members re-sent; once per local day after 02:00 (staggered).
 * Retention: consent-pending templates after 7 days (here and on the device), 90 days after the
 * last package, retired PINs after 180 days. Member deleted and consent withdrawn: everything gone,
 * from every device, even an OUT device in exit grace.
 * Outbox: written in the business transaction (rolled back with it), processed after commit; a
 * failing reconcile never fails the business write; the capacity sweep leaves device rows alone;
 * a tenant without devices writes nothing.
 * Security: no template or photo in any log line or JSON answer; tenant isolation; consent routes
 * and permissions.
 */
const { createWorld, localNow, day } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const sync = require('../../src/services/devices/device-sync.service');
const jobs = require('../../src/jobs/device-jobs');
const privacy = require('../../src/services/devices/device-privacy.service');
const identity = require('../../src/services/devices/device-identity.service');
const triggers = require('../../src/services/devices/device-triggers');
const capacityOutbox = require('../../src/services/capacity-outbox.service');
const { utc } = require('../../src/services/devices/sql-time');
const { sequelize: platformDb } = require('../../src/database/platform');
const fx = require('../fixtures/zkteco/manual-samples');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const REG = 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,' +
  'MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,DateFmtFunOn=1';
const freshBranch = async () => w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
const exec = (sql, rep) => w.db1.sequelize.query(sql, { replacements: utc(rep) });

describe('layer 1: watchdog', () => {
  test('a command with no answer goes back with backoff (30 s, 2 min, 10 min, 1 h), then fails and is logged', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const u = await w.member('Silent Device Member');
    await w.subscribe(w.db1, { user: u, branch });
    const waits = [];
    for (let i = 0; i < 5; i++) {
      await exec('UPDATE device_commands SET not_before = ? WHERE device_id = ? AND status = \'queued\'', [new Date(Date.now() - 1000), d.id]);
      const p = await d.sim.poll(); // the device takes the commands and never answers
      expect(p.commands.length).toBe(2);
      const now = new Date(Date.now() + 61000);
      await jobs.watchdogTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, now);
      const [c] = await w.q(w.db1, 'SELECT * FROM device_commands WHERE device_id = ? AND member_id = ? ORDER BY id LIMIT 1', [d.id, u.id]);
      if (c.status === 'queued') waits.push(Math.round((new Date(c.not_before).getTime() - now.getTime()) / 1000));
    }
    expect(waits).toEqual([30, 120, 600, 3600]);
    const cmds = await w.commands(w.db1, d.id, 'member_id = ?', [u.id]);
    expect(cmds.map((c) => c.status)).toEqual(['failed', 'failed']);
    expect((await w.q(w.db1, 'SELECT kind FROM device_error_logs WHERE device_id = ?', [d.id])).map((r) => r.kind)).toEqual(['no_answer', 'no_answer']);
    expect(await w.syncRow(w.db1, d.id, u.id)).toMatchObject({ state: 'failed' });
  });

  test('offline for 10 minutes: one owner notification per incident; back online clears it; changes made meanwhile arrive', async () => {
    const { Notification } = require('../../src/models/platform');
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG, name: 'Back door' });
    const notes = () => Notification.count({ where: { userId: w.ctx.tenant1.ownerUserId, type: 'device_offline' } });
    const before = await notes();
    await platformDb.query('UPDATE access_devices SET last_seen_at = ? WHERE id = ?', { replacements: utc([new Date(Date.now() - 20 * 60000), d.id]) });
    // While it is offline a member joins.
    const u = await w.member('Joined While Offline');
    await w.subscribe(w.db1, { user: u, branch });
    let r = await jobs.watchdogTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 });
    expect(r.offline).toBe(1);
    expect(await notes()).toBe(before + 1);
    r = await jobs.watchdogTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 });
    expect(r.offline).toBe(0);
    expect(await notes()).toBe(before + 1); // once per incident
    // Back: it polls, gets the member, and the watchdog clears the incident.
    await d.sim.drain();
    expect(d.sim.holds(await w.pinOf(w.db1, u.id)).user).not.toBeNull();
    r = await jobs.watchdogTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 });
    expect(r.online).toBe(1);
    expect((await w.q(w.db1, 'SELECT offline_since, offline_notified_at FROM access_device_details WHERE id = ?', [d.id]))[0]).toEqual({ offline_since: null, offline_notified_at: null });
  });

  test('a queued command past expires_at expires (an enrolment nobody came for)', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const u = await w.member('Never Came');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    await privacy.giveConsent(w.db1, { memberId: u.id, method: 'in_person' });
    const { commandId } = await privacy.requestEnrollment(w.db1, { deviceId: d.id, memberId: u.id });
    await jobs.watchdogTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, new Date(Date.now() + 3 * 60000));
    expect((await w.commands(w.db1, d.id, 'id = ?', [commandId]))[0].status).toBe('expired');
  });
});

describe('layer 3: nightly audit', () => {
  test('extras removed, hand-added PIN listed as unlinked, missing member re-sent; query answered in packs', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG, queryPackSize: 2 });
    const keep = await w.member('Stays');
    const missing = await w.member('Deleted On Device');
    const gone = await w.member('Expired Still There');
    await w.subscribe(w.db1, { user: keep, branch });
    await w.subscribe(w.db1, { user: missing, branch });
    const goneSub = await w.subscribe(w.db1, { user: gone, branch });
    await d.sim.drain();
    const [pKeep, pMissing, pGone] = [await w.pinOf(w.db1, keep.id), await w.pinOf(w.db1, missing.id), await w.pinOf(w.db1, gone.id)];
    // Drift the engine cannot see: expired behind its back, a user deleted and one added by hand on the device.
    await exec('UPDATE member_subscriptions SET status = \'EXPIRED\' WHERE id = ?', [goneSub.id]);
    await exec('UPDATE device_member_sync SET state = \'removed\', desired = 0, applied_json = NULL, applied_hash = NULL WHERE device_id = ? AND member_id = ?', [d.id, gone.id]);
    d.sim.users.delete(pMissing);
    d.sim.users.set('990001', { pin: '990001', name: 'Hand Added' });

    const { auditId } = await jobs.requestAudit(w.db1, d.id);
    await d.sim.drain();
    const [audit] = await w.q(w.db1, 'SELECT * FROM device_audits WHERE id = ?', [auditId]);
    expect(audit).toMatchObject({ status: 'compared', device_user_count: 3, packs_expected: 2, packs_received: 2, extra_count: 1, missing_count: 1, unlinked_count: 1 });
    expect(d.sim.uploads.filter((x) => x.path === 'querydata').map((x) => x.text)).toEqual(['user=2\n', 'user=1\n']);
    await d.sim.drain();
    expect(d.sim.holds(pKeep).user).not.toBeNull();
    expect(d.sim.holds(pMissing).user).not.toBeNull();
    expect(d.sim.holds(pGone).user).toBeNull();
    expect(d.sim.holds('990001').user).not.toBeNull(); // never removed on its own: staff decide (Phase 3)
    expect(await w.q(w.db1, 'SELECT pin, source FROM device_unlinked_users WHERE device_id = ?', [d.id])).toEqual([{ pin: '990001', source: 'audit' }]);
  });

  test('requested once per local day, from 02:00 branch time plus the device stagger', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const stagger = jobs.staggerOf(d.id);
    // Today in Karachi (UTC+5) at 02:00 + stagger - 1 minute → not yet; + 1 minute → requested; again → nothing.
    const at = (minutes) => new Date(new Date(`${day(0)}T00:00:00Z`).getTime() - 5 * 3600000 + (120 + stagger + minutes) * 60000);
    const mine = async () => (await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_audits WHERE device_id = ?', [d.id]))[0].n;
    await jobs.auditTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, at(-1));
    expect(await mine()).toBe(0);
    await jobs.auditTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, at(1));
    expect(await mine()).toBe(1);
    await jobs.auditTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, at(90));
    expect(await mine()).toBe(1);
  });
});

describe('retention (D-4) and deletion', () => {
  test('a template waiting for consent past 7 days is deleted here and on the device that enrolled it', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const u = await w.member('No Consent Given');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    d.sim.bio.set(`${pin}:9:0:0`, { pin, type: 9, no: 0, index: 0, majorVer: '40', tmp: fx.TEMPLATE }); // enrolled on the device menu
    await d.sim.upload(null, `biodata pin=${pin}\tno=0\tindex=0\tvalid=1\tduress=0\ttype=9\tmajorver=40\tminorver=1\tformat=0\ttmp=${fx.TEMPLATE}`, { tablename: 'biodata', count: 1 });
    await w.settled();
    await exec('UPDATE member_biometrics SET pending_until = ? WHERE member_id = ?', [new Date(Date.now() - 1000), u.id]);
    const r = await jobs.retentionTenant({ db: w.db1 });
    expect(r.pendingExpired).toBe(1);
    expect(await w.q(w.db1, 'SELECT id FROM member_biometrics WHERE member_id = ?', [u.id])).toEqual([]);
    const done = await d.sim.drain();
    expect(done.map((c) => c.text)).toEqual([`DATA DELETE biodata Type=9\tPin=${pin}`]);
    expect(d.sim.holds(pin).bioTypes).toEqual([]);
    expect(d.sim.holds(pin).user).not.toBeNull(); // the member stays; only the template goes
  });

  test('90 days after the last package: templates and photos deleted; a running package keeps them', async () => {
    const branch = await freshBranch();
    const old = await w.member('Left Long Ago');
    const cur = await w.member('Still Training');
    await w.subscribe(w.db1, { user: old, branch, start: -200, end: -100, status: 'EXPIRED' });
    await w.subscribe(w.db1, { user: cur, branch });
    const bio = require('../../src/services/devices/biometric.service');
    for (const u of [old, cur]) {
      await bio.recordConsent(w.db1, { memberId: u.id, method: 'in_person' });
      await bio.storeTemplates(w.db1, { memberId: u.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: fx.TEMPLATE }] });
    }
    const r = await jobs.retentionTenant({ db: w.db1 });
    expect(r.retained).toBeGreaterThanOrEqual(1);
    expect(await w.q(w.db1, 'SELECT id FROM member_biometrics WHERE member_id = ?', [old.id])).toEqual([]);
    expect((await w.q(w.db1, 'SELECT id FROM member_biometrics WHERE member_id = ?', [cur.id])).length).toBe(1);
  });

  test('member deleted: templates gone, removed from every device now (even an OUT device in exit grace), PIN retired and held', async () => {
    const branch = await freshBranch();
    const din = await w.device(w.db1, { branch, registryBody: REG, direction: 'in' });
    const dout = await w.device(w.db1, { branch, registryBody: REG, direction: 'out' });
    const u = await w.member('Deletes Account');
    await w.subscribe(w.db1, { user: u, branch });
    await privacy.giveConsent(w.db1, { memberId: u.id, method: 'app' });
    await require('../../src/services/devices/biometric.service').storeTemplates(w.db1, { memberId: u.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: fx.TEMPLATE }] });
    await sync.reconcileMember(w.db1, u.id, 'test');
    await din.sim.drain();
    await dout.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    expect(dout.sim.holds(pin).bioTypes).toEqual([9]);
    // The account deletion path (account-deletion-finalize.service#_scrubPersonInTenantDb).
    await w.db1.models.MemberSubscription.update({ status: 'CANCELLED' }, { where: { userId: u.id } });
    await privacy.forgetMember(w.db1, u.id);
    await w.settled();
    await din.sim.drain();
    await dout.sim.drain();
    expect(din.sim.holds(pin).user).toBeNull();
    expect(dout.sim.holds(pin).user).toBeNull();
    expect(await w.q(w.db1, 'SELECT id FROM member_biometrics WHERE member_id = ?', [u.id])).toEqual([]);
    expect((await identity.identityOf(w.db1, u.id)).retired_at).toBeTruthy();
    // A scan with the retired PIN on a device that missed the removal: logged and removed again.
    dout.sim.users.set(pin, { pin, name: 'Old Copy' });
    await dout.sim.scan(pin, localNow());
    expect((await w.q(w.db1, 'SELECT kind FROM device_error_logs WHERE device_id = ?', [dout.id])).map((r) => r.kind)).toContain('granted_retired_pin');
    // Within the hold the same person gets the same PIN back; after 180 days the row is purged.
    expect(String(await identity.ensurePin(w.db1, u.id))).toBe(pin);
    await identity.retire(w.db1, u.id, new Date(Date.now() - 181 * 86400000));
    await exec('UPDATE member_device_identity SET retired_at = ? WHERE member_id = ?', [new Date(Date.now() - 181 * 86400000), u.id]);
    expect(await identity.purgeRetired(w.db1, 180)).toBe(1);
    // A new PIN is never an old one: the sequence only moves up.
    expect(Number(await identity.ensurePin(w.db1, u.id))).toBeGreaterThan(Number(pin));
  });

  test('consent withdrawn: templates deleted here and from every device', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const u = await w.member('Withdraws Consent');
    await w.subscribe(w.db1, { user: u, branch });
    await privacy.giveConsent(w.db1, { memberId: u.id, method: 'in_person' });
    await require('../../src/services/devices/biometric.service').storeTemplates(w.db1, { memberId: u.id, deviceId: null, templates: [{ pin: '1', type: 1, no: 6, index: 0, valid: 1, duress: 0, majorVer: '10', minorVer: '0', format: 0, tmp: fx.TEMPLATE }] });
    await sync.reconcileMember(w.db1, u.id, 'test');
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    expect(d.sim.holds(pin).bioTypes).toEqual([1]);
    const res = await privacy.withdrawConsent(w.db1, { memberId: u.id });
    expect(res.templatesDeleted).toBe(1);
    await w.settled();
    const done = await d.sim.drain();
    expect(done.map((c) => c.text)).toEqual([`DATA DELETE biodata Type=1\tPin=${pin}`]);
    expect(d.sim.holds(pin).user).not.toBeNull(); // still a member: card or PIN instead (§14 point 1)
  });
});

describe('outbox (§8.2)', () => {
  test('written in the business transaction: a rollback leaves nothing; a commit is processed after commit', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const outbox = () => w.q(w.db1, 'SELECT status, payload_json FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' ORDER BY created_at');
    const before = (await outbox()).length;
    const u = await w.member('Rolled Back');
    const plan = await w.plan(w.db1, branch);
    const t = await w.db1.sequelize.transaction();
    await w.db1.models.MemberSubscription.create({ userId: u.id, branchId: branch.id, membershipPlanId: plan.id, startDate: day(-1), endDate: day(20), status: 'ACTIVE' }, { transaction: t });
    await t.rollback();
    await w.settled();
    expect((await outbox()).length).toBe(before);
    expect(await w.syncRow(w.db1, d.id, u.id)).toBeNull();

    await w.db1.sequelize.transaction(async (tx) => {
      await w.db1.models.MemberSubscription.create({ userId: u.id, branchId: branch.id, membershipPlanId: plan.id, startDate: day(-1), endDate: day(20), status: 'ACTIVE' }, { transaction: tx });
    });
    await w.settled();
    const rows = await outbox();
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1].status).toBe('PROCESSED');
    expect(await w.syncRow(w.db1, d.id, u.id)).toMatchObject({ state: 'pending_add' });
  });

  test('a failing reconcile never fails the business write; the device-sync job finishes it later', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG });
    const u = await w.member('Reconcile Fails');
    const original = sync.reconcileMember;
    sync.reconcileMember = async () => { throw new Error('simulated outage'); };
    let sub;
    try {
      sub = await w.subscribe(w.db1, { user: u, branch });
    } finally {
      sync.reconcileMember = original;
    }
    expect(sub.id).toBeTruthy();
    const [row] = await w.q(w.db1, 'SELECT id, status, last_error FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND JSON_CONTAINS(payload_json, JSON_QUOTE(?), \'$.memberIds\')', [u.id]);
    expect(row).toMatchObject({ status: 'FAILED', last_error: 'simulated outage' });
    await exec('UPDATE capacity_outbox SET created_at = ? WHERE id = ?', [new Date(Date.now() - 120000), row.id]);
    const r = await jobs.syncTenant({ db: w.db1 });
    expect(r.outbox).toBe(1);
    await d.sim.drain();
    expect(d.sim.holds(await w.pinOf(w.db1, u.id)).user).not.toBeNull();
  });

  test('the capacity outbox sweep leaves device rows alone; a tenant without devices writes no row', async () => {
    const pending = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND status = \'PENDING\'');
    await w.db1.sequelize.query(
      'INSERT INTO capacity_outbox (id, event_type, payload_json, idempotency_key, status, attempts, created_at, updated_at) VALUES (UUID(), \'DEVICE_RECONCILE\', \'{"memberIds":[],"reason":"x"}\', UUID(), \'PENDING\', 0, NOW(), NOW())'
    );
    await capacityOutbox.sweepTenantOutbox(w.ctx.tenant1.id, w.db1);
    const after = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND status = \'PENDING\'');
    expect(Number(after[0].n)).toBe(Number(pending[0].n) + 1);
    expect((await capacityOutbox.getOutboxStats(w.db1)).unprocessed).toBe(0);
    // Tenant 2 has no device.
    expect(await triggers.hasDevices(w.db2.sequelize)).toBe(false);
    const u2 = await w.member('Other Tenant Member');
    await w.subscribe(w.db2, { user: u2, branch: w.ctx.branch2 });
    expect(await w.q(w.db2, 'SELECT id FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\'')).toEqual([]);
  });
});

describe('security (§14)', () => {
  test('no template or photo in any log line, even with device logging on', async () => {
    const branch = await freshBranch();
    const lines = [];
    const spies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => lines.push(a.map(String).join(' '))));
    process.env.LOG_DEVICES = 'true';
    try {
      const d = await w.device(w.db1, { branch, registryBody: REG });
      const u = await w.member('Log Check');
      await w.subscribe(w.db1, { user: u, branch });
      await privacy.giveConsent(w.db1, { memberId: u.id, method: 'in_person' });
      const pin = await w.pinOf(w.db1, u.id);
      await d.sim.upload(null, `biodata pin=${pin}\tno=0\tindex=0\tvalid=1\tduress=0\ttype=9\tmajorver=40\tminorver=1\tformat=0\ttmp=${fx.TEMPLATE}`, { tablename: 'biodata', count: 1 });
      await d.sim.upload(null, `biophoto pin=${pin}\ttype=9\tsize=${fx.PHOTO.length}\tcontent=${fx.PHOTO}`, { tablename: 'biophoto', count: 1 });
      await w.settled();
      await d.sim.drain();
      const other = await w.device(w.db1, { branch, registryBody: REG.replace('40.1', '58.1') });
      await other.sim.drain(); // receives the photo fallback
    } finally {
      delete process.env.LOG_DEVICES;
      spies.forEach((s) => s.mockRestore());
    }
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).not.toContain(fx.TEMPLATE.slice(0, 40));
    expect(all).not.toContain(fx.PHOTO.slice(0, 40));
  });

  test('tenant isolation: a tenant 2 device never gets tenant 1 members; each tenant has its own PIN sequence', async () => {
    const d2 = await w.device(w.db2, { branch: w.ctx.branch2, registryBody: REG, tenantId: w.ctx.tenant2.id });
    const u2 = await w.member('Tenant Two Member');
    await w.subscribe(w.db2, { user: u2, branch: w.ctx.branch2 });
    const got = await d2.sim.drain();
    const pins = [...d2.sim.users.keys()].sort();
    const tenant2 = (await w.q(w.db2, 'SELECT member_id, pin FROM member_device_identity ORDER BY pin'));
    const tenant1 = (await w.q(w.db1, 'SELECT member_id, pin FROM member_device_identity'));
    expect(got.length).toBeGreaterThan(0);
    // Exactly tenant 2's members (the one subscribed earlier and this one), none of tenant 1's.
    expect(pins).toEqual(tenant2.map((r) => String(r.pin)).sort());
    expect(tenant2.map((r) => r.member_id)).toContain(u2.id);
    const t1Members = new Set(tenant1.map((r) => r.member_id));
    expect(tenant2.some((r) => t1Members.has(r.member_id))).toBe(false);
    // Each tenant's sequence starts at 1001 on its own.
    expect(tenant2.map((r) => Number(r.pin))[0]).toBe(1001);
    expect(tenant1.map((r) => Number(r.pin))).toContain(1001);
  });

  test('consent routes: devices.manage records and withdraws; front desk (view) reads only; never any template', async () => {
    const branch = w.ctx.branch1;
    const u = await w.member('Route Member');
    await w.subscribe(w.db1, { user: u, branch });
    const read = await asPersona('frontDesk').get(`/host/devices/members/${u.id}/biometric-consent`);
    expect(read.status).toBe(200);
    expect(read.body.data.consent).toEqual({ consented: false, consentedAt: null, method: null, templates: 0, waitingForConsent: 0 });
    expect((await asPersona('frontDesk').post(`/host/devices/members/${u.id}/biometric-consent`, { method: 'in_person' })).status).toBe(403);
    const give = await asPersona('owner').post(`/host/devices/members/${u.id}/biometric-consent`, { method: 'in_person' });
    expect(give.status).toBe(200);
    expect(give.body.data.consent).toMatchObject({ consented: true, method: 'in_person' });
    expect((await asPersona('owner').post(`/host/devices/members/${u.id}/biometric-consent`, { method: 'fingerprint' })).status).toBe(422);
    const gone = await asPersona('owner').delete(`/host/devices/members/${u.id}/biometric-consent`);
    expect(gone.status).toBe(200);
    expect(JSON.stringify(gone.body)).not.toMatch(/tmp|template_enc|TAlTUzIx/);
    expect((await asPersona('owner').get('/host/devices/members/00000000-0000-4000-8000-000000000000/biometric-consent')).status).toBe(404);
    const stranger = await w.member('Not A Member Here');
    expect((await asPersona('owner').post(`/host/devices/members/${stranger.id}/biometric-consent`, {})).status).toBe(404);
  });
});

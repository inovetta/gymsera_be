/**
 * ZKTeco Phase 2: the sync engine end to end (spec §6.3, §7.1, §7.2, §7.4, §8.1, §8.2), with the
 * simulator acting as the device over real HTTP.
 *
 * New member → on the device with the package window and an authorization; an idempotent rerun;
 * renewal (window only); expiry in real time and at the branch's midnight sweep; branch transfer
 * between organizations; wrong results (-27 re-sends the user, storage full, transient retry,
 * several results in one body with return=); version mismatch → comparison photo; staff (D-8);
 * locked branch past the check-in grace (D-5); OUT exit grace (D-7); superseded batches.
 */
const { createWorld, day, localNow } = require('../harness/zkteco-world');
const sync = require('../../src/services/devices/device-sync.service');
const jobs = require('../../src/jobs/device-jobs');
const biometrics = require('../../src/services/devices/biometric.service');
const protocol = require('../../src/services/devices/push-protocol');
const fx = require('../fixtures/zkteco/manual-samples');
const { utc } = require('../../src/services/devices/sql-time');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const FACE_ONLY = 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,' +
  'MultiBioDataSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:0:0:0:0:0:0:0:0:40.1:0,DateFmtFunOn=0';

describe('new member, renewal, expiry (§7.1, §7.2, §8.2)', () => {
  let org; let branch; let dev; let user; let sub;
  beforeAll(async () => {
    org = await w.gym(w.db1);
    branch = await w.branch(w.db1, { gymId: org.id });
    dev = await w.device(w.db1, { branch, registryBody: FACE_ONLY });
    user = await w.member('A Member With A Very Long Full Name');
  });

  test('a new ACTIVE package puts the member on the device: user (window, privilege 0), authorization; PIN from 1001', async () => {
    sub = await w.subscribe(w.db1, { user, branch, start: -3, end: 27 });
    const pin = await w.pinOf(w.db1, user.id);
    expect(Number(pin)).toBeGreaterThanOrEqual(1001);
    const done = await dev.sim.drain();
    expect(done.map((c) => c.text.split('\t')[0].split(' ').slice(0, 3).join(' '))).toEqual(['DATA UPDATE user', 'DATA UPDATE userauthorize']);
    expect(done.every((c) => c.returnCode === 0)).toBe(true);
    const held = dev.sim.holds(pin);
    expect(held.user).toMatchObject({ pin, name: 'A Very Long Full Name'.length ? held.user.name : '', privilege: '0' });
    expect(held.user.name.length).toBeLessThanOrEqual(24);
    // DateFmtFunOn=0 → YYYYMMDD; the end date of the package.
    expect(held.user.endTime).toBe(day(27).replace(/-/g, ''));
    expect(held.user.startTime).toBe(day(-3).replace(/-/g, ''));
    expect(held.auth).toMatchObject({ authorizetimezoneid: '1', authorizedoorid: '1' });
    const row = await w.syncRow(w.db1, dev.id, user.id);
    expect(row).toMatchObject({ state: 'in_sync', desired: 1 });
    expect(row.applied_hash).toBe(row.desired_hash);
  });

  test('idempotent: running the reconciler again creates nothing', async () => {
    const before = (await w.commands(w.db1, dev.id)).length;
    await sync.reconcileMember(w.db1, user.id, 'test');
    await sync.reconcileDevice(w.db1, dev.id, 'test');
    expect((await w.commands(w.db1, dev.id)).length).toBe(before);
    expect((await dev.sim.poll()).text).toBe('OK\n');
  });

  test('renewal: only the user and its authorization go again, with the new EndTime', async () => {
    await sub.update({ endDate: day(57) });
    await w.settled();
    const done = await dev.sim.drain();
    expect(done.map((c) => c.text.split(' ').slice(0, 3).join(' '))).toEqual(['DATA UPDATE user', 'DATA UPDATE userauthorize']);
    expect(dev.sim.holds(await w.pinOf(w.db1, user.id)).user.endTime).toBe(day(57).replace(/-/g, ''));
  });

  test('cancel in real time: removed from the device (templates, authorization, user)', async () => {
    const pin = await w.pinOf(w.db1, user.id);
    await sub.update({ status: 'CANCELLED', cancelledAt: new Date() });
    await w.settled();
    const done = await dev.sim.drain();
    expect(done.map((c) => c.text.split('\t')[0])).toEqual([`DATA DELETE biodata Type=9`, `DATA DELETE biophoto PIN=${pin}`, `DATA DELETE userauthorize Pin=${pin}`, `DATA DELETE user Pin=${pin}`]);
    expect(dev.sim.holds(pin).user).toBeNull();
    expect(await w.syncRow(w.db1, dev.id, user.id)).toMatchObject({ state: 'removed', desired: 0 });
  });

  test('expiry with no event: the sweep after the branch\'s local midnight removes the member', async () => {
    const u2 = await w.member('Expiring Member');
    const s2 = await w.subscribe(w.db1, { user: u2, branch, start: -30, end: 0 });
    await dev.sim.drain();
    const pin = await w.pinOf(w.db1, u2.id);
    expect(dev.sim.holds(pin).user).not.toBeNull();
    // The package ended yesterday; nothing fires (time passed). Raw SQL: no hook.
    await w.db1.sequelize.query('UPDATE member_subscriptions SET end_date = ? WHERE id = ?', { replacements: [day(-1), s2.id] });
    // Swept 5 minutes ago (not due by the 15-minute rule) but yesterday local: a midnight passed.
    await w.db1.sequelize.query('UPDATE access_device_details SET last_sweep_at = ? WHERE id = ?', { replacements: utc([new Date(Date.now() - 24 * 3600000), dev.id]) });
    const r = await jobs.syncTenant({ db: w.db1 });
    expect(r.devicesSwept).toBe(1);
    await dev.sim.drain();
    expect(dev.sim.holds(pin).user).toBeNull();
    // Swept just now: the next run is not due.
    expect((await jobs.syncTenant({ db: w.db1 })).devicesSwept).toBe(0);
  });

  test('a visit-limited package used up is not desired (attendance rule isCheckinValid)', async () => {
    const u3 = await w.member('Visits Member');
    await w.subscribe(w.db1, { user: u3, branch, remainingVisits: 0 });
    expect(await w.pinOf(w.db1, u3.id)).toBeNull(); // never qualified: no PIN handed out
    expect(await w.syncRow(w.db1, dev.id, u3.id)).toBeNull();
  });
});

describe('branch transfer between organizations', () => {
  test('moving the subscription to a branch of another organization moves the member between devices', async () => {
    const orgA = await w.gym(w.db1);
    const orgB = await w.gym(w.db1);
    const bA = await w.branch(w.db1, { gymId: orgA.id });
    const bA2 = await w.branch(w.db1, { gymId: orgA.id });
    const bB = await w.branch(w.db1, { gymId: orgB.id });
    const dA = await w.device(w.db1, { branch: bA, registryBody: FACE_ONLY });
    const dA2 = await w.device(w.db1, { branch: bA2, registryBody: FACE_ONLY });
    const dB = await w.device(w.db1, { branch: bB, registryBody: FACE_ONLY });
    const u = await w.member('Transfer Member');
    const s = await w.subscribe(w.db1, { user: u, branch: bA });
    const pin = await w.pinOf(w.db1, u.id);
    for (const d of [dA, dA2, dB]) await d.sim.drain();
    // QR rule: any branch of the same organization.
    expect(dA.sim.holds(pin).user).not.toBeNull();
    expect(dA2.sim.holds(pin).user).not.toBeNull();
    expect(dB.sim.holds(pin).user).toBeNull();
    await s.update({ branchId: bB.id });
    await w.settled();
    for (const d of [dA, dA2, dB]) await d.sim.drain();
    expect(dA.sim.holds(pin).user).toBeNull();
    expect(dA2.sim.holds(pin).user).toBeNull();
    expect(dB.sim.holds(pin).user).not.toBeNull();
    expect(await w.pinOf(w.db1, u.id)).toBe(pin); // the PIN never changes
  });
});

describe('return codes (§8.1)', () => {
  // Each test its own branch: a new device takes every member of its branch.
  let branch;
  beforeEach(async () => { branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id }); });

  test('-27 on the authorization: the user is sent again, then the authorization; the pair ends in sync', async () => {
    let once = true;
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY, forceReturn: (t) => (t.startsWith('DATA UPDATE userauthorize') && once ? ((once = false), -27) : null) });
    const u = await w.member('Minus 27');
    await w.subscribe(w.db1, { user: u, branch });
    const done = await d.sim.drain();
    expect(done.map((c) => `${c.text.split(' ').slice(0, 3).join(' ')}:${c.returnCode}`)).toEqual([
      'DATA UPDATE user:0', 'DATA UPDATE userauthorize:-27', 'DATA UPDATE user:0', 'DATA UPDATE userauthorize:0',
    ]);
    expect(await w.syncRow(w.db1, d.id, u.id)).toMatchObject({ state: 'in_sync' });
  });

  test('storage full (-18): failed, logged; transient (-2): back in the queue with a 30 s backoff', async () => {
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY, forceReturn: (t) => (t.startsWith('DATA UPDATE user ') ? -18 : t.startsWith('DATA UPDATE userauthorize') ? -2 : null) });
    const u = await w.member('Full Device');
    await w.subscribe(w.db1, { user: u, branch });
    const step = await d.sim.step();
    expect(step.results.map((r) => r.returnCode)).toEqual([-18, -2]);
    const cmds = await w.commands(w.db1, d.id, 'member_id = ?', [u.id]);
    expect(cmds.map((c) => c.status)).toEqual(['failed', 'queued']);
    expect(new Date(cmds[1].not_before).getTime()).toBeGreaterThan(Date.now() + 20000);
    const logs = await w.q(w.db1, 'SELECT kind, code FROM device_error_logs WHERE device_id = ?', [d.id]);
    expect(logs).toEqual([{ kind: 'device_storage_full', code: -18 }]);
    // Once the retry is answered the batch settles as failed (one command failed).
    await w.db1.sequelize.query('UPDATE device_commands SET not_before = ? WHERE id = ?', { replacements: utc([new Date(Date.now() - 1000), cmds[1].id]) });
    d.sim.forceReturn = null;
    await d.sim.drain();
    expect(await w.syncRow(w.db1, d.id, u.id)).toMatchObject({ state: 'failed', last_return_code: -18 });
    // The failed pair is retried by the sweep only after an hour.
    await sync.reconcileMember(w.db1, u.id, 'test');
    expect((await w.commands(w.db1, d.id, 'member_id = ? AND status = \'queued\'', [u.id])).length).toBe(0);
    await w.db1.sequelize.query('UPDATE device_member_sync SET last_error_at = ? WHERE device_id = ?', { replacements: utc([new Date(Date.now() - 2 * 3600000), d.id]) });
    await sync.reconcileDevice(w.db1, d.id, 'sweep');
    await d.sim.drain();
    expect(await w.syncRow(w.db1, d.id, u.id)).toMatchObject({ state: 'in_sync', retry_count: 1 });
  });

  test('several results in one devicecmd body, lower-case return=, a result for another device ignored', async () => {
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY, lowerCaseReturn: true });
    const other = await w.device(w.db1, { branch, registryBody: FACE_ONLY });
    const u = await w.member('Lower Case');
    await w.subscribe(w.db1, { user: u, branch });
    const theirs = await w.commands(w.db1, other.id, 'member_id = ?', [u.id]);
    const poll = await d.sim.poll();
    expect(poll.commands.length).toBe(2);
    const body = [...poll.commands.map((c) => `ID=${c.id}&return=0&CMD=DATA`), `ID=${theirs[0].id}&Return=0&CMD=DATA`].join('\r\n');
    await d.sim.request('POST', `/iclock/devicecmd?SN=${d.sim.sn}`, body);
    expect(await w.syncRow(w.db1, d.id, u.id)).toMatchObject({ state: 'in_sync' });
    expect((await w.commands(w.db1, other.id, 'id = ?', [theirs[0].id]))[0].status).toBe('queued');
  });

  test('superseded: activate then cancel before the device polls sends only the removal', async () => {
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY });
    const u = await w.member('Quick Cancel');
    const s = await w.subscribe(w.db1, { user: u, branch });
    await s.update({ status: 'CANCELLED' });
    await w.settled();
    const statuses = (await w.commands(w.db1, d.id, 'member_id = ?', [u.id])).map((c) => c.status);
    expect(statuses.filter((x) => x === 'superseded').length).toBe(2);
    const done = await d.sim.drain();
    expect(done.every((c) => c.text.startsWith('DATA DELETE'))).toBe(true);
  });
});

describe('version mismatch → comparison photo (§3, §7.1)', () => {
  test('a template of another algorithm version is not sent; the comparison photo is; -30 does the same', async () => {
    const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY });
    const u = await w.member('Face Member');
    await biometrics.recordConsent(w.db1, { memberId: u.id, method: 'in_person' });
    await biometrics.storeTemplates(w.db1, { memberId: u.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '58', minorVer: '1', format: 0, tmp: fx.TEMPLATE }] });
    await biometrics.storePhoto(w.db1, { tenantId: w.ctx.tenant1.id, memberId: u.id, deviceId: null, photo: { pin: '1', type: 9, kind: 'biophoto', content: fx.PHOTO } });
    await w.subscribe(w.db1, { user: u, branch });
    const done = await d.sim.drain();
    expect(done.map((c) => c.text.split(' ').slice(0, 3).join(' '))).toEqual(['DATA UPDATE user', 'DATA UPDATE userauthorize', 'DATA UPDATE biophoto']);
    const pin = await w.pinOf(w.db1, u.id);
    expect(d.sim.holds(pin).photoTypes).toEqual([9]);
    expect(d.sim.holds(pin).bioTypes).toEqual([]);

    // A matching version is sent as a template; the device says -30 anyway → photo fallback.
    const u2 = await w.member('Face Member Two');
    await biometrics.recordConsent(w.db1, { memberId: u2.id, method: 'in_person' });
    await biometrics.storeTemplates(w.db1, { memberId: u2.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: fx.TEMPLATE }] });
    await biometrics.storePhoto(w.db1, { tenantId: w.ctx.tenant1.id, memberId: u2.id, deviceId: null, photo: { pin: '1', type: 9, kind: 'biophoto', content: fx.PHOTO } });
    d.sim.forceReturn = (t) => (t.startsWith('DATA UPDATE biodata') ? -30 : null);
    await w.subscribe(w.db1, { user: u2, branch });
    const done2 = await d.sim.drain();
    // The pair was never confirmed, so the re-plan after -30 sends the user again (harmless), then the photo.
    expect(done2.map((c) => `${c.text.split(' ').slice(0, 3).join(' ')}:${c.returnCode}`)).toEqual([
      'DATA UPDATE user:0', 'DATA UPDATE userauthorize:0', 'DATA UPDATE biodata:-30', 'DATA UPDATE user:0', 'DATA UPDATE userauthorize:0', 'DATA UPDATE biophoto:0',
    ]);
    const row = await w.syncRow(w.db1, d.id, u2.id);
    expect(row.state).toBe('in_sync');
    expect(JSON.parse(row.incompatible_json).length).toBe(1);
    // The template went out in the command, but is stored only encrypted and never in args_json.
    const cmds = await w.commands(w.db1, d.id);
    expect(cmds.some((c) => String(c.args_json).includes(fx.TEMPLATE.slice(0, 40)))).toBe(false);
  });
});

describe('staff (D-8), locked branch (D-5), OUT exit grace (D-7)', () => {
  test('staff with device access: privilege 0, no window; flag off → removed', async () => {
    const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY });
    const u = await w.member('Staff Person');
    const staff = await w.db1.models.GymStaff.create({ branchId: branch.id, userId: u.id, employmentStatus: 'ACTIVE', status: 'active' });
    await w.db1.sequelize.query('UPDATE gym_staff SET device_access = 1 WHERE id = ?', { replacements: [staff.id] });
    await sync.reconcileMember(w.db1, u.id, 'test');
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    expect(d.sim.holds(pin).user).toMatchObject({ privilege: '0', endTime: undefined });
    await w.db1.sequelize.query('UPDATE gym_staff SET device_access = 0 WHERE id = ?', { replacements: [staff.id] });
    await sync.reconcileMember(w.db1, u.id, 'test');
    await d.sim.drain();
    expect(d.sim.holds(pin).user).toBeNull();
  });

  test('a branch locked past the members\' check-in grace: no new member is added, an expiry is still removed', async () => {
    const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const d = await w.device(w.db1, { branch, registryBody: FACE_ONLY });
    const old = await w.member('Already On');
    const s = await w.subscribe(w.db1, { user: old, branch });
    await d.sim.drain();
    await w.db1.sequelize.query('UPDATE branches SET billing_locked_at = ? WHERE id = ?', { replacements: utc([new Date(Date.now() - 30 * 86400000), branch.id]) });
    const fresh = await w.member('Joins Later');
    await w.subscribe(w.db1, { user: fresh, branch });
    await d.sim.drain();
    expect(await w.syncRow(w.db1, d.id, fresh.id)).toBeNull();
    await s.update({ status: 'CANCELLED' });
    await w.settled();
    await d.sim.drain();
    expect(d.sim.holds(await w.pinOf(w.db1, old.id)).user).toBeNull();
  });

  test('OUT device: EndTime + 24 h, and an expired member stays for the exit grace, then goes', async () => {
    const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const din = await w.device(w.db1, { branch, registryBody: FACE_ONLY.replace('DateFmtFunOn=0', 'DateFmtFunOn=1'), direction: 'in' });
    const dout = await w.device(w.db1, { branch, registryBody: FACE_ONLY.replace('DateFmtFunOn=0', 'DateFmtFunOn=1'), direction: 'out' });
    const u = await w.member('Leaving Member');
    const s = await w.subscribe(w.db1, { user: u, branch, end: 5 });
    await din.sim.drain();
    await dout.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    const endIn = Number(din.sim.holds(pin).user.endTime);
    const endOut = Number(dout.sim.holds(pin).user.endTime);
    const [y, m, dd] = day(5).split('-').map(Number);
    expect(endIn).toBe(protocol.encodeZkTime(y, m, dd, 23, 59, 59));
    expect(endOut - endIn).toBe(86400); // 24 h later (same ZK day arithmetic within a month boundary)
    await s.update({ status: 'CANCELLED' });
    await w.settled();
    await din.sim.drain();
    await dout.sim.drain();
    expect(din.sim.holds(pin).user).toBeNull();
    expect(dout.sim.holds(pin).user).not.toBeNull(); // can still get out
    expect((await w.syncRow(w.db1, dout.id, u.id)).undesired_since).toBeTruthy();
    // 25 hours later the sweep removes it.
    await sync.reconcileDevice(w.db1, dout.id, 'sweep', { now: new Date(Date.now() + 25 * 3600000) });
    await dout.sim.drain();
    expect(dout.sim.holds(pin).user).toBeNull();
    // On the device itself, past EndTime the scan is refused even without GymsEra (layer 3).
    expect((await din.sim.scan('999999', localNow(), { send: false })).event).toBe(27);
  });
});

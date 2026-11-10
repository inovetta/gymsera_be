/**
 * ZKTeco Phase 3 engine items (spec §7.5, §8.2, §10.3, §13, §14; D-5, D-6), with the simulator as the device:
 *
 *   wipe on unpair      explicit confirmation; the device gets DATA DELETE … * and is removed when it answers
 *   batching            templates of several members in ONE biodata command; a refused pack goes back one by one
 *   suspension          a suspended user leaves the device at once (not at the next sweep), and comes back
 *   owner alerts        error rate and capacity 90%, once per incident, only with the branch's alerts on
 *   capture photos      ATTPHOTO stored only with the branch opt-in, linked to the scan, 30-day retention,
 *                       deleted when the branch opts out
 *   unlinked users      link to a member (the member takes the device PIN), dismiss (and remove)
 *   live feed           D-5 scans stored without a check-in show with their note
 *   self-withdrawal     the member withdraws consent at one gym: data deleted there and from its devices
 */
const { QueryTypes } = require('sequelize');
const { createWorld, localNow } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { sequelize: platformDb } = require('../../src/database/platform');
const { User, Notification } = require('../../src/models/platform');
const biometrics = require('../../src/services/devices/biometric.service');
const sync = require('../../src/services/devices/device-sync.service');
const jobs = require('../../src/jobs/device-jobs');
const fx = require('../fixtures/zkteco/manual-samples');
const { utc } = require('../../src/services/devices/sql-time');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const FACE = (extra = '') => 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,' +
  'MultiBioDataSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:0:0,MultiBioVersion=0:0:0:0:0:0:0:0:0:58.1:0,DateFmtFunOn=0' + extra;
const owner = () => asPersona('owner');
const at = (db, sql, rep) => db.query(sql, { replacements: utc(rep) });
const platformRow = async (id) => (await platformDb.query('SELECT * FROM access_devices WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];
const newOrgBranch = async () => w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
const withFace = async (user) => {
  await biometrics.recordConsent(w.db1, { memberId: user.id, method: 'in_person' });
  await biometrics.storeTemplates(w.db1, { memberId: user.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '58', minorVer: '1', format: 0, tmp: fx.TEMPLATE }] });
};

describe('wipe on unpair (§10.3)', () => {
  let branch; let door; let user;
  beforeAll(async () => {
    branch = await newOrgBranch();
    door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Wipe Door' });
    user = await w.member('Wipe Member');
    await w.subscribe(w.db1, { user, branch });
    await door.sim.drain();
    expect(door.sim.users.size).toBe(1);
  });

  test('no wipe without typing the device name', async () => {
    const res = await owner().delete(`/host/devices/${door.id}`, { wipeDevice: true, confirmName: 'something else' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code || res.body.code).toBe('wipe_confirmation_required');
    expect((await platformRow(door.id)).status).toBe('active');
  });

  test('with the name: wiping; the device gets the deletes, nothing else; then it is removed and the serial is free', async () => {
    const res = await owner().delete(`/host/devices/${door.id}`, { wipeDevice: true, confirmName: ' wipe door ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'wiping', wipe: true });
    expect((await platformRow(door.id)).status).toBe('wiping');
    const view = await owner().get(`/host/devices/${door.id}`);
    expect(view.body.data.device.connection).toBe('wiping');
    // A scan while wiping is answered and dropped.
    const before = (await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_access_events WHERE device_id = ?', [door.id]))[0].n;
    await door.sim.scan(await w.pinOf(w.db1, user.id), localNow());
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_access_events WHERE device_id = ?', [door.id]))[0].n).toBe(before);
    const done = await door.sim.drain();
    expect(done.map((c) => c.text)).toEqual(['DATA DELETE userauthorize *', 'DATA DELETE biodata Type=9', 'DATA DELETE biophoto *', 'DATA DELETE user *']);
    expect(door.sim.users.size).toBe(0);
    const row = await platformRow(door.id);
    expect(row.status).toBe('removed');
    expect(row.serial_number).toBeNull();
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_member_sync WHERE device_id = ?', [door.id]))[0].n).toBe(0);
    expect((await w.q(w.db1, 'SELECT action FROM audit_logs WHERE action = \'devices.removed_with_wipe\'')).length).toBe(1);
  });

  test('a device that never answers is removed after DEVICE_WIPE_WAIT_DAYS by the watchdog', async () => {
    const b2 = await newOrgBranch();
    const silent = await w.device(w.db1, { branch: b2, registryBody: FACE(), name: 'Silent' });
    await owner().delete(`/host/devices/${silent.id}`, { wipeDevice: true, confirmName: 'Silent' });
    expect(await jobs.finishWipes({ tenantId: w.db1.tenantId, db: w.db1 })).toBe(0);
    await at(w.db1.sequelize, 'UPDATE device_commands SET created_at = ? WHERE device_id = ? AND kind = \'wipe\'', [new Date(Date.now() - 8 * 86400000), silent.id]);
    expect(await jobs.finishWipes({ tenantId: w.db1.tenantId, db: w.db1 })).toBe(1);
    expect((await platformRow(silent.id)).status).toBe('removed');
  });

  test('remove without wipe leaves the device as it is (Phase 1 behaviour)', async () => {
    const b3 = await newOrgBranch();
    const plain = await w.device(w.db1, { branch: b3, registryBody: FACE(), name: 'Plain' });
    const res = await owner().delete(`/host/devices/${plain.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'removed', wipe: false });
  });
});

describe('first sync: templates of several members in one biodata command (§13)', () => {
  let branch; let door; let members;
  beforeAll(async () => {
    branch = await newOrgBranch();
    members = [];
    for (let i = 0; i < 3; i++) {
      const u = await w.member(`Batch Member ${i}`);
      await withFace(u);
      await w.subscribe(w.db1, { user: u, branch });
      members.push(u);
    }
    door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Batch Door' });
  });

  test('one DATA UPDATE biodata with the three members, after their user records; all in sync', async () => {
    const done = await door.sim.drain();
    const bio = done.filter((c) => c.text.startsWith('DATA UPDATE biodata'));
    expect(bio.length).toBe(1);
    expect(bio[0].text.split('\n').length).toBe(3);
    const firstBio = done.findIndex((c) => c.text.startsWith('DATA UPDATE biodata'));
    const lastUser = done.map((c) => c.text.startsWith('DATA UPDATE user ')).lastIndexOf(true);
    expect(firstBio).toBeGreaterThan(lastUser);
    for (const u of members) {
      expect(door.sim.holds(await w.pinOf(w.db1, u.id)).bioTypes).toEqual([9]);
      expect(await w.syncRow(w.db1, door.id, u.id)).toMatchObject({ state: 'in_sync' });
    }
    const carried = await w.commands(w.db1, door.id, 'kind = \'bio_upsert\' AND merged_into IS NOT NULL');
    expect(carried.length).toBe(2);
    expect(carried.every((c) => c.status === 'acked')).toBe(true);
  });

  test('a refused pack (-26) blames nobody: each member is sent alone and its own answer decides', async () => {
    const b2 = await newOrgBranch();
    const pair = [];
    for (let i = 0; i < 2; i++) {
      const u = await w.member(`Pack Member ${i}`);
      await withFace(u);
      await w.subscribe(w.db1, { user: u, branch: b2 });
      pair.push(u);
    }
    let refused = 0;
    const dev = await w.device(w.db1, {
      branch: b2, registryBody: FACE(), name: 'Pack Door',
      forceReturn: (text) => (text.startsWith('DATA UPDATE biodata') && text.includes('\n') ? (refused += 1, -26) : null),
    });
    await dev.sim.drain();
    expect(refused).toBe(1);
    for (const u of pair) expect(await w.syncRow(w.db1, dev.id, u.id)).toMatchObject({ state: 'in_sync' });
    const solo = await w.commands(w.db1, dev.id, 'kind = \'bio_upsert\' AND status = \'acked\'');
    expect(solo.length).toBe(2);
    expect(solo.every((c) => JSON.parse(c.args_json).solo === true)).toBe(true);
  });

  test('DEVICE_BIO_BATCH_SIZE=1 turns it off', () => {
    const rows = [1, 2].map((id) => ({ id, kind: 'bio_upsert', member_id: `m${id}`, args_json: '{}' }));
    const list = rows.map((r) => ({ id: r.id, text: `DATA UPDATE biodata Pin=${r.id}\tType=9\tTmp=x` }));
    expect(sync.mergeBiodata(list, rows, 1).list).toEqual(list);
    expect(sync.mergeBiodata(list, rows, 10).list).toEqual([{ id: 2, text: 'DATA UPDATE biodata Pin=1\tType=9\tTmp=x\nPin=2\tType=9\tTmp=x' }]);
  });
});

describe('suspension removes at once (§8.2 "member blocked")', () => {
  test('suspended → off the device in real time (no exit grace); unsuspended → back on', async () => {
    const branch = await newOrgBranch();
    const out = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Exit', direction: 'out' });
    const user = await w.member('Suspended Member');
    await w.subscribe(w.db1, { user, branch });
    await out.sim.drain();
    const pin = await w.pinOf(w.db1, user.id);
    expect(out.sim.holds(pin).user).not.toBeNull();

    const u = await User.findByPk(user.id);
    await u.update({ status: 'SUSPENDED' });
    await w.settled();
    await out.sim.drain();
    expect(out.sim.holds(pin).user).toBeNull(); // an OUT device too: no 24 h grace for a blocked user

    await u.update({ status: 'ACTIVE' });
    await w.settled();
    await out.sim.drain();
    expect(out.sim.holds(pin).user).not.toBeNull();
  });
});

describe('owner alerts per device (§13)', () => {
  let branch; let door;
  const alertsFor = async (type) => Notification.findAll({ where: { userId: w.owner.user.id, type }, raw: true });
  beforeAll(async () => {
    branch = await newOrgBranch();
    door = await w.device(w.db1, { branch, registryBody: FACE(',~MaxUserCount=10'), name: 'Small Door' });
    await Notification.destroy({ where: { userId: w.owner.user.id, type: ['device_capacity', 'device_error_rate', 'device_offline'] } });
  });

  test('capacity at 90% of MaxUserCount: one notification per incident', async () => {
    for (let i = 0; i < 9; i++) await w.subscribe(w.db1, { user: await w.member(`Cap ${i}`), branch });
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    const sent = await alertsFor('device_capacity');
    expect(sent.length).toBe(1);
    expect(sent[0].message).toMatch(/Small Door is at 90% of its user capacity \(9 of 10\)/);
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    expect((await alertsFor('device_capacity')).length).toBe(1);
  });

  test('error rate: DEVICE_ALERT_ERRORS_PER_HOUR errors in an hour; not with the branch alerts off', async () => {
    const put = await owner().put(`/host/devices/branch-settings/${branch.id}`, { alertsEnabled: false });
    expect(put.status).toBe(200);
    for (let i = 0; i < 20; i++) await sync.logError(w.db1, door.id, { kind: 'command_failed', code: -1 });
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    expect((await alertsFor('device_error_rate')).length).toBe(0);
    await owner().put(`/host/devices/branch-settings/${branch.id}`, { alertsEnabled: true });
    await w.db1.sequelize.query('UPDATE access_device_details SET alerts_json = NULL WHERE id = ?', { replacements: [door.id] });
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    const sent = await alertsFor('device_error_rate');
    expect(sent.length).toBe(1);
    expect(sent[0].message).toMatch(/Small Door reported 20 errors in the last hour/);
  });

  test('offline: no owner notification when the branch turned alerts off (the incident is still recorded)', async () => {
    await owner().put(`/host/devices/branch-settings/${branch.id}`, { alertsEnabled: false });
    await at(platformDb, 'UPDATE access_devices SET last_seen_at = ? WHERE id = ?', [new Date(Date.now() - 3600000), door.id]);
    await jobs.watchdogTenant({ tenantId: w.db1.tenantId, db: w.db1 });
    expect((await alertsFor('device_offline')).length).toBe(0);
    const [det] = await w.q(w.db1, 'SELECT offline_notified_at FROM access_device_details WHERE id = ?', [door.id]);
    expect(det.offline_notified_at).not.toBeNull();
  });
});

describe('capture photos (D-6)', () => {
  let branch; let door; let user;
  const photoLine = (pin, local) => `pin=${local.replace(/[- :]/g, '')}-${pin}.jpg\tsn=X\tsize=${fx.PHOTO.length}\tcmd=uploadphoto\tphoto=${fx.PHOTO}`;
  beforeAll(async () => {
    branch = await newOrgBranch();
    door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Camera Door' });
    user = await w.member('Photo Member');
    await w.subscribe(w.db1, { user, branch });
    await door.sim.drain();
  });

  test('off by default: an ATTPHOTO upload is answered and nothing is stored', async () => {
    const t = localNow();
    await door.sim.scan(await w.pinOf(w.db1, user.id), t);
    const res = await door.sim.upload(null, photoLine(await w.pinOf(w.db1, user.id), t), { tablename: 'ATTPHOTO', count: 1 });
    expect(res.text).toMatch(/ATTPHOTO=1/);
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_capture_photos'))[0].n).toBe(0);
    expect((await owner().get(`/host/devices/branch-settings/${branch.id}`)).body.data.settings).toMatchObject({ capturePhotos: false, alertsEnabled: true, photoRetentionDays: 30 });
  });

  test('opted in: stored encrypted, linked to the scan, shown in the live feed, served as a JPEG', async () => {
    expect((await owner().put(`/host/devices/branch-settings/${branch.id}`, { capturePhotos: true })).body.data.settings.capturePhotos).toBe(true);
    const t = localNow(1);
    const pin = await w.pinOf(w.db1, user.id);
    await door.sim.scan(pin, t);
    await door.sim.upload(null, photoLine(pin, t), { tablename: 'ATTPHOTO', count: 1 });
    const [photo] = await w.q(w.db1, 'SELECT * FROM device_capture_photos');
    expect(photo.event_id).not.toBeNull();
    expect(photo.storage_key).toMatch(/^device-captures\//);
    const feed = await owner().get(`/host/devices/${door.id}/access-events`);
    const ev = feed.body.data.events.find((e) => e.id === Number(photo.event_id));
    expect(ev).toMatchObject({ photoId: Number(photo.id), memberName: 'Photo Member', result: 'granted' });
    expect(JSON.stringify(feed.body)).not.toContain(fx.PHOTO.slice(0, 40));
    const img = await owner().get(`/host/devices/capture-photos/${photo.id}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/);
    expect(Buffer.from(img.body).equals(Buffer.from(fx.PHOTO, 'base64'))).toBe(true);
    expect((await asPersona('otherTenantOwner').get(`/host/devices/capture-photos/${photo.id}`)).status).toBe(404);
  });

  test('30-day retention, and opting out deletes what is stored', async () => {
    await at(w.db1.sequelize, 'UPDATE device_capture_photos SET created_at = ?', [new Date(Date.now() - 31 * 86400000)]);
    const r = await jobs.retentionTenant({ db: w.db1 });
    expect(r.capturePhotosDeleted).toBe(1);
    const pin = await w.pinOf(w.db1, user.id);
    const t = localNow(2);
    await door.sim.scan(pin, t);
    await door.sim.upload(null, photoLine(pin, t), { tablename: 'ATTPHOTO', count: 1 });
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_capture_photos'))[0].n).toBe(1);
    const off = await owner().put(`/host/devices/branch-settings/${branch.id}`, { capturePhotos: false });
    expect(off.body.data.photosDeleted).toBe(1);
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_capture_photos'))[0].n).toBe(0);
  });
});

describe('unlinked device users (§7.5)', () => {
  let branch; let door;
  beforeAll(async () => {
    branch = await newOrgBranch();
    door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Old Door' });
    // Users added by hand on the device before GymsEra (GymBioSync era).
    await door.sim.upload(null, 'user uid=1\tcardno=\tpin=7\tname=Old Seven\tprivilege=0\nuser uid=2\tcardno=\tpin=8\tname=Old Eight\tprivilege=0', { tablename: 'user', count: 2 });
  });

  test('listed per device and for the tenant', async () => {
    const one = await owner().get(`/host/devices/${door.id}/unlinked-users`);
    expect(one.body.data.users.map((u) => u.pin).sort()).toEqual(['7', '8']);
    const all = await owner().get(`/host/devices/unlinked-users?branchId=${branch.id}`);
    expect(all.body.data.users.length).toBe(2);
    expect(all.body.data.users[0]).toMatchObject({ deviceName: 'Old Door' });
  });

  test('link: a member with no PIN takes the device PIN; entitled → sent with the window; gone from the list', async () => {
    const m = await w.member('Linked Member');
    await w.db1.models.MemberProfile.create({ userId: m.id }).catch(() => null);
    await w.subscribe(w.db1, { user: m, branch });
    // subscribe gave a PIN through the trigger; a member with a PIN gets 409.
    const clash = await owner().post(`/host/devices/${door.id}/unlinked-users/7/link`, { memberId: m.id });
    expect(clash.status).toBe(409);
    expect(clash.body.error?.code || clash.body.code).toBe('member_has_pin');

    const fresh = await w.member('Fresh Linked Member');
    await w.db1.models.MemberProfile.create({ userId: fresh.id }).catch(() => null);
    const res = await owner().post(`/host/devices/${door.id}/unlinked-users/7/link`, { memberId: fresh.id });
    expect(res.status).toBe(200);
    expect(await w.pinOf(w.db1, fresh.id)).toBe('7');
    // Not entitled (no package): the device's user 7 is taken off.
    await door.sim.drain();
    expect(door.sim.holds('7').user).toBeNull();
    expect((await owner().get(`/host/devices/${door.id}/unlinked-users`)).body.data.users.map((u) => u.pin)).toEqual(['8']);
    // A PIN already linked cannot be linked again.
    expect((await owner().post(`/host/devices/${door.id}/unlinked-users/7/link`, { memberId: m.id })).status).toBe(404);
  });

  test('dismiss, with removeFromDevice: hidden, and the device deletes that user', async () => {
    door.sim.users.set('8', { pin: '8', name: 'Old Eight' });
    const res = await owner().post(`/host/devices/${door.id}/unlinked-users/8/dismiss`, { removeFromDevice: true });
    expect(res.status).toBe(200);
    expect((await owner().get(`/host/devices/${door.id}/unlinked-users`)).body.data.users).toEqual([]);
    await door.sim.drain();
    expect(door.sim.holds('8').user).toBeNull();
  });

  test('a member of another tenant cannot be linked', async () => {
    const stranger = await w.member('Stranger');
    await door.sim.upload(null, 'user uid=3\tcardno=\tpin=9\tname=Nine\tprivilege=0', { tablename: 'user', count: 1 });
    expect((await owner().post(`/host/devices/${door.id}/unlinked-users/9/link`, { memberId: stranger.id })).status).toBe(404);
  });
});

describe('live feed with D-5 scans (§10.5)', () => {
  test('a scan stored without a check-in (branch locked past the grace) shows with its note', async () => {
    const branch = await newOrgBranch();
    const door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Locked Door' });
    const user = await w.member('Grace Member');
    await w.subscribe(w.db1, { user, branch });
    await door.sim.drain();
    await at(w.db1.sequelize, 'UPDATE branches SET billing_locked_at = ? WHERE id = ?', [new Date(Date.now() - 30 * 86400000), branch.id]);
    await door.sim.scan(await w.pinOf(w.db1, user.id), localNow());
    const feed = await owner().get(`/host/branches/${branch.id}/access-events`);
    expect(feed.status).toBe(200);
    expect(feed.body.data.events[0]).toMatchObject({ result: 'granted', attendanceNote: 'member_checkin_grace_expired', checkedIn: false, memberName: 'Grace Member', deviceName: 'Locked Door' });
    const latest = feed.body.data.latestId;
    expect((await owner().get(`/host/branches/${branch.id}/access-events?afterId=${latest}`)).body.data.events).toEqual([]);
  });
});

describe('member self-withdrawal (§14)', () => {
  test('GET lists the gym; DELETE withdraws: templates gone here and from the device', async () => {
    const branch = await newOrgBranch();
    const door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Self Door' });
    const me = asPersona('member');
    const memberId = require('../harness/personas').personaManager.personas.member.user.id;
    await withFace({ id: memberId });
    await w.subscribe(w.db1, { user: { id: memberId }, branch });
    await door.sim.drain();
    const pin = await w.pinOf(w.db1, memberId);
    expect(door.sim.holds(pin).bioTypes).toEqual([9]);

    const list = await me.get('/me/biometric-consents');
    expect(list.status).toBe(200);
    const gym = list.body.data.gyms.find((g) => g.tenantId === w.db1.tenantId);
    expect(gym.consent).toMatchObject({ consented: true, templates: 1 });

    const res = await me.delete(`/me/biometric-consents/${w.db1.tenantId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.templatesDeleted).toBe(1);
    await w.settled();
    await door.sim.drain();
    expect(door.sim.holds(pin).bioTypes).toEqual([]);
    expect(door.sim.holds(pin).user).not.toBeNull(); // still a member: card / PIN entry keeps working
    // Another tenant's id: nothing there.
    expect((await me.delete(`/me/biometric-consents/${w.db2.tenantId}`)).status).toBe(404);
  });
});

describe('device tabs and the member card: content (§10.3, §10.4)', () => {
  test('members, commands, errors, audits; the member card; never a template or a command text', async () => {
    const branch = await newOrgBranch();
    const door = await w.device(w.db1, { branch, registryBody: FACE(), name: 'Tab Door' });
    const ok = await w.member('Tab In Sync');
    await withFace(ok);
    await w.subscribe(w.db1, { user: ok, branch });
    const bad = await w.member('Tab Failed');
    await w.subscribe(w.db1, { user: bad, branch });
    const badPin = await w.pinOf(w.db1, bad.id);
    door.sim.forceReturn = (text) => (text.startsWith('DATA UPDATE user ') && text.includes(`Pin=${badPin}\t`) ? -18 : null);
    await door.sim.drain();
    door.sim.forceReturn = null;

    const members = (await owner().get(`/host/devices/${door.id}/members`)).body.data;
    expect(members.counts).toMatchObject({ inSync: 1, failed: 1, pending: 0 });
    expect(members.members.find((m) => m.memberId === bad.id)).toMatchObject({ name: 'Tab Failed', state: 'failed', lastReturnCode: -18, failedReason: 'device_storage_full' });
    expect((await owner().get(`/host/devices/${door.id}/members?state=failed`)).body.data.members.map((m) => m.memberId)).toEqual([bad.id]);

    const cmds = (await owner().get(`/host/devices/${door.id}/commands?status=failed`)).body.data.commands;
    // Newest first; after the user record fails (-18) the authorization gets -27 (unknown PIN).
    expect(cmds.find((c) => c.kind === 'user_upsert')).toMatchObject({ status: 'failed', returnCode: -18, memberName: 'Tab Failed' });
    const errors = (await owner().get(`/host/devices/${door.id}/errors`)).body.data.errors;
    expect(errors.find((e) => e.kind === 'device_storage_full')).toMatchObject({ code: -18, source: 'server' });

    await owner().post(`/host/devices/${door.id}/sync`, { mode: 'audit' });
    await door.sim.drain();
    const audits = (await owner().get(`/host/devices/${door.id}/audits`)).body.data;
    expect(audits.reports[0]).toMatchObject({ status: 'compared', deviceUserCount: 1 });
    expect(audits.activity.map((a) => a.action)).toContain('devices.audit_requested');

    const card = (await owner().get(`/host/members/${ok.id}/device-status`)).body.data;
    expect(card).toMatchObject({ pin: await w.pinOf(w.db1, ok.id), consent: { consented: true } });
    expect(card.biometrics).toEqual([expect.objectContaining({ type: 9, count: 1, waitingForConsent: false })]);
    expect(card.devices.find((d) => d.deviceId === door.id)).toMatchObject({ entitled: true, onDevice: true, state: 'in_sync', pending: false });
    const badCard = (await owner().get(`/host/members/${bad.id}/device-status`)).body.data;
    expect(badCard.devices.find((d) => d.deviceId === door.id)).toMatchObject({ entitled: true, state: 'failed', failedReason: 'device_storage_full', lastReturnCode: -18 });

    const everything = JSON.stringify([members, cmds, errors, audits, card, badCard]);
    expect(everything).not.toContain(fx.TEMPLATE.slice(0, 40));
    expect(everything).not.toMatch(/DATA UPDATE|Tmp=|template_enc|registry_code|session_id|comm_key/);
  });
});

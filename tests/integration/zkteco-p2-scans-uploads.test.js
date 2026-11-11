/**
 * ZKTeco Phase 2: what devices send (spec §7.3, §7.4 layer 4, §7.5, §7.6).
 *
 * Scans → device_access_events and check-ins through attendance.service#deviceScan (the one
 * check-in path): IN check-in, OUT check-out, "both" by inoutstatus, the same record twice (one row),
 * the same person twice in the duplicate window (one check-in), unknown PIN → unlinked list, denied
 * while desired → drift re-send, granted while not desired → logged and removed at once, time in
 * the branch zone. Uploads: device users (card adopted, name never), templates without consent
 * (pending, kept on the enrolling device only), consent releases them to the member's other devices,
 * photos to the private store (encrypted), ENROLL_BIO and its -708 fallback.
 */
const fs = require('fs');
const path = require('path');
const { createWorld, localNow } = require('../harness/zkteco-world');
const privacy = require('../../src/services/devices/device-privacy.service');
const biometrics = require('../../src/services/devices/biometric.service');
const ingest = require('../../src/services/devices/device-ingest.service');
const fx = require('../fixtures/zkteco/manual-samples');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const REG = (dateFmt = 1) => 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,' +
  'MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,' +
  `DateFmtFunOn=${dateFmt}`;

const freshBranch = async () => w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
const events = (deviceId) => w.q(w.db1, 'SELECT * FROM device_access_events WHERE device_id = ? ORDER BY id', [deviceId]);
const attendance = (userId) => w.q(w.db1, 'SELECT * FROM attendance_logs WHERE user_id = ? ORDER BY check_in_at', [userId]);

describe('scans → check-ins (§7.3)', () => {
  test('granted on an IN device: one access event and one check-in (method DEVICE); the same record twice is one row', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Scanner One');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    const at = localNow();
    const s = await d.sim.scan(pin, at);
    expect(s.event).toBe(0);
    expect(s.res.text).toBe('OK\n');
    await d.sim.upload('rtlog', s.line); // the device sends the same record again
    const ev = await events(d.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ pin, member_id: u.id, result: 'granted', event_code: 0, attendance_note: 'check_in', branch_id: branch.id });
    // Device local time is the branch's (Asia/Karachi, UTC+5): utc_time is 5 hours earlier.
    expect(new Date(`${at.replace(' ', 'T')}Z`).getTime() - new Date(ev[0].utc_time).getTime()).toBe(5 * 3600000);
    const logs = await attendance(u.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entry_method: 'DEVICE', attendance_type: 'CHECK_IN', device_id: d.id, branch_id: branch.id });
  });

  test('the same person twice inside the duplicate window: two events, one check-in', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Scanner Twice');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    await d.sim.scan(pin, localNow(-1));
    await d.sim.scan(pin, localNow());
    const ev = await events(d.id);
    expect(ev.map((e) => e.attendance_note)).toEqual(['check_in', 'duplicate']);
    expect(await attendance(u.id)).toHaveLength(1);
  });

  test('OUT device closes the check-in; a "both" device follows inoutstatus', async () => {
    const branch = await freshBranch();
    const din = await w.device(w.db1, { branch, registryBody: REG(), direction: 'in' });
    const dout = await w.device(w.db1, { branch, registryBody: REG(), direction: 'out' });
    const both = await w.device(w.db1, { branch, registryBody: REG(), direction: 'both' });
    const u = await w.member('In And Out');
    await w.subscribe(w.db1, { user: u, branch });
    for (const d of [din, dout, both]) await d.sim.drain();
    // These scans are an hour and half an hour old: the doors must have been running then. Since Phase 5 a scan
    // from before a device's activation is history (a device event, never a check-in), so the activation of
    // these just-added doors is put two hours back. The assertions are unchanged.
    await require('../../src/database/platform').sequelize.query('UPDATE access_devices SET registered_at = DATE_SUB(registered_at, INTERVAL 2 HOUR) WHERE id IN (?)',
      { replacements: [[din.id, dout.id, both.id]] });
    const pin = await w.pinOf(w.db1, u.id);
    await din.sim.scan(pin, localNow(-60));
    await dout.sim.scan(pin, localNow(-30));
    let logs = await attendance(u.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].attendance_type).toBe('CHECK_OUT');
    expect(logs[0].check_out_at).toBeTruthy();
    await both.sim.scan(pin, localNow(-10), { inoutstatus: 0 });
    await both.sim.scan(pin, localNow(), { inoutstatus: 1 });
    logs = await attendance(u.id);
    expect(logs).toHaveLength(2);
    expect(logs[1].attendance_type).toBe('CHECK_OUT');
  });

  test('a visit-limited package: the device check-in counts a visit; the last one takes the member off', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Last Visit');
    const sub = await w.subscribe(w.db1, { user: u, branch, remainingVisits: 1 });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    await d.sim.scan(pin, localNow());
    await w.settled();
    expect((await sub.reload()).remainingVisits).toBe(0);
    await d.sim.drain();
    expect(d.sim.holds(pin).user).toBeNull();
  });

  test('unknown PIN → unlinked list (never a member); door events (PIN 0) are stored only', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    await d.sim.upload('rtlog', `time=${localNow()}\tpin=777001\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=0\tverifytype=15\tindex=9001`);
    await d.sim.upload('rtlog', `time=${localNow()}\tpin=0\tcardno=0\teventaddr=1\tevent=206\tinoutstatus=2\tverifytype=200\tindex=9002`);
    const ev = await events(d.id);
    expect(ev.map((e) => [e.pin, e.result, e.attendance_note])).toEqual([['777001', 'granted', 'unlinked_pin'], ['0', 'granted', null]]);
    const unlinked = await w.q(w.db1, 'SELECT pin, source, hits FROM device_unlinked_users WHERE device_id = ?', [d.id]);
    expect(unlinked).toEqual([{ pin: '777001', source: 'scan', hits: 1 }]);
  });

  test('denied while GymsEra admits the member (drift): logged and the member is sent again', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Drifted Member');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    d.sim.users.delete(pin); // someone deleted the user on the device menu
    const s = await d.sim.scan(pin, localNow());
    expect(s.event).toBe(27);
    const ev = await events(d.id);
    expect(ev[0]).toMatchObject({ result: 'denied', reason: 'not_registered', member_id: u.id });
    expect((await w.q(w.db1, 'SELECT kind FROM device_error_logs WHERE device_id = ?', [d.id])).map((r) => r.kind)).toEqual(['denied_but_desired']);
    await d.sim.drain();
    expect(d.sim.holds(pin).user).not.toBeNull();
    expect((await d.sim.scan(pin, localNow(1))).event).toBe(0);
  });

  test('granted while GymsEra does not admit (safety layer 4): logged, removed at once', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Should Not Enter');
    const sub = await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    // Cancelled behind the engine's back (no hook) and the sync row says removed: the device still has them.
    await w.db1.sequelize.query('UPDATE member_subscriptions SET status = \'CANCELLED\' WHERE id = ?', { replacements: [sub.id] });
    await w.db1.sequelize.query('UPDATE device_member_sync SET state = \'removed\', desired = 0 WHERE device_id = ?', { replacements: [d.id] });
    expect((await d.sim.scan(pin, localNow())).event).toBe(0);
    expect((await w.q(w.db1, 'SELECT kind FROM device_error_logs WHERE device_id = ?', [d.id])).map((r) => r.kind)).toEqual(['granted_not_desired']);
    const queued = await w.commands(w.db1, d.id, 'member_id = ? AND status = \'queued\'', [u.id]);
    expect(queued.map((c) => c.kind)).toContain('user_delete');
    expect(queued.every((c) => Number(c.priority) === 0)).toBe(true);
    await d.sim.drain();
    expect(d.sim.holds(pin).user).toBeNull();
  });

  test('ATTLOG (positional) lines are stored too, one row per person per second', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Attlog Member');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    const line = `${pin}\t${localNow()}\t0\t15\t0\t0\t0`;
    await d.sim.upload('ATTLOG', `${line}\n${line}`);
    const ev = await events(d.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ member_id: u.id, result: 'granted', attendance_note: 'check_in' });
  });

  test('the local-to-UTC conversion follows the branch zone (DST)', () => {
    expect(ingest.localToUtc('2025-07-01 10:00:00', 'Europe/London').utc.toISOString()).toBe('2025-07-01T09:00:00.000Z');
    expect(ingest.localToUtc('2025-12-01 10:00:00', 'Europe/London').utc.toISOString()).toBe('2025-12-01T10:00:00.000Z');
    expect(ingest.localToUtc('not a time', 'Asia/Karachi')).toBeNull();
  });
});

describe('uploads from the device (§7.5, §7.6)', () => {
  test('a device user: card adopted when GymsEra has none, the name never copied; unknown PIN unlinked', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Real Name');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    const res = await d.sim.upload(null, `user uid=1\tcardno=55667788\tpin=${pin}\tname=Typed On Device\tprivilege=0\nuser uid=2\tcardno=\tpin=888002\tname=Stranger\tprivilege=0`, { tablename: 'user', count: 2 });
    expect(res.text).toBe('user=2\n');
    await w.settled();
    expect((await w.q(w.db1, 'SELECT card_no FROM member_device_identity WHERE member_id = ?', [u.id]))[0].card_no).toBe('55667788');
    expect((await w.q(w.db1, 'SELECT pin, name, source FROM device_unlinked_users WHERE device_id = ?', [d.id]))).toEqual([{ pin: '888002', name: 'Stranger', source: 'upload' }]);
    await d.sim.drain();
    expect(d.sim.holds(pin).user).toMatchObject({ name: 'Real Name', cardNo: '55667788' });
  });

  test('templates without consent: stored encrypted, pending 7 days, only on the enrolling device; consent sends them to the others', async () => {
    const branch = await freshBranch();
    const d1 = await w.device(w.db1, { branch, registryBody: REG() });
    const d2 = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Enrols On Device');
    await w.subscribe(w.db1, { user: u, branch });
    await d1.sim.drain();
    await d2.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    const body = `biodata pin=${pin}\tno=0\tindex=0\tvalid=1\tduress=0\ttype=9\tmajorver=40\tminorver=1\tformat=0\ttmp=${fx.TEMPLATE}`;
    expect((await d1.sim.upload(null, body, { tablename: 'biodata', count: 1 })).text).toBe('biodata=1\n');
    await w.settled();
    const [row] = await w.q(w.db1, 'SELECT * FROM member_biometrics WHERE member_id = ?', [u.id]);
    expect(row).toMatchObject({ bio_type: 9, consent_pending: 1, source_device_id: d1.id, major_ver: '40' });
    expect(row.template_enc.includes(Buffer.from(fx.TEMPLATE.slice(0, 40)))).toBe(false);
    expect(new Date(row.pending_until).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
    // Not sent anywhere: the second device gets nothing; the first already has it.
    expect((await d1.sim.poll()).text).toBe('OK\n');
    expect((await d2.sim.poll()).text).toBe('OK\n');

    await privacy.giveConsent(w.db1, { memberId: u.id, byUserId: w.owner.user.id, method: 'in_person' });
    await w.settled();
    const sent1 = await d1.sim.drain();
    const sent2 = await d2.sim.drain();
    expect(sent1).toEqual([]); // the enrolling device is not sent its own template again
    expect(sent2.map((c) => c.text.split(' ').slice(0, 3).join(' '))).toEqual(['DATA UPDATE biodata']);
    expect(d2.sim.holds(pin).bioTypes).toEqual([9]);
  });

  test('photos go to the private store encrypted; capture photos (ATTPHOTO) are never stored (D-6)', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Photo Member');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, u.id);
    await privacy.giveConsent(w.db1, { memberId: u.id, method: 'in_person' });
    await d.sim.upload(null, `biophoto pin=${pin}\tfilename=${pin}.jpg\ttype=9\tsize=${fx.PHOTO.length}\tcontent=${fx.PHOTO}`, { tablename: 'biophoto', count: 1 });
    await d.sim.upload(null, `pin=20261110100000-${pin}.jpg\tsn=${d.sim.sn}\tsize=${fx.PHOTO.length}\tcmd=uploadphoto\tphoto=${fx.PHOTO}`, { tablename: 'ATTPHOTO', count: 1 });
    await w.settled();
    const photos = await w.q(w.db1, 'SELECT kind, bio_type, storage_key, size FROM member_biometric_photos WHERE member_id = ?', [u.id]);
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ kind: 'biophoto', bio_type: 9 });
    expect(photos[0].storage_key).toMatch(new RegExp(`^biometrics/${w.ctx.tenant1.id}/${u.id}/biophoto-9-`));
    const file = path.join(__dirname, '../../storage/private/kyc', photos[0].storage_key);
    const bytes = fs.readFileSync(file);
    expect(bytes.includes(Buffer.from(fx.PHOTO.slice(0, 24)))).toBe(false); // encrypted at rest
    expect((await biometrics.photoForDelivery(w.db1, (await w.q(w.db1, 'SELECT id FROM member_biometric_photos WHERE member_id = ?', [u.id]))[0].id))).toBe(fx.PHOTO);
    await privacy.withdrawConsent(w.db1, { memberId: u.id });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('ENROLL_BIO: consent first; the device enrols and the result is stored; -708 → "enrol on the device menu with PIN"', async () => {
    const branch = await freshBranch();
    const d = await w.device(w.db1, { branch, registryBody: REG() });
    const u = await w.member('Remote Enrol');
    await w.subscribe(w.db1, { user: u, branch });
    await d.sim.drain();
    await expect(privacy.requestEnrollment(w.db1, { deviceId: d.id, memberId: u.id, type: 9 })).rejects.toMatchObject({ code: 'biometric_consent_required' });
    await privacy.giveConsent(w.db1, { memberId: u.id, method: 'in_person' });
    const { pin } = await privacy.requestEnrollment(w.db1, { deviceId: d.id, memberId: u.id, type: 9 });
    const done = await d.sim.drain();
    expect(done.map((c) => c.text)).toContain(`ENROLL_BIO TYPE=9 NO=0 PIN=${pin} RETRY=3 OVERWRITE=1 MODE=1`);
    expect(d.sim.uploads.find((x) => x.path === 'BioData')).toMatchObject({ status: 200 });
    await w.settled();
    const rows = await w.q(w.db1, 'SELECT bio_type, consent_pending, source_device_id FROM member_biometrics WHERE member_id = ?', [u.id]);
    expect(rows).toEqual([{ bio_type: 9, consent_pending: 0, source_device_id: d.id }]);

    const old = await w.device(w.db1, { branch, registryBody: REG(), enrollSupported: false });
    await old.sim.drain();
    await privacy.requestEnrollment(w.db1, { deviceId: old.id, memberId: u.id, type: 9 });
    const r = await old.sim.drain();
    expect(r.find((c) => c.text.startsWith('ENROLL_BIO')).returnCode).toBe(-708);
    await expect(privacy.requestEnrollment(w.db1, { deviceId: old.id, memberId: u.id, type: 9 })).rejects.toMatchObject({ code: 'enroll_not_supported', data: { pin } });
  });
});

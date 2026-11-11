/**
 * ZKTeco Phase 5: T&A PUSH (DeviceType=att) devices end to end, with the simulator in att mode
 * (scripts/zk-device-simulator.js `{ att: true }`, the flow of the 2026-11-11 capture; sanitized fixture
 * tests/fixtures/zkteco/att-speedface-v5l.js).
 *
 *   activation    first request GET cdata?options=all&DeviceType=att, no registry: activated per the link rules
 *                 (host key, path key, serial pairing only when allowed; an unknown serial never joins), answered
 *                 with the att option lines (random codes, stamps, Delay); device type, push version, options
 *                 (counts, versions, MultiBioDataSupport positions) and the INFO counts stored
 *   polling       Delay = DEVICE_REQUEST_DELAY or the device's own poll delay; the fields per setting; SET OPTION
 *                 Delay for a slow poller when switched on; the poll gap is measured
 *   history       punches older than activation (or go-live) are device events only, never check-ins; the
 *                 history upload is accepted in bulk and idempotently
 *   same second   a fingerprint and a face punch of one person in the same second are two events
 *   import        an "import first" att device fills its import from the history upload (356-style data:
 *                 users with admins, FP lines and BIODATA faces); the import becomes ready, matches, applies
 *   audit         OPERLOG USER lines uploaded for an audit's query count as its answer
 *   commands      delivered at the next poll in the per-device form: no userauthorize, validity none
 *                 (StartTime=0 EndTime=0), `user` or `USERINFO` form; removal without userauthorize
 *   token         an att device stays in log mode; the enforce script refuses it and any device that never
 *                 sent a cookie
 *   screens       device type, push version, counts from the device, att options in the device view
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { createWorld, localNow } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');
const imports = require('../../src/services/devices/device-import.service');
const { planTokenMode } = require('../../src/scripts/device-token-mode');
const { sequelize: platformDb } = require('../../src/database/platform');

const owner = () => asPersona('owner');
const data = (res) => res.body.data;
let w;
let branch;
let n = 0;
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();
const sn = () => `ATT${RUN}${String(++n).padStart(4, '0')}`;

const env = (vars, fn) => async () => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const platformRow = async (id) => (await platformDb.query('SELECT * FROM access_devices WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];
const details = async (id) => (await w.q(w.db1, 'SELECT * FROM access_device_details WHERE id = ?', [id]))[0];
const json = (t) => (t ? JSON.parse(t) : null);

/** An att device on `branch`, connected the way the capture shows (no history unless asked). */
async function attDevice({ importFirst = false, mode = 'host', name = 'Front Door', history = false, simOpts = {} } = {}) {
  const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name, direction: 'in', importFirst, createdBy: w.owner.user.id });
  const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode, att: true, ...simOpts });
  const c = await sim.connectAtt();
  if (history) await sim.uploadHistory();
  await w.settled();
  return { device, sim, id: device.id, c };
}

beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Att Branch' });
});

describe('activation without registry', () => {
  test('host key: activated on GET cdata options, answered with the att lines; type, versions, options and INFO stored', async () => {
    const { id, sim, c } = await attDevice();
    expect(c.cdata.status).toBe(200);
    const lines = c.cdata.text.trim().split('\n');
    expect(lines[0]).toBe(`GET OPTION FROM: ${sim.sn}`);
    expect(lines).toEqual(expect.arrayContaining(['registry=ok', 'Delay=3', 'Realtime=1', 'ServerName=GymsEra']));
    expect(lines).not.toContain('RequestDelay=3');
    const p = await platformRow(id);
    expect(p.status).toBe('active');
    expect(p.device_type).toBe('att');
    expect(p.serial_number).toBe(sim.sn);
    expect(p.registered_at).not.toBeNull();
    expect(p.token_mode).toBe('log');
    expect(sim.config.RegistryCode).toBe(p.registry_code);
    expect(sim.config.SessionID).toBe(p.session_id);
    expect(p.last_pushver).toBe('2.4.1');

    const d = await details(id);
    expect(d).toMatchObject({ device_type: 'att', model: 'SpeedFace-V5L', firmware: 'ZAM180-NF50VA-Ver3.4.9', push_version: 'Ver 2.0.33S-20220623', mac: '00:00:5e:00:53:01' });
    const caps = json(d.capabilities_json);
    expect(caps).toMatchObject({ MaxUserCount: '10000', MultiBioDataSupport: '0:1:0:0:0:0:0:0:1:1', MultiBioVersion: '0:10:0:0:0:0:0:0:12:39', OEMVendor: 'ZKTECO CO., LTD.' });
    expect(json(d.counts_json)).toMatchObject({ UserCount: '356', FPCount: '416', FaceCount: '15', TransactionCount: '14262' });
    expect(json(d.info_json)).toMatchObject({ firmware: 'ZAM180-NF50VA-Ver3.4.9', UserCount: '356', FaceVersion: '39' });
  });

  test('path key works the same; a second cdata keeps the device active and the same codes', async () => {
    const { id, sim } = await attDevice({ mode: 'path' });
    expect((await platformRow(id)).status).toBe('active');
    const again = await sim.connectAtt({ info: false });
    expect(again.config.RegistryCode).toBe((await platformRow(id)).registry_code);
  });

  test('works with DEVICE_REGISTRATION_STYLE=spec (the default) and =gbs alike', env({ DEVICE_REGISTRATION_STYLE: 'gbs' }, async () => {
    const { id } = await attDevice();
    expect((await platformRow(id)).device_type).toBe('att');
  }));

  test('an unknown serial without a key never joins (no auto-join)', async () => {
    const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), att: true });
    const c = await sim.connectAtt();
    expect(c.cdata.text.trim()).toBe('OK');
    expect(await registry.findBySerial(sim.sn)).toBeNull();
  });

  test('serial pairing: activated only while DEVICE_SERIAL_PAIRING allows it', env({ DEVICE_SERIAL_PAIRING: 'open', DEVICE_UNCLAIMED_RATE_SECONDS: '0' }, async () => {
    const serial = sn();
    const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name: 'Serial', direction: 'in', linkMode: 'serial', serialNumber: serial, importFirst: false, createdBy: w.owner.user.id });
    process.env.DEVICE_SERIAL_PAIRING = 'off';
    const off = await new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: serial, att: true }).connectAtt({ info: false });
    expect(off.cdata.text.trim()).toBe('OK');
    expect((await platformRow(device.id)).status).toBe('awaiting_connection');
    process.env.DEVICE_SERIAL_PAIRING = 'open';
    const on = await new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: serial, att: true }).connectAtt({ info: false });
    expect(on.cdata.text).toMatch(/^registry=ok$/m);
    expect((await platformRow(device.id)).status).toBe('active');
  }));

  test('a key presented with another serial is refused (406), nothing changes', async () => {
    const { device, sim } = await attDevice();
    const other = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true });
    const refused = await other.connectAtt({ info: false });
    expect(refused.ok).toBe(false);
    expect(refused.res.status).toBe(406);
    expect((await platformRow(device.id)).serial_number).toBe(sim.sn);
  });
});

describe('polling interval', () => {
  test('the device’s own poll delay; both fields when set; the poll gap is measured', env({ DEVICE_ATT_DELAY_FIELDS: 'Delay,RequestDelay' }, async () => {
    const { id, sim } = await attDevice();
    await w.db1.sequelize.query('UPDATE access_device_details SET poll_delay_seconds = 1 WHERE id = ?', { replacements: [id] });
    const c = await sim.connectAtt({ info: false });
    expect(c.config).toMatchObject({ Delay: '1', RequestDelay: '1' });
    expect(sim.nextInterval()).toBe(1);
    await sim.poll();
    await new Promise((r) => setTimeout(r, 1100));
    await sim.poll();
    const d = await details(id);
    expect(d.last_poll_at).not.toBeNull();
    expect(Number(d.poll_gap_seconds)).toBeGreaterThanOrEqual(1);
    expect(Number(d.poll_gap_seconds)).toBeLessThanOrEqual(3);
  }));

  test('without a Delay the firmware slows down (what the capture showed); with one it stays', async () => {
    const plain = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), att: true });
    const gaps = Array.from({ length: 12 }, () => plain.nextInterval());
    expect(gaps[gaps.length - 1]).toBeGreaterThan(20);
    const { sim } = await attDevice();
    expect(Array.from({ length: 12 }, () => sim.nextInterval())).toEqual(Array(12).fill(3));
  });

  test('DEVICE_ATT_SET_OPTION_DELAY: a slow poller is sent SET OPTION Delay once, between polls', env({ DEVICE_ATT_SET_OPTION_DELAY: 'true' }, async () => {
    const { id, sim } = await attDevice();
    delete sim.config.Delay; // as if the option answer never reached it
    await sim.poll();
    await w.db1.sequelize.query('UPDATE access_device_details SET last_poll_at = DATE_SUB(last_poll_at, INTERVAL 40 SECOND) WHERE id = ?', { replacements: [id] });
    const s = await sim.step(); // measures the 40 s gap, queues the command and hands it out in the same answer
    const texts = s.commands.map((x) => x.text);
    expect(texts).toContain('SET OPTION Delay=3');
    expect(sim.config.Delay).toBe('3');
    await w.db1.sequelize.query('UPDATE access_device_details SET last_poll_at = DATE_SUB(last_poll_at, INTERVAL 40 SECOND) WHERE id = ?', { replacements: [id] });
    expect((await sim.step()).commands).toHaveLength(0); // not again within 10 minutes
  }));
});

describe('ATTLOG: history, bulk, same second', () => {
  let dev;
  let member;
  let pin;

  beforeAll(async () => {
    member = await w.member('Att Member', { email: `p5-att-${crypto.randomBytes(3).toString('hex')}@gymseratest.com` });
    dev = await attDevice({ name: 'History Door' });
    await w.subscribe(w.db1, { user: member, branch });
    await dev.sim.drain();
    pin = await w.pinOf(w.db1, member.id);
    expect(pin).toMatch(/^\d+$/);
  });

  const events = (where = '1=1', rep = []) => w.q(w.db1, `SELECT * FROM device_access_events WHERE device_id = ? AND ${where} ORDER BY id`, [dev.id, ...rep]);
  const attendance = () => w.q(w.db1, 'SELECT * FROM attendance_logs WHERE user_id = ?', [member.id]);

  test('the history upload: every row stored once, as a device event only (no check-in, no unlinked users)', async () => {
    const before = (await attendance()).length;
    const unlinkedBefore = (await w.q(w.db1, 'SELECT COUNT(*) AS c FROM device_unlinked_users WHERE device_id = ?', [dev.id]))[0].c;
    const res = await dev.sim.uploadHistory({ users: false, templates: false, oplog: false });
    expect(res.every((r) => r.status === 200 && r.text.trim() === 'OK')).toBe(true);
    const rows = await events();
    expect(rows).toHaveLength(dev.sim.fixture.history.length);
    expect(rows.every((r) => r.attendance_note === 'history' && r.attendance_id === null)).toBe(true);
    expect((await attendance()).length).toBe(before);
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS c FROM device_unlinked_users WHERE device_id = ?', [dev.id]))[0].c).toBe(unlinkedBefore);
    // The device sends it again (a reboot, stamps reset): nothing new.
    await dev.sim.uploadHistory({ users: false, templates: false, oplog: false });
    expect(await events()).toHaveLength(dev.sim.fixture.history.length);
  });

  test('a member’s punch from before activation is history; one after it is a check-in', async () => {
    await dev.sim.punch(pin, localNow(-3 * 24 * 60), 1);
    const [old] = await events('pin = ? AND attendance_note = ?', [pin, 'history']);
    expect(old).toBeDefined();
    expect(old.attendance_id).toBeNull();
    expect((await attendance()).length).toBe(0);
    await dev.sim.punch(pin, localNow(0), 15);
    const [live] = await events('pin = ? AND attendance_note = ?', [pin, 'check_in']);
    expect(live.attendance_id).not.toBeNull();
    expect(live.member_id).toBe(member.id);
    expect(live.verify_type).toBe(15);
    expect((await attendance()).length).toBe(1);
  });

  test('a fingerprint and a face punch in the same second are two events', async () => {
    const at = localNow(1);
    await dev.sim.punch(pin, at, 1);
    await dev.sim.punch(pin, at, 15);
    await dev.sim.punch(pin, at, 15); // the same punch again: a duplicate
    const rows = await events('pin = ? AND device_time = ?', [pin, at]);
    expect(rows.map((r) => r.verify_type).sort((a, b) => a - b)).toEqual([1, 15]);
  });

  test('history before go-live of an imported device is history too', async () => {
    await w.db1.sequelize.query('UPDATE access_device_details SET live_at = ? WHERE id = ?', { replacements: [new Date(Date.now() + 5 * 60000), dev.id] });
    await dev.sim.punch(pin, localNow(-1), 4);
    const [row] = await events('pin = ? AND verify_type = 4', [pin]);
    expect(row.attendance_note).toBe('history');
    await w.db1.sequelize.query('UPDATE access_device_details SET live_at = NULL WHERE id = ?', { replacements: [dev.id] });
  });
});

describe('import of 356-style data (an "import first" att device)', () => {
  let dev;
  let imp;

  beforeAll(async () => {
    dev = await attDevice({ importFirst: true, name: 'GymBioSync Door', history: true });
  });

  test('the first contact opens an import and the history upload fills it: users with admins, FP and faces', async () => {
    const list = await w.q(w.db1, 'SELECT * FROM device_imports WHERE device_id = ?', [dev.id]);
    expect(list).toHaveLength(1);
    imp = list[0];
    expect(json(imp.result_json)).toMatchObject({ mode: 'upload' });
    const users = await w.q(w.db1, 'SELECT * FROM device_import_users WHERE import_id = ?', [imp.id]);
    expect(users).toHaveLength(356);
    expect(users.filter((u) => Number(u.privilege) === 14)).toHaveLength(2);
    expect(users.find((u) => u.pin === dev.sim.fixture.users[5].pin).card_no).toBe('0012345678');
    const tpl = await w.q(w.db1, 'SELECT bio_type, major_ver, COUNT(*) AS c FROM device_import_templates WHERE import_id = ? GROUP BY bio_type, major_ver ORDER BY bio_type', [imp.id]);
    expect(tpl.map((t) => [t.bio_type, t.major_ver, t.c])).toEqual([[1, '10', 416], [9, '39', 15]]);
    // Held: nothing for members was queued, nothing stored as member data.
    expect(await w.commands(w.db1, dev.id, 'kind NOT IN (?)', [registry.READ_ONLY_KINDS])).toHaveLength(0);
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS c FROM member_biometrics WHERE source_device_id = ?', [dev.id]))[0].c).toBe(0);
  });

  test('a re-sent upload adds nothing; the import is ready after a quiet minute with a poll', async () => {
    await dev.sim.uploadHistory({ attlog: false, oplog: false });
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS c FROM device_import_users WHERE import_id = ?', [imp.id]))[0].c).toBe(356);
    expect((await imports.refresh(w.db1, imp, new Date())).status).toBe('querying');
    await dev.sim.poll();
    const later = await imports.refresh(w.db1, (await w.q(w.db1, 'SELECT * FROM device_imports WHERE id = ?', [imp.id]))[0], new Date(Date.now() + 2 * 60000));
    expect(later.status).toBe('ready');
    expect(later.users_count).toBe(356);
    expect(later.templates_count).toBe(431);
  });

  test('match by CSV and apply: the member keeps the device PIN, templates held until go-live', async () => {
    // A member of the gym with no GymsEra PIN yet: their package starts next week, so the branch's other (live)
    // doors do not want them now. (An active member would already have a PIN: the Phase 4 member_has_pin case.)
    const member = await w.member('Imported Att', { email: `p5-imp-${crypto.randomBytes(3).toString('hex')}@gymseratest.com` });
    await w.subscribe(w.db1, { user: member, branch, start: 7, end: 37 });
    expect(await w.pinOf(w.db1, member.id)).toBeNull();
    const devicePin = dev.sim.fixture.fingerprints.find((f) => Number(f.pin) > 100).pin;
    const res = await owner().post(`/api/v1/host/devices/${dev.id}/imports/${imp.id}/mapping`).send({ csv: `pin,member_id\n${devicePin},${member.id}\n` });
    expect(res.status).toBe(200);
    const applied = await owner().post(`/api/v1/host/devices/${dev.id}/imports/${imp.id}/apply`).send({});
    expect(applied.status).toBe(200);
    expect(await w.pinOf(w.db1, member.id)).toBe(devicePin);
    const held = await w.q(w.db1, 'SELECT import_hold, bio_type FROM member_biometrics WHERE member_id = ?', [member.id]);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((b) => Number(b.import_hold) === 1)).toBe(true);
  });

  test('a manual import on an att device is fed by uploads too (CHECK asks the device to send)', async () => {
    const other = await attDevice({ name: 'Re-import Door' });
    const res = await owner().post(`/api/v1/host/devices/${other.id}/imports`).send({});
    expect([200, 202]).toContain(res.status);
    const [row] = await w.q(w.db1, 'SELECT * FROM device_imports WHERE device_id = ?', [other.id]);
    expect(json(row.result_json).mode).toBe('upload');
    expect((await w.commands(w.db1, other.id, 'kind = ?', ['check']))).toHaveLength(1);
    expect(await w.commands(w.db1, other.id, 'kind IN (?)', [['query_users', 'query_bio']])).toHaveLength(0);
    await other.sim.uploadHistory({ templates: false, attlog: false, oplog: false });
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS c FROM device_import_users WHERE import_id = ?', [row.id]))[0].c).toBe(356);
  });
});

describe('audit fed by OPERLOG USER uploads', () => {
  test('the users the device uploads for the audit query are its answer; the ack compares', async () => {
    const dev = await attDevice({ name: 'Audit Door', simOpts: { attQueryByUpload: true } });
    dev.sim.seedUser({ pin: '777777', name: 'Stranger' });
    const { requestAudit } = require('../../src/jobs/device-jobs');
    const { auditId } = await requestAudit(w.db1, dev.id);
    await dev.sim.drain();
    const [audit] = await w.q(w.db1, 'SELECT * FROM device_audits WHERE id = ?', [auditId]);
    expect(audit.status).toBe('compared');
    const pins = (await w.q(w.db1, 'SELECT pin FROM device_audit_pins WHERE audit_id = ?', [auditId])).map((r) => String(r.pin));
    expect(pins).toContain('777777');
    expect((await w.q(w.db1, 'SELECT * FROM device_unlinked_users WHERE device_id = ? AND pin = ?', [dev.id, '777777']))).toHaveLength(1);
  });
});

describe('commands for att devices, delivered between polls', () => {
  let dev;
  let member;

  beforeAll(async () => {
    dev = await attDevice({ name: 'Command Door' });
    member = await w.member('Command Member', { email: `p5-cmd-${crypto.randomBytes(3).toString('hex')}@gymseratest.com` });
  });

  test('safe defaults: DATA UPDATE user with StartTime=0 EndTime=0, no userauthorize; in sync after the ack', async () => {
    await w.subscribe(w.db1, { user: member, branch });
    const done = await dev.sim.drain();
    const pin = await w.pinOf(w.db1, member.id);
    const user = done.find((d) => d.text.startsWith(`DATA UPDATE user CardNo=\tPin=${pin}\t`));
    expect(user.text).toBe(`DATA UPDATE user CardNo=\tPin=${pin}\tPassword=\tGroup=1\tStartTime=0\tEndTime=0\tName=Command Member\tPrivilege=0`);
    expect(done.some((d) => /userauthorize/i.test(d.text))).toBe(false);
    expect((await w.syncRow(w.db1, dev.id, member.id)).state).toBe('in_sync');
  });

  test('Push now reaches the device at its next poll', async () => {
    const res = await owner().post(`/api/v1/host/members/${member.id}/device-push`).send({ deviceIds: [dev.id] });
    expect(res.status).toBe(202);
    const s = await dev.sim.step();
    expect(s.commands.some((c) => c.text.startsWith('DATA UPDATE user '))).toBe(true);
    const r = await owner().get(`/api/v1/host/device-push-requests/${data(res).requestId}`);
    expect(data(r).devices[0].state).toBe('applied');
  });

  test('per device: USERINFO form and datetime validity (PATCH), then removal without userauthorize', async () => {
    const res = await owner().patch(`/api/v1/host/devices/${dev.id}`).send({ attOptions: { userCommandForm: 'userinfo', validityMode: 'datetime' } });
    expect(res.status).toBe(200);
    expect(data(res).device.attOptions).toEqual({ userAuthorize: false, validityMode: 'datetime', userCommandForm: 'userinfo' });
    await w.settled();
    const done = await dev.sim.drain();
    const pin = await w.pinOf(w.db1, member.id);
    const user = done.find((d) => d.text.startsWith(`DATA UPDATE USERINFO PIN=${pin}\t`));
    expect(user.text).toMatch(new RegExp(`^DATA UPDATE USERINFO PIN=${pin}\\tName=Command Member\\tPri=0\\tPasswd=\\tCard=\\tGrp=1\\tStartDatetime=\\d{4}-\\d\\d-\\d\\d 00:00:00\\tEndDatetime=\\d{4}-\\d\\d-\\d\\d 23:59:59$`));
    expect(dev.sim.holds(pin).user).not.toBeNull();

    await w.db1.sequelize.query('UPDATE member_subscriptions SET status = \'CANCELLED\' WHERE user_id = ?', { replacements: [member.id] });
    await require('../../src/services/devices/device-sync.service').reconcileMember(w.db1, member.id, 'test');
    const gone = await dev.sim.drain();
    expect(gone.map((d) => d.text)).toContain(`DATA DELETE USERINFO PIN=${pin}`);
    expect(gone.some((d) => /userauthorize/i.test(d.text))).toBe(false);
    expect(dev.sim.holds(pin).user).toBeNull();
  });

  test('PATCH refuses unknown values', async () => {
    const res = await owner().patch(`/api/v1/host/devices/${dev.id}`).send({ attOptions: { validityMode: 'forever' } });
    expect(res.status).toBe(422);
  });
});

describe('token', () => {
  test('an att device stays in log mode even when its row says enforce; no cookie is fine', async () => {
    const dev = await attDevice({ name: 'Token Door' });
    await platformDb.query('UPDATE access_devices SET token_mode = \'enforce\' WHERE id = ?', { replacements: [dev.id] });
    const r = await dev.sim.poll();
    expect(r.status).toBe(200);
    expect((await platformRow(dev.id)).last_token_state).toBe('absent');
    const plan = await planTokenMode({ to: 'enforce', deviceIds: [dev.id] });
    expect(plan.switch).toHaveLength(0);
    // Its row was forced to enforce by hand above: the script would move it back, never further.
    await platformDb.query('UPDATE access_devices SET token_mode = \'log\' WHERE id = ?', { replacements: [dev.id] });
    expect((await planTokenMode({ to: 'enforce', deviceIds: [dev.id] })).skip).toEqual([{ id: dev.id, reason: 'att_device' }]);
  });

  test('the enforce script refuses a device that never sent a cookie, whatever its last state says', async () => {
    const acc = await w.device(w.db1, { branch, name: 'Acc Door' });
    await acc.sim.poll();
    expect((await platformRow(acc.id)).cookie_seen_at).not.toBeNull();
    expect((await planTokenMode({ to: 'enforce', deviceIds: [acc.id] })).switch.map((s) => s.id)).toEqual([acc.id]);
    await platformDb.query('UPDATE access_devices SET cookie_seen_at = NULL, last_token_state = \'match\' WHERE id = ?', { replacements: [acc.id] });
    expect((await planTokenMode({ to: 'enforce', deviceIds: [acc.id] })).skip).toEqual([{ id: acc.id, reason: 'never_sent_cookie' }]);
  });
});

describe('device view (CMS)', () => {
  test('type, push version, counts from the device, att options and poll timing', async () => {
    const dev = await attDevice({ name: 'View Door' });
    const res = await owner().get(`/api/v1/host/devices/${dev.id}`);
    expect(res.status).toBe(200);
    const d = data(res).device;
    expect(d).toMatchObject({ deviceType: 'att', pushVersion: 'Ver 2.0.33S-20220623', model: 'SpeedFace-V5L' });
    expect(d.counts).toEqual({ users: 356, faces: 15, fingerprints: 416, palms: 0, attendanceRecords: 14262, maxUsers: 10000 });
    expect(d.attOptions).toEqual({ userAuthorize: false, validityMode: 'none', userCommandForm: 'user' });
    expect(d.poll).toMatchObject({ delaySeconds: 3 });
    expect(JSON.stringify(d)).not.toMatch(/RegistryCode|registry_code|session_id|"options"/);
  });

  test('an acc device has no att options', async () => {
    const acc = await w.device(w.db1, { branch, name: 'Acc View' });
    const d = data(await owner().get(`/api/v1/host/devices/${acc.id}`)).device;
    expect(d.attOptions).toBeNull();
  });
});

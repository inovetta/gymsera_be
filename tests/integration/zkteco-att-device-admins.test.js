/**
 * NEW-248d (owner decision R-101, tenant migration 027): GymsEra always sends Pri=0 (USERINFO) / Privilege=0 (user)
 * and never gives device admin rights. A device user with privilege above 0 is an administrator ON THE DEVICE: GymsEra
 * must never send them a user record (that would demote them) nor delete them. Who is one is remembered per device
 * in device_admin_pins: at go-live from the import's admins, and from every user record the device uploads
 * (OPERLOG USER `Pri`); Pri 0 forgets it. Also: an update to a member who has templates on the device sends only the
 * user record, never a template delete (what GymsEra sends; the firmware side is a device test).
 *
 * Simulator `{ att: true, realFirmware: true }` (checklist (i) return codes).
 */
const crypto = require('crypto');
const { createWorld } = require('../harness/zkteco-world');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');
const imports = require('../../src/services/devices/device-import.service');
const sync = require('../../src/services/devices/device-sync.service');
const biometrics = require('../../src/services/devices/biometric.service');
const jobs = require('../../src/jobs/device-jobs');
const { userLine } = require('../fixtures/zkteco/att-speedface-v5l');
const fx = require('../fixtures/zkteco/manual-samples');

let w;
let n = 0;
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();
const sn = () => `ADM${RUN}${String(++n).padStart(4, '0')}`;
const mail = (tag) => `att-admin-${tag}-${crypto.randomBytes(3).toString('hex')}@gymseratest.com`;

async function attDevice(branch, name, { importFirst = false } = {}) {
  const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name, direction: 'in', importFirst, createdBy: w.owner.user.id });
  const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true, realFirmware: true });
  await sim.connectAtt();
  await w.settled();
  return { id: device.id, sim };
}
const newBranch = async (name) => w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name });
const rename = async (memberId, fullName) => {
  const { User } = require('../../src/models/platform');
  await User.update({ fullName }, { where: { id: memberId } });
  await sync.reconcileMember(w.db1, memberId, 'test');
};
const mentions = (cmds, pin) => cmds.filter((c) => new RegExp(`(PIN|Pin)=${pin}(\\t|$|\\n)`).test(c.text));
const adminRows = async (deviceId) => w.q(w.db1, 'SELECT pin, privilege, source FROM device_admin_pins WHERE device_id = ? ORDER BY pin', [deviceId]);
const protectedLogs = async (deviceId) => w.q(w.db1, 'SELECT data_json FROM device_error_logs WHERE device_id = ? AND kind = \'device_admin_protected\'', [deviceId]);

beforeAll(async () => {
  w = await createWorld();
});

describe('an update to a member with templates on the device', () => {
  test('only DATA UPDATE USERINFO with Pri=0 goes out: no template is deleted or sent again', async () => {
    const branch = await newBranch('Admin Tpl Branch');
    const dev = await attDevice(branch, 'Template Door');
    const m = await w.member('Has Finger', { email: mail('tpl') });
    await biometrics.recordConsent(w.db1, { memberId: m.id, method: 'in_person' });
    await biometrics.storeTemplates(w.db1, { memberId: m.id, deviceId: null, templates: [{ pin: '1', type: 1, no: 0, index: 0, valid: 1, duress: 0, majorVer: '10', minorVer: '0', format: 0, tmp: fx.TEMPLATE }] });
    await w.subscribe(w.db1, { user: m, branch });
    const first = await dev.sim.drain();
    const pin = await w.pinOf(w.db1, m.id);
    expect(first.some((c) => c.text.startsWith(`DATA UPDATE USERINFO PIN=${pin}\t`))).toBe(true);
    expect(first.some((c) => c.text.startsWith('DATA UPDATE biodata ') && c.text.includes(`Pin=${pin}\t`))).toBe(true);
    const row = await w.syncRow(w.db1, dev.id, m.id);
    expect(row.state).toBe('in_sync');
    expect(JSON.parse(row.applied_json).bio.map((b) => b.type)).toEqual([1]);

    await rename(m.id, 'Has Finger Renamed');
    const upd = await dev.sim.drain();
    expect(upd.map((c) => c.text)).toEqual([`DATA UPDATE USERINFO PIN=${pin}\tName=Has Finger Renamed\tPri=0\tPasswd=\tCard=\tGrp=1\tStartDatetime=0\tEndDatetime=0`]);
    expect([...dev.sim.bio.keys()].some((k) => k.startsWith(`${pin}:1:`))).toBe(true);
  });
});

describe('a member made an administrator on the device menu after go-live', () => {
  let branch;
  let dev;
  let m;
  let pin;

  beforeAll(async () => {
    branch = await newBranch('Admin Menu Branch');
    dev = await attDevice(branch, 'Menu Door');
    m = await w.member('Front Desk Lead', { email: mail('menu') });
    await w.subscribe(w.db1, { user: m, branch });
    await dev.sim.drain();
    pin = await w.pinOf(w.db1, m.id);
    expect((await w.syncRow(w.db1, dev.id, m.id)).state).toBe('in_sync');
    // Promoted on the device: it reports the user with Pri=14.
    dev.sim.users.get(pin).privilege = '14';
    await dev.sim.uploadAtt('OPERLOG', userLine({ pin, name: 'Front Desk Lead', privilege: 14, card: '' }));
  });

  test('remembered from the upload', async () => {
    expect(await adminRows(dev.id)).toEqual([{ pin, privilege: 14, source: 'upload' }]);
  });

  test('a rename sends nothing (no Pri=0); logged once', async () => {
    await rename(m.id, 'Front Desk Lead Two');
    await rename(m.id, 'Front Desk Lead Three');
    expect(mentions(await dev.sim.drain(), pin)).toEqual([]);
    expect(dev.sim.users.get(pin).privilege).toBe('14');
    const logs = await protectedLogs(dev.id);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].data_json)).toMatchObject({ pin, memberId: m.id });
  });

  test('the plan ends: not deleted; the audit leaves the admin alone', async () => {
    await w.db1.sequelize.query('UPDATE member_subscriptions SET status = \'CANCELLED\' WHERE user_id = ?', { replacements: [m.id] });
    await sync.reconcileMember(w.db1, m.id, 'test');
    expect(mentions(await dev.sim.drain(), pin)).toEqual([]);
    expect(dev.sim.users.has(pin)).toBe(true);

    const r = await jobs.requestAudit(w.db1, dev.id);
    const asked = await dev.sim.drain();
    expect(asked.map((c) => c.text)).toEqual([`DATA QUERY USERINFO PIN=${pin}`]); // a read: allowed
    await jobs.finishAttAudits(w.db1, new Date(Date.now() + 31000));
    const [audit] = await w.q(w.db1, 'SELECT status, extra_count, report_json FROM device_audits WHERE id = ?', [r.auditId]);
    expect(audit.status).toBe('compared');
    expect(audit.extra_count).toBe(0);
    expect(JSON.parse(audit.report_json).adminsLeft).toBe(1);
    expect(mentions(await dev.sim.drain(), pin)).toEqual([]);
    expect(dev.sim.users.get(pin).privilege).toBe('14');
  });

  test('commands queued before the device reported the admin are not sent', async () => {
    const other = await w.member('Queued Before Promotion', { email: mail('queued') });
    await w.subscribe(w.db1, { user: other, branch });
    const otherPin = await w.pinOf(w.db1, other.id);
    expect((await w.commands(w.db1, dev.id, 'member_id = ? AND status = ?', [other.id, 'queued'])).length).toBeGreaterThan(0);
    await dev.sim.uploadAtt('OPERLOG', userLine({ pin: otherPin, name: 'Queued Before Promotion', privilege: 14, card: '' }));
    expect(mentions(await dev.sim.drain(), otherPin)).toEqual([]);
  });

  test('demoted on the device (Pri=0 upload): forgotten, and GymsEra manages the user again', async () => {
    dev.sim.users.get(pin).privilege = '0';
    await dev.sim.uploadAtt('OPERLOG', userLine({ pin, name: 'Front Desk Lead', privilege: 0, card: '' }));
    expect((await adminRows(dev.id)).map((r) => r.pin)).not.toContain(pin);
    await sync.reconcileMember(w.db1, m.id, 'test');
    expect((await dev.sim.drain()).map((c) => c.text)).toContain(`DATA DELETE USERINFO PIN=${pin}`);
    expect(dev.sim.users.has(pin)).toBe(false);
  });
});

describe('go-live keeps the import\'s administrators', () => {
  test('the import\'s admins are remembered at go-live and never sent anything', async () => {
    const branch = await newBranch('Admin Import Branch');
    const dev = await attDevice(branch, 'Import Admin Door', { importFirst: true });
    await dev.sim.uploadHistory({ templates: false, attlog: false, oplog: false });
    await dev.sim.poll();
    const [open] = await w.q(w.db1, 'SELECT * FROM device_imports WHERE device_id = ?', [dev.id]);
    const ready = await imports.refresh(w.db1, open, new Date(Date.now() + 2 * 60000));
    expect(ready.status).toBe('ready');
    const admins = (await w.q(w.db1, 'SELECT pin, privilege FROM device_import_users WHERE import_id = ? AND privilege > 0 ORDER BY pin', [ready.id]));
    expect(admins.length).toBeGreaterThan(0);
    await imports.apply(w.db1, ready);
    await imports.goLive(w.db1, { tenantId: w.db1.tenantId, deviceId: dev.id });
    expect(await adminRows(dev.id)).toEqual(admins.map((a) => ({ pin: String(a.pin), privilege: Number(a.privilege), source: 'import' })));
    const sent = await dev.sim.drain();
    for (const a of admins) expect(mentions(sent.filter((c) => !c.text.startsWith('DATA QUERY USERINFO ')), a.pin)).toEqual([]);
  });
});

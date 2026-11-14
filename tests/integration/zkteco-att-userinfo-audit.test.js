/**
 * NEW-248b: the audit of a T&A PUSH device (checklist (i), 2026-11-14). The real firmware answers DATA COUNT user
 * -1002 and DATA QUERY tablename=user -1004, so the audit asks DATA QUERY USERINFO PIN=<pin> for each PIN GymsEra
 * has a sync row for; the device answers 0 and uploads the user as one OPERLOG USER line when it has it. The
 * device's own user count is its DEVICE INFO count. Compared once every query is answered and 30 s have passed;
 * a query that failed makes the audit incomplete (never "missing").
 *
 * Simulator `{ att: true, realFirmware: true }`: the return codes and the `CMD=DATA` echo of the real device.
 */
const crypto = require('crypto');
const { createWorld } = require('../harness/zkteco-world');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');
const sync = require('../../src/services/devices/device-sync.service');
const jobs = require('../../src/jobs/device-jobs');

let w;
let branch;
let n = 0;
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();
const sn = () => `ATA${RUN}${String(++n).padStart(4, '0')}`;
const later = (seconds) => new Date(Date.now() + seconds * 1000);
const mail = (tag) => `att-audit-${tag}-${crypto.randomBytes(3).toString('hex')}@gymseratest.com`;

async function realAttDevice(name, on = branch) {
  const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: on.id, organizationId: on.gymId, name, direction: 'in', importFirst: false, createdBy: w.owner.user.id });
  const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true, realFirmware: true });
  await sim.connectAtt();
  await w.settled();
  return { id: device.id, sim };
}

const audit = async (id) => (await w.q(w.db1, 'SELECT * FROM device_audits WHERE id = ?', [id]))[0];
const auditPins = async (id) => (await w.q(w.db1, 'SELECT pin FROM device_audit_pins WHERE audit_id = ?', [id])).map((r) => String(r.pin)).sort();

beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Att Audit Branch' });
});

describe('audit of a T&A PUSH device (real firmware codes)', () => {
  let dev;
  const m = {};
  const pin = {};

  beforeAll(async () => {
    dev = await realAttDevice('Audit Door');
    for (const k of ['kept', 'missing', 'extra']) {
      m[k] = await w.member(`Audit ${k}`, { email: mail(k) });
      await w.subscribe(w.db1, { user: m[k], branch });
    }
    const added = await dev.sim.drain();
    for (const k of Object.keys(m)) pin[k] = String(await w.pinOf(w.db1, m[k].id));
    // The default form reaches the real firmware: every add answered 0.
    expect(added.filter((d) => d.text.startsWith('DATA UPDATE USERINFO ')).every((d) => d.returnCode === 0)).toBe(true);
    for (const k of Object.keys(m)) expect((await w.syncRow(w.db1, dev.id, m[k].id)).state).toBe('in_sync');

    // Drift the audit must find: one member gone from the device, one removed member still on it.
    dev.sim.users.delete(pin.missing);
    await w.db1.sequelize.query('UPDATE member_subscriptions SET status = \'CANCELLED\' WHERE user_id = ?', { replacements: [m.extra.id] });
    await sync.reconcileMember(w.db1, m.extra.id, 'test');
    await dev.sim.drain();
    expect((await w.syncRow(w.db1, dev.id, m.extra.id)).state).toBe('removed');
    dev.sim.users.set(pin.extra, { pin: pin.extra, name: 'Audit extra', cardNo: '', privilege: '0' });
  });

  test('the real firmware refuses the acc audit commands (why the att audit exists)', () => {
    expect(dev.sim.execute('DATA COUNT user')).toBe(-1002);
    expect(dev.sim.execute('DATA QUERY tablename=user,fielddesc=*,filter=*')).toBe(-1004);
    expect(dev.sim.execute(`DATA UPDATE user CardNo=\tPin=${pin.kept}\tName=x\tPrivilege=0`)).toBe(-1004);
  });

  test('no DATA COUNT, no DATA QUERY user: one DATA QUERY USERINFO per PIN; INFO count; compared after 30 s', async () => {
    const r = await jobs.requestAudit(w.db1, dev.id);
    expect(r).toMatchObject({ countCmdId: null, queryCmdId: null, queries: 3 });
    const before = await audit(r.auditId);
    const [det] = await w.q(w.db1, 'SELECT counts_json FROM access_device_details WHERE id = ?', [dev.id]);
    expect(before.device_user_count).toBe(Number(JSON.parse(det.counts_json).UserCount));
    expect(before.device_user_count).toBeGreaterThan(0);

    const done = await dev.sim.drain();
    const texts = done.map((d) => d.text);
    expect(texts.some((t) => /^DATA COUNT/.test(t) || /tablename=user/.test(t))).toBe(false);
    expect(texts.sort()).toEqual([pin.extra, pin.kept, pin.missing].map((p) => `DATA QUERY USERINFO PIN=${p}`).sort());
    expect(done.every((d) => d.returnCode === 0 && d.cmd === 'DATA')).toBe(true);
    // The answers are the OPERLOG USER uploads: the two PINs the device has.
    expect(await auditPins(r.auditId)).toEqual([pin.extra, pin.kept].sort());
    expect((await audit(r.auditId)).status).toBe('receiving');

    // Not before the settle time.
    expect(await jobs.finishAttAudits(w.db1, new Date())).toEqual({ compared: 0, incomplete: 0 });
    expect((await audit(r.auditId)).status).toBe('receiving');

    expect(await jobs.finishAttAudits(w.db1, later(31))).toEqual({ compared: 1, incomplete: 0 });
    const after = await audit(r.auditId);
    expect(after).toMatchObject({ status: 'compared', missing_count: 1, extra_count: 1, unlinked_count: 0 });

    const fix = (await dev.sim.drain()).map((d) => d.text);
    expect(fix.some((t) => t.startsWith(`DATA UPDATE USERINFO PIN=${pin.missing}\t`))).toBe(true);
    expect(fix).toContain(`DATA DELETE USERINFO PIN=${pin.extra}`);
    expect(fix.some((t) => t.includes(`PIN=${pin.kept}\t`) || t.endsWith(`PIN=${pin.kept}`))).toBe(false);
    expect(dev.sim.users.has(pin.missing)).toBe(true);
    expect(dev.sim.users.has(pin.extra)).toBe(false);
  });

  test('a query that failed: incomplete, nothing re-sent or removed', async () => {
    dev.sim.users.delete(pin.missing); // would look missing if a failure counted as an empty answer
    dev.sim.forceReturn = (t) => (t === `DATA QUERY USERINFO PIN=${pin.kept}` ? -1004 : null);
    const r = await jobs.requestAudit(w.db1, dev.id);
    await dev.sim.drain();
    dev.sim.forceReturn = null;
    expect(await jobs.finishAttAudits(w.db1, later(60))).toEqual({ compared: 0, incomplete: 1 });
    expect((await audit(r.auditId)).status).toBe('incomplete');
    expect(await dev.sim.drain()).toEqual([]);
  });

  test('the watchdog compares a finished att audit; an audit with no PIN to ask is compared at once', async () => {
    dev.sim.users.set(pin.missing, { pin: pin.missing, name: 'Audit missing', cardNo: '', privilege: '0' });
    const r = await jobs.requestAudit(w.db1, dev.id);
    await dev.sim.drain();
    const counts = await jobs.watchdogTenant({ tenantId: w.db1.tenantId, db: w.db1 }, later(31));
    expect(counts.attAuditsCompared).toBe(1);
    expect((await audit(r.auditId)).status).toBe('compared');

    // A branch of another organization: none of the members above belongs on it.
    const lone = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Att Empty Branch' });
    const empty = await realAttDevice('Empty Door', lone);
    const e = await jobs.requestAudit(w.db1, empty.id);
    expect(e.queries).toBe(0);
    expect((await audit(e.auditId)).status).toBe('compared');
    expect(await empty.sim.drain()).toEqual([]);
  });

  test('an acc device keeps DATA COUNT user and DATA QUERY user', async () => {
    const acc = await w.device(w.db1, { branch, name: 'Acc Audit Door' });
    const r = await jobs.requestAudit(w.db1, acc.id);
    expect(r.countCmdId).toBeGreaterThan(0);
    expect(r.queryCmdId).toBeGreaterThan(0);
    const kinds = (await w.q(w.db1, 'SELECT kind FROM device_commands WHERE id IN (?, ?)', [r.countCmdId, r.queryCmdId])).map((c) => c.kind).sort();
    expect(kinds).toEqual(['count', 'query_users']);
  });
});

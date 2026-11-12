/**
 * NEW-242: re-read a T&A PUSH (DeviceType=att) import, and keep an upload a staging failure would lose.
 *
 * Production (2026-11-12): a SpeedFace-V5L in import hold sent 32 of its 358 users. It kept the stamp 9999 from the
 * Phase 0 capture-server session (`--stamps 9999`); GymsEra echoes the device's stamp in every cdata answer
 * (DEVICE_ATT_STAMPS=echo), so the device never uploads its users again, and nothing asked it to (no CHECK).
 *
 *   stuck         a stamp-aware device answered 9999 uploads nothing, also on reconnect
 *   reread        POST …/imports/:importId/reread (devices.manage): only a T&A device in hold with an import
 *                 querying or ready; queues ONE read-only CHECK, nothing that changes the device; the import is
 *                 querying again; the next cdata answers carry OPERLOGStamp=0 and BIODATAStamp=0 (ATTLOG echoed)
 *                 until the device reports a stamp again, then the echo is back
 *   reading       after CHECK the device fetches the options, uploads every user and template, no ATTLOG; the
 *                 import counts rise and it is ready after a quiet minute; the state shows waiting → queried →
 *                 reading → done on the device view and the import view
 *   retry         in hold, an OPERLOG / BIODATA upload whose staging fails is answered 503 (the device sends it
 *                 again), at most DEVICE_ATT_STAGE_RETRIES times per body, then OK with an error log row
 */
const crypto = require('crypto');
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');
const imports = require('../../src/services/devices/device-import.service');
const { userLine, fpLine } = require('../fixtures/zkteco/att-speedface-v5l');

const owner = () => asPersona('owner');
const data = (res) => res.body.data;
const code = (res) => res.body.error?.code || res.body.code;
let w;
let branch;
let n = 0;
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();
const sn = () => `RRD${RUN}${String(++n).padStart(4, '0')}`;
const STUCK = JSON.stringify({ ATTLOG: '9999', OPERLOG: '9999', BIODATA: '9999' });

const env = (vars, fn) => async () => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; process.env[k] = v; }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const one = async (sql, rep) => (await w.q(w.db1, sql, rep))[0];
const importRow = (id) => one('SELECT * FROM device_imports WHERE id = ?', [id]);
const countUsers = async (importId) => Number((await one('SELECT COUNT(*) AS c FROM device_import_users WHERE import_id = ?', [importId])).c);
const countTemplates = async (importId) => Number((await one('SELECT COUNT(*) AS c FROM device_import_templates WHERE import_id = ?', [importId])).c);
const cdataLines = async (sim) => (await sim.request('GET', `/iclock/cdata?${sim.q(`&${sim.fixture.cdataQuery}`)}`)).text.trim().split('\n');
const changing = (id) => w.commands(w.db1, id, 'kind NOT IN (?)', [registry.READ_ONLY_KINDS]);

/**
 * An "import first" att device that kept the capture server's stamp 9999 and sent only `partial` users (with their
 * fingerprints) before it settled: the production state. → { id, sim, imp }
 */
async function stuckDevice({ partial = 32, name = 'Stuck Door' } = {}) {
  const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name, direction: 'in', importFirst: true, createdBy: w.owner.user.id });
  await w.db1.sequelize.query('UPDATE access_device_details SET att_stamps_json = ? WHERE id = ?', { replacements: [STUCK, device.id] });
  const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true, stampAware: true });
  const c = await sim.connectAtt();
  expect(c.uploads).toHaveLength(0); // stuck: the server said 9999, the device has nothing newer
  const users = sim.fixture.users.slice(0, partial);
  const pins = new Set(users.map((u) => u.pin));
  await sim.uploadAtt('OPERLOG', users.map(userLine).join('\n'));
  await sim.uploadAtt('OPERLOG', sim.fixture.fingerprints.filter((f) => pins.has(f.pin)).map(fpLine).join('\n'));
  await sim.poll();
  await w.settled();
  const [first] = await w.q(w.db1, 'SELECT * FROM device_imports WHERE device_id = ?', [device.id]);
  const imp = await imports.refresh(w.db1, first, new Date(Date.now() + 2 * 60000));
  expect(imp.status).toBe('ready');
  return { id: device.id, sim, imp };
}

beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Reread Branch' });
});

describe('a device stuck on stamp 9999', () => {
  test('uploads nothing beyond what it sent, also when it connects again: the import stays partial', async () => {
    const { id, sim, imp } = await stuckDevice();
    expect(await countUsers(imp.id)).toBe(32);
    const before = sim.attUploads.length;
    const again = await sim.connectAtt({ info: false });
    expect(again.uploads).toHaveLength(0);
    expect(sim.attUploads.length).toBe(before);
    expect(await cdataLines(sim)).toEqual(expect.arrayContaining(['OPERLOGStamp=9999', 'BIODATAStamp=9999', 'ATTLOGStamp=9999']));
    expect(await changing(id)).toHaveLength(0);
  });
});

describe('Read all users again', () => {
  let dev;
  let eventsBefore;

  beforeAll(async () => {
    dev = await stuckDevice({ name: 'Reread Door' });
    eventsBefore = Number((await one('SELECT COUNT(*) AS c FROM device_access_events WHERE device_id = ?', [dev.id])).c);
  });

  test('queues one read-only CHECK and nothing that changes the device; the import is querying again', async () => {
    const res = await owner().post(`/api/v1/host/devices/${dev.id}/imports/${dev.imp.id}/reread`).send({});
    expect(res.status).toBe(202);
    expect(data(res).import).toMatchObject({ id: dev.imp.id, status: 'querying' });
    expect(data(res).import.reread).toMatchObject({ state: 'waiting' });
    const checks = await w.commands(w.db1, dev.id, 'kind = ? AND status = ?', ['check', 'queued']);
    expect(checks).toHaveLength(1);
    expect(await changing(dev.id)).toHaveLength(0);
    // No upload since the re-read: a quiet minute alone does not make it ready.
    expect((await imports.refresh(w.db1, await importRow(dev.imp.id), new Date(Date.now() + 2 * 60000))).status).toBe('querying');
  });

  test('a second press replaces the queued CHECK (still one)', async () => {
    const res = await owner().post(`/api/v1/host/devices/${dev.id}/imports/${dev.imp.id}/reread`).send({});
    expect(res.status).toBe(202);
    expect(await w.commands(w.db1, dev.id, 'kind = ? AND status = ?', ['check', 'queued'])).toHaveLength(1);
  });

  test('the device page shows the stamps and "waiting"', async () => {
    const d = data(await owner().get(`/api/v1/host/devices/${dev.id}`)).device;
    expect(d.attStamps).toMatchObject({ OPERLOG: '9999', BIODATA: '9999', ATTLOG: '9999', forced: ['OPERLOG', 'BIODATA'] });
    expect(d.attStamps.reread).toMatchObject({ state: 'waiting', importId: dev.imp.id });
  });

  test('every cdata answer carries OPERLOG and BIODATA 0, ATTLOG echoed, until the device reports a stamp ("queried")', async () => {
    for (let i = 0; i < 2; i++) {
      const lines = await cdataLines(dev.sim);
      expect(lines).toEqual(expect.arrayContaining(['OPERLOGStamp=0', 'BIODATAStamp=0', 'ATTLOGStamp=9999']));
    }
    const d = data(await owner().get(`/api/v1/host/devices/${dev.id}`)).device;
    expect(d.attStamps.reread.state).toBe('queried');
    expect(d.attStamps.forced).toEqual(['OPERLOG', 'BIODATA']);
  });

  test('after CHECK the device uploads every user and template, no ATTLOG; the counts rise ("reading")', async () => {
    const before = dev.sim.attUploads.length;
    await dev.sim.drain();
    await w.settled();
    const sent = dev.sim.attUploads.slice(before).map((u) => u.table);
    expect(sent).toContain('OPERLOG');
    expect(sent).toContain('BIODATA');
    expect(sent).not.toContain('ATTLOG');
    expect(await countUsers(dev.imp.id)).toBe(356);
    expect(await countTemplates(dev.imp.id)).toBe(431);
    expect(Number((await one('SELECT COUNT(*) AS c FROM device_access_events WHERE device_id = ?', [dev.id])).c)).toBe(eventsBefore);
    const [check] = await w.commands(w.db1, dev.id, 'kind = ? AND status = ?', ['check', 'acked']);
    expect(check).toBeDefined();
    expect(await changing(dev.id)).toHaveLength(0);
    const v = data(await owner().get(`/api/v1/host/devices/${dev.id}/imports/${dev.imp.id}`)).import;
    expect(v.reread.state).toBe('reading');
    expect(v.counts.users).toBe(356);
  });

  test('the device reported its stamp: the echo is back, nothing is forced any more', async () => {
    expect(await cdataLines(dev.sim)).toEqual(expect.arrayContaining(['OPERLOGStamp=9999', 'BIODATAStamp=9999', 'ATTLOGStamp=9999']));
    const d = data(await owner().get(`/api/v1/host/devices/${dev.id}`)).device;
    expect(d.attStamps.forced).toEqual([]);
  });

  test('ready after a quiet minute with a poll ("done"); the device was never sent a change', async () => {
    await dev.sim.poll();
    const ready = await imports.refresh(w.db1, await importRow(dev.imp.id), new Date(Date.now() + 2 * 60000));
    expect(ready.status).toBe('ready');
    expect(ready.users_count).toBe(356);
    const d = data(await owner().get(`/api/v1/host/devices/${dev.id}`)).device;
    expect(d.attStamps.reread.state).toBe('done');
    expect(await changing(dev.id)).toHaveLength(0);
    expect(dev.sim.users.size).toBe(0); // the simulator's own tables: nothing was written to the device
  });
});

describe('who and when', () => {
  test('an Access Control PUSH device: 422 not_att_device', async () => {
    const acc = await w.device(w.db1, { branch, name: 'Acc Reread', importFirst: true });
    const start = await owner().post(`/api/v1/host/devices/${acc.id}/imports`).send({});
    const res = await owner().post(`/api/v1/host/devices/${acc.id}/imports/${start.body.data.import.id}/reread`).send({});
    expect([res.status, code(res)]).toEqual([422, 'not_att_device']);
  });

  test('an applied import: 409 import_applied; a cancelled one (hold ended): 409 device_not_in_import', async () => {
    const a = await stuckDevice({ partial: 3, name: 'Applied Reread' });
    expect((await owner().post(`/api/v1/host/devices/${a.id}/imports/${a.imp.id}/apply`).send({})).status).toBe(200);
    const applied = await owner().post(`/api/v1/host/devices/${a.id}/imports/${a.imp.id}/reread`).send({});
    expect([applied.status, code(applied)]).toEqual([409, 'import_applied']);
    expect(await w.commands(w.db1, a.id, 'kind = ?', ['check'])).toHaveLength(0);

    const c = await stuckDevice({ partial: 3, name: 'Cancelled Reread' });
    expect((await owner().post(`/api/v1/host/devices/${c.id}/imports/${c.imp.id}/cancel`).send({})).status).toBe(200);
    const cancelled = await owner().post(`/api/v1/host/devices/${c.id}/imports/${c.imp.id}/reread`).send({});
    expect([cancelled.status, code(cancelled)]).toEqual([409, 'device_not_in_import']);
  });

  test('the forced 0 is never sent once the hold has ended', async () => {
    const d = await stuckDevice({ partial: 3, name: 'Hold Ends' });
    expect((await owner().post(`/api/v1/host/devices/${d.id}/imports/${d.imp.id}/reread`).send({})).status).toBe(202);
    await w.db1.sequelize.query('UPDATE access_device_details SET import_hold = 0 WHERE id = ?', { replacements: [d.id] });
    expect(await cdataLines(d.sim)).toEqual(expect.arrayContaining(['OPERLOGStamp=9999', 'BIODATAStamp=9999']));
  });
});

describe('a staging failure in hold is answered with a retry', () => {
  let spy;
  afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

  test('503 while staging fails, then the retried post is stored', async () => {
    const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name: 'Retry Door', direction: 'in', importFirst: true, createdBy: w.owner.user.id });
    const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true });
    await sim.connectAtt();
    const body = sim.fixture.userPosts[0];
    spy = jest.spyOn(imports, 'stageUploads').mockRejectedValueOnce(new Error('pool timeout'));
    const failed = await sim.uploadAtt('OPERLOG', body);
    expect(failed.status).toBe(503);
    expect(failed.text.trim()).not.toBe('OK');
    const retried = await sim.uploadAtt('OPERLOG', body);
    expect([retried.status, retried.text.trim()]).toEqual([200, 'OK']);
    const [imp] = await w.q(w.db1, 'SELECT id FROM device_imports WHERE device_id = ?', [device.id]);
    expect(await countUsers(imp.id)).toBe(128);
  });

  test('BIODATA too; after DEVICE_ATT_STAGE_RETRIES failures of one body: OK and an error log row (no loop)', env({ DEVICE_ATT_STAGE_RETRIES: '2' }, async () => {
    const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name: 'Capped Door', direction: 'in', importFirst: true, createdBy: w.owner.user.id });
    const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true });
    await sim.connectAtt();
    spy = jest.spyOn(imports, 'stageUploads').mockRejectedValue(new Error('pool timeout'));
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await sim.uploadAtt('BIODATA', sim.fixture.biodataPost)).status);
    expect(statuses).toEqual([503, 503, 200]);
    const rows = await w.q(w.db1, 'SELECT kind, data_json FROM device_error_logs WHERE device_id = ? AND kind = ?', [device.id, 'import_upload_dropped']);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].data_json)).toMatchObject({ table: 'BIODATA', attempts: 3 });
    expect(rows[0].data_json).not.toMatch(/Tmp=|Type=9/);
  }));

  test('not in hold: unchanged (OK, nothing held back)', async () => {
    const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name: 'Live Door', direction: 'in', importFirst: false, createdBy: w.owner.user.id });
    const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true });
    await sim.connectAtt();
    spy = jest.spyOn(imports, 'stageUploads').mockRejectedValue(new Error('never called'));
    const res = await sim.uploadAtt('OPERLOG', sim.fixture.userPosts[0]);
    expect([res.status, res.text.trim()]).toEqual([200, 'OK']);
    expect(spy).not.toHaveBeenCalled();
  });
});

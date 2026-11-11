/**
 * ZKTeco Phase 1: host device routes (spec ZKTECO_PUSH_DEVICE_SYNC.md §4.4, §10, §11, §12).
 * Add (setup card, K7QM-3XRT key), list, detail (status only), rename / direction / enable,
 * re-pair, unpair; permissions devices.view / devices.manage; platform admins read only;
 * another tenant sees nothing; secrets never leave the API.
 */
const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer } = require('../harness/test-server');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const { sequelize: platformDb } = require('../../src/database/platform');
const { getPermission } = require('../../src/constants/permissions');

const KEY = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
let ctx;
let personas;
let branchB;
let baseUrl;
const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();
let n = 0;
const sn = () => `HST${RUN}${++n}`;

// importFirst is required since Phase 4 (the GymBioSync question); these devices have no GymBioSync members.
const add = (persona, body, headers = {}) => asPersona(persona, headers).post('/host/devices', { name: 'Front door IN', direction: 'in', importFirst: false, ...body });
const platformRow = async (id) => (await platformDb.query('SELECT * FROM access_devices WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = personaManager.context;
  for (const t of ['access_devices', 'unclaimed_device_contacts']) await platformDb.query(`DELETE FROM \`${t}\``);
  for (const db of [ctx.tenant1Db, ctx.tenant2Db]) {
    for (const t of ['access_device_details', 'device_commands']) await db.sequelize.query(`DELETE FROM \`${t}\``);
  }
  branchB = await factories.createBranch(ctx.tenant1Db, ctx.listing1.id, { branchName: 'Branch B', gymId: ctx.branch1.gymId });
  const server = await startTestServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await teardownTestDatabases();
});

describe('catalogue (§12)', () => {
  test('devices.view and devices.manage, deny by default', () => {
    // ROLE_ORDER: OWNER, ORG_ADMIN, MANAGER, BR_ADMIN, DESK, TRAINER, SUPPORT
    expect(getPermission('devices.view').tiers).toEqual(['F', 'F', 'F', 'V', 'V', 'x', 'x']);
    expect(getPermission('devices.manage').tiers).toEqual(['D', 'D', 'D', 'x', 'x', 'x', 'x']);
  });
});

describe('add, list, detail', () => {
  test('owner adds a device: key K7QM-3XRT style and the setup card for mode B (default)', async () => {
    const res = await add('owner', { branchId: ctx.branch1.id });
    expect(res.status).toBe(201);
    const { device, setup } = res.body.data;
    expect(device).toMatchObject({ branchId: ctx.branch1.id, name: 'Front door IN', direction: 'in', linkMode: 'host', connection: 'awaiting_connection', enabled: true });
    expect(device.key).toMatch(KEY);
    expect(setup).toEqual({
      mode: 'host',
      serverAddress: `${device.key.replace('-', '').toLowerCase()}.push.gymsera.com`,
      port: 443,
      https: true,
      domainName: true,
      key: device.key,
    });
    const row = await platformRow(device.id);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(row.registry_code);
    expect(text).not.toContain(row.session_id);
    expect(row).toMatchObject({ tenant_id: ctx.tenant1.id, branch_id: ctx.branch1.id, created_by: personas.owner.user.id, token_mode: 'log' });
  });

  test('path mode shows push.gymsera.com/d/<key>', async () => {
    const res = await add('owner', { branchId: ctx.branch1.id, linkMode: 'path' });
    expect(res.body.data.setup.serverAddress).toBe(`push.gymsera.com/d/${res.body.data.device.key.replace('-', '')}`);
  });

  test('serial mode is refused while DEVICE_SERIAL_PAIRING is off', async () => {
    const res = await add('owner', { branchId: ctx.branch1.id, linkMode: 'serial', serialNumber: 'ABC12345' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code || res.body.code).toBe('serial_pairing_off');
  });

  test('validation: direction, branch, empty name', async () => {
    expect((await add('owner', { branchId: ctx.branch1.id, direction: 'sideways' })).status).toBe(422);
    expect((await add('owner', { branchId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await add('owner', { branchId: ctx.branch1.id, name: '   ' })).status).toBe(422);
  });

  test('list (optionally one branch) and detail with live status after the device connects', async () => {
    const { device } = (await add('owner', { branchId: branchB.id, name: 'Exit', direction: 'out' })).body.data;
    const all = await asPersona('owner').get('/host/devices');
    expect(all.status).toBe(200);
    expect(all.body.data.devices.map((d) => d.id)).toContain(device.id);
    const onlyB = await asPersona('owner').get(`/host/devices?branchId=${branchB.id}`);
    expect(onlyB.body.data.devices.map((d) => d.id)).toEqual([device.id]);
    expect(onlyB.body.data.devices[0].branchName).toBe('Branch B');

    const sim = new ZkDeviceSimulator({ baseUrl, sn: sn(), key: device.key.replace('-', ''), mode: 'host' });
    expect((await sim.connect()).ok).toBe(true);
    const det = await asPersona('owner').get(`/host/devices/${device.id}`);
    expect(det.status).toBe(200);
    expect(det.body.data.device).toMatchObject({
      connection: 'online', serialNumber: sim.sn, model: 'SpeedFace-V5L Simulator', firmware: 'ZAM180-SIM-1.0',
      capabilities: { fingerprint: true, face: true, palm: false }, scheme: 'http', encrypted: false, tokenState: null,
    });
    expect(det.body.data.setup.key).toBe(device.key);
  });
});

describe('edit, re-pair, unpair', () => {
  test('rename and direction; disable shows disabled and stops the device', async () => {
    const { device } = (await add('owner', { branchId: ctx.branch1.id })).body.data;
    const res = await asPersona('owner').patch(`/host/devices/${device.id}`, { name: 'Main gate', direction: 'both' });
    expect(res.status).toBe(200);
    expect(res.body.data.device).toMatchObject({ name: 'Main gate', direction: 'both' });
    const off = await asPersona('owner').patch(`/host/devices/${device.id}`, { enabled: false });
    expect(off.body.data.device).toMatchObject({ enabled: false, connection: 'disabled' });
    const on = await asPersona('owner').patch(`/host/devices/${device.id}`, { enabled: true });
    expect(on.body.data.device).toMatchObject({ enabled: true, connection: 'awaiting_connection' });
  });

  test('re-pair gives a new key and unbinds the serial; the old key stops working', async () => {
    const { device } = (await add('owner', { branchId: ctx.branch1.id })).body.data;
    const sim = new ZkDeviceSimulator({ baseUrl, sn: sn(), key: device.key.replace('-', ''), mode: 'host' });
    await sim.connect();
    const res = await asPersona('owner').post(`/host/devices/${device.id}/repair`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.device.key).not.toBe(device.key);
    expect(res.body.data.device).toMatchObject({ serialNumber: null, connection: 'awaiting_connection' });
    expect(res.body.data.setup.key).toBe(res.body.data.device.key);
    expect((await sim.registry()).status).toBe(406);
  });

  test('unpair: gone from list and detail; the serial can be added again', async () => {
    const { device } = (await add('owner', { branchId: ctx.branch1.id })).body.data;
    const res = await asPersona('owner').delete(`/host/devices/${device.id}`);
    expect(res.status).toBe(200);
    expect((await asPersona('owner').get(`/host/devices/${device.id}`)).status).toBe(404);
    expect((await asPersona('owner').get('/host/devices')).body.data.devices.map((d) => d.id)).not.toContain(device.id);
    expect((await platformRow(device.id)).status).toBe('removed');
  });
});

describe('permissions (§12)', () => {
  let deviceA;
  let deviceB;
  beforeAll(async () => {
    deviceA = (await add('owner', { branchId: ctx.branch1.id, name: 'A' })).body.data.device;
    deviceB = (await add('owner', { branchId: branchB.id, name: 'B' })).body.data.device;
  });

  test('manager: manages devices of their own branch only', async () => {
    expect((await add('manager', { branchId: ctx.branch1.id })).status).toBe(201);
    expect((await add('manager', { branchId: branchB.id })).status).toBe(403);
    expect((await asPersona('manager').patch(`/host/devices/${deviceA.id}`, { name: 'x' })).status).toBe(200);
    expect((await asPersona('manager').patch(`/host/devices/${deviceB.id}`, { name: 'x' })).status).toBe(403);
    expect((await asPersona('manager').get(`/host/devices/${deviceB.id}`)).status).toBe(403);
    const list = await asPersona('manager').get('/host/devices');
    expect(list.status).toBe(200);
    expect(list.body.data.devices.every((d) => d.branchId === ctx.branch1.id)).toBe(true);
  });

  test('re-pair is for the owner and organization admins (not a branch manager)', async () => {
    expect((await asPersona('manager').post(`/host/devices/${deviceA.id}/repair`, {})).status).toBe(403);
    expect((await asPersona('orgAdmin').post(`/host/devices/${deviceA.id}/repair`, {})).status).toBe(200);
  });

  test('front desk: view only; trainer and member: nothing', async () => {
    expect((await asPersona('frontDesk').get('/host/devices')).status).toBe(200);
    expect((await asPersona('frontDesk').get(`/host/devices/${deviceA.id}`)).status).toBe(200);
    expect((await add('frontDesk', { branchId: ctx.branch1.id })).status).toBe(403);
    expect((await asPersona('frontDesk').delete(`/host/devices/${deviceA.id}`)).status).toBe(403);
    expect((await asPersona('trainer').get('/host/devices')).status).toBe(403);
    expect((await asPersona('member').get('/host/devices')).status).toBe(403);
  });

  test('platform admin: reads with a gym chosen, never writes', async () => {
    const h = { 'X-Tenant-Id': ctx.tenant1.id };
    expect((await asPersona('platformAdmin', h).get('/host/devices')).status).toBe(200);
    expect((await asPersona('platformAdmin', h).get(`/host/devices/${deviceA.id}`)).status).toBe(200);
    const writes = [
      await add('platformAdmin', { branchId: ctx.branch1.id }, h),
      await asPersona('platformAdmin', h).patch(`/host/devices/${deviceA.id}`, { name: 'x' }),
      await asPersona('platformAdmin', h).post(`/host/devices/${deviceA.id}/repair`, {}),
      await asPersona('platformAdmin', h).delete(`/host/devices/${deviceA.id}`),
    ];
    for (const w of writes) {
      expect(w.status).toBe(403);
      expect(w.body.error?.code || w.body.code).toBe('devices_read_only_for_platform_admins');
    }
  });

  test('another tenant\'s owner: 404 on a device that is not theirs, none in their list', async () => {
    expect((await asPersona('otherTenantOwner').get(`/host/devices/${deviceA.id}`)).status).toBe(404);
    expect((await asPersona('otherTenantOwner').patch(`/host/devices/${deviceA.id}`, { name: 'x' })).status).toBe(404);
    expect((await asPersona('otherTenantOwner').delete(`/host/devices/${deviceA.id}`)).status).toBe(404);
    expect((await asPersona('otherTenantOwner').get('/host/devices')).body.data.devices).toEqual([]);
    // Another tenant's branch id cannot be used to add a device.
    expect((await add('otherTenantOwner', { branchId: ctx.branch1.id })).status).toBe(404);
  });
});

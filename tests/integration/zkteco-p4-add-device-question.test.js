/**
 * ZKTeco Phase 4 follow-up (owner, 2026-11-11): adding a device asks "Does this device already have members
 * from GymBioSync?". `importFirst` is required on `POST /host/devices` (no default): leaving it out is 422, so
 * a GymBioSync device can no longer be managed by GymsEra by accident (NEW-239). true adds it in import hold
 * (nothing is sent to it until go-live); false adds it as before.
 */
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');

let w;
beforeAll(async () => { w = await createWorld(); }, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const add = (body) => asPersona('owner').post('/host/devices', { branchId: w.ctx.branch1.id, name: 'Front door', direction: 'in', ...body });
const code = (res) => res.body.error?.code || res.body.code;
const holdOf = async (id) => Number((await w.q(w.db1, 'SELECT import_hold FROM access_device_details WHERE id = ?', [id]))[0].import_hold);

describe('POST /host/devices: importFirst is required', () => {
  test('left out: 422 with a plain question, and no device is created', async () => {
    const before = (await asPersona('owner').get('/host/devices')).body.data.devices.length;
    const res = await add({});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/already has members from GymBioSync/);
    expect((await asPersona('owner').get('/host/devices')).body.data.devices.length).toBe(before);
  });

  test.each([['null', null], ['a string', 'yes'], ['a number', 1]])('%s is not an answer: 422', async (_label, value) => {
    expect((await add({ importFirst: value })).status).toBe(422);
  });

  test('true: the device starts in import hold', async () => {
    const res = await add({ importFirst: true });
    expect(res.status).toBe(201);
    expect(res.body.data.device.importHold).toBe(true);
    expect(await holdOf(res.body.data.device.id)).toBe(1);
  });

  test('false: a normal device, managed by GymsEra from its first contact', async () => {
    const res = await add({ importFirst: false });
    expect(res.status).toBe(201);
    expect(res.body.data.device.importHold).toBe(false);
    expect(await holdOf(res.body.data.device.id)).toBe(0);
  });

  test('the question applies only to new devices: editing a device does not ask it', async () => {
    const { device } = (await add({ importFirst: false })).body.data;
    const res = await asPersona('owner').patch(`/host/devices/${device.id}`, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(code(res)).toBeUndefined();
  });
});

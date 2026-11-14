/**
 * NEW-248c: command results are matched by command ID only. The T&A PUSH firmware (checklist (i), 2026-11-14,
 * SpeedFace-V5L ZAM180 Ver3.4.9) echoes `CMD=DATA` for every `DATA …` command, so the echo can never tell two
 * commands apart. push-protocol#parseDevicecmd keys a result on `ID`; device-sync#recordResults looks the command
 * up by that ID and this device, never by the echo.
 */
const crypto = require('crypto');
const { createWorld } = require('../harness/zkteco-world');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');
const protocol = require('../../src/services/devices/push-protocol');
const { utc } = require('../../src/services/devices/sql-time');

let w;
let branch;
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();
let n = 0;
const sn = () => `ARI${RUN}${String(++n).padStart(4, '0')}`;

async function attDevice(name) {
  const { device } = await registry.createDevice({ tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name, direction: 'in', importFirst: false, createdBy: w.owner.user.id });
  const sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: sn(), key: device.deviceKey, mode: 'host', att: true, realFirmware: true });
  await sim.connectAtt();
  await w.settled();
  return { id: device.id, sim };
}

async function queue(deviceId, kind, args) {
  await w.db1.sequelize.query(`INSERT INTO device_commands (device_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'queued', 0, ?, ?, ?)`, { replacements: utc([deviceId, kind, JSON.stringify(args), new Date(Date.now() - 60000), new Date(), new Date()]) });
  const [row] = await w.q(w.db1, 'SELECT MAX(id) AS id FROM device_commands WHERE device_id = ? AND kind = ?', [deviceId, kind]);
  return Number(row.id);
}
const cmd = async (id) => (await w.q(w.db1, 'SELECT status, return_code FROM device_commands WHERE id = ?', [id]))[0];

beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Att Result Branch' });
});

test('parseDevicecmd: the real body (CMD=DATA on every line) gives one result per ID', () => {
  const body = 'ID=4061&Return=-1004&CMD=DATA\nID=4062&Return=0&CMD=DATA\r\nID=4064&Return=0&CMD=DATA\n';
  expect(protocol.parseDevicecmd(body)).toEqual([
    { id: 4061, returnCode: -1004, cmd: 'DATA' },
    { id: 4062, returnCode: 0, cmd: 'DATA' },
    { id: 4064, returnCode: 0, cmd: 'DATA' },
  ]);
  // No ID, or no return code: no result (never guessed from the echo).
  expect(protocol.parseDevicecmd('Return=0&CMD=DATA UPDATE USERINFO PIN=9001')).toEqual([]);
  expect(protocol.parseDevicecmd('ID=7&CMD=DATA')).toEqual([]);
});

test('two DATA commands answered CMD=DATA, out of order, with different codes: each gets its own', async () => {
  const dev = await attDevice('Result Door');
  const other = await attDevice('Other Door');
  const a = await queue(dev.id, 'query_userinfo', { pin: '90001' });
  const b = await queue(dev.id, 'query_userinfo', { pin: '90002' });
  const c = await queue(dev.id, 'info', {});
  const foreign = await queue(other.id, 'query_userinfo', { pin: '90003' });
  await other.sim.poll(); // the other device's command is handed out (sent) to that device

  const got = await dev.sim.poll();
  expect(got.commands.map((x) => x.id).sort((x, y) => x - y)).toEqual([a, b, c]);
  // Reverse order; the INFO line echoes the wrong word: the ID decides, never the echo. The foreign ID is ignored.
  const res = await dev.sim.ack([
    { id: c, returnCode: 0, cmd: 'DATA' },
    { id: b, returnCode: -1004, cmd: 'DATA' },
    { id: foreign, returnCode: -1004, cmd: 'DATA' },
    { id: a, returnCode: 0, cmd: 'DATA' },
  ]);
  expect(res.status).toBe(200);
  expect(await cmd(a)).toEqual({ status: 'acked', return_code: 0 });
  expect(await cmd(b)).toEqual({ status: 'failed', return_code: -1004 });
  expect(await cmd(c)).toEqual({ status: 'acked', return_code: 0 });
  expect(await cmd(foreign)).toEqual({ status: 'sent', return_code: null });
});

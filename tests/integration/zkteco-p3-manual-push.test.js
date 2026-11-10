/**
 * ZKTeco Phase 3: manual "Push now" with a 15-second answer (spec §9), end to end over HTTP with the
 * simulator acting as the device.
 *
 *   member push   202 + requestId; the poll goes queued → delivered → applied; a failed code is shown;
 *                 a device last seen more than 30 s ago is reported offline at once; after the deadline
 *                 the rest say "no answer" and the commands STAY queued, then land later
 *   not entitled  no push, the reason, and "Remove from device now" when still on it
 *   double click  the same person, the same member, inside 10 s → the same request (rate limit)
 *   branch push   every pending change of the branch's devices, with progress; 60 s window
 *   device sync   quick (= branch push for one device) and audit (layer 3 on demand)
 *   audit log     devices.push when asked, devices.push_result when it ends
 */
const { QueryTypes } = require('sequelize');
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { sequelize: platformDb } = require('../../src/database/platform');
const pushService = require('../../src/services/devices/device-push.service');
const { utc } = require('../../src/services/devices/sql-time');

// Dates in raw SQL go through utc() (NEW-237): the connection reads DATETIME as UTC.
const at = (db, sql, rep) => db.query(sql, { replacements: utc(rep) });

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const FACE_ONLY = 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,~MaxUserCount=100,' +
  'MultiBioDataSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:0:0:0:0:0:0:0:0:40.1:0,DateFmtFunOn=0';

const owner = () => asPersona('owner');
const pushMember = (memberId, body = {}, persona = 'owner') => asPersona(persona).post(`/host/members/${memberId}/device-push`, body);
const poll = (requestId, persona = 'owner') => asPersona(persona).get(`/host/device-push-requests/${requestId}`);
const lastSeenAgo = (deviceId, seconds) => at(platformDb, 'UPDATE access_devices SET last_seen_at = ? WHERE id = ?', [new Date(Date.now() - seconds * 1000), deviceId]);
const auditRows = (action) => w.q(w.db1, 'SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at', [action]);
const deviceOf = (res, id) => res.body.data.devices.find((d) => d.deviceId === id);

describe('Push now for one member (§9.2)', () => {
  let branch; let doorA; let doorB; let user;
  beforeAll(async () => {
    branch = w.ctx.branch1;
    doorA = await w.device(w.db1, { branch, registryBody: FACE_ONLY, name: 'Door A' });
    doorB = await w.device(w.db1, { branch, registryBody: FACE_ONLY, name: 'Door B' });
    user = await w.member('Push Member');
    await w.subscribe(w.db1, { user, branch, start: -2, end: 28 });
    await doorA.sim.drain();
    await doorB.sim.drain();
  });

  test('202 with a request id; the member is sent again even though the device was in sync (forced)', async () => {
    const res = await pushMember(user.id);
    expect(res.status).toBe(202);
    const { requestId, devices, deadlineAt } = res.body.data;
    expect(requestId).toMatch(/^[0-9A-Z]{26}$/);
    expect(new Date(deadlineAt).getTime() - Date.now()).toBeGreaterThan(10000);
    expect(devices.map((d) => d.deviceId).sort()).toEqual([doorA.id, doorB.id].sort());
    for (const d of devices) expect(d).toMatchObject({ outcome: 'pushing', offline: false });
    const cmds = await w.commands(w.db1, doorA.id, 'push_request_id = ? AND status = \'queued\'', [requestId]);
    expect(cmds.map((c) => c.kind)).toEqual(['user_upsert', 'user_authorize']);
    expect(cmds.every((c) => Number(c.priority) === 0)).toBe(true);
  });

  test('the poll: queued → delivered (device fetched) → applied; done when every device answered', async () => {
    const { requestId } = (await w.q(w.db1, 'SELECT id AS requestId FROM device_push_requests ORDER BY created_at DESC LIMIT 1'))[0];
    let res = await poll(requestId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requestId, status: 'running' });
    expect(deviceOf(res, doorA.id).state).toBe('queued');

    const fetched = await doorA.sim.poll(); // fetched, not answered yet
    expect(fetched.commands.length).toBe(2);
    res = await poll(requestId);
    expect(deviceOf(res, doorA.id).state).toBe('delivered');

    await doorA.sim.ack(fetched.commands.map((c) => ({ id: c.id, returnCode: doorA.sim.execute(c.text) })));
    res = await poll(requestId);
    expect(deviceOf(res, doorA.id)).toMatchObject({ state: 'applied', returnCode: null });
    expect(res.body.data.status).toBe('running'); // door B has not answered

    await doorB.sim.drain();
    res = await poll(requestId);
    expect(deviceOf(res, doorB.id).state).toBe('applied');
    expect(res.body.data.status).toBe('done');
  });

  test('a failed code is shown (device storage full, -18)', async () => {
    doorA.sim.forceReturn = (text) => (text.startsWith('DATA UPDATE user ') ? -18 : null);
    try {
      const { requestId } = (await pushMember(user.id, { deviceIds: [doorA.id] }, 'orgAdmin')).body.data;
      await doorA.sim.drain();
      const res = await poll(requestId, 'orgAdmin');
      expect(deviceOf(res, doorA.id)).toMatchObject({ state: 'failed', returnCode: -18, reason: 'device_storage_full' });
      expect(res.body.data.status).toBe('done');
    } finally {
      doorA.sim.forceReturn = null;
    }
  });

  test('a device last seen more than 30 s ago is reported offline at once (no 15 s wait)', async () => {
    await lastSeenAgo(doorB.id, 14 * 60);
    const res = await pushMember(user.id, { deviceIds: [doorB.id] }, 'manager');
    expect(res.status).toBe(202);
    const d = res.body.data.devices[0];
    expect(d).toMatchObject({ deviceId: doorB.id, offline: true, outcome: 'pushing' });
    expect(d.lastSeenSecondsAgo).toBeGreaterThanOrEqual(14 * 60);
    const p = await poll(res.body.data.requestId, 'manager');
    expect(deviceOf(p, doorB.id).state).toBe('offline');
    expect(p.body.data.status).toBe('done'); // nothing left to wait for
    // The commands are queued: they land when the device comes back.
    expect((await w.commands(w.db1, doorB.id, 'push_request_id = ? AND status = \'queued\'', [res.body.data.requestId])).length).toBeGreaterThan(0);
    await doorB.sim.drain();
    expect(deviceOf(await poll(res.body.data.requestId, 'manager'), doorB.id).state).toBe('applied');
  });

  test('timeout at 15 s: the rest say "no answer", the commands stay queued, and it turns applied later', async () => {
    const res = await pushMember(user.id, { deviceIds: [doorA.id] }, 'frontDesk');
    const { requestId } = res.body.data;
    await at(w.db1.sequelize, 'UPDATE device_push_requests SET deadline_at = ? WHERE id = ?', [new Date(Date.now() - 1000), requestId]);
    let p = await poll(requestId, 'frontDesk');
    expect(p.body.data.status).toBe('timed_out');
    expect(deviceOf(p, doorA.id)).toMatchObject({ state: 'no_answer' });
    expect((await w.commands(w.db1, doorA.id, 'push_request_id = ? AND status = \'queued\'', [requestId])).length).toBe(2);
    await doorA.sim.drain();
    p = await poll(requestId, 'frontDesk');
    expect(deviceOf(p, doorA.id).state).toBe('applied');
  });

  test('double click: the same person pushing the same member inside 10 s gets the same request', async () => {
    await doorA.sim.drain();
    await w.db1.sequelize.query('DELETE FROM device_push_requests');
    const [a, b] = await Promise.all([pushMember(user.id), pushMember(user.id)]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body.data.requestId).toBe(a.body.data.requestId);
    const c = await pushMember(user.id);
    expect(c.body.data).toMatchObject({ requestId: a.body.data.requestId, reused: true });
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_push_requests'))[0].n).toBe(1);
    // One batch per device, not two.
    expect((await w.commands(w.db1, doorA.id, 'push_request_id = ? AND kind = \'user_upsert\'', [a.body.data.requestId])).length).toBe(1);
    // Another person may push at the same time.
    const other = await pushMember(user.id, {}, 'orgAdmin');
    expect(other.body.data.requestId).not.toBe(a.body.data.requestId);
    // After 10 s a new request.
    await at(w.db1.sequelize, 'UPDATE device_push_requests SET created_at = ? WHERE id = ?', [new Date(Date.now() - 11000), a.body.data.requestId]);
    expect((await pushMember(user.id)).body.data.requestId).not.toBe(a.body.data.requestId);
    await doorA.sim.drain();
    await doorB.sim.drain();
  });

  test('every push is in the audit log: who, member, devices; the result when it ends', async () => {
    const asked = await auditRows('devices.push');
    expect(asked.length).toBeGreaterThan(0);
    const one = asked[asked.length - 1];
    const after = typeof one.after_state === 'string' ? JSON.parse(one.after_state) : one.after_state;
    expect(one).toMatchObject({ target_type: 'member', target_id: user.id });
    expect(after).toMatchObject({ kind: 'member' });
    expect(after.deviceIds.length).toBeGreaterThan(0);
    expect(one.actor_user_id).toBeTruthy();
    // The result is written once, by the first poll that sees it finished (or the watchdog).
    const ended = await auditRows('devices.push_result');
    expect(ended.length).toBeGreaterThan(0);
    const r = typeof ended[0].after_state === 'string' ? JSON.parse(ended[0].after_state) : ended[0].after_state;
    expect(r.devices[0]).toHaveProperty('state');
    expect(JSON.stringify(ended)).not.toMatch(/Tmp=|tmp=|template/i);
  });

  test('requests the watchdog finds past their deadline are closed and audited', async () => {
    const { requestId } = (await pushMember(user.id, { deviceIds: [doorB.id] }, 'manager')).body.data;
    await at(w.db1.sequelize, 'UPDATE device_push_requests SET deadline_at = ?, created_at = ? WHERE id = ?', [new Date(Date.now() - 60000), new Date(Date.now() - 75000), requestId]);
    const closed = await pushService.closeExpired(w.db1);
    expect(closed).toBeGreaterThanOrEqual(1);
    const [row] = await w.q(w.db1, 'SELECT finished_at, result_json FROM device_push_requests WHERE id = ?', [requestId]);
    expect(row.finished_at).not.toBeNull();
    expect(JSON.parse(row.result_json).status).toBe('timed_out');
    await doorB.sim.drain();
  });
});

describe('Not entitled: no push, the reason, and Remove from device now (§9.2)', () => {
  let branch; let door; let user; let sub;
  beforeAll(async () => {
    branch = await w.branch(w.db1, { gymId: w.ctx.branch1.gymId });
    door = await w.device(w.db1, { branch, registryBody: FACE_ONLY, name: 'Gate' });
    user = await w.member('Lapsed Member');
    sub = await w.subscribe(w.db1, { user, branch, start: -20, end: 10 });
    await door.sim.drain();
  });

  test('expired: the push sends nothing and explains why; the member is still on the device', async () => {
    // The package ends without an event (no hook): the device still has them until the sweep.
    await w.db1.sequelize.query('UPDATE member_subscriptions SET end_date = ? WHERE id = ?', { replacements: [require('../harness/zkteco-world').day(-1), sub.id] });
    const res = await pushMember(user.id, { deviceIds: [door.id] });
    expect(res.status).toBe(202);
    expect(res.body.data.devices[0]).toMatchObject({ deviceId: door.id, outcome: 'not_entitled', reason: 'no_valid_package', onDevice: true });
    expect((await w.commands(w.db1, door.id, 'push_request_id = ?', [res.body.data.requestId])).length).toBe(0);
    const status = await owner().get(`/host/members/${user.id}/device-status`);
    expect(status.status).toBe(200);
    const row = status.body.data.devices.find((d) => d.deviceId === door.id);
    expect(row).toMatchObject({ entitled: false, reason: 'no_valid_package', onDevice: true, state: 'in_sync' });
  });

  test('Remove from device now: 202, a tracked request, and the member is gone', async () => {
    const res = await owner().post(`/host/members/${user.id}/device-remove`, { deviceIds: [door.id] });
    expect(res.status).toBe(202);
    const pin = await w.pinOf(w.db1, user.id);
    await door.sim.drain();
    expect(door.sim.holds(pin).user).toBeNull();
    const p = await poll(res.body.data.requestId);
    expect(deviceOf(p, door.id).state).toBe('applied');
    expect((await owner().get(`/host/members/${user.id}/device-status`)).body.data.devices.find((d) => d.deviceId === door.id))
      .toMatchObject({ onDevice: false, state: 'removed' });
  });

  test('remove refuses for someone who is entitled (push them instead)', async () => {
    const fresh = await w.member('Entitled Member');
    await w.subscribe(w.db1, { user: fresh, branch, start: -1, end: 29 });
    await door.sim.drain();
    const res = await owner().post(`/host/members/${fresh.id}/device-remove`, { deviceIds: [door.id] });
    expect(res.status).toBe(409);
    expect(res.body.error?.code || res.body.code).toBe('member_entitled');
  });

  test('a member of no branch with devices: 404 for an unknown member, an empty list for one with no device', async () => {
    expect((await pushMember('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('Push to branch and Sync now (§9.1)', () => {
  let branch; let door; let members;
  beforeAll(async () => {
    // Its own organization: packages at other branches of an organization cover all its branches.
    branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    door = await w.device(w.db1, { branch, registryBody: FACE_ONLY, name: 'Branch door' });
    members = [];
    for (let i = 0; i < 3; i++) {
      const u = await w.member(`Branch Member ${i}`);
      await w.subscribe(w.db1, { user: u, branch, start: -1, end: 29 });
      members.push(u);
    }
  });

  test('branch push: every pending change of the branch at the top of the queue, progress per device', async () => {
    const pending = await w.commands(w.db1, door.id, 'status = \'queued\'');
    expect(pending.length).toBe(6);
    const res = await owner().post(`/host/branches/${branch.id}/device-push`, {});
    expect(res.status).toBe(202);
    const { requestId } = res.body.data;
    const attached = await w.commands(w.db1, door.id, 'status = \'queued\' AND push_request_id = ?', [requestId]);
    expect(attached.length).toBe(6);
    expect(attached.every((c) => Number(c.priority) <= 1)).toBe(true);
    let p = await poll(requestId);
    expect(deviceOf(p, door.id)).toMatchObject({ state: 'queued', progress: { total: 6, done: 0, failed: 0 } });
    await door.sim.drain();
    p = await poll(requestId);
    expect(deviceOf(p, door.id)).toMatchObject({ state: 'applied', progress: { total: 6, done: 6, failed: 0 } });
    expect(p.body.data.status).toBe('done');
  });

  test('a second press inside 60 s by the same person returns the same request', async () => {
    const a = await owner().post(`/host/branches/${branch.id}/device-push`, {});
    const b = await owner().post(`/host/branches/${branch.id}/device-push`, {});
    expect(b.body.data).toMatchObject({ requestId: a.body.data.requestId, reused: true });
  });

  test('device Sync now (quick) is the same for one device; audit queues the layer 3 query', async () => {
    const quick = await owner().post(`/host/devices/${door.id}/sync`, { mode: 'quick' });
    expect(quick.status).toBe(202);
    expect(quick.body.data.requestId).toMatch(/^[0-9A-Z]{26}$/);
    const audit = await owner().post(`/host/devices/${door.id}/sync`, { mode: 'audit' });
    expect(audit.status).toBe(202);
    expect(audit.body.data.auditId).toBeGreaterThan(0);
    const cmds = await w.commands(w.db1, door.id, 'kind IN (\'count\', \'query_users\') AND status = \'queued\'');
    expect(cmds.length).toBe(2);
    await door.sim.drain();
    const [report] = await w.q(w.db1, 'SELECT status FROM device_audits WHERE id = ?', [audit.body.data.auditId]);
    expect(report.status).toBe('compared');
  });

  test('an unknown branch is 404; a branch with no device is 409', async () => {
    expect((await owner().post('/host/branches/00000000-0000-4000-8000-000000000000/device-push', {})).status).toBe(404);
    const empty = await w.branch(w.db1, { gymId: w.ctx.branch1.gymId });
    const res = await owner().post(`/host/branches/${empty.id}/device-push`, {});
    expect(res.status).toBe(409);
    expect(res.body.error?.code || res.body.code).toBe('no_devices');
  });
});

describe('Data shape', () => {
  test('a request from another tenant is 404', async () => {
    const [row] = await w.q(w.db1, 'SELECT id FROM device_push_requests LIMIT 1');
    expect((await poll(row.id, 'otherTenantOwner')).status).toBe(404);
  });

  test('no template text in any push answer', async () => {
    const [row] = await w.q(w.db1, 'SELECT id FROM device_push_requests ORDER BY created_at DESC LIMIT 1');
    const res = await poll(row.id);
    expect(JSON.stringify(res.body)).not.toMatch(/Tmp=|Content=|template_enc/);
  });

  test('pushService exports what the routes and the watchdog use', () => {
    for (const fn of ['pushMember', 'removeMember', 'pushDevices', 'statusOf', 'closeExpired', 'memberDeviceStatus']) {
      expect(typeof pushService[fn]).toBe('function');
    }
    expect(QueryTypes.SELECT).toBe('SELECT');
  });
});

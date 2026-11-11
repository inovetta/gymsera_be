/**
 * ZKTeco Phase 4: move a device to another branch, delete one template, capacity counts what the device
 * really holds (spec §11 move, built as `PUT /host/devices/:id/branch`, `DELETE /host/members/:id/biometrics/:bioId`, §13).
 *
 *   move       the device's members become the new branch's: the old branch's members are removed (no exit
 *              grace, even on an OUT device), the new branch's are sent; platform and tenant rows follow
 *   delete     one template goes from GymsEra and from every device that holds it; the member's other
 *              templates of that type stay (the device deletes the type and gets the rest back)
 *   capacity   the 90% owner alert counts users GymsEra did not put there (another system's users, the
 *              device's own count), not only GymsEra's members
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { sequelize: platformDb } = require('../../src/database/platform');
const { Notification } = require('../../src/models/platform');
const biometrics = require('../../src/services/devices/biometric.service');
const rules = require('../../src/services/devices/sync-rules');
const jobs = require('../../src/jobs/device-jobs');

const REG = 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,~MaxUserCount=10,' +
  'MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:0:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,DateFmtFunOn=1';
const tmp = () => `T${crypto.randomBytes(90).toString('base64').replace(/[^A-Za-z0-9]/g, 'Q')}`;
const owner = () => asPersona('owner');
const code = (res) => res.body.error?.code || res.body.code;

let w;
beforeAll(async () => { w = await createWorld(); }, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const platformRow = async (id) => (await platformDb.query('SELECT * FROM access_devices WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];

describe('move a device to another branch', () => {
  let a; let b; let door; let onlyA; let onlyB;
  beforeAll(async () => {
    a = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Move From' });
    b = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Move To' });
    onlyA = await w.member('Only A');
    onlyB = await w.member('Only B');
    await w.subscribe(w.db1, { user: onlyA, branch: a });
    await w.subscribe(w.db1, { user: onlyB, branch: b });
    door = await w.device(w.db1, { branch: a, registryBody: REG, name: 'Exit Door', direction: 'out' });
    await door.sim.drain();
    expect(door.sim.users.has(await w.pinOf(w.db1, onlyA.id))).toBe(true);
  });

  test('to the same branch: 422', async () => {
    const res = await owner().put(`/host/devices/${door.id}/branch`, { branchId: a.id });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('same_branch');
  });

  test('to an unknown branch: 404', async () => {
    const res = await owner().put(`/host/devices/${door.id}/branch`, { branchId: crypto.randomUUID() });
    expect(res.status).toBe(404);
  });

  test('moved: rows follow; old members removed at once (no exit grace); new members sent', async () => {
    const res = await owner().put(`/host/devices/${door.id}/branch`, { branchId: b.id });
    expect(res.status).toBe(200);
    expect(res.body.data.device.branchId).toBe(b.id);
    expect(res.body.data.device.branchName).toBe('Move To');
    const row = await platformRow(door.id);
    expect(row.branch_id).toBe(b.id);
    expect(row.organization_id).toBe(b.gymId);
    const [det] = await w.q(w.db1, 'SELECT branch_id FROM access_device_details WHERE id = ?', [door.id]);
    expect(det.branch_id).toBe(b.id);
    await door.sim.drain();
    expect(door.sim.users.has(await w.pinOf(w.db1, onlyA.id))).toBe(false);
    expect(door.sim.users.has(await w.pinOf(w.db1, onlyB.id))).toBe(true);
    expect((await w.syncRow(w.db1, door.id, onlyA.id)).state).toBe('removed');
  });
});

describe('delete one template', () => {
  let branch; let door; let user; const ids = {};
  beforeAll(async () => {
    branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Template Branch' });
    user = await w.member('Two Fingers');
    await w.subscribe(w.db1, { user, branch });
    await biometrics.recordConsent(w.db1, { memberId: user.id, method: 'in_person' });
    await biometrics.storeTemplates(w.db1, {
      memberId: user.id,
      deviceId: null,
      templates: [
        { pin: '1', type: 1, no: 0, index: 0, valid: 1, duress: 0, majorVer: '10', minorVer: '0', format: 0, tmp: tmp() },
        { pin: '1', type: 1, no: 1, index: 0, valid: 1, duress: 0, majorVer: '10', minorVer: '0', format: 0, tmp: tmp() },
        { pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: tmp() },
      ],
    });
    for (const r of await w.q(w.db1, 'SELECT id, bio_type, bio_no FROM member_biometrics WHERE member_id = ?', [user.id])) ids[`${r.bio_type}:${r.bio_no}`] = r.id;
    door = await w.device(w.db1, { branch, registryBody: REG, name: 'Finger Door' });
    await door.sim.drain();
  });

  const slots = (pin) => [...door.sim.bio.values()].filter((x) => x.pin === pin).map((x) => `${x.type}:${x.no}`).sort();

  test('the command plan deletes a type before sending fewer templates of it', () => {
    const item = (id, no) => ({ id, no, index: 0, sha: id });
    const base = { pin: '5', name: 'N', cardNo: '', dateFormat: 'seconds', window: null, auth: null, photos: [], userpic: null };
    const plan = rules.planCommands({
      desired: { ...base, bio: [{ type: 1, items: [item('a', 0)] }] },
      applied: { ...base, bio: [{ type: 1, items: [item('a', 0), item('b', 1)] }] },
      pin: '5',
      supportedTypes: [1],
    });
    expect(plan.map((c) => c.kind)).toEqual(['bio_delete', 'bio_upsert']);
    expect(plan[0].args).toEqual({ pin: '5', type: 1 });
  });

  test('DELETE one finger: gone here and on the device; the other finger and the face stay', async () => {
    const pin = await w.pinOf(w.db1, user.id);
    expect(slots(pin)).toEqual(['1:0', '1:1', '9:0']);
    const res = await owner().delete(`/host/members/${user.id}/biometrics/${ids['1:1']}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: 1, bioId: ids['1:1'] });
    expect(JSON.stringify(res.body)).not.toMatch(/template_enc|tmp/i);
    const left = await w.q(w.db1, 'SELECT bio_type, bio_no FROM member_biometrics WHERE member_id = ? ORDER BY bio_type, bio_no', [user.id]);
    expect(left.map((r) => `${r.bio_type}:${r.bio_no}`)).toEqual(['1:0', '9:0']);
    await door.sim.drain();
    expect(slots(pin)).toEqual(['1:0', '9:0']);
  });

  test('a template of another member, or an unknown id: 404', async () => {
    const other = await w.member('Other Member');
    expect((await owner().delete(`/host/members/${other.id}/biometrics/${ids['1:0']}`)).status).toBe(404);
    expect((await owner().delete(`/host/members/${user.id}/biometrics/${crypto.randomUUID()}`)).status).toBe(404);
  });

  test('the member status lists each template with its id (never the data), so the CMS can delete one', async () => {
    const res = await owner().get(`/host/members/${user.id}/device-status`);
    expect(res.status).toBe(200);
    const list = res.body.data.templates;
    expect(list.map((t) => [t.type, t.no])).toEqual([[1, 0], [9, 0]]);
    expect(list[0]).toEqual(expect.objectContaining({ id: ids['1:0'], pending: false }));
    expect(JSON.stringify(list)).not.toMatch(/tmp|template_enc|sha/i);
  });
});

describe('capacity counts what the device holds', () => {
  test('9 users GymsEra did not put there on a 10-user device: one 90% alert', async () => {
    const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const door = await w.device(w.db1, { branch, registryBody: REG, name: 'Full Door' });
    await Notification.destroy({ where: { userId: w.owner.user.id, type: 'device_capacity' } });
    await door.sim.upload('options', 'UserCount=9,FPCount=0,FaceCount=0');
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    const sent = await Notification.findAll({ where: { userId: w.owner.user.id, type: 'device_capacity' }, raw: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatch(/Full Door is at 90% of its user capacity \(9 of 10\)/);
  });
});

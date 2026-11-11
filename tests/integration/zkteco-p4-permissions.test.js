/**
 * ZKTeco Phase 4 permissions per role (spec §12), over HTTP, on every new route:
 *
 *   devices.manage     import (start, match, CSV, preview, apply, rollback, cancel), cut-over (go-live,
 *                      GymBioSync stopped), move (at the device's branch AND the new one)
 *   devices.view       import status, users, preview, cut-over checklist
 *   biometrics.delete  delete one template (owner, org admin, manager; not front desk)
 *   trainer, member    nothing; another tenant's owner: 404; platform admin: reads, never writes
 */
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const biometrics = require('../../src/services/devices/biometric.service');

let w; let home; let away; let homeDoor; let awayDoor; let member; let importId; let bioId;
const PA = { 'X-Tenant-Id': null };
const code = (res) => res.body.error?.code || res.body.code;

beforeAll(async () => {
  w = await createWorld();
  home = w.ctx.branch1; // the manager's and the front desk's branch
  away = await w.branch(w.db1, { gymId: w.ctx.branch1.gymId, name: 'Away P4' });
  homeDoor = await w.device(w.db1, { branch: home, name: 'Home Import Door', importFirst: true });
  awayDoor = await w.device(w.db1, { branch: away, name: 'Away Import Door', importFirst: true });
  homeDoor.sim.seedUser({ pin: 77, name: 'GBS 77' });
  member = await w.member('P4 Permission Member');
  await w.subscribe(w.db1, { user: member, branch: home });
  await biometrics.recordConsent(w.db1, { memberId: member.id, method: 'in_person' });
  await biometrics.storeTemplates(w.db1, { memberId: member.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: `P${'Q'.repeat(300)}` }] });
  [{ id: bioId }] = await w.q(w.db1, 'SELECT id FROM member_biometrics WHERE member_id = ?', [member.id]);
  const res = await asPersona('owner').post(`/host/devices/${homeDoor.id}/imports`, {});
  importId = res.body.data.import.id;
  await homeDoor.sim.drain();
  PA['X-Tenant-Id'] = w.ctx.tenant1.id;
});
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const reads = (door, imp) => [
  ['get', `/host/devices/${door.id}/imports`],
  ['get', `/host/devices/${door.id}/imports/${imp}`],
  ['get', `/host/devices/${door.id}/imports/${imp}/users`],
  ['get', `/host/devices/${door.id}/imports/${imp}/preview`],
  ['get', `/host/devices/${door.id}/cutover`],
];
const writes = (door, imp) => [
  ['post', `/host/devices/${door.id}/imports`, {}],
  ['put', `/host/devices/${door.id}/imports/${imp}/users/77`, { memberId: member.id }],
  ['post', `/host/devices/${door.id}/imports/${imp}/mapping`, { csv: `pin,member_id\n77,${member.id}` }],
  ['post', `/host/devices/${door.id}/imports/${imp}/apply`, {}],
  ['post', `/host/devices/${door.id}/imports/${imp}/rollback`, {}],
  ['post', `/host/devices/${door.id}/imports/${imp}/cancel`, {}],
  ['post', `/host/devices/${door.id}/cutover/go-live`, {}],
  ['post', `/host/devices/${door.id}/cutover/gymbiosync-stopped`, {}],
  ['put', `/host/devices/${door.id}/branch`, { branchId: away.id }],
];
const call = (who, [method, path, body]) => (method === 'get' ? who.get(path) : who[method](path, body));

describe('devices.view: import status, preview, cut-over checklist', () => {
  test.each(['owner', 'orgAdmin', 'manager', 'frontDesk'])('%s reads them at their branch', async (p) => {
    for (const r of reads(homeDoor, importId)) expect((await call(asPersona(p), r)).status).toBe(200);
  });

  test.each(['trainer', 'member'])('%s: 403', async (p) => {
    for (const r of reads(homeDoor, importId)) expect((await call(asPersona(p), r)).status).toBe(403);
  });

  test('manager and front desk: not at a branch they do not hold', async () => {
    for (const p of ['manager', 'frontDesk']) {
      expect((await asPersona(p).get(`/host/devices/${awayDoor.id}/cutover`)).status).toBe(403);
    }
  });

  test('an import id of another device is 404 (no cross-device read)', async () => {
    expect((await asPersona('owner').get(`/host/devices/${awayDoor.id}/imports/${importId}`)).status).toBe(404);
  });
});

describe('devices.manage: import, cut-over, move', () => {
  test.each(['frontDesk', 'trainer', 'member'])('%s: 403 on every write', async (p) => {
    for (const r of writes(homeDoor, importId)) {
      const res = await call(asPersona(p), r);
      expect([r[1], res.status]).toEqual([r[1], 403]);
    }
  });

  test('another tenant\'s owner: 404 on every route', async () => {
    const o = asPersona('otherTenantOwner');
    for (const r of [...reads(homeDoor, importId), ...writes(homeDoor, importId)]) {
      const res = await call(o, r);
      expect([r[1], res.status]).toEqual([r[1], 404]);
    }
  });

  test('platform admin: reads, never writes', async () => {
    const pa = asPersona('platformAdmin', PA);
    for (const r of reads(homeDoor, importId)) expect((await call(pa, r)).status).toBe(200);
    for (const r of writes(homeDoor, importId)) {
      const res = await call(pa, r);
      expect([r[1], res.status, code(res)]).toEqual([r[1], 403, 'devices_read_only_for_platform_admins']);
    }
  });

  test('manager at home: matches; cannot move the device to a branch they do not hold', async () => {
    const mgr = asPersona('manager');
    expect((await mgr.put(`/host/devices/${homeDoor.id}/imports/${importId}/users/77`, { memberId: member.id })).status).toBe(200);
    expect((await mgr.post(`/host/devices/${homeDoor.id}/imports/${importId}/apply`, {})).status).toBe(200);
    expect((await mgr.post(`/host/devices/${homeDoor.id}/imports/${importId}/rollback`, {})).status).toBe(200);
    const move = await mgr.put(`/host/devices/${homeDoor.id}/branch`, { branchId: away.id });
    expect(move.status).toBe(403);
  });

  test('a device in an import cannot be moved or wiped (cancel the import first)', async () => {
    const move = await asPersona('owner').put(`/host/devices/${homeDoor.id}/branch`, { branchId: away.id });
    expect(move.status).toBe(409);
    expect(code(move)).toBe('device_in_import');
    const wipe = await asPersona('owner').delete(`/host/devices/${homeDoor.id}`, { wipeDevice: true, confirmName: 'Home Import Door' });
    expect(wipe.status).toBe(409);
    expect(code(wipe)).toBe('device_in_import');
  });

  test('org admin moves a device between branches of the organization', async () => {
    const extra = await w.branch(w.db1, { gymId: w.ctx.branch1.gymId, name: 'Extra P4' });
    const plain = await w.device(w.db1, { branch: away, name: 'Movable' });
    expect((await asPersona('orgAdmin').put(`/host/devices/${plain.id}/branch`, { branchId: extra.id })).status).toBe(200);
  });
});

describe('biometrics.delete: one template', () => {
  test('front desk, trainer, member: 403; another tenant: 404; platform admin: 403', async () => {
    for (const p of ['frontDesk', 'trainer', 'member']) {
      expect((await asPersona(p).delete(`/host/members/${member.id}/biometrics/${bioId}`)).status).toBe(403);
    }
    expect((await asPersona('otherTenantOwner').delete(`/host/members/${member.id}/biometrics/${bioId}`)).status).toBe(404);
    const pa = await asPersona('platformAdmin', PA).delete(`/host/members/${member.id}/biometrics/${bioId}`);
    expect(pa.status).toBe(403);
    expect(code(pa)).toBe('devices_read_only_for_platform_admins');
  });

  test('manager: deletes it', async () => {
    const res = await asPersona('manager').delete(`/host/members/${member.id}/biometrics/${bioId}`);
    expect(res.status).toBe(200);
  });
});

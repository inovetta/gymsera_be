/**
 * ZKTeco Phase 3 permissions per role (spec §12), over HTTP, on every new route:
 *
 *   devices.push       owner, org admin, manager (own branch), branch admin, front desk
 *   devices.view       the same people read status, requests, live feed, tabs, photos
 *   devices.manage     settings, unlinked link / dismiss, full audit, wipe (not front desk)
 *   biometrics.enroll  consent and remote enrolment (front desk too)
 *   trainer, member    nothing; another tenant's owner: 404; platform admin: reads, never writes
 */
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { getPermission } = require('../../src/constants/permissions');

let w;
let home; let away; let doorHome; let doorAway; let member;
const PA = { 'X-Tenant-Id': null };

beforeAll(async () => {
  w = await createWorld();
  home = w.ctx.branch1; // the manager's and the front desk's branch
  away = await w.branch(w.db1, { gymId: w.ctx.branch1.gymId, name: 'Away Branch' });
  doorHome = await w.device(w.db1, { branch: home, name: 'Home Door' });
  doorAway = await w.device(w.db1, { branch: away, name: 'Away Door' });
  member = await w.member('Permission Member');
  await w.subscribe(w.db1, { user: member, branch: home });
  await doorHome.sim.drain();
  await doorAway.sim.drain();
  PA['X-Tenant-Id'] = w.ctx.tenant1.id;
});
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const code = (res) => res.body.error?.code || res.body.code;

describe('catalogue (§12)', () => {
  test('devices.push, biometrics.enroll, biometrics.delete: deny by default', () => {
    // ROLE_ORDER: OWNER, ORG_ADMIN, MANAGER, BR_ADMIN, DESK, TRAINER, SUPPORT
    expect(getPermission('devices.push').tiers).toEqual(['D', 'D', 'D', 'D', 'D', 'x', 'x']);
    expect(getPermission('biometrics.enroll').tiers).toEqual(['D', 'D', 'D', 'D', 'D', 'x', 'x']);
    expect(getPermission('biometrics.delete').tiers).toEqual(['D', 'D', 'D', 'x', 'x', 'x', 'x']);
  });
});

describe('push (devices.push)', () => {
  test.each(['owner', 'orgAdmin', 'manager', 'frontDesk'])('%s pushes a member at their branch', async (p) => {
    const res = await asPersona(p).post(`/host/members/${member.id}/device-push`, { deviceIds: [doorHome.id] });
    expect(res.status).toBe(202);
  });

  test('manager and front desk: not at a branch they do not hold', async () => {
    for (const p of ['manager', 'frontDesk']) {
      expect((await asPersona(p).post(`/host/members/${member.id}/device-push`, { deviceIds: [doorAway.id] })).status).toBe(404);
      expect((await asPersona(p).post(`/host/branches/${away.id}/device-push`, {})).status).toBe(403);
      expect((await asPersona(p).post(`/host/devices/${doorAway.id}/sync`, { mode: 'quick' })).status).toBe(403);
    }
    // Without deviceIds, only the devices of their branch are pushed.
    const res = await asPersona('manager').post(`/host/members/${member.id}/device-push`, {});
    expect(res.body.data.devices.map((d) => d.deviceId)).toEqual([doorHome.id]);
  });

  test.each(['trainer', 'member'])('%s: 403 on every push route', async (p) => {
    expect((await asPersona(p).post(`/host/members/${member.id}/device-push`, {})).status).toBe(403);
    expect((await asPersona(p).post(`/host/members/${member.id}/device-remove`, {})).status).toBe(403);
    expect((await asPersona(p).post(`/host/branches/${home.id}/device-push`, {})).status).toBe(403);
    expect((await asPersona(p).post(`/host/devices/${doorHome.id}/sync`, {})).status).toBe(403);
    expect((await asPersona(p).get(`/host/members/${member.id}/device-status`)).status).toBe(403);
  });

  test('another tenant\'s owner: 404 (the member, branch and device are not theirs)', async () => {
    const o = asPersona('otherTenantOwner');
    expect((await o.post(`/host/members/${member.id}/device-push`, {})).status).toBe(404);
    expect((await o.post(`/host/branches/${home.id}/device-push`, {})).status).toBe(404);
    expect((await o.post(`/host/devices/${doorHome.id}/sync`, {})).status).toBe(404);
    expect((await o.get(`/host/devices/${doorHome.id}/members`)).status).toBe(404);
  });

  test('platform admin: reads status and tabs, never pushes, enrols or changes settings', async () => {
    const pa = asPersona('platformAdmin', PA);
    expect((await pa.get(`/host/members/${member.id}/device-status`)).status).toBe(200);
    expect((await pa.get(`/host/devices/${doorHome.id}/members`)).status).toBe(200);
    expect((await pa.get(`/host/devices/${doorHome.id}/access-events`)).status).toBe(200);
    const writes = [
      await pa.post(`/host/members/${member.id}/device-push`, {}),
      await pa.post(`/host/members/${member.id}/device-remove`, {}),
      await pa.post(`/host/branches/${home.id}/device-push`, {}),
      await pa.post(`/host/devices/${doorHome.id}/sync`, { mode: 'quick' }),
      await pa.post(`/host/members/${member.id}/biometrics/enroll`, { deviceId: doorHome.id }),
      await pa.put(`/host/devices/branch-settings/${home.id}`, { capturePhotos: true }),
      await pa.post(`/host/devices/${doorHome.id}/unlinked-users/7/dismiss`, {}),
    ];
    for (const r of writes) {
      expect(r.status).toBe(403);
      expect(code(r)).toBe('devices_read_only_for_platform_admins');
    }
  });
});

describe('views (devices.view)', () => {
  test.each(['owner', 'manager', 'frontDesk'])('%s reads the member status, the request, the feed and every tab', async (p) => {
    const a = asPersona(p);
    expect((await a.get(`/host/members/${member.id}/device-status`)).status).toBe(200);
    const pushed = await asPersona('owner').post(`/host/members/${member.id}/device-push`, { deviceIds: [doorHome.id] });
    expect((await a.get(`/host/device-push-requests/${pushed.body.data.requestId}`)).status).toBe(200);
    expect((await a.get(`/host/branches/${home.id}/access-events`)).status).toBe(200);
    for (const tab of ['members', 'access-events', 'errors', 'commands', 'audits', 'unlinked-users']) {
      expect((await a.get(`/host/devices/${doorHome.id}/${tab}`)).status).toBe(200);
    }
    expect((await a.get(`/host/devices/branch-settings/${home.id}`)).status).toBe(200);
    expect((await a.get('/host/devices/unlinked-users')).status).toBe(200);
  });

  test('a manager does not see a request for a device at another branch', async () => {
    const pushed = await asPersona('owner').post(`/host/members/${member.id}/device-push`, { deviceIds: [doorAway.id] });
    expect(pushed.status).toBe(202);
    expect((await asPersona('manager').get(`/host/device-push-requests/${pushed.body.data.requestId}`)).status).toBe(404);
    expect((await asPersona('manager').get(`/host/devices/${doorAway.id}/members`)).status).toBe(403);
    expect((await asPersona('manager').get(`/host/branches/${away.id}/access-events`)).status).toBe(403);
  });

  test('trainer: no tabs, no feed', async () => {
    expect((await asPersona('trainer').get(`/host/devices/${doorHome.id}/members`)).status).toBe(403);
    expect((await asPersona('trainer').get(`/host/branches/${home.id}/access-events`)).status).toBe(403);
  });
});

describe('manage (devices.manage) and biometrics', () => {
  test('front desk: no settings, no unlinked link / dismiss, no full audit, no wipe; manager can at home', async () => {
    const fd = asPersona('frontDesk');
    expect((await fd.put(`/host/devices/branch-settings/${home.id}`, { alertsEnabled: false })).status).toBe(403);
    expect((await fd.post(`/host/devices/${doorHome.id}/unlinked-users/7/dismiss`, {})).status).toBe(403);
    expect((await fd.post(`/host/devices/${doorHome.id}/unlinked-users/7/link`, { memberId: member.id })).status).toBe(403);
    expect((await fd.post(`/host/devices/${doorHome.id}/sync`, { mode: 'audit' })).status).toBe(403);
    expect((await fd.delete(`/host/devices/${doorHome.id}`, { wipeDevice: true, confirmName: 'Home Door' })).status).toBe(403);
    expect((await asPersona('manager').put(`/host/devices/branch-settings/${home.id}`, { alertsEnabled: true })).status).toBe(200);
    expect((await asPersona('manager').put(`/host/devices/branch-settings/${away.id}`, { alertsEnabled: true })).status).toBe(403);
    expect((await asPersona('manager').post(`/host/devices/${doorHome.id}/sync`, { mode: 'audit' })).status).toBe(202);
  });

  test('enrol: front desk yes (consent first), trainer no', async () => {
    const fd = asPersona('frontDesk');
    const noConsent = await fd.post(`/host/members/${member.id}/biometrics/enroll`, { deviceId: doorHome.id });
    expect(noConsent.status).toBe(409);
    expect(code(noConsent)).toBe('biometric_consent_required');
    expect((await fd.post(`/host/devices/members/${member.id}/biometric-consent`, { method: 'in_person' })).status).toBe(200);
    const res = await fd.post(`/host/members/${member.id}/biometrics/enroll`, { deviceId: doorHome.id, type: 9 });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ kind: 'enroll', pin: expect.any(String) });
    expect((await asPersona('trainer').post(`/host/members/${member.id}/biometrics/enroll`, { deviceId: doorHome.id })).status).toBe(403);
    // The device asks the member, the template arrives: the request turns applied.
    await doorHome.sim.drain();
    const p = await fd.get(`/host/device-push-requests/${res.body.data.requestId}`);
    expect(p.body.data.devices[0]).toMatchObject({ state: 'applied' });
  });

  test('withdraw consent: not front desk (biometrics.delete); the owner can', async () => {
    expect((await asPersona('frontDesk').delete(`/host/devices/members/${member.id}/biometric-consent`)).status).toBe(403);
    expect((await asPersona('owner').delete(`/host/devices/members/${member.id}/biometric-consent`)).status).toBe(200);
  });

  test('staff device access switch (D-8): manager at home, not front desk', async () => {
    const person = await w.member('Desk Staff Person');
    const staff = await w.db1.models.GymStaff.create({ branchId: home.id, userId: person.id, employmentStatus: 'ACTIVE', status: 'active' });
    expect((await asPersona('frontDesk').patch(`/host/devices/staff/${staff.id}/device-access`, { deviceAccess: true })).status).toBe(403);
    expect((await asPersona('manager').patch(`/host/devices/staff/${staff.id}/device-access`, { deviceAccess: true })).status).toBe(200);
    expect((await asPersona('manager').patch(`/host/devices/staff/${staff.id}/device-access`, { deviceAccess: false })).status).toBe(200);
    // The Team panel reads the person's rows: the branch, the switch; another tenant sees none.
    const rows = await asPersona('frontDesk').get(`/host/devices/staff/by-user/${person.id}`);
    expect(rows.status).toBe(200);
    expect(rows.body.data.staff).toEqual([expect.objectContaining({ staffId: staff.id, branchId: home.id, deviceAccess: false, active: true })]);
    expect((await asPersona('otherTenantOwner').get(`/host/devices/staff/by-user/${person.id}`)).body.data.staff).toEqual([]);
    expect((await asPersona('trainer').get(`/host/devices/staff/by-user/${person.id}`)).status).toBe(403);
  });
});

/**
 * NEW-296 (owner 2026-11-20, decision R-117): Become a Host step 3 with the old opening / closing pair.
 *
 * Before: a closing time after 12:00 and at or before the opening time (for example 18:00-14:00, what a
 * host gets who means 6:00 AM but leaves the picker on PM) was refused with
 * "A slot may end at most 12 hours after midnight." (branch-hours.service.js:101), which does not
 * tell the host what to change.
 * After: the same rule, reworded: "Closing time is before opening time. Check AM/PM, or pick a closing
 * time up to 12:00 PM the next day." No rule changed: the boundaries below are the R-113 H3 ones.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { firstBranchInput } = require('../harness/first-branch-input');
const hours = require('../../src/services/branch-hours.service');

const MESSAGE = 'Closing time is before opening time. Check AM/PM, or pick a closing time up to 12:00 PM the next day.';

const pairErrors = (openingTime, closingTime) => {
  try {
    hours.resolveWrite({ openingTime, closingTime }, {});
    return [];
  } catch (err) {
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('hours_invalid');
    return err.errors;
  }
};

describe('NEW-296: the after-midnight message, the rule unchanged', () => {
  test('a closing time after 12:00 and before the opening time gets the new sentence', () => {
    expect(pairErrors('18:00', '14:00')).toEqual([{ path: 'closingTime', message: MESSAGE }]);
    expect(pairErrors('20:00', '13:00')).toEqual([{ path: 'closingTime', message: MESSAGE }]);
    expect(pairErrors('18:00', '12:01')).toEqual([{ path: 'closingTime', message: MESSAGE }]);
  });

  test('the weekly schedule gets the same sentence', () => {
    const slot = { open: '20:00', close: '13:00', for: 'all' };
    const week = { v: 1, days: Object.fromEntries(hours.DAYS.map((d) => [d, { closed: false, slots: [{ ...slot }] }])) };
    let caught;
    try { hours.validate(week); } catch (err) { caught = err; }
    expect(caught.errors[0]).toEqual({ path: 'days.mon.slots[0].close', message: MESSAGE });
  });

  test('the old wording is gone', () => {
    expect(JSON.stringify(pairErrors('18:00', '14:00'))).not.toContain('12 hours after midnight');
  });

  test('the rule is unchanged: 12:00 PM next day is the limit; 12 AM closing and overnight hours pass', () => {
    expect(pairErrors('18:00', '12:00')).toEqual([]);
    expect(pairErrors('06:00', '00:00')).toEqual([]);
    expect(pairErrors('22:00', '06:00')).toEqual([]);
    expect(pairErrors('06:00', '22:00')).toEqual([]);
    expect(pairErrors('00:00', '24:00')).toEqual([]);
    expect(pairErrors('09:00', '09:00')).toEqual([{ path: 'closingTime', message: 'Opening and closing times are the same.' }]);
  });
});

describe('NEW-296: Become a Host step 3 (POST /tenants/:id/first-business, the old pair)', () => {
  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const draftHost = async () => {
    const user = await factories.createUser({ email: `new296-${Date.now()}@new296.test`, role: 'GYM_HOST', isHost: true });
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
    const tenant = await factories.createTenant({ ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING' });
    return { tenant, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
  };

  test('18:00-14:00 is refused with the new sentence; 06:00-00:00 (12 AM closing) is stored', async () => {
    const { tenant, as } = await draftHost();
    const profile = (firstBranch) => ({ organizationName: 'Hours Brand', firstBusinessName: 'G', firstBranch }); // A3 J10
    const bad = await as().post(`/organizations/${tenant.id}/first-business`).send(profile(await firstBranchInput({ openingTime: '18:00', closingTime: '14:00' })));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('hours_invalid');
    expect(JSON.stringify(bad.body)).toContain(MESSAGE);

    const ok = await as().post(`/organizations/${tenant.id}/first-business`).send(profile(await firstBranchInput({ openingTime: '06:00', closingTime: '00:00' })));
    expect(ok.status).toBe(200);
    await tenant.reload();
    expect([tenant.firstBranchDraft.openingTime, tenant.firstBranchDraft.closingTime]).toEqual(['06:00', '00:00']);
    expect(tenant.firstBranchDraft.hours.days.sun.slots).toEqual([{ open: '06:00', close: '00:00', for: 'all' }]);
  });
});

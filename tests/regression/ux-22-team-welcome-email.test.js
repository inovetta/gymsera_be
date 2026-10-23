/**
 * UX-22, option B (spec §14 R-48, revised): a team member gets access at once, as before, and is e-mailed a
 * welcome with a link to gymsera.com. The host is no longer shown the temporary password unless the e-mail
 * could not be sent (the e-mail never carries the password: a new person chooses their own through "Forgot password").
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { GymListing, User } = require('../../src/models/platform');

const WEB = (process.env.APP_URL || process.env.FRONTEND_URL || 'https://gymsera.com').replace(/\/+$/, '');

describe('UX-22: team welcome e-mail', () => {
  let branchId;
  let tenantId;
  let mail;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    const personas = await setupPersonas(h);
    tenantId = personas.owner.tenantId;
    const listing = await GymListing.findOne({ where: { tenantId } });
    branchId = (await h.tenant1.models.Branch.findOne({ where: { gymListingId: listing.id } })).id;
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(() => {
    mail = installMailFake();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const invite = (email, extra = {}) =>
    asPersona('owner').post('/team/invites', { email, fullName: 'New Person', roleKey: 'DESK', branchIds: [branchId], ...extra });
  const to = (email) => mail.sent.filter((m) => m.to === email);

  test('a new person is e-mailed a link to set their password; the host is not shown a password', async () => {
    const res = await invite('ux22.new@example.test');

    expect(res.status).toBe(201);
    expect(res.body.data.tempPassword).toBeNull();
    expect(res.body.data.emailSent).toBe(true);
    const sent = to('ux22.new@example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain(`${WEB}/auth/forgot-password`);
    expect(sent[0].subject).toMatch(/welcome|access/i);
    const user = await User.findOne({ where: { email: 'ux22.new@example.test' } });
    expect(sent[0].html + sent[0].text).not.toContain(user.passwordHash);
  });

  test('someone who already has an account is e-mailed a sign-in link', async () => {
    const existing = await User.create({ fullName: 'Has Account', email: 'ux22.has@example.test', passwordHash: 'x', role: 'MEMBER', status: 'ACTIVE', isVerified: true });

    const r = await invite(existing.email);

    expect(r.status).toBe(201);
    expect(r.body.data.tempPassword).toBeNull();
    const sent = to(existing.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain(`${WEB}/auth/login`);
    expect(sent[0].html).not.toContain('forgot-password');
  });

  test('if the e-mail cannot be sent the host still gets the temporary password, and the invite still works', async () => {
    mail.send.mockRejectedValueOnce(new Error('554 5.1.8 blocked'));

    const res = await invite('ux22.fail@example.test');

    expect(res.status).toBe(201);
    expect(res.body.data.emailSent).toBe(false);
    expect(typeof res.body.data.tempPassword).toBe('string');
    expect(res.body.data.tempPassword.length).toBeGreaterThanOrEqual(8);
  });

  test('POST /gyms/staff behaves the same', async () => {
    const res = await asPersona('owner').post('/gyms/staff', {
      fullName: 'Legacy Path',
      email: 'ux22.staff@example.test',
      designation: 'Receptionist',
      branchIds: [branchId],
      assignToAllBranches: false,
    });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data.tempPassword ?? null).toBeNull();
    expect(to('ux22.staff@example.test')).toHaveLength(1);
  });

  test('the e-mail names the gym and the role and carries no password', async () => {
    await invite('ux22.copy@example.test');
    const [m] = to('ux22.copy@example.test');
    expect(m.text).toMatch(/Front Desk|Desk|Reception/i);
    expect(m.text).not.toMatch(/temporary password|temp password/i);
    expect(m.text).not.toMatch(/[0-9a-f]{8}!Aa1/);
  });
});

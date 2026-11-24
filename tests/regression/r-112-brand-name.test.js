/**
 * R-112 (owner 2026-11-18, build 26): the brand name is a real field in Become a Host.
 *
 * Before: the app generated tenants.business_name as "<full name>'s Gym Business" on Step 1 and the host never
 * saw it; POST /tenants/register required it, gym-profile had no place for it, PATCH /tenants/me accepted any
 * text up to 200 characters without an audit row, and /host/status did not return it.
 *
 * After (spec §13 "R-112", C1 to C5): register takes no name (build 26 types it on Step 2); gym-profile saves
 * `organizationName` under the brand rules (3 to 60 characters, no link / phone number / markup, the area-name word
 * filter); the draft first branch's name follows the gym name; PATCH /tenants/me checks the same rules and
 * audits a change; /host/status returns `organizationName`.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');
const { Tenant, PlatformAuditLog } = require('../../src/models/platform');
const moderationWords = require('../../src/services/moderation-words.service');

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  // The NEW-256 starter list, as the area-name tests load it (production keeps the admin's list).
  const { STARTER_WORDS } = require('../../src/constants/moderation');
  await moderationWords.replaceWords([...STARTER_WORDS]);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

beforeEach(() => moderationWords.clearCache());

let seq = 0;
const newUser = async (role = 'MEMBER') => {
  seq += 1;
  const user = await factories.createUser({ email: `r112-${Date.now()}-${seq}@r112.test`, role, isHost: role === 'GYM_HOST', isVerified: true });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role, isVerified: true });
  return { user, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
};

const draftHost = async (overrides = {}) => {
  const { user, as } = await newUser('GYM_HOST');
  const tenant = await factories.createTenant({
    ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING', ...overrides,
  });
  return { user, tenant, as };
};

const BAD_NAMES = [
  ['ab', 'brand_name_invalid'], // too short
  ['x'.repeat(61), 'brand_name_invalid'], // too long
  ['123', 'brand_name_invalid'], // no letter
  ['Visit www.mygym.com', 'brand_name_invalid'], // a link
  ['Call 03001234567', 'brand_name_invalid'], // a phone number
  ['<script>alert(1)</script>', 'brand_name_invalid'], // markup (e-mails print the brand as HTML)
  ['Fuck Fitness', 'brand_name_blocked'], // the area-name word filter (NEW-256 list)
];

describe('R-112: brand name', () => {
  test('C2: POST /tenants/register without a business name creates the draft with an empty brand', async () => {
    const { user, as } = await newUser();
    const res = await as().post('/organizations/register').send({ email: user.email });
    expect(res.status).toBe(201);
    const tenant = await Tenant.findOne({ where: { ownerUserId: user.id } });
    expect(tenant.organizationName).toBe('');
  });

  test('C2: an old app (build 25 and before) still registers with the generated name', async () => {
    const { user, as } = await newUser();
    const res = await as().post('/organizations/register').send({ organizationName: 'Test Person\'s Gym Business', email: user.email });
    expect(res.status).toBe(201);
    expect((await Tenant.findOne({ where: { ownerUserId: user.id } })).organizationName).toBe('Test Person\'s Gym Business');
  });

  test('C3: gym-profile saves the brand (cleaned) and the gym name; GET /tenants/me returns both', async () => {
    const { tenant, as } = await draftHost({ organizationName: '' });
    const res = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: '  Iron   Works  ', firstBusinessName: 'Iron Works Saddar' });
    expect(res.status).toBe(200);
    await tenant.reload();
    expect(tenant.organizationName).toBe('Iron Works');
    expect(tenant.firstBusinessName).toBe('Iron Works Saddar');
    const me = (await as().get('/organizations/me')).body.data.tenant;
    expect(me.organizationName).toBe('Iron Works');
    expect(me.firstBusinessName).toBe('Iron Works Saddar');
  });

  test.each([['Gold\'s Gym'], ['F45 Training'], ['24/7 Fitness'], ['Fit+ Club'], ['Zorba & Sons']])('C1: real brands pass: %s', async (name) => {
    const { tenant, as } = await draftHost();
    const res = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: name, firstBusinessName: 'Gym' });
    expect(res.status).toBe(200);
    await tenant.reload();
    expect(tenant.organizationName).toBe(name);
  });

  test.each(BAD_NAMES)('C1 / C3: gym-profile refuses %s → %s, nothing saved', async (name, code) => {
    const { tenant, as } = await draftHost({ organizationName: 'Kept Brand', firstBusinessName: 'Kept Gym' });
    const res = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: name, firstBusinessName: 'Other Gym' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe(code);
    if (code === 'brand_name_blocked') expect(JSON.stringify(res.body).toLowerCase()).not.toContain('fuck');
    await tenant.reload();
    expect(tenant.organizationName).toBe('Kept Brand');
    expect(tenant.firstBusinessName).toBe('Kept Gym');
  });

  test('C3: without organizationName gym-profile behaves as before (old apps)', async () => {
    const { tenant, as } = await draftHost({ organizationName: 'Old Person\'s Gym Business' });
    const res = await as().post(`/organizations/${tenant.id}/first-business`).send({ firstBusinessName: 'Old Gym' });
    expect(res.status).toBe(200);
    await tenant.reload();
    expect(tenant.organizationName).toBe('Old Person\'s Gym Business');
    expect(tenant.firstBusinessName).toBe('Old Gym');
  });

  test('C3: the draft first branch name follows the gym name, unless the host typed another one', async () => {
    const { tenant, as } = await draftHost({ firstBusinessName: 'First Name', firstBranchDraft: { name: 'First Name', address: 'Road 1' } });
    await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: 'Brand One', firstBusinessName: 'Second Name' });
    await tenant.reload();
    expect(tenant.firstBranchDraft.name).toBe('Second Name');
    expect(tenant.firstBranchDraft.address).toBe('Road 1');
    expect(tenant.onboardingStep).toBeLessThanOrEqual(2); // saving names does not skip the address step

    const typed = await draftHost({ firstBusinessName: 'Gym A', firstBranchDraft: { name: 'Gym A Saddar' } });
    await typed.as().post(`/organizations/${typed.tenant.id}/first-business`).send({ firstBusinessName: 'Gym B' });
    await typed.tenant.reload();
    expect(typed.tenant.firstBranchDraft.name).toBe('Gym A Saddar');
  });

  test('C4: PATCH /tenants/me (live gym) checks the rules and audits the change', async () => {
    const organizationId = personaManager.context.tenant1.id;
    const before = (await Tenant.findByPk(organizationId)).organizationName;
    for (const [name, code] of BAD_NAMES) {
      const res = await asPersona('owner').patch('/organizations/me').send({ organizationName: name });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    }
    expect((await Tenant.findByPk(organizationId)).organizationName).toBe(before);

    const res = await asPersona('owner').patch('/organizations/me').send({ organizationName: 'Renamed Brand' });
    expect(res.status).toBe(200);
    expect(res.body.data.tenant.organizationName).toBe('Renamed Brand');
    const audit = await PlatformAuditLog.findOne({ where: { action: 'tenant.brand_renamed', targetId: organizationId }, order: [['createdAt', 'DESC']] });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(personaManager.personas.owner.user.id);
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    expect(details).toEqual({ from: before, to: 'Renamed Brand' });

    // The same name again changes nothing and writes no second row.
    const count = await PlatformAuditLog.count({ where: { action: 'tenant.brand_renamed', targetId: organizationId } });
    await asPersona('owner').patch('/organizations/me').send({ organizationName: 'Renamed Brand' });
    expect(await PlatformAuditLog.count({ where: { action: 'tenant.brand_renamed', targetId: organizationId } })).toBe(count);
    await Tenant.update({ organizationName: before }, { where: { id: organizationId } });
  });

  test('C5: GET /host/status returns organizationName (null while empty)', async () => {
    const empty = await draftHost({ organizationName: '', firstBusinessName: 'Status Gym' });
    let body = (await empty.as().get('/host/status')).body.data;
    expect(body.organizationName).toBeNull();
    expect(body.firstBusinessName).toBe('Status Gym');

    await empty.as().post(`/organizations/${empty.tenant.id}/first-business`).send({ organizationName: 'Status Brand', firstBusinessName: 'Status Gym' });
    body = (await empty.as().get('/host/status')).body.data;
    expect(body.organizationName).toBe('Status Brand');
    expect(body.firstBusinessName).toBe('Status Gym');
  });

  test('C4 / C7: an old stored name sent back unchanged is not re-checked (the host can still edit the e-mail)', async () => {
    const organizationId = personaManager.context.tenant1.id;
    const before = await Tenant.findByPk(organizationId);
    const legacy = 'Legacy Brand Name That Is Much Longer Than Sixty Characters Allowed Now';
    await before.update({ organizationName: legacy });
    const audits = () => PlatformAuditLog.count({ where: { action: 'tenant.brand_renamed', targetId: organizationId } });
    const auditsBefore = await audits();
    const res = await asPersona('owner').patch('/organizations/me').send({ organizationName: legacy, phone: '' });
    expect(res.status).toBe(200);
    expect(await audits()).toBe(auditsBefore);
    // A real change to it is checked as usual.
    const changed = await asPersona('owner').patch('/organizations/me').send({ organizationName: `${legacy} 2` });
    expect(changed.status).toBe(422);
    await Tenant.update({ organizationName: before.organizationName }, { where: { id: organizationId } });
  });
});

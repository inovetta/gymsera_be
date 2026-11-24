/**
 * NEW-273 (owner 2026-11-18, R-113 D4 part, "fix the seconds now"): branch hours were sent as MySQL TIME
 * ("06:00:00") and every client printed them as received ("06:00:00 - 22:00:00").
 *
 * After: every branch object carries openingTime / closingTime as "HH:MM" (a getter on the Branch model),
 * so the gym detail, the host lists and the admin screens all show "06:00 - 22:00", old app builds included.
 * Storage is unchanged.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing } = require('../../src/models/platform');

let tenantDb;
let branch;

beforeAll(async () => {
  const h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  const listing = await GymListing.findOne({ where: { organizationId: personas.owner.organizationId } });
  branch = await factories.createBranch(tenantDb, listing.id, { name: 'Hours branch' });
  await branch.update({ openingTime: '06:00', closingTime: '22:30' });
  await factories.makeBranchLive(tenantDb, branch);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-273: branch hours are HH:MM, never HH:MM:SS', () => {
  test('stored as TIME (seconds in the database), read as HH:MM', async () => {
    const [[row]] = await tenantDb.sequelize.query('SELECT opening_time AS o FROM branches WHERE id = ?', { replacements: [branch.id] });
    expect(String(row.o)).toBe('06:00:00');
    const fresh = await tenantDb.models.Branch.findByPk(branch.id);
    expect(fresh.openingTime).toBe('06:00');
    expect(fresh.toJSON().closingTime).toBe('22:30');
  });

  test('gym detail (travellers)', async () => {
    const res = await asPersona('anonymous').get(`/discovery/branches/${branch.id}`);
    expect(res.status).toBe(200);
    const b = [res.body.data.branch].find((x) => x.id === branch.id);
    expect(b.openingTime).toBe('06:00');
    expect(b.closingTime).toBe('22:30');
  });

  test('host branch list', async () => {
    const res = await asPersona('owner').get('/host/branches');
    expect(res.status).toBe(200);
    const list = Array.isArray(res.body.data) ? res.body.data : res.body.data.branches;
    const b = list.find((x) => x.id === branch.id);
    expect(b.openingTime).toBe('06:00');
    expect(b.closingTime).toBe('22:30');
  });

  test('no hours stay null', async () => {
    await branch.update({ openingTime: null, closingTime: null });
    const fresh = await tenantDb.models.Branch.findByPk(branch.id);
    expect(fresh.openingTime).toBeNull();
    expect(fresh.toJSON().closingTime).toBeNull();
    await branch.update({ openingTime: '06:00', closingTime: '22:30' });
  });
});

/**
 * R-120 NEW-309 (API contract v2 §1 rule 3): the access-token claim is `organizationId`. A token that still carries the old
 * `tenantId` claim (signed before the rename) is refused with 401 so the client refreshes; a token with the new claim works.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');

let personas;
beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const withToken = (token) => asPersona('anonymous', { Authorization: `Bearer ${token}` });
const base = () => ({ sub: personas.owner.user.id, id: personas.owner.user.id, email: personas.owner.user.email, role: 'GYM_HOST', isVerified: true });

describe('access-token claim', () => {
  test('a token with the old tenantId claim and no organizationId: 401', async () => {
    const old = signToken({ ...base(), tenantId: personas.owner.organizationId });
    const res = await withToken(old).get('/host/status');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  test('a token with the old claim set to null (a member token before the rename): 401', async () => {
    const old = signToken({ ...base(), role: 'MEMBER', tenantId: null });
    expect((await withToken(old).get('/host/status')).status).toBe(401);
  });

  test('a token with organizationId works', async () => {
    const res = await withToken(signToken({ ...base(), organizationId: personas.owner.organizationId })).get('/host/status');
    expect(res.status).toBe(200);
  });

  test('a token with organizationId null (a traveller) works', async () => {
    const res = await withToken(signToken({ ...base(), role: 'MEMBER', organizationId: null })).get('/host/status');
    expect(res.status).toBe(200);
  });

  test('the persona tokens (new claim) still work', async () => {
    expect((await asPersona('owner').get('/host/status')).status).toBe(200);
  });
});

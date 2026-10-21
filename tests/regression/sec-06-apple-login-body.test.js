/**
 * SEC-06 stage 2, POST /auth/social/apple: the body is { identityToken, authorizationCode?, fullName? }.
 * userIdentifier and email are still accepted and ignored because app builds released before the fix sent
 * them (the server reads both from the signed identity token, NEW-02). Anything else is a 422.
 */
const request = require('supertest');
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});

const post = (body) => request(app).post('/api/v1/auth/social/apple').send(body);
const unknownFields = (res) => (res.body.errors || []).filter((e) => e.code === 'unknown_field').map((e) => e.field);

describe('POST /auth/social/apple body', () => {
  test('an unknown field is a 422 that names it', async () => {
    const res = await post({ identityToken: 'x', role: 'PLATFORM_ADMIN' });
    expect(res.status).toBe(422);
    expect(unknownFields(res)).toEqual(['role']);
  });

  test('fullName and authorizationCode are declared', async () => {
    const res = await post({ identityToken: 'not-a-real-jwt', fullName: 'Ali Raza', authorizationCode: 'c' });
    expect(unknownFields(res)).toEqual([]);
  });

  test('the two fields older app builds send are tolerated (and ignored)', async () => {
    const res = await post({ identityToken: 'not-a-real-jwt', userIdentifier: 'u', email: 'a@b.co' });
    expect(unknownFields(res)).toEqual([]);
  });

  test('fullName is validated as text', async () => {
    const res = await post({ identityToken: 'x', fullName: { a: 1 } });
    expect(res.status).toBe(422);
  });
});

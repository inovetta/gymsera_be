/**
 * SEC-06 stage 2: the validated routes whose client bodies are now clean run validate.strict in LOG mode
 * first (docs/changes/SEC-06.md). An unknown field is accepted and logged as "[unknown-fields] ... would be
 * rejected" so the logs show whether any real client still sends one; setting UNKNOWN_FIELDS_STAGE2_MODE=reject
 * turns every stage-2 route to 422 without a deploy. UNKNOWN_FIELDS_MODE keeps governing stage 1; "off" there
 * switches the check off everywhere.
 */
const request = require('supertest');
const { body } = require('express-validator');
const fixture = require('../fixtures/sec-06-stage2-client-bodies.json');
const { startTestServer } = require('../harness/test-server');
const validate = require('../../src/middleware/validate');

const ENV = ['UNKNOWN_FIELDS_MODE', 'UNKNOWN_FIELDS_STAGE2_MODE'];
const saved = {};
beforeEach(() => ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

const run = async (mw, reqBody) => {
  const req = { body: reqBody, originalUrl: '/x?y=1', method: 'POST' };
  const res = { statusCode: null, payload: null, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; }, getHeader() {}, req };
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { nexted, status: res.statusCode, payload: res.payload };
};

describe('validate.strict with { stage: 2 }', () => {
  const chains = [body('email').isEmail()];

  test('defaults to log: accepts and logs the unknown field', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await run(validate.strict(chains, { stage: 2 }), { email: 'a@b.co', role: 'x' });
    expect(r.nexted).toBe(true);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('[unknown-fields]');
    expect(logged).toContain('POST /x');
    expect(logged).toContain('role');
    warn.mockRestore();
  });

  test('the global reject mode does not enforce stage 2 early', async () => {
    process.env.UNKNOWN_FIELDS_MODE = 'reject';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await run(validate.strict(chains, { stage: 2 }), { email: 'a@b.co', role: 'x' })).nexted).toBe(true);
    console.warn.mockRestore();
  });

  test('UNKNOWN_FIELDS_STAGE2_MODE=reject makes it a 422', async () => {
    process.env.UNKNOWN_FIELDS_STAGE2_MODE = 'reject';
    const r = await run(validate.strict(chains, { stage: 2 }), { email: 'a@b.co', role: 'x' });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.payload)).toContain('unknown_field');
  });

  test('UNKNOWN_FIELDS_MODE=off switches stage 2 off too', async () => {
    process.env.UNKNOWN_FIELDS_MODE = 'off';
    process.env.UNKNOWN_FIELDS_STAGE2_MODE = 'reject';
    expect((await run(validate.strict(chains, { stage: 2 }), { email: 'a@b.co', role: 'x' })).nexted).toBe(true);
  });

  test('stage 1 (no option) still rejects by default', async () => {
    expect((await run(validate.strict(chains), { email: 'a@b.co', role: 'x' })).status).toBe(422);
  });

  test('a declared-only body logs nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await run(validate.strict(chains, { stage: 2 }), { email: 'a@b.co' })).nexted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('stage-2 routes', () => {
  let app;
  beforeAll(async () => { app = await startTestServer(); });

  const walk = require('../harness/route-walk');

  test.each(fixture.routes.map((r) => [`${r.method} ${r.path}`, r]))('%s is strict (stage 2) and accepts every key the clients send', (key, r) => {
    const found = walk(require('../../app')._router.stack).filter((x) => x.key === key);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f.allowed).not.toBeNull();
      expect(f.stage).toBe(2);
      expect(r.clientKeys.filter((k) => !f.allowed.includes(k))).toEqual([]);
    }
  });

  test('POST /auth/password-reset/request with an extra field: accepted in log mode, 422 in reject mode', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = await request(app).post('/api/v1/auth/password-reset/request').send({ email: 'nobody@example.com', role: 'PLATFORM_ADMIN' });
    expect(logged.status).not.toBe(422);
    process.env.UNKNOWN_FIELDS_STAGE2_MODE = 'reject';
    const refused = await request(app).post('/api/v1/auth/password-reset/request').send({ email: 'nobody@example.com', role: 'PLATFORM_ADMIN' });
    expect(refused.status).toBe(422);
    console.warn.mockRestore();
  });
});

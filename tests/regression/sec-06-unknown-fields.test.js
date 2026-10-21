/**
 * SEC-06 (P0), stage 1 — mutating routes reject request-body fields they do not declare (422).
 *
 * validate.strict(chains) is validate(chains) plus a check that every top-level key of req.body is a
 * field one of the chains names. Stage 1 turns it on for the routers where the CMS, web and mobile
 * code send nothing the validators do not already declare (docs/changes/SEC-06.md has the full
 * inventory of the other routes). Modes (UNKNOWN_FIELDS_MODE): reject (default, 422), log (accept
 * and log), off.
 */
const request = require('supertest');
const { body } = require('express-validator');
const fixture = require('../fixtures/sec-06-stage1-client-bodies.json');
const { startTestServer } = require('../harness/test-server');

const validate = require('../../src/middleware/validate');

const run = async (mw, reqBody) => {
  const req = { body: reqBody, originalUrl: '/x', method: 'POST' };
  const res = {
    statusCode: null,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    getHeader() { return undefined; },
    req,
  };
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { nexted, status: res.statusCode, payload: res.payload };
};

describe('SEC-06: validate.strict', () => {
  const chains = [body('email').isEmail(), body('items.*.id').optional().isInt(), body('note').optional().isString()];
  const OLD = process.env.UNKNOWN_FIELDS_MODE;
  afterEach(() => { if (OLD === undefined) delete process.env.UNKNOWN_FIELDS_MODE; else process.env.UNKNOWN_FIELDS_MODE = OLD; });

  test('is exported', () => {
    expect(typeof validate.strict).toBe('function');
  });

  test('an unknown top-level field is a 422 that names every unknown field', async () => {
    const r = await run(validate.strict(chains), { email: 'a@b.co', role: 'PLATFORM_ADMIN', tenantId: 'x' });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(422);
    const fields = JSON.stringify(r.payload);
    expect(fields).toContain('role');
    expect(fields).toContain('tenantId');
    expect(fields).toContain('unknown_field');
  });

  test('declared fields, including the root of a nested or wildcard path, pass', async () => {
    const r = await run(validate.strict(chains), { email: 'a@b.co', items: [{ id: 1 }], note: 'x' });
    expect(r.nexted).toBe(true);
  });

  test('allow adds fields no chain names; a missing body and a non-object body are not touched', async () => {
    expect((await run(validate.strict(chains, { allow: ['extra'] }), { email: 'a@b.co', extra: 1 })).nexted).toBe(true);
    expect((await run(validate.strict(chains), undefined)).status).toBe(422); // email still required
    expect((await run(validate.strict([]), undefined)).nexted).toBe(true);
    expect((await run(validate.strict([]), [1, 2])).nexted).toBe(true);
  });

  test('a validation error and an unknown field are reported together', async () => {
    const r = await run(validate.strict(chains), { email: 'nope', role: 'x' });
    expect(r.status).toBe(422);
    const fields = r.payload.errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'role']));
  });

  test('mode log accepts the request, mode off ignores the check', async () => {
    process.env.UNKNOWN_FIELDS_MODE = 'log';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await run(validate.strict(chains), { email: 'a@b.co', role: 'x' })).nexted).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('role');
    warn.mockRestore();
    process.env.UNKNOWN_FIELDS_MODE = 'off';
    expect((await run(validate.strict(chains), { email: 'a@b.co', role: 'x' })).nexted).toBe(true);
  });

  test('the plain validate() still lets unknown fields through (only listed routes are strict)', async () => {
    expect((await run(validate(chains), { email: 'a@b.co', role: 'x' })).nexted).toBe(true);
  });
});

describe('SEC-06 stage 1: the listed routes are strict and accept everything the clients send', () => {
  let app;
  beforeAll(async () => { app = await startTestServer(); });

  const walk = (stack, base, out) => {
    for (const layer of stack) {
      if (!layer.route) {
        if (layer.name === 'router' && layer.handle?.stack) {
          let prefix = base;
          if (layer.regexp && !layer.regexp.fast_slash) {
            const clean = layer.regexp.source
              .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/')
              .replace(/\^/g, '').replace(/\$/g, '').replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
            prefix = (base + clean).replace(/\/+/g, '/');
          }
          walk(layer.handle.stack, prefix, out);
        }
      } else {
        const r = layer.route;
        let p = (base + (r.path === '/' ? '' : r.path)).replace(/\/+/g, '/');
        if (!p.startsWith('/')) p = '/' + p;
        p = p.replace(/:\w+/g, ':p');
        for (const m of Object.keys(r.methods)) {
          const strict = r.stack.map((s) => s.handle).find((h) => h.__strictAllowed);
          out.push({ key: `${m.toUpperCase()} ${p}`, allowed: strict ? strict.__strictAllowed : null });
        }
      }
    }
    return out;
  };

  test.each(fixture.routes.map((r) => [`${r.method} ${r.path}`, r]))('%s', (key, r) => {
    const found = walk(require('../../app')._router.stack, '', []).filter((x) => x.key === key);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f.allowed).not.toBeNull();
      const missing = r.clientKeys.filter((k) => !f.allowed.includes(k));
      expect(missing).toEqual([]);
    }
  });

  test('POST /auth/login with an extra field is a 422 and does not reach the controller', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x', role: 'PLATFORM_ADMIN' });
    expect(res.status).toBe(422);
    expect(res.body.code || res.body.error?.code || JSON.stringify(res.body)).toContain('validation_error');
    expect(JSON.stringify(res.body)).toContain('role');
  });

  test('POST /auth/login with only declared fields is not rejected for unknown fields', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'Whatever1!' });
    expect(JSON.stringify(res.body)).not.toContain('unknown_field');
  });
});

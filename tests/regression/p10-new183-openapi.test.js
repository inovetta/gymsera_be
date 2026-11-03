/**
 * NEW-183 (P10 item 7, R-82): the API docs describe what the host's plan answer really is.
 *
 * Before: GET /host/subscription/current had no OpenAPI entry at all (host.routes.js has no
 * @swagger block), although P7c changed it to answer a lapsed plan with entitled: false and a
 * `lapse` object, and the store sync routes did not list 409 subscription_owned_by_other_account
 * (BILL-01) or the 401 a bad Apple signature gives. The spec is what swagger-jsdoc builds from
 * the route files (src/config/swagger.config.js).
 */
const spec = require('../../src/config/swagger.config');

describe('NEW-183: OpenAPI entries for the host plan and the store sync routes', () => {
  const op = (path, method) => (spec.paths[path] || {})[method];

  test('GET /host/subscription/current is documented: 200 entitled or lapsed, 404 never had a plan', () => {
    const get = op('/host/subscription/current', 'get');
    expect(get).toBeDefined();
    expect(get.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(get.responses)).toEqual(expect.arrayContaining(['200', '401', '403', '404']));
    const data = get.responses['200'].content['application/json'].schema.properties.data;
    expect(Object.keys(data.properties)).toEqual(
      expect.arrayContaining(['status', 'platform', 'environment', 'branchCount', 'entitled', 'lapse', 'paymentIssue'])
    );
    expect(Object.keys(data.properties.lapse.properties)).toEqual(
      expect.arrayContaining(['status', 'reason', 'provider', 'manageUrl', 'endedAt', 'branchesLockAt', 'inGrace', 'remainingDays'])
    );
    expect(data.properties.lapse.properties.reason.enum).toEqual(['expired', 'on_hold', 'paused', 'refunded', 'ended']);
    expect(data.properties.environment.enum).toEqual(['SANDBOX', 'PRODUCTION', null]);
  });

  test.each(['/billing/ios/sync', '/billing/android/sync'])('%s lists 409 subscription_owned_by_other_account', (path) => {
    const post = op(path, 'post');
    expect(post).toBeDefined();
    expect(post.responses['409']).toBeDefined();
    expect(post.responses['409'].description).toMatch(/subscription_owned_by_other_account/);
  });

  test('/billing/ios/sync lists 401 for a payload Apple did not sign (NEW-177)', () => {
    expect(op('/billing/ios/sync', 'post').responses['401']).toBeDefined();
  });

  test('every documented host and billing operation has a 200-range answer', () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (!/^\/(billing|host)\//.test(path)) continue;
      for (const [method, operation] of Object.entries(ops)) {
        const codes = Object.keys(operation.responses || {});
        expect({ path, method, ok: codes.some((c) => /^2\d\d$/.test(c)) }).toEqual({ path, method, ok: true });
      }
    }
  });
});

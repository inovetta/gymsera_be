const app = require('../../app');
const authenticate = require('../../src/middleware/authenticate');

/**
 * Security Guard Test: Route Authentication Allow-list
 *
 * Ensures that no unauthenticated or unprotected route can be added
 * to the API without an explicit security review and allow-list entry.
 */

// Allow-list for non-login operational / mutating / webhook routes
// specified by the owner (each entry must have a one-line reason):
const ALLOWED_NON_LOGIN_OPERATIONAL_ROUTES = [
  // Provider webhooks (signature checked)
  { method: 'POST', path: '/api/v1/billing/webhooks/apple', reason: 'Apple ASN v2 webhook: payload is a cryptographically signed JWS verified with Apple root certificates' },
  { method: 'POST', path: '/api/v1/billing/webhooks/google', reason: 'Google RTDN webhook: protected by the Pub/Sub push OIDC token (SEC-03)' },
  { method: 'POST', path: '/api/v1/billing/webhooks/stripe', reason: 'Stripe webhook: payload verified with HMAC-SHA256 signature using STRIPE_WEBHOOK_SECRET' },

  // /auth/* public routes (public authentication, registration, password reset)
  { method: 'POST', path: '/api/v1/auth/register', reason: 'Public user registration: creates initial unverified user account' },
  { method: 'POST', path: '/api/v1/auth/otp/verify', reason: 'Public OTP verification: validates one-time code to verify phone/email' },
  { method: 'POST', path: '/api/v1/auth/otp/resend', reason: 'Public OTP resend: issues fresh OTP code subject to rate limits' },
  { method: 'POST', path: '/api/v1/auth/login', reason: 'Public login: validates user credentials and issues JWT session token' },
  { method: 'POST', path: '/api/v1/auth/social/google', reason: 'Public Google sign-in: validates Google OAuth id_token and issues JWT' },
  { method: 'POST', path: '/api/v1/auth/social/google/staff', reason: 'Public staff Google sign-in: validates Google OAuth id_token for staff roles' },
  { method: 'POST', path: '/api/v1/auth/social/apple', reason: 'Public Apple sign-in: validates Apple identity token and issues JWT' },
  { method: 'POST', path: '/api/v1/auth/refresh', reason: 'Public token refresh: exchanges valid refresh token for fresh JWT' },
  { method: 'POST', path: '/api/v1/auth/password-reset/request', reason: 'Public password reset request: generates secure password reset token' },
  { method: 'POST', path: '/api/v1/auth/password-reset/confirm', reason: 'Public password reset confirm: applies new password via validated reset token' },
  { method: 'GET', path: '/api/v1/auth/tenant-invitations/verify', reason: 'Public tenant invitation token verification: validates invitation token before registration' },
  { method: 'POST', path: '/api/v1/auth/tenant-invitations/accept', reason: 'Public tenant invitation accept: creates tenant and owner account via validated invitation token' },

  // Cron route (secret checked)
  { method: 'GET', path: '/api/v1/cron/subscription-expiry', reason: 'Cron trigger: sweeps expired subscriptions; protected by CRON_SECRET header/bearer' },

  // Device-notify route (device key)
  { method: 'POST', path: '/api/v1/attendance/device-notify', reason: 'Biometric device attendance: records scan event; protected by x-device-api-key header' },

  // The four /system maintenance routes from Part 2 (pending owner decision)
  { method: 'GET', path: '/api/v1/system/run-install', reason: 'Maintenance endpoint: installs socket.io behind URL key until owner decides' },
  { method: 'GET', path: '/api/v1/system/run-pull', reason: 'Maintenance endpoint: pulls main branch git commits behind URL key until owner decides' },
  { method: 'POST', path: '/api/v1/system/configure-fcm', reason: 'Maintenance endpoint: configures Firebase service account behind URL key until owner decides' },
  { method: 'POST', path: '/api/v1/system/fcm-test', reason: 'Maintenance endpoint: pushes test FCM notification behind URL key until owner decides' },
];

// Public read-only catalog, search, and documentation routes:
const ALLOWED_PUBLIC_READ_ROUTES = [
  { method: 'OPTIONS', pattern: /^\/\*/, reason: 'CORS preflight options handler' },
  { method: 'GET', pattern: /^\/api\/docs/, reason: 'Swagger API documentation and spec endpoints' },
  { method: 'GET', pattern: /^\/api\/v1\/health$/, reason: 'Public service health check' },
  { method: 'GET', pattern: /^\/api\/v1\/system\/(socket-status|fcm-status)$/, reason: 'Public read-only system diagnostic status' },
  { method: 'GET', pattern: /^\/api\/v1\/cities/, reason: 'Public city and area catalog for mobile/web dropdowns' },
  { method: 'GET', pattern: /^\/api\/v1\/platform-packages/, reason: 'Public platform package pricing catalog' },
  { method: 'GET', pattern: /^\/api\/v1\/billing\/plans$/, reason: 'Public plan pricing for mobile/CMS tier selector' },
  { method: 'GET', pattern: /^\/api\/v1\/discovery\//, reason: 'Public consumer gym search, discovery, and reviews' },
  { method: 'GET', pattern: /^\/api\/v1\/membership-plans/, reason: 'Public gym branch membership plans catalog' },
  { method: 'GET', pattern: /^\/iclock\//, reason: 'ZKTeco ADMS protocol: device polling validated by serial number' },
  { method: 'POST', pattern: /^\/iclock\//, reason: 'ZKTeco ADMS protocol: device attendance data push validated by serial number' },
  { method: '_ALL', pattern: /^\/iclock/, reason: 'ZKTeco ADMS protocol wildcards' },
];

function isAuthMiddleware(fn) {
  return fn === authenticate || fn?.name === 'authenticate';
}

function walkStack(stack, basePath = '', inheritedMiddlewares = []) {
  const routes = [];
  const activeMiddlewares = [...inheritedMiddlewares];

  for (const layer of stack) {
    if (!layer.route) {
      if (layer.name === 'router' && layer.handle?.stack) {
        let prefix = basePath;
        if (layer.regexp && !layer.regexp.fast_slash) {
          const clean = layer.regexp.source
            .replace('^\\/', '/')
            .replace('\\/?(?=\\/|$)', '')
            .replace(/\\\//g, '/')
            .replace(/\^/g, '')
            .replace(/\$/g, '')
            .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
          prefix = (basePath + clean).replace(/\/+/g, '/');
        }
        routes.push(...walkStack(layer.handle.stack, prefix, activeMiddlewares));
      } else if (layer.handle) {
        if (isAuthMiddleware(layer.handle)) {
          activeMiddlewares.push('authenticate');
        }
      }
    } else {
      const route = layer.route;
      let fullPath = (basePath + (route.path === '/' ? '' : route.path)).replace(/\/+/g, '/');
      if (!fullPath.startsWith('/')) fullPath = '/' + fullPath;

      const hasRouteAuth = route.stack.some(s => isAuthMiddleware(s.handle));
      const hasAuth = activeMiddlewares.includes('authenticate') || hasRouteAuth;

      for (const method of Object.keys(route.methods)) {
        routes.push({
          method: method.toUpperCase(),
          path: fullPath,
          hasAuth,
        });
      }
    }
  }

  return routes;
}

describe('PART 3: Express router unauthenticated routes security guard', () => {
  const allRoutes = walkStack(app._router.stack);
  const unauthenticatedRoutes = allRoutes.filter(r => !r.hasAuth);

  test('all unauthenticated mutating/operational routes are in the strict allow-list', () => {
    const unallowedRoutes = [];

    for (const route of unauthenticatedRoutes) {
      // Check if it matches an operational / mutating allow-list entry
      const isAllowedOperational = ALLOWED_NON_LOGIN_OPERATIONAL_ROUTES.some(
        a => a.method === route.method && a.path === route.path
      );
      if (isAllowedOperational) continue;

      // Check if it matches a public read-only catalog pattern
      const isAllowedPublicRead = ALLOWED_PUBLIC_READ_ROUTES.some(
        a => (a.method === route.method || a.method === '_ALL') && a.pattern.test(route.path)
      );
      if (isAllowedPublicRead) continue;

      unallowedRoutes.push(`${route.method} ${route.path}`);
    }

    expect(unallowedRoutes).toEqual([]);
  });

  test('every entry in ALLOWED_NON_LOGIN_OPERATIONAL_ROUTES exists on the router and has a reason', () => {
    for (const entry of ALLOWED_NON_LOGIN_OPERATIONAL_ROUTES) {
      expect(entry.reason).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(10);

      const exists = unauthenticatedRoutes.some(
        r => r.method === entry.method && r.path === entry.path
      );
      expect(exists).toBe(true);
    }
  });

  test('no mutating route (POST, PUT, PATCH, DELETE) outside auth/webhooks/hardware/FCM lacks authentication', () => {
    const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const nonCatalogMutations = unauthenticatedRoutes.filter(r => {
      if (!mutatingMethods.has(r.method)) return false;
      if (r.path.startsWith('/iclock/')) return false; // Hardware ADMS
      return true;
    });

    const allowedMutatingPaths = new Set(
      ALLOWED_NON_LOGIN_OPERATIONAL_ROUTES
        .filter(a => mutatingMethods.has(a.method))
        .map(a => `${a.method} ${a.path}`)
    );

    const unexpected = nonCatalogMutations
      .map(r => `${r.method} ${r.path}`)
      .filter(sig => !allowedMutatingPaths.has(sig));

    expect(unexpected).toEqual([]);
  });
});

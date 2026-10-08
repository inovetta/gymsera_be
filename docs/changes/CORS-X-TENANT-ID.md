# CORS-X-TENANT-ID: Preflight rejected X-Tenant-Id

- **Issue**: Browser calls from https://cms.gymsera.com that carry `X-Tenant-Id` were blocked; the preflight response did not list it in `Access-Control-Allow-Headers`.
- **Root cause**:
  - `app.js:44-55` (before the fix): a hand-written middleware answered every OPTIONS request first, with a fixed header list (`Content-Type, Authorization, x-device-api-key, X-Requested-With, Accept, Origin, X-Request-Id, Idempotency-Key`). It never reached the `cors()` middleware, so editing that one alone would not have helped.
  - The same middleware reflected **any** `Origin` back with `Access-Control-Allow-Credentials: true`, ignoring the allow-list. An unknown origin therefore got CORS headers on every response.
  - `app.js:114` (`corsOptions.allowedHeaders`) was a second, different list.
- **Pattern reused**: the existing `allowedOrigins` list and the gymsera.com / localhost rule, moved into one `isAllowedOrigin()` helper used by `cors()`. One `allowedHeaders` list now serves the preflight.
- **Fix**: removed the duplicate middleware; `allowedHeaders` = `Content-Type, Authorization, Accept, Origin, X-Requested-With, x-device-api-key, X-Request-Id, Idempotency-Key, X-Tenant-Id, X-Api-Version, X-Skip-Timeout`. Origins are unchanged (no origin added).
- **Test**: `tests/regression/cors-x-tenant-id-preflight.test.js`: preflight from the CMS origin returns each client header (x-tenant-id, idempotency-key, x-api-version, x-request-id, x-skip-timeout, authorization, content-type); an unknown origin gets no `Access-Control-*` headers. Failed before the fix (6 of 10), passes after.
- **Client impact**: CMS requests with `X-Tenant-Id` pass the preflight. Unknown origins no longer receive CORS headers (they were wrongly receiving them). Mobile and server clients send no `Origin` and are unaffected.
- **Deploy**: backend only, no migration.

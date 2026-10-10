# NEW-54: Delete stale live-server smoke tests

- **Issue ID**: NEW-54
- **Status**: DONE
- **Decision recorded by owner**: Delete not rewrite (spec §14, owner decision on NEW-54).
- **Files removed**:
  - `tests/admin.test.js`
  - `tests/auth.test.js`
  - `tests/discovery.test.js`
  - `tests/host.test.js`
  - `tests/me.test.js`
  - `tests/member.test.js`
  - `tests/helpers.js` (shared axios helper configured for `http://localhost:3000/api/v1`, unused by any remaining files)

## Rationale & Verification

1. **Why removed**:
   - The six test files were early smoke test scripts from May 2026.
   - They required a live running server listening on `:3000` (`tests/helpers.js`), dev seed users (`admin@gymsera.com`, `ahmed@ironpeak.com`, `ali.hassan@example.com`), seeded Karachi gyms, and a dev-only `debugCode`.
   - Running them against a live server breaks R-19 (database safety / harness isolation).
   - They were never included in `jest.config.js` `testMatch` (which matches `<rootDir>/tests/integration/**/*.test.js` and `<rootDir>/tests/regression/**/*.test.js`), so they were never run during `npm test` or CI.
   - In NEW-53 triage, these files were evaluated: no product bug was found in the application code, and every route they targeted still exists in `src/routes`.
   - The owner decided to delete rather than rewrite onto the harness personas/factories (`tests/harness/personas.js`), as modern coverage already exists in the test harness.

2. **Route coverage**:
   - The endpoints originally called by these smoke tests (`/admin/*`, `/auth/*`, `/discovery/*`, `/gyms/*`, `/me/*`, `/membership-plans/*`) are covered by comprehensive integration and regression suites under `tests/integration/` (such as `rbac-03-permission-matrix.test.js`, `auth-flows.test.js`, `flow-01-member-journey.test.js`, etc.) and `tests/regression/`.

3. **Helper cleanup**:
   - `tests/helpers.js` provided the axios client for hitting `http://localhost:3000/api/v1`.
   - Repo-wide search confirmed that only the six deleted smoke test files referenced `tests/helpers.js`. It was therefore safely removed.

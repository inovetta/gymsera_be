# FLOW-05 — Listings tab stale after creating an organization (investigation)

Prompt 2B group 4, item C. Investigation + a minimal diagnostic. **No fix applied** (the cause seen in normal use is
not proven).

| Field | Value |
|---|---|
| Status | NOT REPRODUCED in normal use. REPRODUCED on the server only with an abnormal (tenant-less) host token. Diagnostic added; fix proposed, not applied. |
| Code checked | backend main 285417b; mobile released `origin/master` b875158 |

## The four hypotheses (spec §12.3 FLOW-05), checked on the released mobile code

| # | Hypothesis | Result | Evidence (gyms_era @ origin/master) |
|---|---|---|---|
| 1 | HTTP-layer / repository cache | Ruled out | Dio has only logging, auth and error interceptors (`lib/core/network/dio_client.dart:27-35`, `auth_interceptor.dart`); `GymsRepository.getListings` is a plain `GET /host/listings` with no cache (`lib/features/gym_host/data/repositories/gyms_repository.dart`) |
| 2 | Different provider instance / container / family mismatch | Ruled out | One `ProviderContainer` (`lib/main.dart:31-40`), no nested `ProviderScope`; `hostListingsProvider` is a plain `FutureProvider`, not a family (`lib/features/host/presentation/providers/host_providers.dart:93-96`); the wizard's notifier is a non-autoDispose `StateNotifierProvider` (`host_onboarding_providers.dart:963`), so its `_ref.invalidate` after the `await` (`:948`) is valid |
| 3 | Local copy in widget `State` | Ruled out | `ListingsOverviewScreen` watches the provider in `build` and derives everything per build (`listings_overview_screen.dart:36-104`); `host_gyms_overview_screen.dart:839,1234` use `ref.read` only inside action handlers that consider ACTIVE organizations |
| 4 | List filtered to ACTIVE | Ruled out | Client filters by search text only (`listings_overview_screen.dart:97-99`); the API returns every status but INACTIVE (`gymsera_be/src/controllers/host.controller.js:361-364`) |

Both create paths call `POST /host/listings` and then invalidate `hostListingsProvider`:
`host_onboarding_providers.dart:917,948` (wizard) and `new_organization_quick_form_screen.dart:107` (quick form / move).
`createListing` commits before it responds (`host.controller.js`, `platformTx.commit()` then `sendSuccess`).

## The JWT lead — what the test shows

- `GET /host/listings` has no `tenantContext` (`src/routes/host.routes.js:36`) and lists `req.user.tenantId`, i.e. the
  raw token claim (`src/middleware/authenticate.js:46`, `host.controller.js:351`).
- `POST /host/listings` runs through `tenantContext` (`host.routes.js:45`), which **overwrites** `req.user.tenantId` with
  the tenant it resolved — header, else token, else branch, else the user's default tenant
  (`src/middleware/tenantContext.js:148-195`, `:289-291`).
- So with a `GYM_HOST` token whose `tenantId` is missing, create succeeds (fallback tenant) and the list answers `[]`.
  `tests/regression/flow-05-listings-after-create.test.js` test 2 reproduces exactly that on main.
- With a normal token the next list contains the new PENDING organization (test 1) — **not reproduced**.

Can the released app hold such a token? Tokens are only signed in `auth.service.js#_buildTokenPayload` (`:163-191`),
always after the tenant exists (registration `tenant.service.js:43-58`, invitation acceptance `auth.service.js` ~`:1185-1252`).
The one way to lose the tenant is the `catch` at `:174-176`, which turns a failed tenant lookup into `tenantId: null`
silently; that token then lives until it expires. The released app sends no `X-Tenant-Id` on `createListing`, so a
header mismatch is not a path today. Whether this is what users hit is **not proven** — it needs the runtime check below.

## Diagnostic added (no personal data)

`host.controller.js#getListings`:
- Always: `console.warn('[FLOW-05] GET /host/listings: token has no tenantId; returning an empty list')` — the only way the
  endpoint answers a host with an empty list. No ids, no e-mail.
- With `DEBUG_FLOW05=true`: one line per call with the count by status and whether `X-Tenant-Id` is absent / matches /
  differs from the token's tenant. No ids, no names.

Runtime check to run on a device (not done — no device in this session): reproduce the stale tab, then search the API
log for `[FLOW-05]`. A "token has no tenantId" line at that moment confirms the JWT lead. If there is none and
`DEBUG_FLOW05` shows the new organization counted, the cause is on the client and the next step is temporary
`debugPrint`s in `hostListingsProvider` (create / `ref.onDispose` / item count).

## Proposed fix (NOT applied)

1. List and create must resolve the tenant the same way: add `tenantContext` to `GET /host/listings`
   (`host.routes.js:36`) and read `req.tenantId` in `getListings` and `createListing`. Effect for a host with no
   resolvable tenant: `400 missing_tenant_context` instead of `[]` — the released app then shows "Failed to load
   listings" (`listings_overview_screen.dart:77-78`) instead of an empty list. Needs an owner nod on that change.
2. `_buildTokenPayload` should not sign a GYM_HOST token with `tenantId: null` after a lookup error: rethrow so login /
   refresh fails and the app retries.
3. Then add the invalidation to the spec §5.3 matrix and the Flutter widget test from §12.3 (create org → pop → visible).

## Test

`tests/regression/flow-05-listings-after-create.test.js` (3 tests): normal token create → list shows it; tenant-less token
create → 201 but list `[]` (+ exactly one `[FLOW-05]` warning without ids or e-mail); `DEBUG_FLOW05` line has counts only.
On main (before the diagnostic) tests 2 and 3 fail on the log assertions only; the reproduction itself already holds.

## Client impact / deploy

None: response shapes unchanged; only log lines added. No migration.

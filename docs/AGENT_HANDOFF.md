# GymsEra — Agent Handoff (live state)

**This file is the shared memory between AI agents** (Claude Code, Gemini, Codex, Cursor, or a human).
Whichever agent works next reads this first and continues from **Next action**. No agent may rely on
its own chat history or its tool's built-in memory: if it isn't written here, in spec §13, or in git, the
next agent won't know it.

- Permanent rules: `AGENTS.md` in each repo.
- Master spec: `GYMSERA_PRODUCTION_ARCHITECTURE.md` (this folder). §13 holds finished work; §14 holds owner decisions.
- Prompts in order: `GYMSERA_AGENT_PLAYBOOK.md` (this folder).

---

## 1. Current position

<!-- The active agent overwrites this whole section at every checkpoint. Keep it short and exact. -->

| Field | Value |
|---|---|
| Last updated | 2026-10-08 |
| Updated by | Gemini (Antigravity) |
| Current prompt | **NEW-46: CMS fixes (catalog, capacity banner, loading state, isTenantOwner, map, cities) and savesto branch report** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | (none) |
| Step within issue | (none) |

### Branches and last commits

Work is on branch `fix/new-46` in `gymsera_cms`. Not pushed, no PRs opened.

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | `fix/new-38-delete-listing-reauth` | (clean) | no |
| gymsera_be | `main` | dbbccc2 Merge pull request #75 from inovetta/fix/new-45-gyms-permissions | no |
| gymsera_cms | `fix/new-46` | 0b8ceb0 test(layout): ensure dual-owner context for in-flight org switch test | no |
| gymsera_web | `phase-2/prompt-2a-reliability` | 41b167c fix(auth): prevent refresh subscriber leak and integrate error-copy resolver (AUTH-03, API-01) | no |

### Next action (exact, so another agent can do it without guessing)

> NEW-46 is complete in `gymsera_cms` branch `fix/new-46` (3x Vitest runs 196/196 passed, Playwright 4/4 passed, Next.js build clean). Next action: Prompt 3C (`docs/GYMSERA_AGENT_PLAYBOOK.md`: Ledger, payouts, dashboard, reports, notifications in the CMS).

### Work in progress that is NOT committed

- (none)

### Blocked / waiting on the owner

- **Deploy order (critical):** platform migrations **p004–p006 must be applied before this backend code goes live.**
  The model reads `currency` and `pending_change`; without them every `tenant_subscriptions` query fails
  ("Unknown column"). Steps: run the read-only checks in `docs/sql/prompt-1b-precheck.sql`, then
  `node src/scripts/run-platform-migrations.js --dry-run`, then without the flag. (p001–p003 from 1A too, if not yet run.)
- **Before deploying this backend branch:** run `node src/scripts/run-platform-migrations.js --dry-run`, check the
  report, then `node src/scripts/run-platform-migrations.js`. It adds `billing_events` (p001), `REVOKED` status
  (p002) and UNIQUE(platform, external_original_transaction_id) (p003; skipped with a list if duplicates exist).
  Until then webhooks answer 500 (providers retry for days), nothing is lost.
- **Existing pay-later tenants (data decision, not done):** tenants approved before BILL-13 still hold the old full-cycle
  ACTIVE / payment-PENDING row; pay-later applications submitted before BILL-13 keep theirs at approval. Query 6 in
  `docs/sql/prompt-1b-precheck.sql` lists the pending ones. Converting them to the 14-day GRACE plan is a production
  data change — owner to decide.
- Still open from 1A / Decide/confirm (not in §14): a **partial** Stripe refund keeps the plan (only full refund or dispute revokes);
  a refunded/disputed Stripe subscription is **not** cancelled at Stripe (it would bill again next period — web card is OFF per R-7,
  so this only matters once a web provider is live).
- **NEW-15 is DONE** and R-21 is DECIDED (`GET /host/subscription/current` is read-only; be 6f3506f, 5d984de).
  New P2 item NEW-18 (spec §12.13.11): plan creation at approval fails silently — recorded, partly fixed in 1B.
- **NEW-26 is DONE**: Suspended tenant complete blocking, immediate Redis cache invalidation (`safeRedisDel`) and pool release on suspend, `updateMyTenant` ACTIVE check, renewal webhooks record on `TenantSubscription` without granting entitlement or reconciling capacity (decision R-23), nightly cron skips suspended tenants in capacity reconciliation and iteration, platform admin access verified intact via separate admin routes. Tests in `tests/regression/new-26-suspended-tenant-blocking.test.js`.
- **NEW-27 (P2)**: Mobile restore purchase retry loop on 409 recorded in spec §12.13.12.
- **NEW-28 (P2)**: Unclosed Redis clients in Bull queues & un-awaited DeviceToken.sync() recorded in spec §12.13.12.
- **Part 2 of Hotfix Part 2**: Decisions pending on the four /system routes (`/system/run-install`, `/system/run-pull`,
  `/system/configure-fcm`, `/system/fcm-test`).

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

**Prompt 3A — Team & Access + Approvals in the CMS (gymsera_cms, branch `phase-3/prompt-3a-team-approvals`):**
- [x] 1. `/gym/team` on the mobile `/team` endpoints: chips, 3-choice editor, preset labels, diff, revoke keeps the record, expectedVersion / 409, disabled higher roles (cms 3c28b96)
- [x] 2. `/gym/approvals` on `/approvals`: Waiting on you / Your requests, sidebar count, 202 helper and notice (cms 52f374c)
- [x] 3. `/gym/staff` redirects to `/gym/team`; legacy staff calls removed from the CMS client (cms 71f36df)
- [x] 4. Trainers page linked to the person's team record (cms b09e776)
- [x] Spec §13 (UX-12, UX-13, Prompt 3A notes), §3.3 parity rows, §8.3.3 wording, NEW-41, NEW-42
- [ ] Owner review, push, PRs (owner said: do not push)

---

**Prompt 2B — Group 1: RBAC & Access Control (RBAC-04, RBAC-05, RBAC-08, RBAC-09):**
- [x] 1. RBAC-09 — Branch deletion revokes branch-scoped `RoleAssignment`s and cleans up junctions (`be/src/services/gym.service.js:deleteBranch`) (be 43851fa)
- [x] 2. RBAC-05 — Level rule strictly enforced on invite, update, and acceptance (`accessService.canAssignRole`, `gym.service.js:assignStaff`, `team.service.js:acceptStaffInvite`) (be 4dfa4c4)
- [x] 3. RBAC-08 — Concurrency versioning on role assignments (`version` column via tenant migration 013, optimistic concurrency checks with `expectedVersion` in `team.service.js`, 409 `grants_changed`) (be 5233633)
- [x] 4. RBAC-04 — Approval execution re-checks requester existence/membership and approver grants, idempotent execution by `approvalId` (`be/src/services/approval.service.js:decide`) (be 4370db4)

---

**Prompt 2A — Reliability (API-01, API-02, REL-02, REL-03, REL-04, REL-05, BILL-07, BILL-09, AUTH-02, AUTH-03, AUTH-08):**
- [x] 1. API-01 — One response/error envelope (§4.1) with backward compatibility + shared error-copy table (§4.2) (be bfaf8fb, app 406e690, cms 3dcf23a, web 41b167c)
- [x] 2. API-02 — Timeouts + retry policy (§4.1) (dio/fetch interceptors; server timeouts 15s) (be bfaf8fb, app 406e690)
- [x] 3. REL-02 — Busy state on mutating controls (`AppButton.busy` / `isLoading` debounce timer) (app 406e690)
- [x] 4. REL-03 — Cron/sweeps safe with >1 instance (distributed lock per job, resumable & batched) (be dd52c24)
- [x] 5. REL-04 — Billing cron skips SUSPENDED/deleted tenants and never mutates tenant status (be dd52c24)
- [x] 6. REL-05 — Graceful shutdown (drain in-flight requests, flush buffers, clean exit) (be dd52c24)
- [x] 7. BILL-07 — Cross-provider double billing prevention (`POST /billing/purchase-intent`) (be 495c827)
- [x] 8. BILL-09 — Superseded row still billing visibility (`duplicateBilling` flag & banner) (be 495c827)
- [x] 9. AUTH-02 — Sessions & devices (`UserSession` model, session list/revoke, `POST /auth/logout`) (be bedc13f)
- [x] 11. AUTH-08 — Immediate permission revocation (`ver` claim checking & NEW-37 immediate token invalidation) (be bedc13f)
- [x] 12. Review Blocker 1: Upload route timeout (120s) exemption & idempotency retry protection across 408 timeouts (be dc394e4)
- [x] 13. Review Blocker 2: In-process bounded cache for `permissionVersion` & user status without Redis (30s TTL, 5000 max entries) (be 7b21589)
- [x] 14. Review Blocker 3: Log `unhandledRejection` without process termination (be 158b3ed)

---

**Prompt 1I — Account and tenant deletion (AUTH-07) + NEW-34:**
- [x] Plan approved through the question tool; decisions recorded as R-28 (df17932)
- [x] p014/p015 migrations (f2c6598), request / preflight / undo + auth guards (6f3ab27), day-30 sweep (3043e1d)
- [x] NEW-34: reject 409 during a live lease, listing INACTIVE, manual orphan-database drop (27ed2a5)
- [x] Apple Sign-In revoke behind config, p016 (0ca2b99, fix 462e561); read-only check script (3c75de1)
- [x] Clients: mobile 7705380, web privacy copy 4b83fbe, CMS statuses b0ae3f8
- [x] §13 rows (AUTH-07, NEW-34); new findings NEW-35, NEW-36, NEW-37
- [x] Backend 3× 84/84 suites 625/625 tests; Flutter 3× 29/29; CMS vitest 3× 12/12, Playwright 1/1; web vitest 3× 10/10, Playwright 1/1

---

**Prompt 1F — Remaining P0 security and provisioning (scope per R-24):**
- [x] 1. SEC-03 — Google RTDN OIDC (884713b)
- [x] 2. SEC-07 — log redaction (d50216b)
- [x] 3. RT-04 — socket room authorization (2bddcae)
- [x] 4. R-25 — remove hard-coded DB credential fallback in provisioning (d9520b8) + read-only check script
- [x] 5. SEC-09 — remove raw card fields and the fake saved card (gyms_era 4ca8277)
- [x] 6. UX-12 — plan only, §13 PLANNED (5bf2fff)
- [x] §13 rows with hashes; backend 3× 71/71 suites 439/439 tests; Flutter 3× 19/19
- Split out (not in 1F): FLOW-02 → Prompt 1G, SEC-10 → 1H, AUTH-07 → 1I

---

**Prompt 1G — Resumable tenant provisioning:**
- [x] FLOW-02 verified again (still open, 3 defects proven on 7e2b246), fixed (be d326909, cms 355b29f), §13 row
- [x] p013 migration with dry-run / conflict / re-run tests; read-only `gymsera-flow02-provisioning-check.js`
- [x] Backend 3× 77/77 suites 516/516; CMS 3× vitest 8/8, Playwright 1/1

## 3. Notes for the next agent

<!-- Things you learned that are not obvious from the code or §13: commands that work, test DB setup quirks,
     files that look relevant but aren't, dead ends already tried. Append; delete only when no longer true. -->

- **Exact commands to run each test suite:**
  - `gymsera_be`:
    - Command: `npm test`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be`
    - Runs isolated test DBs (`gymsera_test_platform`, `gymsera_test_tenant_1`, `gymsera_test_tenant_2`) on local MySQL 5.7 (port 3308 locally via `gymsera-test-mysql57` docker container, 3306 in CI). Never touches live or staging DBs (R-19).
    - Status (2026-09-27, after Prompt 1A): 19 suites, 88 tests PASS (see the intermittent-failure note below).
  - `gyms_era` (Flutter):
    - Command: `flutter test test/regression/`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/GymsEraApp/gyms_era`
    - Status: 4 suites PASS (5 tests total: §9.2, §9.3, §9.5, §9.8).
    - Note on `flutter test`: runs all tests; all 5 regression tests pass, but `test/widget_test.dart` ("Counter increments smoke test") fails because it is the unused Flutter default template counter test.
  - `gymsera_cms`:
    - Unit/Component: `npm test` (runs Vitest jsdom tests in `tests/`) -> PASS (2/2)
    - E2E: `npx playwright test` (runs against local port 3001) -> PASS (1/1)
  - `gymsera_web`:
    - Unit/Component: `npm test` (runs Vitest jsdom tests in `tests/`) -> PASS (2/2)
    - E2E: `npx playwright test` (runs against local port 3002) -> PASS (1/1)
- Local MySQL port is 3308 for MySQL 5.7 container (`gymsera-test-mysql57`), fallback 3306.
- Test safety guard: `tests/harness/test-db.js` exports `assertTestEnvironmentSafety` which enforces `NODE_ENV === 'test'`, DB hosts within `{localhost, 127.0.0.1, ::1, mysql}`, and DB names starting with `gymsera_test_`.
- Tenant migrations: `src/database/tenant-migration-runner.js` manages versioned tenant DB migrations (target version 7). To preview across all active tenants, use `node src/scripts/run-tenant-migrations.js --dry-run`. To apply, use `node src/scripts/run-tenant-migrations.js`.

---

- **Prompt 1A additions (2026-09-27):**
  - Platform DB migrations: `src/database/platform-migrations.js` (reuses `runTenantMigrations` with a migration
    list). CLI `node src/scripts/run-platform-migrations.js [--dry-run]`; it only `authenticate()`s, because
    `platform.js#connect` runs boot-time ALTERs. Proof: `tests/integration/platform-migration-runner.test.js`.
  - Every store/webhook change goes through ONE function: `subscription-migration.service.js#applyVerifiedSubscription`.
    Entry points: `syncFromApple` / `syncFromGoogle` / `syncFromStripe` (used by `/billing/*/sync`, the inbox
    processor `billing-event.service.js`, and the daily cron).
  - Provider calls live in `appleApi` / `playApi` / `stripeApi` objects; tests fake them with
    `tests/harness/billing-fakes.js`. The test harness blanks all provider credentials (`test-db.js`) — before that,
    one test run sent a real acknowledge call to Google Play with a fake token (rejected, no effect).
  - Backend suite now 19 suites / 88 tests. Flutter `flutter test`: 9 tests, all pass (the old counter-template
    failure is gone). Web: vitest 6, Playwright 1.
  - **Intermittent backend failure — NOT diagnosed, next agent should look first**: in 3 of ~14 full `npm test`
    runs one test failed that passes alone: `harness.test.js`; the BILL-14 "another tenant's session" check (got
    400); and the BILL-06 RTDN-acknowledge test (ack not called — the inbox event most likely ended FAILED; print
    its `lastError` to see why). Always the full run, never the file alone. Suspect cross-file leakage of background
    work (the provisioning test's emails/notifications, open pools) or a lock race — could be a real bug in the
    1A code, so treat it as open.
  - Existing tests reach real services: the tenant-provisioning test sends a real e-mail
    (`[Email] Successfully sent email to host-prov@gymsera.test`), and a mobile regression test issues a real
    `GET https://apistaging.gymsera.com/api/v1/tenants/me`. Not touched in 1A; worth fixing under R-19.
  - ESLint: test files fail lint repo-wide (no Jest env in the config); pre-existing. Changed `src/` files add no
    new lint errors.

- **Prompt 1B additions (2026-09-28):**
  - Entitling set: `subscription-quota.service.js#ENTITLING_STATUSES = ['ACTIVE','GRACE']`. The one-ACTIVE-row
    invariant now means one *entitling* row. `ENDED_STATUSES` (REVOKED, ON_HOLD, PAUSED) reconcile capacity when a
    row leaves the entitling set; `NO_FALLBACK_STATUSES` (+ EXPIRED) never fall back to the legacy package.
  - `applyVerifiedSubscription` now also handles: provider charge (`chargedAmount`/`chargedCurrency`), the provider's
    upcoming plan (`upcomingChange` → `pendingChange`), first-seen non-entitling rows (recorded, not activated), and
    MANUAL rows (pay-later, keyed `pay-later:<tenantId>`).
  - Migration tests for p004+ live in `tests/integration/platform-migrations-1b.test.js` (scratch DB
    `gymsera_test_platform_mig_1b`, shaped like production after 1A). Add each new migration there: dry-run, conflict,
    apply + re-run.
  - `subscription-expiry.cron.js` computes "today" as local midnight printed in UTC, so east of UTC (Pakistan) a plan
    expires one day late. Pre-existing; not changed. The pay-later tests advance the clock 16 days because of it.
  - **Intermittent full-suite failure — cause proven and fixed (TEST-FLAKE-1B, be e9feaf7, §13):** supertest ran the
    bare app on a random port on every address but called 127.0.0.1; on macOS that port can belong to another program
    bound to 127.0.0.1 only. Tests now call `tests/harness/test-server.js#startTestServer` (listening on 127.0.0.1);
    `tests/harness/loopback-listen.js` refuses a bare `request(app)` with a clear message. **New test files: use
    `startTestServer`, never `request(require('../../app'))`.**
  - Still open (not the flake): Jest needs `--forceExit` — 33 Redis sockets (Bull queues, `src/jobs/queues.js:36`, never
    closed; tests use the developer's local Redis on 6379) and 3 MySQL sockets remain; `src/models/platform/index.js:46`
    runs `DeviceToken.sync()` un-awaited at require time.
  - Security, still live on production (already tracked P0, not fixed): NEW-04 `/debug-sync-db` (unauthenticated
    `sync({alter:true})` on every database) and NEW-05 `/system/recycle` etc. behind a key committed in git
    (`src/routes/index.js:326-470`).
  - Remaining client work from 1B: mobile "choose branches to keep" screen (API exists: `GET /billing/downgrade-preview`,
    `PUT /billing/downgrade-choice`); CMS admin "Verify payment" button (`POST /admin/tenants/:id/subscriptions/:subId/verify-payment`);
    host countdown/banner from `paymentIssue` on `GET /host/subscription/current` (mobile, CMS, web).

- **Prompt 1G additions (2026-10-01):**
  - Provisioning = `tenant-provisioning.service.js` step machine; test seam `provisioningHooks.onStep(step, phase)`.
    Lease writes: MySQL returns *changed* rows, and DATETIME has 1-second precision, so a same-second renewal
    reports 0 rows — `writeUnderLease` re-reads before deciding the lease was lost. Keep that in mind for any
    other conditional UPDATE used as a lock.
  - `jest.restoreAllMocks()` in a test also removes `installMailFake()`; reinstall it after, or restore spies one by one.
  - Mobile `admin_repository.dart#approveTenant` has no caller in the UI; nothing to update there.
  - Full backend suite now takes ~11 minutes.

- **Prompt 1I additions (2026-10-02):**
  - Deletion = statuses, not a new gate: `PENDING_DELETION` tenants are already closed by `tenantContext` (ACTIVE only) and discovery (ACTIVE only). A pending USER's token carries `dp: true` and `middleware/authenticate.js` allows only profile / preflight / cancel-deletion / refresh / logout.
  - Services: `account-deletion.service.js` (request / preflight / undo), `account-deletion-finalize.service.js` (day 30; anonymize in place; never drops), `apple-signin-revoke.service.js`, `orphan-database.service.js` (manual drop with hard refusals). Scripts: `run-account-deletion-sweep.js`, `drop-orphan-tenant-database.js`; read-only `gymsera-auth07-deletion-check.js`.
  - Test-harness gotchas: all factory tenants share `gymsera_test_tenant_1` unless given another connection string; a sweep that scrubs a whole tenant DB (`where: {}`) must use tenant 2. MySQL DATETIME keeps whole seconds: compare timestamps the database returned, not `new Date()` with milliseconds.
  - A migration test that pins an older version must pass `targetVersion` (1G's test now does); every new platform migration must skip a missing table (the full suite, not the targeted tests, caught p016 without it).
  - Full backend suite now ~13 minutes.

- **Prompt 2A additions (2026-10-03/04):**
  - Platform migration `p018_create_audit_logs` manages `audit_logs` creation on Platform DB with full dry-run and conflict-skip tests (`tests/integration/platform-migrations-p018.test.js`). Boot-time table creation removed from `platform.js#connect`.
  - Redis resilience (spec §0.1 Rule 10 & §15): all tests touching Redis must also pass with `DISABLE_REDIS=true`. In `tests/regression/new-26-suspended-tenant-blocking.test.js`, Redis cache checks are conditional on Redis availability (`DISABLE_REDIS !== 'true' && ensureRedisReady() !== null`).

- **Prompt 3A (2026-10-06) — endpoints the mobile Team & Access and Approvals screens call** (the CMS must call the same ones):
  - Repository: `gyms_era/lib/features/host/data/repositories/team_repository.dart`; providers `presentation/providers/team_provider.dart`;
    screens `team_access_screen.dart`, `permission_editor_screen.dart`, `add_team_member_screen.dart`, `approvals_inbox_screen.dart`.
  - `GET /team/meta/roles` (`:33`; each role carries `assignableByMe` and its `preset`), `GET /team/meta/permissions` (`:43`),
    `GET /team` (`:58`), `GET /team/:assignmentId` (`:71`; returns `overrides`, `effectivePermissions`, `effectiveScopes`, `version`),
    `POST /team/invites` (`:92`), `PATCH /team/:assignmentId` (`:121`; in the repository but no mobile screen calls it),
    `PUT /team/:assignmentId/permissions` (`:144`; whole-set replace), `DELETE /team/:assignmentId` (`:153`; revoke, row kept).
  - `GET /approvals?status=PENDING` (`:160`), `GET /approvals/mine` (`:170`), `POST /approvals/:id/approve` (`:180`),
    `POST /approvals/:id/reject` (`:188`, reason required), `POST /approvals/:id/cancel` (`:195`).
  - The host screens send no `X-Tenant-Id` (server default); only the team-member workspace passes one.
  - Mobile does NOT send `expectedVersion` yet and has no 409 `grants_changed` handling (RBAC-08 is backend-only so far).
  - None of the `/team` or `/approvals` routes asks for re-auth, and none answers 202 (team permissions are not approvable).
    202 comes from `/actions/:key`, ledger adjustments, payouts and `POST /payments/:id/refund`.
  - **3A results and gotchas (2026-10-06):**
    - CMS suites after 3A: `npx vitest run` 14 files / 86 tests (3 runs, all pass); `npx playwright test` 3/3; `npm run build` OK.
      Run them from `gymsera_cms` itself: `npm test` from another folder picks up an unrelated `package.json`.
    - `tsc --noEmit` rewrites the tracked `tsconfig.tsbuildinfo`; restore it (`git checkout tsconfig.tsbuildinfo`) before committing.
    - A Next.js `page.tsx` may export only the page (a second named export fails the build); shared constants live in `src/lib`.
    - CMS component tests mock the API with `vi.spyOn(<api object>, …)`; fixtures for team shapes are in `tests/fixtures/team.ts`.
      Playwright tests answer `**/api/v1/**` with `page.route` and seed the session in `localStorage` + the `gymsera_session` cookie
      (placeholder values only). An open Radix dialog hides the page behind it from role queries (`{ hidden: true }`).
    - Server 403 / 409 without an explicit code arrive as `forbidden` / `conflict`; the shared resolver then returns the generic table
      text. `src/lib/team/access.ts#teamErrorMessage` keeps the server's own sentence in that case.
    - Spec §13 has no rows for Prompt 2B groups 2–4 (they are recorded under `docs/changes/*.md` instead), and this file's §2 checklist
      stops at group 1. Git is right; the files were not back-filled in 3A.

## 4. Session log (append-only, newest at the bottom)

| # | Date | Agent (tool + model) | Prompt | Issues finished | Ended because | Handoff clean? |
|---|---|---|---|---|---|---|
| 0 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (created docs, AGENTS.md / CLAUDE.md / GEMINI.md in all 4 repos) | task complete | yes |
| 1 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (recorded owner decisions R-1…R-19 in §14; DB rule R-19 in AGENTS.md; GO prompt in playbook) | task complete | yes |
| 2 | 2026-09-26 | Claude Code (Opus 5.5) | Prompt 0 | Audit written to spec §1.8, §3.3, §12.13 (164 issues + 17 NEW) | task complete | yes |
| 3 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Prompt 1 | test harness, factories, personas, mobile fakes, CMS/web vitest+playwright, CI workflows, §9.1–§9.8 regressions | task complete | yes |
| 4 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.5 | NEW-10 (§9.6 getConnection side effects), test safety guard, Playwright smoke tests | task complete | yes |
| 5 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.7 | Payment business_date immutable from collection time; model hooks; Migration 006; raw SQL audit; backfill-payments.js removed | task complete | yes |
| 6 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.8 | One rule for collection time (getPaymentCollectionTime): cash -> created_at, online -> paid_at; unified model hooks, Migration 004, and Query B | task complete | yes |
| 7 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.9 | Maintenance repair script for payment business_date (repair-payment-business-dates.js), collation audit, demo tenant audit | task complete | yes |
| 8 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.11 | Fix collection-time rule (earlier of created_at/paid_at for CASH; pending non-cash provisional date finalization on completion) | task complete | yes |
| 9 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.10 | Step 2.10: MySQL 5.7 CI/Docker, mixed-collation fixture, Migration 004 JS join, Migration 007 collation align, runner dry-run & error isolation, reactivateTenant migration | task complete | yes |
| 10 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.10b | Collation mismatch re-audit: explained owner failure, verified Migration 007 dynamic table/column scan, added ledger_days join failure & success tests | task complete | yes |
| 11 | 2026-09-27 | Gemini (Gemini 3.8 Flash) | P0 Urgent | NEW-17: --dry-run safety, rollback transaction wrapper, individual migration dryRun guards, Migration 004 non-null isolation audit & tests | task complete | yes |


| 12 | 2026-09-27 | Claude Code (Opus 5.5) | Prompt 1A | BILL-12, BILL-02, BILL-06, BILL-01, BILL-14 (transfer endpoint for BILL-01 deferred) | task complete | yes |
| 13 | 2026-09-28 | Claude Code (Opus 5.5) | NEW-15 (1A follow-up) | NEW-15 (R-21 raised for owner) | task complete | yes |
| 14 | 2026-09-28 | Claude Code (Opus 5.5) | R-21 (1A follow-up) | R-21 read-only endpoint; NEW-18 recorded | task complete | yes |
| 15 | 2026-09-28 | Claude Code (Opus 5.5) | docs: owner decisions 1B | R-2, R-3, R-4 marked DECIDED 2026-09-28; R-22 pay-later grace added (owner confirmation pending) | task complete | yes |
| 16 | 2026-09-28 | Gemini (Gemini 3.8 Flash) | Hotfix: close open routes | NEW-04, NEW-05, audit unauthenticated routes, suspended tenant report & NEW-26/27/28 recorded | task complete | yes |
| 17 | 2026-09-28 | Gemini (Gemini 3.8 Flash) | Hotfix part 2 | NEW-29, NEW-30, NEW-31 (resolves NEW-01), Part 2 report, Part 3 unauthenticated-routes-guard test | task complete | yes |
| 18 | 2026-09-28 | Claude Code (Opus 5.5) | Prompt 1B | BILL-04, BILL-05, BILL-03 (lock = CAP-01), BILL-13, FLOW-03, BILL-08 | task complete | yes |
| 19 | 2026-09-28 | Claude Code (Opus 5.5) | 1B close-out | TEST-FLAKE-1B (cause proven, fixed); backward-compat report; NEW-19…NEW-25 + §16 sandbox list | task complete | yes |
| 20 | 2026-09-28 | Gemini (Gemini 3.8 Flash) | Merge: 1B + Hotfix PR #48 | Resolve docs merge conflicts in AGENT_HANDOFF.md and GYMSERA_PRODUCTION_ARCHITECTURE.md | task complete | yes |
| 21 | 2026-09-29 | Gemini (Gemini 3.8 Flash) | Prompt 1C (Branch capacity) | CAP-01..CAP-08 (branch billing lock, capacity outbox, lifecycle doors, admin suspend, reject pending org, restore auto-deactivated org, org never empty, concurrency controls) | task complete | yes |
| 22 | 2026-09-29 | Gemini (Gemini 3.8 Flash) | NEW-26 | NEW-26 (suspended tenant complete blocking, cache invalidation, updateMyTenant, webhook audit-only R-23, cron sweep, platform admin exception verified) | task complete | yes |
| 23 | 2026-09-29 | Gemini (Gemini 3.8 Flash) | NEW-28 (Option B) | NEW-28 (removed Bull/Redis queue dependency for member notifications PAYMENT_FAILED, SUBSCRIPTION_RENEWED, SUBSCRIPTION_EXPIRING_SOON; direct in-app/push/email dispatch; deleted queues.js & notifications.processor.js) | task complete | yes |
| 24 | 2026-09-29 | Gemini (Gemini 3.8 Flash) | Prompt 1D (Access control) | RBAC-07, AUTH-01, AUTH-04, AUTH-09, SEC-02, SEC-01, RBAC-03 (permissions doc & test matrix) | task complete | yes |
| 25 | 2026-09-30 | Gemini (Gemini 3.8 Flash) | Prompt 1E (Member money) | REL-01, PAY-01, PAY-02, PAY-03, PAY-04, PAY-07, PAY-10, SEC-13 | task complete | yes |
| 26 | 2026-09-30 | Claude Code (Opus 5.5) | Prompt 1F | SEC-03, SEC-07, RT-04, R-25, SEC-09, UX-12 (plan); FLOW-02/SEC-10/AUTH-07 split to 1G–1I (R-24) | task complete | yes |
| 27 | 2026-09-30 | Claude Code (Opus 5.5) | Owner task: NEW-02 + NEW-03 | NEW-03 (Google: fallback removed), NEW-02 (Apple: JWKS verification, identity only from the token) | task complete | yes |
| 28 | 2026-09-30 | Claude Code (Opus 5.5) | Prompt 1G | FLOW-02 (be d326909, cms 355b29f); read-only check script | task complete | yes |
| 29 | 2026-10-01 | Gemini (Gemini 3.8 Flash) | Prompt 1H | SEC-10 (KYC data protection, private AES-256 storage, audit logging, CMS watermark viewer, 90-day retention purge sweep, read-only audit script) | task complete | yes |
| 30 | 2026-10-02 | Claude Code (Sonnet 5.5) | Prompt 1I | AUTH-07 (be f2c6598, 6f3ab27, 3043e1d, 0ca2b99, 462e561, 3c75de1; cms b0ae3f8; web 4b83fbe; app 7705380), NEW-34 (be 27ed2a5); NEW-35/36/37 recorded | task complete | yes |
| 31 | 2026-10-02 | Gemini (Gemini 3.8 Flash) | NEW-35 | NEW-35: social account re-auth on payout bank details and branch deletion routed through assertReauth | task complete | yes |
| 32 | 2026-10-02 | Gemini (Gemini 3.8 Flash) | NEW-38 | Organization deletion re-authentication via assertReauth | task complete | yes |
| 33 | 2026-10-03 | Gemini (Gemini 3.8 Flash) | NEW-38 (Rollback gap fix) | Empty-organization rollback promptless exemption (< 5m, 0 branches, caller-owned, no cascade); honest error on cleanup failure | task complete | yes |
| 34 | 2026-10-02 | Gemini (Gemini 3.8 Flash) | Prompt 2A (Reliability) | API-01, API-02, REL-02..05, BILL-07/09, AUTH-02/03/08, NEW-37 | task complete | yes |
| 35 | 2026-10-03 | Gemini (Gemini 3.8 Flash) | Prompt 2A Review Blockers | 2A Blockers 1, 2, 3 (upload timeout exemption & idempotency protection, in-process permissionVersion cache, unhandledRejection logging), p017 deploy prerequisite, GET_LOCK note | task complete | yes |
| 36 | 2026-10-03 | Gemini (Gemini 3.8 Flash) | Merge: Prompt 2A + origin/main (NEW-38) | Merged origin/main into phase-2/prompt-2a-reliability after NEW-38; resolved doc conflicts; kept all spec & handoff rows; verified platform migrations p014-p017; ran full backend suite 3x | task complete | yes |
| 37 | 2026-10-04 | Gemini (Gemini 3.8 Flash) | Production Hotfix | REL-03: MySQL GET_LOCK raw query wrapper and releaseConnection fix (be 979dc9c); SEC-12: platform AuditLog persistence (be 83e8cff) | task complete | yes |
| 38 | 2026-10-04 | Gemini (Gemini 3.8 Flash) | Redis Independence & p018 Migration | new-26 Redis resilience for DISABLE_REDIS=true; audit_logs field/security/latency/retention analysis; p018 platform migration with dry-run/conflict-skip tests (be); spec §0.1 Rule 10 & §15 matrix | task complete | yes |
| 39 | 2026-10-04 | Gemini (Antigravity) | Prompt 2B (Group 1: RBAC) | RBAC-04, RBAC-05, RBAC-08, RBAC-09 | task complete | yes |
| 40 | 2026-10-05 | Gemini (Antigravity) | PAY-08a & gitignore | PAY-08a (reject method TEST in production with 403, ignore in payment service, test harness regression tests), gitignore (firebase-service-account.json, iisnode/) | task complete | yes |
| 41 | 2026-10-05 | Gemini (Antigravity) | Merge: Prompt 2B Group 1 + origin/main (PAY-08a) | Merged origin/main into phase-2/prompt-2b-rbac after PAY-08a; resolved doc conflicts in spec §13 and handoff; verified platform p001-p018 and tenant 001-013 migrations; ran full suite twice | task complete | yes |
| 42 | 2026-10-05 | Gemini (Antigravity) | Hotfix: RBAC-09 check script | Fixed Unknown column 'name' (tenants.business_name) and 'rab.role_assignment_id' (rab.assignment_id) in gymsera-rbac09-stale-branch-assignments-check.js; added regression test against migrated schema | task complete | yes |
| 43 | 2026-10-06 | Gemini (Antigravity) | Hotfix: Prompt 2B Group 3 check script | Fixed Unknown column 'name' in check-prompt-2b-group3-data.js (business_name, tenant_code, user_gym_memberships schema) & check-tenant-entitlement.js (title); fixed regression test with real migration runners & zero writes; audited 15 scripts; ran full test suite twice (normal + DISABLE_REDIS=true) | task complete | yes |
| 44 | 2026-10-06 | Gemini (Antigravity) | Fix regression test raw SQL inserts | Fixed CI failure on fresh DB (ER_NO_DEFAULT_FOR_FIELD business_date due to Migration 006 NOT NULL & STRICT_TRANS_TABLES); converted test to Payment.create, User.create, GymReview.create; ran full suite twice | task complete | yes |
| 45 | 2026-10-06 | Claude Code (Opus 5.5) | Prompt 3A (CMS Team & Access + Approvals) | UX-12 (cms 3c28b96, 71f36df, b09e776), UX-13 approvals part (cms 52f374c); CMS side of RBAC-04/05/08; NEW-41, NEW-42 recorded | task complete (not pushed, owner review) | yes |
| 46 | 2026-10-06 | Claude Code (Opus 5.5) | NEW-42 (CMS menu by permissions) | NEW-42 (cms 86fdbd0) | task complete (not pushed, owner review) | yes |
| 45 | 2026-10-08 | Gemini (Antigravity) | NEW-46 | CMS catalog, capacity banner, loading state, isTenantOwner, map, cities, and savesto investigation (items a–g) | task complete | yes |
| 47 | 2026-10-08 | (backfilled in NEW-52; original agent not recorded) | NEW-47 | owner with account role MEMBER gets all branches and members (be `478347a`) | task complete (not pushed at the time) | yes |
| 48 | 2026-10-09 | (backfilled in NEW-52; original agent not recorded) | NEW-48 | multi-branch Branch Manager members list (be `5638190`) | task complete | yes |
| 49 | 2026-10-09 | (backfilled in NEW-52; original agent not recorded) | NEW-49 | branch-scoped staff lists (be `789862e`) | task complete | yes |
| 50 | 2026-10-09 | (backfilled in NEW-52; original agent not recorded) | NEW-50 | attendance read routes scope, listForStaff shape (be `d19b112`) | task complete | yes |
| 51 | 2026-10-09 | (backfilled in NEW-52; original agent not recorded) | NEW-51 | attendance write routes, weekly-attendance, host dashboard/checkins scope (be `3af6de0`) | task complete | yes |
| 52 | 2026-10-09 | Claude Code (Sonnet 5.5) | NEW-52 | host branch members/announcements/schedule/resubmit routes and `GET /reports/branch/:branchId` scoped by permission at `:branchId` (be branch `fix/new-52`, not pushed); `dashboard-access.test.js` now runs | task complete (not pushed, owner review) | yes |




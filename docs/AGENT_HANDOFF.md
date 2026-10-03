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
| Last updated | 2026-10-03 |
| Updated by | Gemini (Gemini 3.8 Flash) |
| Current prompt | **Prompt 2A — Reliability (merged after NEW-38)** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | (none) |
| Step within issue | (none) |

### Branches and last commits

Prompt 2A is on branch `phase-2/prompt-2a-reliability` in `gymsera_be` (merged with `origin/main` after NEW-38), `gymsera_cms`, `gymsera_web` and `gyms_era` (cut from each repo's merged 1I state). Not pushed, no PRs opened.

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | `phase-2/prompt-2a-reliability` | 406e690 feat(core): debounce primary button and add Dio retry/error interceptors (REL-02, API-01) | no |
| gymsera_be | `phase-2/prompt-2a-reliability` | (merge commit) Merge origin/main into phase-2/prompt-2a-reliability (NEW-35, NEW-38 merged) | no |
| gymsera_cms | `phase-2/prompt-2a-reliability` | 3dcf23a fix(auth): prevent refresh subscriber leak and integrate error-copy resolver (AUTH-03, API-01) | no |
| gymsera_web | `phase-2/prompt-2a-reliability` | 41b167c fix(auth): prevent refresh subscriber leak and integrate error-copy resolver (AUTH-03, API-01) | no |

### Next action (exact, so another agent can do it without guessing)

> Start **Prompt 2B** from `docs/GYMSERA_AGENT_PLAYBOOK.md` Part B:
> "Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §5.3 and these issues: FLOW-05 (stale Listings tab — follow the four hypotheses in order, with debug logs, and fix the proven cause), FLOW-06, FLOW-08, FLOW-09, FLOW-10, FLOW-12, FLOW-13, RBAC-04, RBAC-05, RBAC-08, RBAC-09, PAY-05…PAY-08, PAY-12. For FLOW-05, record in the handoff file which hypotheses you already ruled out and how."

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

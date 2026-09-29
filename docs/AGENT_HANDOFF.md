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
| Last updated | 2026-09-29 |
| Updated by | Gemini (Gemini 3.8 Flash) |
| Current prompt | **NEW-28 / OPTION-B — Direct Member Notifications (Remove Bull/Redis)** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | (none) |
| Step within issue | done <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

NEW-28 (Option B) is committed on branch `refactor/direct-member-notifications` in `gymsera_be`.

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | `phase-1/prompt-1b-billing-lifecycle` | 520a49b fix(billing): pending Android purchases show 'payment pending', never success (BILL-08) | no |
| gymsera_be | `refactor/direct-member-notifications` | 65d70f8 refactor(notifications): replace Bull/Redis queues with direct member notification dispatch (NEW-28 Option B) | no |
| gymsera_cms | main | 4c631b1 test(cms): add Playwright login smoke test and CI workflow | no (not touched) |
| gymsera_web | `phase-1/prompt-1a-billing-core` | f5fa208 fix(billing): Stripe return page never trusts ?checkout=success (BILL-14) | no |

### Next action (exact, so another agent can do it without guessing)

> Prompt 1C and NEW-28 (Option B) are DONE. Next prompt is **Prompt 1D — Access control: sessions, OTP, RBAC unification, IDOR** from `GYMSERA_AGENT_PLAYBOOK.md`:
> Read spec §0.5, §8 (especially §8.3 Team & Access — approved design from mobile) and issues: RBAC-07, AUTH-01, AUTH-04, AUTH-09, SEC-02, SEC-01, SEC-06, RBAC-03.
> RBAC-07 first: every path that grants or removes staff access must go through the /team service and RoleAssignment. Do NOT change mobile Team & Access UX.
> RBAC-03: generate endpoint x persona test suite from real route list and constants/permissions.js, and commit docs/PERMISSIONS.md.
> Branch to create: `phase-1/prompt-1d-access-control`.

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

**Prompt 1C — Branch Capacity (CAP-01 to CAP-08):**
- [x] 1. CAP-03 — Route all branch creation through `createBranch` and guard lifecycle doors (be 0d81080)
- [x] 2. CAP-04 — Separate admin policy disable from deletion, add migration 008, guard discovery (be 9444ca2)
- [x] 3. CAP-02 — Add tenant capacity outbox for cross-database durability, add migration 009, sweep hook (be 03493c5)
- [x] 4. CAP-01 — Enforce real branch billing lock on over-quota tenants, add migration 010 & p007, middleware guard (be a023dad)
- [x] 5. CAP-05 — Return capacity on pending organization rejection via `deleteBranch` (be 262846e)
- [x] 6. CAP-06 — Reactivate auto-deactivated organization on branch restore (be a85db2d)
- [x] 7. CAP-07 — Enforce organization never empty everywhere and report in `auditCapacity` (be 5463307)
- [x] 8. CAP-08 — Verify concurrency controls for parallel create, delete+restore, and donor slot competition (be 2dcaec8)
- [x] §13 rows with hashes, 3 consecutive full runs, pre-check SQL queries, this handoff

---

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

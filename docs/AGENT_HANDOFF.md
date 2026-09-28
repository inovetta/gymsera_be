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
| Last updated | 2026-09-28 |
| Updated by | Claude Code (Opus 5.5) |
| Current prompt | **Prompt 1B — Billing lifecycle** (BILL-04, BILL-05, BILL-03, BILL-13, FLOW-03, BILL-08) |
| Prompt status | `IN PROGRESS` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | FLOW-03 |
| Step within issue | verify / root cause <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

Prompt 1A is merged into main (PR #47). Prompt 1B works on `phase-1/prompt-1b-billing-lifecycle`, created from
main at ea1d4df. **Not pushed, not merged** — the owner reviews and merges.

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | `phase-1/prompt-1b-billing-lifecycle` (from `phase-1/prompt-1a-billing-core` b4dfb59 — mobile 1A is NOT in master yet) | b8909df fix(billing): Android downgrades use DEFERRED replacement (BILL-03) | no |
| gymsera_be | `phase-1/prompt-1b-billing-lifecycle` (from main ea1d4df) | see `git log` | no |
| gymsera_cms | main | (not touched) | no |
| gymsera_web | main | (not touched) | no |

### Next action (exact, so another agent can do it without guessing)

> FLOW-03: at approval (tenant-provisioning step 1b/10), before creating any plan, look for a provider-backed row of this tenant (e.g. Stripe from the card step). If one exists, link/activate it and create nothing else; otherwise MANUAL/pending for the chosen method. Test: `tests/integration/flow-03-one-entitlement.test.js`.

### Work in progress that is NOT committed

- (none)

### Blocked / waiting on the owner

- Still open from 1A: run `node src/scripts/run-platform-migrations.js --dry-run` then without the flag before
  deploying; partial-Stripe-refund question (see §14 notes / previous handoff).

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

- [x] STEP 0 — §14 R-22 owner confirmed; R-17 = R-22 = one setting (be 043066a)
- [x] 1. BILL-04 — GRACE / ON_HOLD / PAUSED (p004) (be f5543f2)
- [x] 2. BILL-05 — amount/currency from the provider's charge (be e7d61f5)
- [x] 3. BILL-03 — deferred downgrade, pendingChange + keepBranchIds (be 900506e, app b8909df; lock = CAP-01)
- [x] 4. BILL-13 — pay-later GRACE MANUAL row, PAY_LATER_GRACE_DAYS (be fc76f8b)
- [ ] 5. FLOW-03 — one entitlement at approval
- [ ] 6. BILL-08 — Google PENDING purchases
- [ ] §13 rows, 3 full runs, report

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
| 16 | 2026-09-28 | Claude Code (Opus 5.5) | Prompt 1B | (in progress) | — | — |
